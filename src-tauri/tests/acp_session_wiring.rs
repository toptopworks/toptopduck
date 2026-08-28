//! Session external-runtime wiring integration (issue #299 slice 9c).
//!
//! Drives the full Session -> AcpEngine -> fake-CLI -> bridge -> gateway ->
//! tools::dispatch chain in CI. The fake-CLI's `gateway_tool_call` scenario
//! spawns the real bridge binary (its path injected via the `session/new` MCP
//! descriptor); the bridge connects back to the per-turn gateway, which serves
//! the MCP subset and routes `tools/call` (explore, or a registered CLI tool
//! via `cli_gateway_tool_call` -- issue #673) through `tools::dispatch` or the
//! shared spawn engine against the session's live resources. Real CLI E2E is
//! manual (the #299 AC, not in CI); #300 covers the other ACP CLIs against the
//! same engine. The trace-merge dedup is unit-tested at the merge function;
//! these tests pin the WIRING -- the scoped-thread serve, the bridge
//! spawn/connect, and the parallel engine drive rejoin without deadlock.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, MutexGuard};

use toptopduck_lib::cli_tools::config::{
    CliParamDelivery, CliToolConfig, CliToolParam, CliToolSource,
};
use toptopduck_lib::model::SkillProvenance;
use toptopduck_lib::persistence::recipe::{RecipeEntry, RuntimeKind};
use toptopduck_lib::runtime::acp::adapter::{AdapterId, AdapterSpec};
use toptopduck_lib::skills::{resolve_prompt_fragments, SkillPromptFragment};
use toptopduck_lib::util::sha256_hex;
use toptopduck_lib::{
    ApprovalRequestBody, ApprovalResponse, ApprovalSink, ApprovalState, KeychainStore, Session,
    TurnFailure, TurnInputs, TurnOutcome,
};

/// The fake-CLI adapter: the fixture binary (named `acp-fake-cli`) driven with
/// no argv prefix -- it reads its scenario from `ACP_FAKE_SCENARIO`. A bespoke
/// adapter (not `gemini_cli()`) so the PATH scan resolves the fixture, not any
/// real gemini-cli install on the dev box.
fn fake_cli_adapter() -> AdapterSpec {
    AdapterSpec {
        id: AdapterId::new("fake-cli"),
        display_name: "fake-cli",
        binary_names: &["acp-fake-cli"],
        argv: &[],
        stream_format: toptopduck_lib::runtime::acp::adapter::StreamFormat::Acp,
        probe_argv: None,
        model_arg: None,
        effort: None,
    }
}

/// Process-wide lock: the global env (`PATH`, `ACP_FAKE_SCENARIO`,
/// `TOPTOPDUCK_ACP_BRIDGE_BIN`) is set under this mutex so the two tests in
/// this binary do not race. Cargo runs test binaries sequentially, so this
/// never contends with `acp_engine.rs`'s own lock; it only serializes the
/// tests within this file. Mirrors the 9a env-lock pattern.
static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Prepend `dir` to `PATH` so the adapter PATH scan resolves the fixture
/// binary. Returns the prior `PATH` for restoration.
fn prepend_path(dir: &std::path::Path) -> std::ffi::OsString {
    let old = std::env::var_os("PATH").unwrap_or_default();
    let mut entries: Vec<PathBuf> = std::env::split_paths(&old).collect();
    entries.insert(0, dir.to_path_buf());
    let joined = std::env::join_paths(entries).expect("PATH joins");
    std::env::set_var("PATH", &joined);
    old
}

/// Lock the global env, point it at the fixture (scenario + bridge binary +
/// PATH), and build a Session wired to the fake-CLI adapter. Returns the
/// session + the prior `PATH` + the env-lock guard (held across the turn so a
/// sibling test cannot reset the global env mid-drive).
fn external_session(scenario: &str) -> (Session, std::ffi::OsString, MutexGuard<'static, ()>) {
    let guard = ENV_LOCK.lock().unwrap();
    let fake_cli = PathBuf::from(env!("CARGO_BIN_EXE_acp-fake-cli"));
    let old_path = prepend_path(fake_cli.parent().expect("fixture has a parent dir"));
    std::env::set_var("ACP_FAKE_SCENARIO", scenario);
    std::env::set_var(
        "TOPTOPDUCK_ACP_BRIDGE_BIN",
        env!("CARGO_BIN_EXE_toptopduck-acp-bridge"),
    );
    let mut session = Session::new().expect("session");
    session.set_external_runtime(Some(fake_cli_adapter()));
    (session, old_path, guard)
}

/// The vanilla external path: a no-tool turn completes `Textual` through the
/// ACP pump. The bridge still spawns + connects (the descriptor always rides
/// `session/new`), but no `tools/call` fires -- this pins the engine + serve
/// rejoin for a turn that leaves the gateway idle, the baseline the
/// gateway-call test layers a dispatch on top of.
#[test]
fn external_text_reply_turn_completes() {
    let (mut session, old_path, _guard) = external_session("text_reply");
    let outcome = session.ask("what is the answer?");
    std::env::set_var("PATH", old_path);
    match outcome {
        TurnOutcome::Textual { body, .. } => {
            assert!(
                body.contains("42"),
                "agent text round-tripped through the pump: got {body:?}"
            );
        }
        other => panic!("text_reply must complete Textual, got {other:?}"),
    }
}

/// The full chain: the fake-CLI's `gateway_tool_call` scenario drives one MCP
/// `tools/call` (explore) through the spawned bridge -> the per-turn gateway
/// -> `tools::dispatch`, then emits a terminal agent message. The turn must
/// complete `Textual` -- proving the bridge spawns + connects, the gateway
/// serves the MCP subset, dispatch runs against the live session resources,
/// and the scoped-thread serve rejoins the parallel engine drive without
/// deadlock.
#[test]
fn external_gateway_tool_call_drives_dispatch() {
    let (mut session, old_path, _guard) = external_session("gateway_tool_call");
    let outcome = session.ask("run one gateway tool call");
    std::env::set_var("PATH", old_path);
    match outcome {
        TurnOutcome::Textual { body, .. } => {
            assert!(
                body.contains("done via gateway"),
                "agent message round-tripped through the pump: got {body:?}"
            );
        }
        other => panic!("gateway_tool_call must complete Textual, got {other:?}"),
    }
}

/// Issue #673 (ADR-0108 Decision 6): a registered CLI tool is advertised on
/// the bridge's `tools/list` (asserted fixture-side) and a bridge-originated
/// call routes through the per-turn gateway into the same approval gate +
/// spawn engine a built-in-initiated call uses -- the single tool plane. The
/// answering sink allows the card once, pinning that the bridge-originated
/// call really does gate (CLI registrations classify as external tools,
/// ADR-0108 Decision 8) rather than bypassing the card.
#[test]
fn external_cli_tool_call_routes_through_the_gateway() {
    let (mut session, old_path, _guard) = external_session("cli_gateway_tool_call");
    // The registration: the cli-fake-tool fixture under the exact name the
    // fixture's scenario addresses.
    let tool = CliToolConfig {
        name: "cli-fixture-echo".into(),
        description: "echo fixture".into(),
        executable: env!("CARGO_BIN_EXE_cli-fake-tool").into(),
        argv_template: Vec::new(),
        params: vec![CliToolParam {
            name: "args".into(),
            description: "tail args".into(),
            delivery: CliParamDelivery::Argv,
            varargs: true,
        }],
        env: Default::default(),
        enabled: true,
        source: CliToolSource::User,
        baseline: None,
    };
    let keychain = KeychainStore::new();
    let inputs = TurnInputs {
        mcp_servers: &[],
        keychain: &keychain,
        skills: &[],
        activated: &[],
        cli_tools: std::slice::from_ref(&tool),
    };
    // An approval sink that answers allow-once from inside emit_request: the
    // gate installs the pending slot before calling the sink and holds no
    // locks across it, so respond() here is the same store-then-notify the
    // IPC command does.
    struct AnsweringSink<'a> {
        state: &'a ApprovalState,
        cards: std::sync::atomic::AtomicUsize,
    }
    impl ApprovalSink for AnsweringSink<'_> {
        fn emit_request(&self, body: &ApprovalRequestBody) {
            self.cards.fetch_add(1, Ordering::SeqCst);
            let id: uuid::Uuid = body.request_id.parse().expect("uuid");
            self.state
                .respond(id, ApprovalResponse::AllowOnce)
                .expect("respond");
        }
        fn emit_resolved(&self, _: &ApprovalRequestBody, _: ApprovalResponse) {}
    }
    let approval = ApprovalState::new();
    let sink = AnsweringSink {
        state: &approval,
        cards: std::sync::atomic::AtomicUsize::new(0),
    };
    let outcome = session.ask_with_phase("run the cli tool", &approval, &sink, |_| {}, &inputs);
    std::env::set_var("PATH", old_path);
    assert_eq!(
        sink.cards.load(Ordering::SeqCst),
        1,
        "the bridge-originated CLI call surfaced exactly one approval card"
    );
    match outcome {
        TurnOutcome::Textual { body, .. } => {
            assert!(
                body.contains("done via cli gateway"),
                "agent message round-tripped through the pump: got {body:?}"
            );
        }
        other => panic!("cli_gateway_tool_call must complete Textual, got {other:?}"),
    }
    // One bridge call -> one persisted row: the fixture emits the ACP
    // notification (`gw_cli_1`) for the same call the gateway served (`id=3`),
    // and the merge de-duplicates them at the wiring level -- a wiring
    // regression (an empty slice at the merge call site) would persist two
    // rows for one call and fail this count.
    let recipe = session.build_recipe();
    let last_turn = recipe
        .history
        .iter()
        .rev()
        .find_map(|e| match e {
            RecipeEntry::Turn(t) => Some(t),
            _ => None,
        })
        .expect("at least one turn in the recipe");
    let cli_rows: Vec<_> = last_turn
        .trace
        .iter()
        .flat_map(|r| r.calls.iter())
        .filter(|c| c.name == "cli-fixture-echo")
        .collect();
    assert_eq!(
        cli_rows.len(),
        1,
        "one bridge-originated CLI call persists exactly one trace row"
    );
    assert!(
        cli_rows[0].success,
        "the gateway's served row is the winner"
    );
}

/// Issue #646: an MCP request frame from the bridge that exceeds the
/// gateway's per-line byte cap fails the serve (the connection tears down, no
/// id-matched response ever exists). The turn lands on the serve-error path
/// with the framing cause riding the failure detail -- never a `Cancelled`
/// hang waiting on a response the gateway refused to write.
#[test]
fn external_overlong_gateway_request_fails_the_turn() {
    let (mut session, old_path, _guard) = external_session("gateway_overlong_call");
    let outcome = session.ask("run one over-long gateway tool call");
    std::env::set_var("PATH", old_path);
    match outcome {
        TurnOutcome::Failed(TurnFailure::Execute { detail }) => {
            assert!(
                detail.contains("gateway serve failed"),
                "the failure names its face: {detail}"
            );
            assert!(
                detail.contains("frame line exceeded"),
                "the framing cause rides the detail: {detail}"
            );
        }
        other => panic!("gateway_overlong_call must land Failed(Execute), got {other:?}"),
    }
}

// --- helpers for skill-injection tests (issue #368) -------------------------

/// A no-op approval sink (the turn runs ungated). Mirrors the NullSink in
/// skill_injection_blackbox.rs -- the real one is private to the session module.
struct NullSink;
impl ApprovalSink for NullSink {
    fn emit_request(&self, _body: &ApprovalRequestBody) {}
    fn emit_resolved(&self, _body: &ApprovalRequestBody, _response: ApprovalResponse) {}
}

/// Write one skill directory with a spec-valid SKILL.md (frontmatter + body).
fn put_skill(root: &Path, name: &str, description: &str, body: &str) {
    let dir = root.join(name);
    fs::create_dir_all(&dir).unwrap();
    let content = format!("---\nname: {name}\ndescription: {description}\n---\n{body}");
    fs::write(dir.join("SKILL.md"), content).unwrap();
}

/// Issue #368 AC #2: an external-runtime turn with a mounted skill records
/// `{name, content_hash}` in TurnProvenance.skills. The ask_with_phase facade
/// computes provenance once before the built-in / external branch and passes it
/// to record_turn after; this test pins the external branch so a future change
/// cannot silently drop the skill provenance on the ACP path.
///
/// ADR-0110 (issues #700/#702): since the ACP assembly renders disclosure,
/// the external turn records the ACTIVATED subset -- the same set the
/// built-in turn records. The activated list deliberately covers only one of
/// the two mounts, so recording the full mounted set -- the pre-#702 fork --
/// reddens this test with an extra pdf-tools entry.
#[test]
fn external_turn_records_activated_subset_provenance() {
    let skills_root = tempfile::tempdir().unwrap();
    let skills_root = skills_root.path().to_path_buf();
    let body = "Name the statistical method you use.\n";
    put_skill(
        &skills_root,
        "sql-coach",
        "Coach honest SQL reporting.",
        body,
    );
    put_skill(
        &skills_root,
        "pdf-tools",
        "Extract tables before querying.",
        "Extract the tables first.\n",
    );
    let sql_coach_bytes = fs::read(skills_root.join("sql-coach").join("SKILL.md")).unwrap();
    let sql_coach_hash = sha256_hex(&sql_coach_bytes);

    let (mut session, old_path, _guard) = external_session("text_reply");
    session.mount_skill("sql-coach").expect("mount");
    session.mount_skill("pdf-tools").expect("mount");
    let mounted = session.mounted_skills();
    let fragments: Vec<SkillPromptFragment> = resolve_prompt_fragments(&skills_root, &mounted);
    assert_eq!(fragments.len(), 2);

    let approval = ApprovalState::new();
    let sink = NullSink;
    let keychain = KeychainStore::new();
    // Only one of the two mounts is activated -- the convergence's
    // discriminating case (see the doc comment).
    let activated = vec!["sql-coach".to_string()];
    let outcome = session.ask_with_phase(
        "what is the answer?",
        &approval,
        &sink,
        |_| {},
        &TurnInputs {
            mcp_servers: &[],
            keychain: &keychain,
            skills: &fragments,
            activated: &activated,
            cli_tools: &[],
        },
    );
    std::env::set_var("PATH", old_path);
    assert!(
        matches!(outcome, TurnOutcome::Textual { .. }),
        "got {outcome:?}"
    );

    let recipe = session.build_recipe();
    let last_turn = recipe
        .history
        .iter()
        .rev()
        .find_map(|e| match e {
            RecipeEntry::Turn(t) => Some(t),
            _ => None,
        })
        .expect("at least one turn in the recipe");
    assert_eq!(
        last_turn.provenance.skills,
        vec![SkillProvenance {
            name: "sql-coach".into(),
            content_hash: sql_coach_hash,
        }],
        "the external turn records the ACTIVATED subset, not the full mounted set"
    );
    // ADR-0101: the turn-top snapshot must record the turn's real runtime --
    // the pre-#588 `TurnAudit::builtin` hardcoded BuiltIn here, mislabeling
    // every live external turn. The external turn names its driving adapter's
    // stable id on the persisted pair.
    assert_eq!(
        last_turn.provenance.runtime,
        Some(RuntimeKind::External),
        "a live external turn records the external runtime, never a hardcoded BuiltIn"
    );
    assert_eq!(
        last_turn.provenance.adapter_id.as_deref(),
        Some("fake-cli"),
        "the live snapshot names the driving adapter's stable id"
    );
}

/// Issue #702: a resumed session with NO Activate events in its timeline (the
/// old-session shape -- pre-v6 recipes cannot carry any) folds an EMPTY
/// activated set, and the external turn driven on top of it records an empty
/// skill provenance -- the same honest-degrade behavior as the built-in
/// side. Pins the resume AC end-to-end: mounts rebuild (so the empty
/// activation is meaningful, not "nothing resumed"), and the turn's
/// provenance carries no skill whose body was never injected.
#[test]
fn resumed_external_turn_without_activations_records_empty_provenance() {
    let skills_root = tempfile::tempdir().unwrap();
    let skills_root = skills_root.path().to_path_buf();
    put_skill(
        &skills_root,
        "sql-coach",
        "Coach honest SQL reporting.",
        "Name the statistical method you use.\n",
    );
    put_skill(
        &skills_root,
        "pdf-tools",
        "Extract tables before querying.",
        "Extract the tables first.\n",
    );

    let duck_dir = tempfile::tempdir().unwrap();
    let duck_path = duck_dir.path().join("resume.duck");
    let (mut session, old_path, _guard) = external_session("text_reply");
    session
        .bind_duck(duck_path.clone(), "resume".into())
        .expect("bind");
    // Mounts persist through the timeline append; no Activate event ever
    // lands -- the old-session shape.
    session.mount_skill("sql-coach").expect("mount");
    session.mount_skill("pdf-tools").expect("mount");
    drop(session);

    let mut resumed = Session::open_duck(
        &duck_path,
        Arc::new(toptopduck_lib::CancelToken::new()),
        Box::new(toptopduck_lib::UnwiredProvider),
        |_| {},
        |_| toptopduck_lib::SourceResolution::Abort,
        |_| toptopduck_lib::ActiveResolution::Abort,
    )
    .expect("resume");
    assert_eq!(
        resumed.mounted_skills(),
        vec!["sql-coach".to_string(), "pdf-tools".to_string()],
        "mounts rebuild off the timeline"
    );
    assert!(
        resumed.activated_skills().is_empty(),
        "a timeline with no Activate events folds an empty activated set"
    );

    resumed.set_external_runtime(Some(fake_cli_adapter()));
    let fragments: Vec<SkillPromptFragment> =
        resolve_prompt_fragments(&skills_root, &resumed.mounted_skills());
    assert_eq!(fragments.len(), 2);
    let activated = resumed.activated_skills();
    let outcome = resumed.ask_with_phase(
        "what is the answer?",
        &ApprovalState::new(),
        &NullSink,
        |_| {},
        &TurnInputs {
            mcp_servers: &[],
            keychain: &KeychainStore::new(),
            skills: &fragments,
            activated: &activated,
            cli_tools: &[],
        },
    );
    // Restore PATH while still holding the env lock (the `_guard` binding
    // drops at scope end), matching every sibling test -- an explicit drop
    // here would open an unlocked env-write window between the two.
    std::env::set_var("PATH", old_path);
    assert!(
        matches!(outcome, TurnOutcome::Textual { .. }),
        "got {outcome:?}"
    );

    let recipe = resumed.build_recipe();
    let last_turn = recipe
        .history
        .iter()
        .rev()
        .find_map(|e| match e {
            RecipeEntry::Turn(t) => Some(t),
            _ => None,
        })
        .expect("at least one turn in the recipe");
    assert!(
        last_turn.provenance.skills.is_empty(),
        "a resumed external turn with no activations records no skill bodies"
    );
}

/// Issue #702 (PR #709 review): the `activated` wire-through into the ACP
/// assembly is otherwise unpinned end-to-end -- the provenance tests assert
/// `build_recipe()` output, which is computed before the assembly call, and
/// the unit tests construct the argument directly. This test drives the
/// `prompt_echo` fixture scenario, which echoes the received `session/prompt`
/// blocks back as the agent message (the ACP counterpart of the built-in
/// face's provider-side prompt capture), and pins the disclosure mix the CLI
/// actually received: the mounted-only skill as an index entry, the activated
/// skill's framed verbatim body -- and the mounted-only skill's body nowhere
/// (a full-text or wrong-list regression at the call site leaks it here).
#[test]
fn external_turn_prompt_carries_disclosure_not_full_text() {
    let skills_root = tempfile::tempdir().unwrap();
    let skills_root = skills_root.path().to_path_buf();
    put_skill(
        &skills_root,
        "sql-coach",
        "Coach honest SQL reporting.",
        "Name the statistical method you use.\n",
    );
    put_skill(
        &skills_root,
        "pdf-tools",
        "Extract tables before querying.",
        "Extract the tables first.\n",
    );

    let (mut session, old_path, _guard) = external_session("prompt_echo");
    session.mount_skill("sql-coach").expect("mount");
    session.mount_skill("pdf-tools").expect("mount");
    let mounted = session.mounted_skills();
    let fragments: Vec<SkillPromptFragment> = resolve_prompt_fragments(&skills_root, &mounted);
    assert_eq!(fragments.len(), 2);

    let activated = vec!["sql-coach".to_string()];
    let keychain = KeychainStore::new();
    let outcome = session.ask_with_phase(
        "what is the answer?",
        &ApprovalState::new(),
        &NullSink,
        |_| {},
        &TurnInputs {
            mcp_servers: &[],
            keychain: &keychain,
            skills: &fragments,
            activated: &activated,
            cli_tools: &[],
        },
    );
    std::env::set_var("PATH", old_path);
    match outcome {
        TurnOutcome::Textual { body, .. } => {
            // The mounted-only skill rides as an index entry.
            assert!(
                body.contains("【可用技能】"),
                "index section rides the prompt"
            );
            assert!(
                body.contains("- `pdf-tools` — Extract tables before querying.\n"),
                "mounted-only skill indexed, not body-injected"
            );
            // The activated skill rides its framed verbatim body.
            assert!(
                body.contains(
                    "【激活技能】技能 `sql-coach`：\nName the statistical method you use.\n"
                ),
                "activated body framed + verbatim"
            );
            // The retired full-text shape leaks the mounted-only body.
            assert!(
                !body.contains("Extract the tables first."),
                "the mounted-only skill's body must not ride the prompt"
            );
        }
        other => panic!("prompt_echo must complete Textual, got {other:?}"),
    }
}

/// Issue #530: a pre-handshake ACP failure ("no discovery") must NOT wipe
/// the previous turn's catalog -- the None-skip at `run_external_turn`'s
/// snapshot is the only thing standing between the selector's cold-start
/// cache and a silent clear. Drive a discovering turn on the fake CLI, then
/// a turn whose adapter points at a nonexistent binary (spawn fails before
/// the handshake, so the engine reports `None`), and assert the Session's
/// cached catalog (and the recipe-header source) still holds the first
/// turn's discovery.
#[test]
fn external_prehandshake_failure_preserves_cached_discovery() {
    let (mut session, old_path, _guard) = external_session("text_reply");
    let first = session.ask("what is the answer?");
    assert!(
        matches!(first, TurnOutcome::Textual { .. }),
        "got {first:?}"
    );
    let catalog = session
        .last_discovered_runtime()
        .expect("a post-handshake turn reports a catalog");

    // Second turn: same session, an adapter whose binary does not exist --
    // the engine exits pre-handshake with `discovered_runtime: None`.
    session.set_external_runtime(Some(AdapterSpec {
        id: AdapterId::new("missing-cli"),
        display_name: "missing-cli",
        binary_names: &["definitely-not-on-path-530"],
        argv: &[],
        stream_format: toptopduck_lib::runtime::acp::adapter::StreamFormat::Acp,
        probe_argv: None,
        model_arg: None,
        effort: None,
    }));
    let second = session.ask("this one cannot even spawn");
    std::env::set_var("PATH", old_path);
    assert!(
        matches!(second, TurnOutcome::Failed(_)),
        "the missing-binary turn must fail, got {second:?}"
    );

    // The no-discovery turn preserved both the session-side snapshot and the
    // recipe-header cache (one storage, issue #530).
    assert_eq!(
        session.last_discovered_runtime().as_ref(),
        Some(&catalog),
        "a pre-handshake failure must retain the previous catalog"
    );
    let config = session.runtime_facts();
    assert_eq!(
        config.cached_discovered.as_ref(),
        Some(&catalog),
        "the recipe-header cache must survive the no-discovery turn"
    );
}
