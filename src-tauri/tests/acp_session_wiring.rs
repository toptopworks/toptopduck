//! Session external-runtime wiring integration (issue #299 slice 9c).
//!
//! Drives the full Session -> AcpEngine -> fake-CLI -> bridge -> gateway ->
//! tools::dispatch chain in CI. The fake-CLI's `gateway_tool_call` scenario
//! spawns the real bridge binary (its path injected via the `session/new` MCP
//! descriptor); the bridge connects back to the per-turn gateway, which serves
//! the MCP subset and routes `tools/call` (explore) through `tools::dispatch`
//! against the session's live DuckDB connection. Real CLI E2E is
//! manual (the #299 AC, not in CI); #300 covers the other ACP CLIs against the
//! same engine. The trace-merge dedup is unit-tested at the merge function;
//! these tests pin the WIRING -- the scoped-thread serve, the bridge
//! spawn/connect, and the parallel engine drive rejoin without deadlock.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use toptopduck_lib::model::SkillProvenance;
use toptopduck_lib::persistence::recipe::{RecipeEntry, RuntimeKind};
use toptopduck_lib::runtime::acp::adapter::{AdapterId, AdapterSpec};
use toptopduck_lib::skills::{resolve_prompt_fragments, SkillPromptFragment};
use toptopduck_lib::util::sha256_hex;
use toptopduck_lib::{
    ApprovalRequestBody, ApprovalResponse, ApprovalSink, ApprovalState, KeychainStore, Session,
    TurnInputs, TurnOutcome,
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
#[test]
fn external_turn_with_skill_records_provenance() {
    let skills_root = tempfile::tempdir().unwrap();
    let skills_root = skills_root.path().to_path_buf();
    let body = "Name the statistical method you use.\n";
    put_skill(
        &skills_root,
        "sql-coach",
        "Coach honest SQL reporting.",
        body,
    );
    let skill_md_bytes = fs::read(skills_root.join("sql-coach").join("SKILL.md")).unwrap();
    let expected_hash = sha256_hex(&skill_md_bytes);

    let (mut session, old_path, _guard) = external_session("text_reply");
    session.mount_skill("sql-coach").expect("mount");
    let mounted = session.mounted_skills();
    let fragments: Vec<SkillPromptFragment> = resolve_prompt_fragments(&skills_root, &mounted);
    assert_eq!(fragments.len(), 1);
    assert_eq!(fragments[0].content_hash, expected_hash);

    let approval = ApprovalState::new();
    let sink = NullSink;
    let keychain = KeychainStore::new();
    let outcome = session.ask_with_phase(
        "what is the answer?",
        &approval,
        &sink,
        |_| {},
        &TurnInputs {
            mcp_servers: &[],
            keychain: &keychain,
            skills: &fragments,
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
            content_hash: expected_hash,
        }],
        "external path provenance must snapshot skill name + hash"
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
    let config = session.runtime_model_config();
    assert_eq!(
        config.cached_discovered.as_ref(),
        Some(&catalog),
        "the recipe-header cache must survive the no-discovery turn"
    );
}
