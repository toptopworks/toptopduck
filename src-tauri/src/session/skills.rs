//! Skill lifecycle I/O orchestration on [`Session`] (ADR-0086, issue #363).
//!
//! These are the methods that mutate the session's active skill set: mount
//! (add) and unmount (remove). They are a physical move out of
//! `session/mod.rs` for locality -- NOT a deep module (mirrors the
//! [`super::source_lifecycle`] split). The active set is FOLDED from the
//! timeline's Mount/Unmount sequence ([`Recipe::mounted_skills`]), never
//! snapshotted into the recipe; the live [`Session::mounted_skills`] field is
//! a memoization that stays in sync because every event append + cache update
//! happens together here.
//!
//! The impl block is a sibling of the one in `session/mod.rs`: Rust lets a
//! descendant module add methods to a type defined in the ancestor and reach
//! its private fields and helpers (`persist_if_bound`). The reverse direction
//! is NOT allowed: the parent cannot call [`Session::append_skill_event`], so
//! it stays private to this module (today mount/unmount are the sole callers,
//! and no ancestor path records Skill events -- contrast [`Session::
//! append_source_event`], which IS `pub(super)` because the add-path helpers
//! in `session/mod.rs` call it from the parent).
//!
//! [`Recipe::mounted_skills`]: crate::persistence::recipe::Recipe::mounted_skills

use crate::model::{SkillLifecycleEvent, SkillLifecycleKind, ThreadEntry};

/// Why a skill mount / unmount was refused (issue #363). Mirrors the typed-
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
        self.append_skill_event(SkillLifecycleKind::Mount, name);
        Ok(())
    }

    /// Unmount a skill from the session's active set (ADR-0086, issue #363).
    /// Appends an `Unmount` event, mutates the live cache, and persists.
    /// Refuses an unmount of a name not in the set (`NotMounted`) -- symmetric
    /// with [`Self::mount_skill`]'s redundant-mount refusal.
    pub fn unmount_skill(&mut self, name: &str) -> Result<(), SkillMountError> {
        let was_present = self.mounted_skills.iter().any(|n| n == name);
        if !was_present {
            return Err(SkillMountError::NotMounted {
                name: name.to_string(),
            });
        }
        self.mounted_skills.retain(|n| n != name);
        self.append_skill_event(SkillLifecycleKind::Unmount, name);
        Ok(())
    }

    /// Append a skill lifecycle event (Mount / Unmount) to the conversation
    /// thread and atomically persist the recipe (ADR-0086, issue #363).
    /// Mirrors [`super::Session::append_source_event`]: first-class timeline
    /// slot (always visible), never a turn, never enters the LLM window.
    fn append_skill_event(&mut self, kind: SkillLifecycleKind, name: &str) {
        self.history.push(ThreadEntry::Skill(SkillLifecycleEvent {
            kind,
            name: name.to_string(),
        }));
        // Keep turn_audit index-aligned with history (ADR-0078, issue #319):
        // a skill event is not a turn, so its audit slot is a default.
        self.turn_audit.push(super::TurnAudit::default());
        // ADR-0086: a skill lifecycle operation also lands its terminal state
        // to the recipe atomically (the timeline IS the source of truth for
        // the active set, so changing it is a recipe mutation).
        self.persist_if_bound();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        let last = session.history.last().expect("history non-empty");
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
        assert_eq!(session.history.len(), 1);
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
        assert_eq!(session.history.len(), 2);
        match &session.history[1] {
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
        assert!(session.history.is_empty(), "no event appended on refusal");
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
}
