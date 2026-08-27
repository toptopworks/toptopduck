//! Skill lifecycle I/O orchestration on [`Session`] (ADR-0086, issue #363;
//! ADR-0110, issue #698).
//!
//! These are the methods that mutate the session's skill state: mount (add),
//! unmount (remove, cascading any activation), and activate (promote a
//! mounted skill into the persistent activated subset). They are a physical
//! move out of `session/mod.rs` for locality -- NOT a deep module (mirrors the
//! [`super::source_lifecycle`] split). Both sets are FOLDED from the
//! timeline's event sequence ([`Recipe::mounted_skills`] /
//! [`Recipe::activated_skills`]), never snapshotted into the recipe; the live
//! [`Session::mounted_skills`] / [`Session::activated_skills`] fields are
//! memoizations that stay in sync because every event append + cache update
//! happens together here.
//!
//! The impl block is a sibling of the one in `session/mod.rs`: Rust lets a
//! descendant module add methods to a type defined in the ancestor and reach
//! its private fields and helpers (`persist_if_bound`). The reverse direction
//! is NOT allowed: the parent cannot call [`Session::append_skill_event`], so
//! it stays private to this module (today mount/unmount are the sole callers;
//! the activation paths go through [`land_skill_activation`] because their
//! persistence borrows differ -- the method persists through `&mut self`, the
//! mid-turn [`SkillActivationCtx`] through the field-split
//! [`super::persist_snapshot`] -- contrast [`Session::append_source_event`],
//! which IS `pub(super)` because the add-path helpers in `session/mod.rs`
//! call it from the parent).
//!
//! [`Recipe::mounted_skills`]: crate::persistence::recipe::Recipe::mounted_skills
//! [`Recipe::activated_skills`]: crate::persistence::recipe::Recipe::activated_skills

use crate::model::{SkillLifecycleActor, SkillLifecycleEvent, SkillLifecycleKind};

/// Why a skill mount / unmount / activate was refused (issue #363; issue
/// #698, ADR-0110). Mirrors the typed-
/// reject pattern of [`crate::model::RemoveSourceError`]: each variant names
/// the offending skill so the frontend can render a precise locale message
/// rather than a generic "failed". The session's timeline is the source of
/// truth, so a stale frontend view racing a concurrent mount/unmount surfaces
/// as `AlreadyMounted` / `NotMounted` instead of silently double-appending.
///
/// Crosses IPC serde-structured, wrapped in
/// [`crate::session_store::SessionError::SkillMount`] (adjacently-tagged like
/// every other typed IPC error); the hand-written `Display` stays Rust-log-
/// only -- it is NOT the IPC contract.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum SkillMountError {
    /// `mount_skill` targeted a name already in the active set. The live path
    /// refuses a redundant mount so the timeline stays free of no-op events
    /// (a re-mount would otherwise pollute the fold with a duplicate). The
    /// frontend disables the mount button for already-mounted skills; reaching
    /// this variant means a stale view or a direct IPC.
    #[error("技能「{name}」已挂载")]
    AlreadyMounted { name: String },
    /// `unmount_skill` targeted a name not in the active set. Symmetric with
    /// [`Self::AlreadyMounted`]: the live path refuses a no-op unmount.
    #[error("技能「{name}」未挂载")]
    NotMounted { name: String },
    /// `activate_skill` targeted a name not in the mounted set (issue #698,
    /// ADR-0110 Decision 2: the activated set is a SUBSET of the mounted set,
    /// so an activation can only name a mounted skill). No event lands. The
    /// frontend affordance (#699) only offers mounted names, so reaching this
    /// variant means a stale view or a direct IPC.
    #[error("技能「{name}」未挂载，无法激活")]
    NotMountedForActivation { name: String },
}

impl super::Session {
    /// The session's currently-mounted skill names (ADR-0086, issue #363), in
    /// first-mount insertion order. A live memoization of the timeline's
    /// Mount/Unmount fold; the recipe never stores a snapshot, only the event
    /// sequence. Cloned so the command layer can serialize the vec without
    /// holding the session lock.
    pub fn mounted_skills(&self) -> Vec<String> {
        self.mounted_skills.clone()
    }

    /// The session's currently-ACTIVATED skill names (ADR-0110, issue #698),
    /// in first-activation insertion order. A live memoization of the
    /// timeline's Activate/Unmount fold ([`Recipe::activated_skills`]); the
    /// recipe never stores a snapshot, only the event sequence. Always a
    /// subset of [`Self::mounted_skills`]. Cloned so the command layer can
    /// serialize the vec without holding the session lock.
    ///
    /// [`Recipe::activated_skills`]: crate::persistence::recipe::Recipe::activated_skills
    pub fn activated_skills(&self) -> Vec<String> {
        self.activated_skills.clone()
    }

    /// Mount a skill into the session's active set (ADR-0086, issue #363).
    /// Appends a `Mount` event to the timeline, mutates the live mounted-skills
    /// cache, and persists the recipe atomically. Refuses a redundant mount
    /// (`AlreadyMounted`) so the timeline stays free of no-op events; the
    /// frontend disables the mount button for already-mounted skills, so
    /// reaching the refusal means a stale view or a direct IPC.
    ///
    /// The backend does NOT query the registry here: the timeline carries
    /// names that may have left the registry (a skill deleted after mounting,
    /// or a recipe imported from elsewhere), and resume honestly degrades
    /// when assembly looks up a missing name. The frontend validates against
    /// `list_skills` before offering the mount, so a UI-driven mount always
    /// names a registry-existing skill.
    pub fn mount_skill(&mut self, name: &str) -> Result<(), SkillMountError> {
        if self.mounted_skills.iter().any(|n| n == name) {
            return Err(SkillMountError::AlreadyMounted {
                name: name.to_string(),
            });
        }
        self.mounted_skills.push(name.to_string());
        self.append_skill_event(SkillLifecycleEvent {
            kind: SkillLifecycleKind::Mount,
            name: name.to_string(),
            actor: None,
        });
        Ok(())
    }

    /// Unmount a skill from the session's mounted set (ADR-0086, issue #363;
    /// ADR-0110, issue #698). Appends an `Unmount` event, mutates the live
    /// caches, and persists. Refuses an unmount of a name not in the set
    /// (`NotMounted`) -- symmetric with [`Self::mount_skill`]'s
    /// redundant-mount refusal. The unmount CASCADES any activation of the
    /// name out of the live activated cache: unmount is the sole exit for an
    /// activation -- no deactivate event exists (ADR-0110 Decision 4); the
    /// activated fold reads the cascade off the same `Unmount` event.
    pub fn unmount_skill(&mut self, name: &str) -> Result<(), SkillMountError> {
        let was_present = self.mounted_skills.iter().any(|n| n == name);
        if !was_present {
            return Err(SkillMountError::NotMounted {
                name: name.to_string(),
            });
        }
        self.mounted_skills.retain(|n| n != name);
        self.activated_skills.retain(|n| n != name);
        self.append_skill_event(SkillLifecycleEvent {
            kind: SkillLifecycleKind::Unmount,
            name: name.to_string(),
            actor: None,
        });
        Ok(())
    }

    /// Activate a MOUNTED skill into the session's activated subset
    /// (ADR-0110, issue #698). Appends an `Activate` event carrying the
    /// initiation actor (the user on this IPC entry; the agent rides the same
    /// transition through [`SkillActivationCtx::land`], issue #701 -- one
    /// body, [`land_skill_activation`]), mutates the live activated-skills
    /// cache, and persists the recipe atomically.
    ///
    /// Two postures, both ADR-0110 decisions and deliberately asymmetric
    /// with the mount family:
    /// - a name NOT in the mounted set is a typed refusal
    ///   (`NotMountedForActivation`, no event) -- the activated set is a
    ///   subset of the mounted set by definition;
    /// - a REPEAT activation of an already-activated name is idempotent
    ///   success with NO second event (Decision 3) -- activation is
    ///   approval-free and zero-friction, so a duplicate is not an error the
    ///   timeline needs to record (contrast [`Self::mount_skill`], which
    ///   refuses a redundant mount so no-op Mount events never land).
    pub fn activate_skill(
        &mut self,
        name: &str,
        actor: SkillLifecycleActor,
    ) -> Result<(), SkillMountError> {
        if !self.mounted_skills.iter().any(|n| n == name) {
            return Err(SkillMountError::NotMountedForActivation {
                name: name.to_string(),
            });
        }
        if land_skill_activation(&mut self.activated_skills, &mut self.timeline, name, actor) {
            self.persist_if_bound();
        }
        Ok(())
    }

    /// Seed the folded mounted set's INITIAL state (issue #677, ADR-0109
    /// Decision 6, calibrated by ADR-0110 Decision 7): the auto-included
    /// builtin skills enter the MOUNTED fold's starting accumulator, not as
    /// events. No `Mount` event is appended, no thread timeline entry is
    /// created, nothing is persisted (the initial set is recomputed from the
    /// CURRENT config at every creation / resume). Recomputes both live
    /// caches by folding the existing timeline's skill events OVER the
    /// initial set, so an in-session unmount that the recipe recorded still
    /// wins at resume and a later manual mount folds in normally. A fresh
    /// session has an empty timeline, so the mounted fold is the initial set
    /// itself. The ACTIVATED accumulator starts empty unconditionally:
    /// builtins auto-mount but never pre-activate (discovery is free,
    /// body-injection is not -- ADR-0110 Decision 7), and a pre-activation
    /// (v5) recipe carries no `Activate` events, so it folds empty -- the
    /// honest post-resume posture, no degrade. The fold ends with the
    /// activated accumulator clamped to the mounted one: an activation
    /// whose mount basis evaporated (an auto-include builtin disabled since
    /// the last run, a dangling `Activate` in an imported recipe) degrades
    /// away with its mount, because nothing else could ever clear it
    /// (unmount refuses `NotMounted`, no deactivate exists -- ADR-0110
    /// Decision 2).
    pub fn seed_initial_skills(&mut self, initial: Vec<String>) {
        let mut mounted: Vec<String> = Vec::new();
        let mut activated: Vec<String> = Vec::new();
        for name in initial {
            if !mounted.iter().any(|n| n == &name) {
                mounted.push(name);
            }
        }
        for entry in &self.timeline {
            if let super::TimelineEntry::Skill(ev) = entry {
                match ev.kind {
                    crate::model::SkillLifecycleKind::Mount => {
                        if !mounted.iter().any(|n| n == &ev.name) {
                            mounted.push(ev.name.clone());
                        }
                    }
                    crate::model::SkillLifecycleKind::Unmount => {
                        mounted.retain(|n| n != &ev.name);
                        // The cascade: an unmount is the sole exit for an
                        // activation (ADR-0110 Decision 4).
                        activated.retain(|n| n != &ev.name);
                    }
                    crate::model::SkillLifecycleKind::Activate => {
                        if !activated.iter().any(|n| n == &ev.name) {
                            activated.push(ev.name.clone());
                        }
                    }
                }
            }
        }
        // Decision 2's subset clamp: an activation whose mount basis
        // evaporated degrades away with its mount (see the doc above).
        activated.retain(|n| mounted.iter().any(|m| m == n));
        self.mounted_skills = mounted;
        self.activated_skills = activated;
    }

    /// Append a skill lifecycle event (Mount / Unmount / Activate) to the
    /// conversation thread and atomically persist the recipe (ADR-0086,
    /// issue #363; ADR-0110, issue #698). Mirrors
    /// [`super::Session::append_source_event`]: first-class timeline slot
    /// (always visible), never a turn, never enters the LLM window.
    fn append_skill_event(&mut self, event: SkillLifecycleEvent) {
        self.timeline.push(super::TimelineEntry::Skill(event));
        // ADR-0086: a skill lifecycle operation also lands its terminal state
        // to the recipe atomically (the timeline IS the source of truth for
        // the skill sets, so changing it is a recipe mutation).
        self.persist_if_bound();
    }
}

/// The single activation transition body (ADR-0110 Decisions 4/5, issue
/// #701): push the name onto the live activated cache and append the
/// `Activate` event to the timeline, carrying the initiation actor. Returns
/// whether a FRESH event landed -- a repeat activation lands nothing
/// (idempotent, the deliberately asymmetric posture
/// [`Session::activate_skill`] documents). The persistence pairing lives
/// with the caller: the IPC method persists through `&mut self`, the
/// mid-turn [`SkillActivationCtx`] through the field-split
/// [`super::persist_snapshot`] -- one transition, two borrow shapes, zero
/// duplicated body.
fn land_skill_activation(
    activated: &mut Vec<String>,
    timeline: &mut Vec<super::TimelineEntry>,
    name: &str,
    actor: SkillLifecycleActor,
) -> bool {
    if activated.iter().any(|n| n == name) {
        return false;
    }
    activated.push(name.to_string());
    timeline.push(super::TimelineEntry::Skill(SkillLifecycleEvent {
        kind: SkillLifecycleKind::Activate,
        name: name.to_string(),
        actor: Some(actor),
    }));
    true
}

/// The mid-turn skill-activation channel the dispatch layer serves the
/// `activate_skill` meta-tool through (ADR-0110 Decision 3, issue #701):
/// field-disjoint borrows off one locked [`Session`] -- the activated cache,
/// the timeline, the persister, the runtime facts -- plus the turn's mounted
/// prompt fragments. Mirrors [`super::materializer::TurnDeps`]'s
/// disjoint-borrow construction: built at the turn boundary while the other
/// session fields are lent to `TurnDeps`, moved into the dispatch layer (the
/// yoagent dispatch server / the bridge gateway -- both runtimes share one
/// channel by construction), dropped before `record_turn` re-borrows the
/// session. The fragments are the TURN-START resolution: mounts are
/// turn-external (the agent channel is activation-only), so the snapshot is
/// the mounted set for the whole turn, and the body the tool returns is the
/// same body the system prompt would inject -- one source.
pub(crate) struct SkillActivationCtx<'a> {
    /// The turn's mounted-skill fragments, in mount order. Public read so
    /// the tool-surface assembly can mount `activate_skill` only when the
    /// set is non-empty (the trio's conditional-mounting posture,
    /// ADR-0105 Decision 6).
    pub(crate) fragments: &'a [crate::skills::SkillPromptFragment],
    activated: &'a mut Vec<String>,
    timeline: &'a mut Vec<super::TimelineEntry>,
    persister: &'a mut super::recipe_persister::RecipePersister,
    runtime_facts: &'a super::SessionRuntimeFacts,
}

impl<'a> SkillActivationCtx<'a> {
    /// Production constructor: the turn boundary's field-disjoint borrows
    /// off one locked session (the fields stay private -- only this module
    /// and its descendants may name them).
    pub(super) fn from_session(
        fragments: &'a [crate::skills::SkillPromptFragment],
        activated: &'a mut Vec<String>,
        timeline: &'a mut Vec<super::TimelineEntry>,
        persister: &'a mut super::recipe_persister::RecipePersister,
        runtime_facts: &'a super::SessionRuntimeFacts,
    ) -> Self {
        Self {
            fragments,
            activated,
            timeline,
            persister,
            runtime_facts,
        }
    }

    /// Land the agent-side activation + persist immediately (issue #701):
    /// real-time by contract -- the event reaches the timeline and the
    /// recipe atomically BEFORE the tool result returns, so a turn that
    /// later fails or is cancelled keeps the activation (the tool result
    /// already crossed into the trajectory; the exit is unmount). The actor
    /// is always `Agent` on this channel -- the user channel is the IPC
    /// command, which routes [`Session::activate_skill`] instead. The
    /// working set + temp path are the two pieces the field-split persist
    /// borrows that live inside `TurnDeps` on both dispatch faces.
    pub(crate) fn land(
        &mut self,
        name: &str,
        working_set: &mut crate::workingset::WorkingSet,
        temp_path: &std::path::Path,
    ) -> bool {
        if !land_skill_activation(
            self.activated,
            self.timeline,
            name,
            SkillLifecycleActor::Agent,
        ) {
            return false;
        }
        super::persist_snapshot(
            self.persister,
            working_set,
            temp_path,
            self.timeline,
            self.runtime_facts,
        );
        true
    }
}

/// Test scaffolding for the activation channel (issue #701): owns the state
/// a [`SkillActivationCtx`] borrows, so any crate test (not just this
/// module's descendants, which alone can name `RecipePersister`) can build a
/// channel and then read the post-state. `cfg(test)` -- production builds
/// the ctx directly at the turn boundary.
#[cfg(test)]
pub(crate) struct SkillActivationFixture {
    pub fragments: Vec<crate::skills::SkillPromptFragment>,
    pub activated: Vec<String>,
    pub timeline: Vec<super::TimelineEntry>,
    pub(super) persister: super::recipe_persister::RecipePersister,
    pub facts: super::SessionRuntimeFacts,
}

#[cfg(test)]
impl SkillActivationFixture {
    pub(crate) fn new(fragments: Vec<crate::skills::SkillPromptFragment>) -> Self {
        Self {
            fragments,
            activated: Vec::new(),
            timeline: Vec::new(),
            persister: super::recipe_persister::RecipePersister::new(),
            facts: super::SessionRuntimeFacts::default(),
        }
    }

    /// Borrow the fixture as the channel the dispatch layer takes. The
    /// borrow lasts as long as the returned ctx -- inline it in the call:
    /// `resolve_skill_activation(call, &mut fx.ctx(), ...)`.
    pub(crate) fn ctx(&mut self) -> SkillActivationCtx<'_> {
        SkillActivationCtx {
            fragments: &self.fragments,
            activated: &mut self.activated,
            timeline: &mut self.timeline,
            persister: &mut self.persister,
            runtime_facts: &self.facts,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ThreadEntry;
    use crate::session::Session;

    /// A fresh session mounts nothing: the live cache is empty and the fold
    /// over the (empty) timeline yields the empty set.
    #[test]
    fn fresh_session_has_no_mounted_skills() {
        let session = Session::new().expect("session");
        assert!(session.mounted_skills().is_empty());
    }

    /// mount_skill adds the name to the live cache AND lands a Mount event on
    /// the timeline. Both stay in sync.
    #[test]
    fn mount_skill_adds_to_live_cache_and_timeline() {
        let mut session = Session::new().expect("session");
        session.mount_skill("sql-coach").expect("mount");
        assert_eq!(session.mounted_skills(), vec!["sql-coach".to_string()]);
        // The timeline's tail is the Mount event.
        let conv = session.conversation();
        let last = conv.last().expect("history non-empty");
        match last {
            ThreadEntry::Skill(ev) => {
                assert_eq!(ev.kind, SkillLifecycleKind::Mount);
                assert_eq!(ev.name, "sql-coach");
            }
            other => panic!("expected Skill event, got {other:?}"),
        }
    }

    /// A redundant mount is refused so the timeline stays free of no-op events.
    #[test]
    fn mount_skill_redundant_is_refused() {
        let mut session = Session::new().expect("session");
        session.mount_skill("sql-coach").expect("first mount");
        let err = session.mount_skill("sql-coach").unwrap_err();
        assert!(
            matches!(err, SkillMountError::AlreadyMounted { ref name } if name == "sql-coach"),
            "expected AlreadyMounted, got {err:?}",
        );
        // The cache + timeline are unchanged (no second event appended).
        assert_eq!(session.mounted_skills(), vec!["sql-coach".to_string()]);
        assert_eq!(session.conversation().len(), 1);
    }

    /// unmount_skill removes the name from the live cache AND lands an Unmount
    /// event; the fold then yields the empty set.
    #[test]
    fn unmount_skill_removes_from_live_cache_and_lands_event() {
        let mut session = Session::new().expect("session");
        session.mount_skill("sql-coach").expect("mount");
        session.unmount_skill("sql-coach").expect("unmount");
        assert!(session.mounted_skills().is_empty());
        // Two events: Mount then Unmount.
        assert_eq!(session.conversation().len(), 2);
        match &session.conversation()[1] {
            ThreadEntry::Skill(ev) => {
                assert_eq!(ev.kind, SkillLifecycleKind::Unmount);
                assert_eq!(ev.name, "sql-coach");
            }
            other => panic!("expected Skill event, got {other:?}"),
        }
    }

    /// An unmount of a name not in the set is refused (no no-op event).
    #[test]
    fn unmount_skill_unknown_is_refused() {
        let mut session = Session::new().expect("session");
        let err = session.unmount_skill("sql-coach").unwrap_err();
        assert!(
            matches!(err, SkillMountError::NotMounted { ref name } if name == "sql-coach"),
            "expected NotMounted, got {err:?}",
        );
        assert!(
            session.conversation().is_empty(),
            "no event appended on refusal"
        );
    }

    /// The mount -> unmount -> remount sequence (AC #3): the live cache ends
    /// with the remounted name, and the timeline carries all three events so
    /// the recipe fold yields the same set.
    #[test]
    fn mount_unmount_remount_round_trip() {
        let mut session = Session::new().expect("session");
        session.mount_skill("sql-coach").expect("mount");
        session.unmount_skill("sql-coach").expect("unmount");
        session.mount_skill("sql-coach").expect("remount");
        assert_eq!(session.mounted_skills(), vec!["sql-coach".to_string()]);
        // The recipe fold matches the live cache (the timeline IS the source
        // of truth).
        let recipe = session.build_recipe();
        assert_eq!(recipe.mounted_skills(), vec!["sql-coach".to_string()]);
    }

    /// First-mount insertion order survives a later unmount of an earlier
    /// entry, so the assembly sequence reads deterministically.
    #[test]
    fn mounted_skills_preserves_first_mount_order() {
        let mut session = Session::new().expect("session");
        session.mount_skill("a").expect("mount a");
        session.mount_skill("b").expect("mount b");
        session.unmount_skill("a").expect("unmount a");
        assert_eq!(session.mounted_skills(), vec!["b".to_string()]);
    }

    /// Auto-include (issue #677): the initial set seeds the fold without
    /// events; a recorded in-session Unmount still wins over the initial
    /// set; a later manual Mount folds in normally.
    #[test]
    fn seed_initial_skills_folds_events_over_the_initial_set() {
        let mut session = Session::new().expect("session");
        session.mount_skill("auto-a").expect("mount");
        session.unmount_skill("auto-a").expect("unmount");
        session.mount_skill("user-b").expect("mount");
        session.seed_initial_skills(vec![
            "auto-a".to_string(),
            "auto-c".to_string(),
            "auto-a".to_string(), // deduped
        ]);
        // auto-a: the recorded Unmount removed it; user-b survives; auto-c
        // joins via the initial set.
        assert_eq!(
            session.mounted_skills(),
            vec!["auto-c".to_string(), "user-b".to_string()]
        );
        // No new timeline entries: the conversation still holds exactly the
        // three events the manual actions wrote.
        assert_eq!(session.conversation().len(), 3);
        // The unmount of an initial-set member works through the normal
        // event path (the live cache carries it).
        session.unmount_skill("auto-c").expect("unmount");
        assert_eq!(session.mounted_skills(), vec!["user-b".to_string()]);
    }

    /// A fresh session's fold is the initial set itself (empty timeline).
    #[test]
    fn seed_initial_skills_on_a_fresh_session_is_the_initial_set() {
        let mut session = Session::new().expect("session");
        session.seed_initial_skills(vec!["pandoc".to_string(), "python".to_string()]);
        assert_eq!(
            session.mounted_skills(),
            vec!["pandoc".to_string(), "python".to_string()]
        );
        assert!(session.conversation().is_empty(), "no timeline entry");
    }

    /// ADR-0110 (issue #698): a fresh session activates nothing -- the live
    /// cache is empty and the fold over the (empty) timeline is empty.
    #[test]
    fn fresh_session_has_no_activated_skills() {
        let session = Session::new().expect("session");
        assert!(session.activated_skills().is_empty());
    }

    /// Activating a name not in the mounted set is a typed refusal with NO
    /// event (the activated set is a subset of the mounted set, ADR-0110
    /// Decision 2).
    #[test]
    fn activate_skill_not_mounted_is_refused_without_event() {
        let mut session = Session::new().expect("session");
        let err = session
            .activate_skill("sql-coach", SkillLifecycleActor::User)
            .unwrap_err();
        assert!(
            matches!(
                err,
                SkillMountError::NotMountedForActivation { ref name } if name == "sql-coach"
            ),
            "expected NotMountedForActivation, got {err:?}",
        );
        assert!(
            session.conversation().is_empty(),
            "no event appended on refusal"
        );
        assert!(session.activated_skills().is_empty());
    }

    /// activate_skill adds the name to the live activated cache AND lands an
    /// `Activate` event carrying the user actor on the timeline (issue #698
    /// records the user actor only; the agent channel rides #701).
    #[test]
    fn activate_skill_adds_to_live_cache_and_lands_user_actor_event() {
        let mut session = Session::new().expect("session");
        session.mount_skill("sql-coach").expect("mount");
        session
            .activate_skill("sql-coach", SkillLifecycleActor::User)
            .expect("activate");
        assert_eq!(session.activated_skills(), vec!["sql-coach".to_string()]);
        match session.conversation().last().expect("event") {
            ThreadEntry::Skill(ev) => {
                assert_eq!(ev.kind, SkillLifecycleKind::Activate);
                assert_eq!(ev.name, "sql-coach");
                assert_eq!(ev.actor, Some(crate::model::SkillLifecycleActor::User));
            }
            other => panic!("expected Skill event, got {other:?}"),
        }
    }

    /// A repeat activation is idempotent SUCCESS with no second event
    /// (ADR-0110 Decision 3) -- deliberately asymmetric with the refused
    /// redundant mount (see `mount_skill_redundant_is_refused`).
    #[test]
    fn activate_skill_repeat_is_idempotent_success_without_second_event() {
        let mut session = Session::new().expect("session");
        session.mount_skill("sql-coach").expect("mount");
        session
            .activate_skill("sql-coach", SkillLifecycleActor::User)
            .expect("first activate");
        session
            .activate_skill("sql-coach", SkillLifecycleActor::User)
            .expect("repeat activate succeeds");
        // The timeline still holds exactly Mount + Activate -- no duplicate.
        assert_eq!(session.conversation().len(), 2);
        assert_eq!(session.activated_skills(), vec!["sql-coach".to_string()]);
    }

    /// An unmount cascades the deactivation: both live caches drop the name,
    /// and the recipe folds agree (unmount is the sole activation exit --
    /// no deactivate event exists, ADR-0110 Decision 4).
    #[test]
    fn unmount_cascades_deactivation_live_and_fold() {
        let mut session = Session::new().expect("session");
        session.mount_skill("sql-coach").expect("mount");
        session
            .activate_skill("sql-coach", SkillLifecycleActor::User)
            .expect("activate");
        session.unmount_skill("sql-coach").expect("unmount");
        assert!(session.mounted_skills().is_empty());
        assert!(
            session.activated_skills().is_empty(),
            "the unmount cascades the activation out",
        );
        // Three events: Mount, Activate, Unmount -- no fourth (deactivate)
        // event exists.
        assert_eq!(session.conversation().len(), 3);
        let recipe = session.build_recipe();
        assert!(recipe.mounted_skills().is_empty());
        assert!(recipe.activated_skills().is_empty());
    }

    /// The AC's `mount -> activate -> unmount` sequence: the live activated
    /// cache and the recipe fold both end empty, and the fold matches the
    /// live memoization (the timeline IS the source of truth).
    #[test]
    fn mount_activate_unmount_folds_to_empty_activated_set() {
        let mut session = Session::new().expect("session");
        session.mount_skill("sql-coach").expect("mount");
        session
            .activate_skill("sql-coach", SkillLifecycleActor::User)
            .expect("activate");
        session.unmount_skill("sql-coach").expect("unmount");
        let recipe = session.build_recipe();
        assert_eq!(
            recipe.activated_skills(),
            session.activated_skills(),
            "the recipe fold matches the live cache",
        );
        assert!(recipe.activated_skills().is_empty());
    }

    /// The activated set stays a subset of the mounted set: first-activation
    /// order is preserved, and an activation of one name does not activate
    /// its mounted sibling.
    #[test]
    fn activated_skills_stay_subset_of_mounted_in_activation_order() {
        let mut session = Session::new().expect("session");
        session.mount_skill("a").expect("mount a");
        session.mount_skill("b").expect("mount b");
        session
            .activate_skill("b", SkillLifecycleActor::User)
            .expect("activate b");
        session
            .activate_skill("a", SkillLifecycleActor::User)
            .expect("activate a");
        assert_eq!(
            session.activated_skills(),
            vec!["b".to_string(), "a".to_string()],
            "first-activation order, b before a",
        );
        assert_eq!(
            session.mounted_skills(),
            vec!["a".to_string(), "b".to_string()],
            "mount order is untouched",
        );
    }

    /// seed_initial_skills seeds the MOUNTED fold only: the auto-included
    /// initial set never pre-activates (ADR-0110 Decision 7), while
    /// recorded Activate / Unmount events fold into the activated cache
    /// exactly as the recipe fold reads them.
    #[test]
    fn seed_initial_skills_seeds_mounts_but_never_activations() {
        let mut session = Session::new().expect("session");
        session.mount_skill("auto-a").expect("mount");
        session
            .activate_skill("auto-a", SkillLifecycleActor::User)
            .expect("activate");
        session.mount_skill("auto-b").expect("mount b");
        session
            .activate_skill("auto-b", SkillLifecycleActor::User)
            .expect("activate b");
        session.unmount_skill("auto-b").expect("unmount b");
        session.seed_initial_skills(vec!["auto-a".to_string(), "auto-c".to_string()]);
        // auto-a: mounted via seed + activated via its recorded event;
        // auto-b: unmounted (event) and its activation cascaded out;
        // auto-c: mounted via seed but NEVER activated.
        assert_eq!(
            session.mounted_skills(),
            vec!["auto-a".to_string(), "auto-c".to_string()]
        );
        assert_eq!(session.activated_skills(), vec!["auto-a".to_string()]);
    }

    /// The subset clamp: an auto-include builtin seeds mounted with no Mount
    /// event, so a recorded Activate can outlive its mount basis once the
    /// tool is disabled before a resume -- the refold drops the activation
    /// with its evaporated mount (ADR-0110 Decision 2) instead of leaving an
    /// un-clearable phantom (unmount would refuse NotMounted, and no
    /// deactivate exists).
    #[test]
    fn seed_refold_drops_an_activation_whose_mount_basis_evaporated() {
        let mut session = Session::new().expect("session");
        // The auto-include posture at creation: pandoc seeds mounted (no
        // Mount event) and the user activates it.
        session.seed_initial_skills(vec!["pandoc".to_string()]);
        session
            .activate_skill("pandoc", SkillLifecycleActor::User)
            .expect("activate");
        assert_eq!(session.activated_skills(), vec!["pandoc".to_string()]);
        // The tool is disabled before the resume: the initial set is empty
        // now, and the recorded Activate has no mount backing left.
        session.seed_initial_skills(Vec::new());
        assert!(session.mounted_skills().is_empty());
        assert!(
            session.activated_skills().is_empty(),
            "the activation degrades away with its evaporated mount basis",
        );
    }

    /// A remount after the cascade does NOT resurrect the activation: unmount
    /// is the sole activation exit, so the fresh mount starts
    /// discoverable-but-inactive (ADR-0110 Decision 4) -- on the live caches
    /// and on both recipe folds.
    #[test]
    fn remount_after_unmount_does_not_resurrect_the_activation() {
        let mut session = Session::new().expect("session");
        session.mount_skill("a").expect("mount");
        session
            .activate_skill("a", SkillLifecycleActor::User)
            .expect("activate");
        session.unmount_skill("a").expect("unmount");
        session.mount_skill("a").expect("remount");
        assert_eq!(session.mounted_skills(), vec!["a".to_string()]);
        assert!(
            session.activated_skills().is_empty(),
            "the remount is discovery-only; only an explicit Activate re-enters",
        );
        assert_eq!(
            session.conversation().len(),
            4,
            "Mount, Activate, Unmount, Mount -- no deactivate anywhere",
        );
        let recipe = session.build_recipe();
        assert_eq!(recipe.mounted_skills(), vec!["a".to_string()]);
        assert!(recipe.activated_skills().is_empty());
    }
}
