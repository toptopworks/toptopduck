//! Session-side skill state (ADR-0119, issues #983/#984): the discovery
//! snapshot, the session-invoked fold, and the submit-time materialization of
//! the user's staged invocations. Activation is retired -- a skill's body
//! enters the conversation once per invocation (the user channel expands it
//! into the turn's input ahead of the question; the agent channel is the
//! `invoke_skill` meta-tool) and then persists on the turn record; there is
//! no session-level skill state left to mutate.
//!
//! The impl block is a sibling of the one in `session/mod.rs`: Rust lets a
//! descendant module add methods to a type defined in the ancestor and reach
//! its private fields. The session owns two skill stores: the immutable
//! discovery snapshot (dual-stored on the session and the persister, set
//! once at creation / resume) and the monotonic invoked fold (grown by
//! `record_turn`, re-folded at resume).

use crate::model::SkillLifecycleActor;

impl super::Session {
    /// The session's discovery snapshot (ADR-0119 Decision 3, issue #983):
    /// the enabled set at session creation, immutable within the session.
    /// Cloned so the production read (the command layer's turn assembly)
    /// takes an owned vec without holding the session borrow open.
    pub fn discovery_snapshot(&self) -> Vec<String> {
        // The dual storage is set-once by convention, not by type (issue
        // #989 F): one setter writes both stores, and this debug check trips
        // at the first read if a future session-construction path ever
        // writes a field directly -- that path's persist would otherwise
        // write an empty header (skip_serializing_if drops the key
        // entirely), and every later resume would SILENTLY open with an
        // empty snapshot, refusing every invoke_skill for that session's
        // life -- a capability loss with no failure signal, worse than a
        // refusal to open. Collapsing to a single store is not possible
        // here: the invocation channel reads the session-side copy while
        // the resume path holds the persister across the header write, so
        // the persister cannot be the sole owner.
        debug_assert_eq!(
            self.discovery_snapshot,
            self.persister.discovery_snapshot(),
            "the dual discovery-snapshot stores drifted (set_discovery_snapshot is the only writer)",
        );
        self.discovery_snapshot.clone()
    }

    /// Materialize the discovery snapshot (ADR-0119 Decision 3): called at
    /// session creation (off the enabled-set computation) and at resume
    /// adoption (from the recipe header). No other writer exists;
    /// immutability is by construction.
    pub fn set_discovery_snapshot(&mut self, names: Vec<String>) {
        // Dedupe defensively in order (the seed computation is already
        // unique; this only guards a hypothetical future duplicate).
        let mut seen = Vec::new();
        for name in &names {
            crate::util::push_unique(&mut seen, name);
        }
        self.discovery_snapshot = seen.clone();
        // The persister layers the same snapshot onto every recipe build
        // (#987 F): one set point feeds both stores -- immutable within the
        // session, so no drift surface today (the accessor's debug check
        // guards a future direct-write path).
        self.persister.set_discovery_snapshot(seen);
    }

    /// The session-INVOKED skill names (ADR-0119 Decision 4, issue #983), in
    /// first-invocation insertion order -- a monotonic fold of the timeline's
    /// turn invocation records. Cloned for the lock-free command layer.
    pub fn invoked_skills(&self) -> Vec<String> {
        self.invoked_skills.clone()
    }

    /// Materialize the user's submit-time skill invocations (ADR-0119
    /// Decision 1; the ADR-0112 picker channel's calibrated continuation):
    /// resolve each staged name against the registry NOW so the body +
    /// content_hash pin the invocation-time bytes. The records ride the turn
    /// -- the window renders the bodies ahead of the question and the turn
    /// persists them. A name the registry cannot serve degrades to an
    /// empty-body record (the invocation still happened; honest degrade),
    /// never a refusal. A DISABLED name (ADR-0119 Decision 3: the invocation
    /// eligibility gate is the enable axis, both actors) lands the same
    /// empty-body record -- the picker filters at pick time and the axis is
    /// read at submit, so a plain sequence reaches this arm: pick while
    /// enabled, disable in settings, come back, submit. The name stays
    /// visible (the badge reads the attempt, the turn's history keeps it)
    /// while the empty body keeps the gate's meaning -- nothing enters the
    /// context -- and the empty hash exempts the record from the drift
    /// check; the read gate crosses the same axis, so the record never
    /// opens the attachment surface. The drop-shaped degrade this arm
    /// replaces was silent on the frontend (review Important 2, #991). The
    /// agent channel's identical case answers with a self-correcting
    /// refusal. Staged names dedupe order-preservingly BEFORE the map
    /// (review Important 3, issue #983): a duplicated stage is one
    /// invocation -- the byte-rendering consumer has no set semantics to
    /// absorb a duplicate, so it collapses here, at the source.
    pub fn materialize_user_invocations(
        &self,
        names: &[String],
        root: &std::path::Path,
        disabled: &[String],
    ) -> Vec<crate::model::SkillInvocation> {
        let mut staged: Vec<String> = Vec::new();
        for name in names {
            crate::util::push_unique(&mut staged, name);
        }
        let mut records = Vec::new();
        for name in &staged {
            if disabled.iter().any(|d| d == name) {
                log::warn!(
                    target: "skills",
                    "staged skill `{name}` is disabled on the enable axis -- \
                     recording the name, serving no body",
                );
                // The unreadable-file degrade shape (resolve_one's ladder):
                // name lands, body and hash stay empty. The read gate's
                // disabled cross keeps the attempt from opening files.
                records.push(crate::model::SkillInvocation {
                    name: name.clone(),
                    body: String::new(),
                    actor: SkillLifecycleActor::User,
                    content_hash: String::new(),
                });
                continue;
            }
            let fragment = crate::skills::prompt::resolve_one(root, name);
            records.push(crate::model::SkillInvocation::from_fragment(
                &fragment,
                SkillLifecycleActor::User,
            ));
        }
        records
    }
}

/// The turn-scoped skill state bundle (issue #989 D): the turn's
/// accumulating invocation records + the turn-start invoked-set snapshot --
/// one construction at the submit boundary, shared by both runtime faces
/// (the built-in loop and the external gateway) and consumed by value at
/// the `record_turn` call site. The pair is one turn-scope concern -- the pending
/// accumulation and the eligibility set its records feed -- so they travel
/// as one parameter instead of growing `run_external_turn`'s orchestration
/// signature one invocation-semantics feature at a time.
pub(crate) struct SkillTurnState<'a> {
    /// The in-flight turn's accumulating invocation records: the user's
    /// submit-time materialization starts the vec, the agent's
    /// `invoke_skill` calls append mid-turn through the invocation channel,
    /// and the whole lands on the turn record at `record_turn` (via
    /// [`Self::into_pending`]).
    pub(crate) pending: &'a mut Vec<crate::model::SkillInvocation>,
    /// The turn-start invoked-set snapshot (ADR-0119 Decision 4): the read
    /// gate's eligibility + the read-tool mount read this -- immutable for
    /// the turn's duration (an agent's mid-turn invoke joins the NEXT
    /// turn's snapshot).
    pub(crate) start_invoked: &'a [String],
}

impl<'a> SkillTurnState<'a> {
    /// Drain the pending records for the turn's record: the `record_turn`
    /// call site consumes the bundle by value and the borrowed vec cannot
    /// move out of it, so the take drains the caller's accumulation into
    /// an owned vec.
    pub(crate) fn into_pending(self) -> Vec<crate::model::SkillInvocation> {
        std::mem::take(self.pending)
    }
}

impl<'a> crate::skills::invocation::SkillInvocationCtx<'a> {
    /// Production constructor: pins the wiring shared by both runtime faces
    /// -- the built-in loop and the external gateway channel their
    /// invocation records through this one site, so the registry root /
    /// enable axis / discovery snapshot cannot drift between the two (the
    /// one-constructor posture, issue #707). The pending vec is the turn's
    /// own accumulation, borrowed by the caller.
    pub(crate) fn from_session(
        pending: &'a mut Vec<crate::model::SkillInvocation>,
        snapshot: &'a [String],
        inputs: &super::TurnInputs<'a>,
    ) -> Self {
        Self {
            pending,
            snapshot,
            root: inputs.skills_root,
            disabled: inputs.disabled_skills,
        }
    }
}

#[cfg(test)]
mod tests {
    /// F (#989): the accessor's debug consistency check trips when the dual
    /// stores drift -- a future direct-write path (a session constructor
    /// bypassing the setter) surfaces at the first read instead of
    /// persisting an empty header. Debug-builds only: the check compiles
    /// away under release, so the pin sits behind cfg(debug_assertions).
    #[cfg(debug_assertions)]
    #[test]
    fn discovery_snapshot_accessor_trips_on_dual_store_drift() {
        let mut session = super::super::Session::new().expect("session");
        session.set_discovery_snapshot(vec!["sql-coach".to_string()]);
        // Simulate the drift: the persister copy re-set without the
        // session's.
        session
            .persister
            .set_discovery_snapshot(vec!["other".to_string()]);
        let tripped = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            session.discovery_snapshot();
        }));
        assert!(
            tripped.is_err(),
            "the debug consistency check trips on dual-store drift",
        );
    }

    /// I3 (#987 review): the from_session constructor wires ALL four inputs
    /// through -- a wiring break (an empty disabled list, a wrong root)
    /// survives the rest of the suite because every other TurnInputs
    /// literal stages an empty disabled list, so this pin is the enable
    /// axis's only observer at the seam.
    #[test]
    fn invocation_ctx_from_session_wires_all_four_inputs() {
        let keychain = crate::provider::keychain::KeychainStore::new();
        let mut inputs = crate::session::TurnInputs::empty(&keychain);
        let disabled = vec!["ghosted".to_string()];
        let root = std::path::PathBuf::from("registry-root");
        inputs.disabled_skills = &disabled;
        inputs.skills_root = &root;
        let snapshot = vec!["sql-coach".to_string()];
        let mut pending = Vec::new();
        let ctx = crate::skills::invocation::SkillInvocationCtx::from_session(
            &mut pending,
            &snapshot,
            &inputs,
        );
        assert_eq!(
            ctx.disabled,
            disabled.as_slice(),
            "the enable axis wires through",
        );
        assert_eq!(ctx.root, root.as_path(), "the registry root wires through");
        assert_eq!(
            ctx.snapshot,
            snapshot.as_slice(),
            "the discovery snapshot wires through",
        );
        ctx.pending.push(crate::model::SkillInvocation {
            name: "sql-coach".to_string(),
            body: String::new(),
            actor: crate::model::SkillLifecycleActor::Agent,
            content_hash: String::new(),
        });
        assert_eq!(pending.len(), 1, "the pending vec is the caller's own");
    }

    /// Review Important 2 (#991): a staged name disabled between pick and
    /// submit lands the honest-degrade record -- the attempt stays visible
    /// (the badge reads the name, the turn's history keeps it) while the
    /// empty body keeps the enable-axis gate's meaning (nothing enters the
    /// context) and the empty hash exempts the record from the drift check.
    /// The pre-fix drop was silent on the frontend; this pin holds the
    /// landed shape.
    #[test]
    fn disabled_staged_name_lands_an_empty_body_record() {
        let session = super::super::Session::new().expect("session");
        let tmp = tempfile::tempdir().unwrap();
        let disabled = vec!["ghosted".to_string()];
        let records =
            session.materialize_user_invocations(&["ghosted".to_string()], tmp.path(), &disabled);
        assert_eq!(records.len(), 1, "the attempt lands a record");
        assert_eq!(records[0].name, "ghosted");
        assert_eq!(records[0].body, "", "no body crosses the enable-axis gate");
        assert_eq!(
            records[0].content_hash, "",
            "no drift anchor for the attempt"
        );
        assert_eq!(records[0].actor, crate::model::SkillLifecycleActor::User);
    }
}
