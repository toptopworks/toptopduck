//! The turn entry species (issue #1414): the session-side turn entry
//! [`SessionHandle::run_turn`], in the domain-side + injected-callback
//! shape `open_recipe` already validated. The `ask` command handler builds
//! the transport-bound halves -- the pure data ([`TurnDeps`]) and the
//! ports ([`TurnPorts`], approval + the three Tauri closures) -- and calls
//! this entry from its blocking window, so the orchestration itself
//! (mirror pair -> assembly -> turn -> mirror-back -> scope grant) is
//! testable against a bare handle with zero Tauri types: "the Session
//! stays AppHandle-free" (ADR-0029) is a structural guarantee here, not a
//! comment convention. The lock window and call order are the ask
//! handler's former ones, verbatim: the handle's runtime/posture slot
//! lock is taken inside the session lock (lock-light inside lock-heavy,
//! issue #600), and the scope grant rides the same held window at the
//! same position -- deliberately post-turn, pre-unlock.

use std::path::{Path, PathBuf};

use crate::approval::{ApprovalSink, ApprovalState};
use crate::mcp::config::McpServerConfig;
use crate::model::{TurnOutcome, TurnPhase};
use crate::provider::live_config::LiveProviderConfig;
use crate::session::store::{SessionError, SessionHandle};
use crate::skills::{resolve_prompt_fragments, SkillPromptFragment};

use super::{turn_runner::TurnInputs, Session};

/// The command-boundary pure data [`SessionHandle::run_turn`] consumes
/// (issue #1414): the live provider config handle (skill/CLI/agent
/// enablement + the keychain), the per-turn MCP enablement snapshot
/// (ADR-0106), and the two registry roots. Owned plain data, built at the
/// command boundary and moved into the blocking window. The snapshot and
/// the roots are resolved before the window; the enablement itself is
/// loaded by the entry's assembly under the held session lock, as the
/// former command body did (ADR-0086 reads both session sets there).
pub struct TurnDeps {
    pub live: LiveProviderConfig,
    pub mcp_servers: Vec<McpServerConfig>,
    pub skills_root: PathBuf,
    pub agents_root: PathBuf,
}

/// The grant port's callback shape: the thread's manifest-referenced paths
/// (ADR-0137 Decision 6), handed over once at the turn's settle.
pub type GrantScopeFn = Box<dyn Fn(&[PathBuf]) + Send>;

/// The transport-injected ports [`SessionHandle::run_turn`] consumes
/// (issue #1414): the session's tiered-approval gateway halves (ADR-0080/
/// #0083 -- the store-attached [`ApprovalState`] the
/// `respond_tool_approval` command wakes, and the card-emitting
/// [`ApprovalSink`]), plus the three boundary callbacks: `on_phase`
/// (`turn-progress`), `on_named` (the first-question auto-name push,
/// issue #1353), and `grant_scope` (the asset-protocol allowlist widen,
/// ADR-0124 / ADR-0137 Decision 6). The callbacks are boxed so the entry's
/// signature stays fixed while the command layer owns their Tauri bodies;
/// nothing here names a Tauri type.
pub struct TurnPorts<'a> {
    pub approval: &'a ApprovalState,
    pub sink: &'a dyn ApprovalSink,
    pub on_phase: Box<dyn FnMut(TurnPhase) + Send>,
    pub on_named: Box<dyn FnOnce(&str) + Send>,
    pub grant_scope: GrantScopeFn,
}

impl SessionHandle {
    /// Run one full turn at the session side (issue #1414): mirror the
    /// handle-held runtime/posture choice in, assemble the turn inputs,
    /// execute the turn, mirror the discovered catalog back, and widen the
    /// asset-protocol scope over the thread's referenced files. The lock
    /// window and call order are the `ask` handler's former ones,
    /// verbatim.
    pub fn run_turn(
        &self,
        question: &str,
        skill_invocations: &[String],
        deps: &TurnDeps,
        ports: TurnPorts<'_>,
    ) -> Result<TurnOutcome, SessionError> {
        let mut s = self.session_lock()?;
        // Issue #353 + ADR-0095: feed the session's runtime choice and the
        // session-level model + thought-level pair into the turn's dispatch
        // at the turn boundary. Both live on the handle (lock-light writes
        // via set_session_runtime / set_session_posture); the Session consumes
        // them for THIS turn only -- a switch lands between turns, never
        // mid-turn, and a resumed Session reads the restored choice. The
        // combined read takes the one slot lock (issue #600), so the pair
        // the turn consumes is namespaced by the runtime it runs on.
        let (external_runtime, external_posture) = self.runtime_and_posture();
        s.set_external_runtime(external_runtime);
        s.set_external_model_config(external_posture);
        // Issue #364 (ADR-0086) + #707: the skill + CLI assembly reads both
        // session sets under this held lock (neither can change between the
        // read and the turn) and wires `TurnInputs` in one seam -- see
        // [`assemble_turn_inputs`].
        let assembled = assemble_turn_inputs(
            &s,
            &deps.skills_root,
            &deps.agents_root,
            &deps.live,
            skill_invocations,
        );
        let inputs = assembled.turn_inputs(&deps.mcp_servers);
        let outcome = s.ask_with_phase_and_auto_name(
            question,
            ports.approval,
            ports.sink,
            ports.on_phase,
            ports.on_named,
            &inputs,
        );
        // ADR-0095: mirror the turn's discovered runtime catalog onto the
        // handle (lock-light reads for the selector). An ACP turn reports
        // the handshake catalog and a ClaudeStreamJson turn reports the
        // `system{init}` current model (ADR-0097 Decision 5 honest
        // rendering); the built-in / CodexEventStream `None` means "no
        // discovery", so the mirror is skipped and the previous cache
        // survives (issue #530 made the None arm unrepresentable at the
        // setter).
        if let Some(discovered) = s.last_discovered_runtime() {
            self.set_cached_discovered(discovered);
        }
        // ADR-0124 (issue #1087), tightened to a file-level allowlist by
        // ADR-0137 Decision 6 (#1383): the turn's manifest entries widen
        // the asset protocol scope right here, before any card can render
        // -- the files named this turn may not have existed when the
        // session opened. Deliberately inside the held window (issue #1414
        // froze the ask handler's former position; the grant takes no lock
        // the session gate orders against, but the reordering is not this
        // ticket's to make).
        (ports.grant_scope)(&s.referenced_artifact_paths());
        Ok(outcome)
    }
}

/// The turn-boundary skill + CLI assembly's owning buffers (issue #364/
/// ADR-0086; the seam itself is issue #707): the data behind `TurnInputs`'s
/// borrowed fields. `run_turn` calls [`assemble_turn_inputs`] under the
/// held session lock, then borrows through [`Self::turn_inputs`] -- the
/// two-step shape exists because a `TurnInputs` borrows its buffers, so the
/// owning values must be built first and outlive the borrowed view: no Rust
/// signature can return a value and a borrow of that value as one tuple.
/// The keychain rides here as a borrowed field (taken from `live` at
/// assembly time) so the projection carries no source-config re-passes.
struct AssembledTurnInputs<'a> {
    skills: Vec<SkillPromptFragment>,
    /// The user's submit-time invocations (ADR-0119, issue #983), resolved
    /// under the held session lock so the bodies + hashes pin the submit-time
    /// bytes.
    user_invocations: Vec<crate::model::SkillInvocation>,
    /// The machine-level disabled skill names (ADR-0118 enable axis): the
    /// `invoke_skill` gate reads them mid-turn.
    disabled_skills: Vec<String>,
    /// The registry root borrow (ADR-0111, issue #714): the turn's read
    /// surface resolves skill names against it live, mid-turn.
    skills_root: &'a Path,
    /// The live-config handle (ADR-0122 Decision 1): the `create_skill`
    /// mint's composite needs the config write. Always `Some` from the
    /// command boundary; the turn-input view keeps the `None` escape for
    /// config-less test sessions.
    live_config: Option<&'a LiveProviderConfig>,
    cli_tools: Vec<crate::cli_tools::config::CliToolConfig>,
    /// The turn's delegation snapshot (issue #933, ADR-0117): the enabled
    /// agent definitions with their bound skill bodies resolved. One scan
    /// alongside the skills + CLI reads; the guarantee is the snapshot
    /// itself -- the turn consumes this one consistent family, while the
    /// on-disk registry and the enablement store may change freely
    /// afterwards (the next turn re-reads).
    delegations: Vec<crate::agents::DelegationSpec>,
    keychain: &'a crate::provider::keychain::KeychainStore,
}

/// Read the session's discovery snapshot (ADR-0119 Decision 3) and resolve
/// its names into prompt fragments (name + description + verbatim body +
/// whole-file SHA-256) against the registry root, here at the entry's data
/// boundary ([`TurnDeps`] carries the roots), so the session stays I/O-free
/// for skill content (it consumes fragments, mirroring the mcp_servers
/// "data passed in" pattern). The user's staged invocation names materialize
/// here too (ADR-0119 Decision 1: the body + hash pin the invocation-time
/// bytes at the submit boundary). The caller must hold the session lock, so
/// the snapshot cannot change between this read and the turn. One seam so
/// neither snapshot read nor the `TurnInputs` field wiring can silently pass
/// the wrong set (issue #707's wiring pin) -- the black-box tests
/// hand-assemble their inputs, which left the orchestration itself
/// uncovered.
fn assemble_turn_inputs<'a>(
    session: &Session,
    skills_root: &'a Path,
    agents_root: &'a Path,
    live: &'a LiveProviderConfig,
    user_invocation_names: &[String],
) -> AssembledTurnInputs<'a> {
    // ADR-0119 Decision 3 (issue #983): the assembly's skill set is the
    // discovery SNAPSHOT, not the legacy mount fold -- the index lists the
    // creation-time enabled set wholesale, every turn.
    let snapshot = session.discovery_snapshot();
    let skills = resolve_prompt_fragments(skills_root, &snapshot);
    let disabled_skills: Vec<String> = live.load().disabled_skills.iter().cloned().collect();
    // The enable axis gates BOTH invocation actors (ADR-0119 Decision 3), so
    // the user channel filters disabled names at materialization time.
    let user_invocations =
        session.materialize_user_invocations(user_invocation_names, skills_root, &disabled_skills);
    let cli_tools = live.enabled_cli_tools();
    let delegations = live.delegation_specs(agents_root, skills_root);
    AssembledTurnInputs {
        skills,
        user_invocations,
        disabled_skills,
        skills_root,
        live_config: Some(live),
        cli_tools,
        delegations,
        keychain: live.keychain(),
    }
}

impl AssembledTurnInputs<'_> {
    /// Project the owning buffers (plus the caller's command-level MCP
    /// servers) into the turn's borrowed input view.
    fn turn_inputs<'b>(&'b self, mcp_servers: &'b [McpServerConfig]) -> TurnInputs<'b> {
        TurnInputs {
            mcp_servers,
            keychain: self.keychain,
            skills: &self.skills,
            user_invocations: &self.user_invocations,
            disabled_skills: &self.disabled_skills,
            skills_root: self.skills_root,
            live_config: self.live_config,
            cli_tools: &self.cli_tools,
            delegations: &self.delegations,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    use crate::approval::{ApprovalRequestBody, ApprovalResponse};
    use crate::cancel::CancelToken;
    use crate::provider::keychain::KeychainStore;
    use crate::session::loop_contract::DiscoveredRuntime;
    use crate::session::store::SessionStore;
    use crate::session::PosturePair;
    use crate::{Provider, ProviderError, UnwiredProvider};

    /// A no-op approval sink: the real one is Tauri-bound (transport side),
    /// the entry only borrows the trait.
    struct NoopSink;
    impl ApprovalSink for NoopSink {
        fn emit_request(&self, _: &ApprovalRequestBody) {}
        fn emit_resolved(&self, _: &ApprovalRequestBody, _: ApprovalResponse) {}
    }

    /// A fast-fail provider that records the request's thought-level (the
    /// post-mirror observable for the posture half of the mirror pair) and
    /// refuses the turn: UnwiredProvider's honest refusal plus a probe.
    struct RecordingProvider {
        seen: Arc<Mutex<Vec<Option<String>>>>,
    }
    impl Provider for RecordingProvider {
        fn generate_tool_turn(
            &self,
            request: &crate::provider::tool_calling::ToolTurnRequest,
        ) -> Result<crate::provider::tool_calling::ToolTurnOutcome, ProviderError> {
            self.seen
                .lock()
                .unwrap()
                .push(request.thought_level.clone());
            Err(ProviderError::NotWired)
        }
    }

    fn put_skill(root: &Path, name: &str, description: &str, body: &str) {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let content = format!("---\nname: {name}\ndescription: {description}\n---\n{body}");
        std::fs::write(dir.join("SKILL.md"), content).unwrap();
    }

    fn cli_tool(name: &str, enabled: bool) -> crate::cli_tools::config::CliToolConfig {
        crate::cli_tools::config::CliToolConfig {
            name: name.to_string(),
            description: "does a thing".to_string(),
            executable: "/bin/tool".to_string(),
            argv_template: Vec::new(),
            params: Vec::new(),
            env: Default::default(),
            enabled,
            source: Default::default(),
            baseline: None,
        }
    }

    /// One store-built handle around the given provider (the layer
    /// `run_turn` lives on).
    fn handle_with(provider: Box<dyn Provider>) -> Arc<SessionHandle> {
        let store = SessionStore::new();
        let id = store
            .create(Arc::new(CancelToken::new()), provider, Default::default())
            .expect("create session");
        store.get(&id).expect("handle")
    }

    /// Entry deps over one temp dir: a written config file (so `load()` never
    /// walks the missing-config keychain path), an empty MCP snapshot, and
    /// fresh roots.
    fn deps_under(tmp: &Path) -> TurnDeps {
        let live = LiveProviderConfig::new(KeychainStore::new(), tmp.join("config.json"));
        // One disabled registration just to make the config file exist; the
        // empty direction is fine here -- the assembly pin below owns the
        // non-empty CLI/delegation directions.
        live.upsert_cli_tool(cli_tool("pin", false))
            .expect("write config");
        TurnDeps {
            live,
            mcp_servers: Vec::new(),
            skills_root: tmp.join("skills"),
            agents_root: tmp.join("agents"),
        }
    }

    /// A stale external choice that can never spawn (the mirror-pair pin's
    /// discriminant: without the runtime mirror it survives and dispatches
    /// the external arm).
    fn missing_adapter() -> crate::runtime::acp::adapter::AdapterSpec {
        crate::runtime::acp::adapter::AdapterSpec {
            id: crate::runtime::acp::adapter::AdapterId::new("missing-cli"),
            display_name: "missing-cli".into(),
            binary_names: vec!["definitely-not-on-path-1414".into()],
            argv: Vec::new(),
            stream_format: crate::runtime::acp::adapter::StreamFormat::Acp,
            probe_argv: None,
            model_arg: None,
            effort: None,
            env: Default::default(),
        }
    }

    fn run_builtin_turn(handle: &SessionHandle, deps: &TurnDeps) -> TurnOutcome {
        let approval = handle.approval_state();
        let sink = NoopSink;
        handle
            .run_turn(
                "one question",
                &[],
                deps,
                TurnPorts {
                    approval: &approval,
                    sink: &sink,
                    on_phase: Box::new(|_| {}),
                    on_named: Box::new(|_| {}),
                    grant_scope: Box::new(|_| {}),
                },
            )
            .expect("run_turn")
    }

    /// The mirror-pair pin (issue #353 / ADR-0095): `run_turn` feeds the
    /// handle-held runtime + posture choice into the turn at the turn top,
    /// before the provider runs. A builtin fast-fail turn observes both
    /// halves: the recording provider sees the handle's posture (the
    /// thought-level rides the built-in request), and the provider being
    /// called AT ALL proves the stale external choice was cleared -- a
    /// session holding a leftover `Some(spec)` dispatches the external arm
    /// and never reaches the provider. Deleting either mirror line reddens
    /// the pair below.
    #[test]
    fn run_turn_mirrors_the_runtime_choice_and_posture_into_the_turn() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let handle = handle_with(Box::new(RecordingProvider {
            seen: Arc::clone(&seen),
        }));
        // A stale external choice on the Session (a prior external turn's
        // leftover): the handle slot below says built-in, so the mirror must
        // clear it.
        {
            let mut s = handle.session_lock().expect("lock");
            s.set_external_runtime(Some(missing_adapter()));
        }
        handle.set_runtime_and_posture(
            None,
            PosturePair {
                model: None,
                thought_level: Some("high".to_string()),
            },
        );
        let tmp = tempfile::tempdir().unwrap();
        let deps = deps_under(tmp.path());
        let outcome = run_builtin_turn(&handle, &deps);
        // The refusal itself is the expected fast-fail shape either way;
        // the DISCRIMINANT is the recording: a deleted runtime mirror
        // leaves the stale choice dispatching the external arm, the
        // provider never runs, and the vec stays empty; a deleted posture
        // mirror lands `None` instead of "high".
        assert!(
            matches!(outcome, TurnOutcome::Failed(_)),
            "the unwired provider refuses the turn: {outcome:?}"
        );
        assert_eq!(
            *seen.lock().unwrap(),
            vec![Some("high".to_string())],
            "the built-in arm ran exactly once with the mirrored posture"
        );
    }

    /// The mirror-back None-arm pin (ADR-0095, issue #530): a built-in turn
    /// discovers nothing, so the discovered-runtime mirror-back must SKIP
    /// the cache write -- the handle's previous catalog survives verbatim.
    /// (The Some-arm half -- an external turn's catalog landing on the
    /// handle -- is pinned end-to-end by the acp_session_wiring rig.)
    #[test]
    fn builtin_turn_preserves_the_cached_discovery() {
        let handle = handle_with(Box::new(UnwiredProvider));
        let sentinel = DiscoveredRuntime {
            models: vec!["sentinel-model".to_string()],
            current_model: Some("sentinel-model".to_string()),
            ..DiscoveredRuntime::empty()
        };
        handle.set_cached_discovered(sentinel.clone());
        let tmp = tempfile::tempdir().unwrap();
        let deps = deps_under(tmp.path());
        let _ = run_builtin_turn(&handle, &deps);
        assert_eq!(
            handle.cached_discovered(),
            Some(sentinel),
            "a no-discovery turn must not touch the cached catalog"
        );
    }

    /// The grant-port pin (ADR-0124 / ADR-0137 Decision 6): the asset-scope
    /// grant rides the same lock window at the turn's settle, exactly once,
    /// with the thread's referenced paths -- for a no-artifact built-in turn
    /// that is ONE call over an EMPTY list, never zero calls. The position
    /// half: while the grant runs, the non-blocking lock attempt fails, so
    /// a grant hoisted out of the held window (or moved before the turn)
    /// reddens here.
    #[test]
    fn run_turn_grants_asset_scope_exactly_once() {
        let handle = handle_with(Box::new(UnwiredProvider));
        let tmp = tempfile::tempdir().unwrap();
        let deps = deps_under(tmp.path());
        let approval = handle.approval_state();
        let sink = NoopSink;
        let grants: Arc<Mutex<Vec<Vec<PathBuf>>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_grants = Arc::clone(&grants);
        let handle_for_pin = Arc::clone(&handle);
        let _ = handle
            .run_turn(
                "one question",
                &[],
                &deps,
                TurnPorts {
                    approval: &approval,
                    sink: &sink,
                    on_phase: Box::new(|_| {}),
                    on_named: Box::new(|_| {}),
                    grant_scope: Box::new(move |paths| {
                        assert!(
                            handle_for_pin.try_session_lock().is_none(),
                            "the grant fires inside the held session lock window"
                        );
                        sink_grants.lock().unwrap().push(paths.to_vec())
                    }),
                },
            )
            .expect("run_turn");
        let grants = grants.lock().unwrap();
        assert_eq!(grants.len(), 1, "exactly one grant per turn");
        assert!(
            grants[0].is_empty(),
            "a no-artifact turn grants an empty list"
        );
    }

    /// The wiring pin issue #707 adds (calibrated by ADR-0119, issue #983):
    /// the seam reads the session's discovery snapshot and wires
    /// `TurnInputs`'s fields correctly. The black-box tests hand-assemble
    /// their inputs, so a wrong-set field (e.g. resolving the legacy mount
    /// fold instead of the snapshot) or `&[]` survived every test before
    /// this pin.
    #[test]
    fn assemble_turn_inputs_pins_the_snapshot_and_field_wiring() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        put_skill(&root, "alpha", "Alpha description.", "Alpha body.\n");
        put_skill(&root, "beta", "Beta description.", "Beta body.\n");
        put_skill(&root, "gamma", "Gamma description.", "Gamma body.\n");

        let mut session =
            Session::with_provider(Box::new(crate::UnwiredProvider)).expect("session");
        // The snapshot is the assembly source (ADR-0119 Decision 3):
        // materialized at creation, immutable -- here it names two of the
        // three registry skills (gamma stays out) so a wrong-set wiring
        // (the full registry, an ad-hoc name list) fails the pin.
        session.set_discovery_snapshot(vec!["alpha".to_string(), "beta".to_string()]);

        let live = LiveProviderConfig::new(
            crate::provider::keychain::KeychainStore::new(),
            tmp.path().join("config.json"),
        );
        // The non-empty direction of the CLI wiring (review I1, issue #707):
        // one enabled registration upserted through the real config path, so
        // the projection is pinned against `cli_tools: &[]` too -- an
        // empty-only assert is vacuously satisfied by a missing config. This
        // also makes `load()` read the temp config file instead of the
        // missing-config path that would query the OS keychain for the
        // legacy blob (review C).
        live.upsert_cli_tool(cli_tool("pandoc-guide", true))
            .expect("upsert one enabled CLI tool");
        // The enable axis feeds the turn inputs (review Importants 1-2,
        // issue #983): gamma is machine-disabled through the real config
        // path, so the staged set exercises all three halves at once -- the
        // disabled name rides `disabled_skills`, a disabled stage lands no
        // record, and a duplicated stage collapses to one.
        live.set_skill_enabled("gamma", false)
            .expect("disable gamma on the enable axis");
        // An empty agents root (issue #933): the delegation scan reads an
        // absent registry as the legitimate never-created state and lists
        // nothing, pinning the empty-family projection here too.
        let agents_tmp = tempfile::tempdir().unwrap();
        let staged = ["beta".to_string(), "gamma".to_string(), "beta".to_string()];
        let assembled = assemble_turn_inputs(&session, &root, agents_tmp.path(), &live, &staged);
        let inputs = assembled.turn_inputs(&[]);

        // The assembly's skill set is the discovery SNAPSHOT, wholesale --
        // neither the legacy mount fold (gamma absent) nor the activation
        // subset (beta absent).
        let names: Vec<&str> = inputs.skills.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["alpha", "beta"],
            "skills resolve from the discovery snapshot, not the mount fold or activation subset"
        );
        assert_eq!(
            inputs.skills[0].description, "Alpha description.",
            "the snapshot's rows carry the frontmatter description"
        );
        // The field-wiring half the pin exists for (the #707 mirror-drift
        // class, restored -- review Important 1): both new fields are
        // observed, so a seam that wires either one to an empty slice
        // reddens here, and the disabled stage's empty-body degrade
        // (review Important 2, #991) reddens on gamma's record shape.
        assert_eq!(
            inputs.disabled_skills,
            &["gamma".to_string()],
            "the machine-level disabled names ride the turn inputs"
        );
        assert_eq!(
            inputs.user_invocations.len(),
            2,
            "one enabled staged name materializes one record (duplicates collapse) and \
             the disabled stage lands the empty-body degrade (review Important 2, #991)"
        );
        assert_eq!(inputs.user_invocations[0].name, "beta");
        assert_eq!(
            inputs.user_invocations[0].actor,
            crate::model::SkillLifecycleActor::User
        );
        assert!(
            !inputs.user_invocations[0].content_hash.is_empty(),
            "the record pins the invocation-time whole-file hash"
        );
        // The disabled stage's honest-degrade record: the name lands (the
        // badge reads the attempt), the body and hash stay empty -- nothing
        // enters the context, no drift anchor, no read surface.
        assert_eq!(inputs.user_invocations[1].name, "gamma");
        assert_eq!(inputs.user_invocations[1].body, "");
        assert_eq!(inputs.user_invocations[1].content_hash, "");
        assert_eq!(
            inputs.user_invocations[1].actor,
            crate::model::SkillLifecycleActor::User
        );
        // The empty agents registry projects the empty delegation family
        // (issue #933): a never-created registry is the legitimate state.
        assert_eq!(
            inputs.delegations,
            &[],
            "an empty agents root lists no delegation specs"
        );

        // The non-empty direction: one spec-valid definition on disk plus
        // its enablement set entry project exactly one spec (the enabled
        // filter and the file scan both have to pass), so an empty-only
        // assert cannot be vacuously satisfied by a broken scan.
        std::fs::write(
            agents_tmp.path().join("analyst.md"),
            "---
name: analyst
description: Open-ended analysis.
---
You are a focused analyst.
",
        )
        .expect("write agent definition");
        live.set_agent_enabled("analyst", true)
            .expect("enable analyst");
        let assembled = assemble_turn_inputs(&session, &root, agents_tmp.path(), &live, &[]);
        let inputs = assembled.turn_inputs(&[]);
        // An empty staging projects zero user invocations; both wire
        // forms (absent, empty) converge on this slice upstream, at
        // the ask command's Option fold upstream (#992).
        assert!(
            inputs.user_invocations.is_empty(),
            "an empty staging materializes no user invocation records"
        );
        assert_eq!(inputs.delegations.len(), 1, "the enabled entry projects");
        assert_eq!(inputs.delegations[0].name, "analyst");
        assert_eq!(
            inputs.delegations[0].preamble,
            "You are a focused analyst.
"
        );
        // Every mounted skill resolves with its description + body verbatim.
        assert_eq!(inputs.skills.len(), 2, "every mounted skill resolves");
        let alpha = inputs
            .skills
            .iter()
            .find(|f| f.name == "alpha")
            .expect("alpha fragment");
        assert_eq!(alpha.description, "Alpha description.");
        assert_eq!(alpha.body, "Alpha body.\n");
        assert!(
            !alpha.content_hash.is_empty(),
            "the whole-file hash is recorded"
        );
        let beta = inputs
            .skills
            .iter()
            .find(|f| f.name == "beta")
            .expect("beta fragment");
        assert_eq!(beta.description, "Beta description.");
        assert_eq!(beta.body, "Beta body.\n");
        // The command-level wiring rides the same projection: the enabled
        // CLI registration flows through (an empty-direction assert alone
        // could not catch `cli_tools: &[]`), and the empty MCP set
        // contributes nothing.
        assert_eq!(
            inputs.cli_tools.len(),
            1,
            "the enabled CLI tool rides the seam"
        );
        assert_eq!(inputs.cli_tools[0].name, "pandoc-guide");
        assert!(inputs.mcp_servers.is_empty());
    }
}
