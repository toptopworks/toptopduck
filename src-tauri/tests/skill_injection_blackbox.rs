//! Integration test: mounted-skill prompt injection + provenance (issue #364,
//! ADR-0086; recalibrated for progressive disclosure by issue #700, ADR-0110).
//!
//! Drives the built-in agent loop end-to-end with skills mounted, then asserts
//! the disclosure surfaces issue #700 wires:
//!   1. A mounted-but-not-activated skill lands as a metadata index entry
//!      (name + description, no body) in the system prompt.
//!   2. An activated skill's body lands verbatim in the 【激活技能】 frame,
//!      and the turn's persisted provenance records the ACTIVATED subset's
//!      `{name, content_hash}` (SHA-256 of the whole `SKILL.md`).
//!   3. Unmounting cascades a skill out of both blocks.
//!
//! The empty-mount case is covered by every existing black-box test --
//! they pass `&[]` for skills and see no skill section -- so this file focuses
//! on the disclosure-positive paths.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;

use toptopduck_lib::mcp::config::{McpServerConfig, McpServerId, McpTransport};
use toptopduck_lib::model::SkillLifecycleActor;
use toptopduck_lib::model::SkillProvenance;
use toptopduck_lib::persistence::recipe::{Recipe, RecipeEntry, RecipeTurn};
use toptopduck_lib::provider::tool_calling::ToolTurnReply;
use toptopduck_lib::skills::{resolve_prompt_fragments, SkillPromptFragment};
use toptopduck_lib::util::sha256_hex;
use toptopduck_lib::{
    ApprovalRequestBody, ApprovalResponse, ApprovalSink, ApprovalState, FakeProvider,
    KeychainStore, LiveProviderConfig, Session, TurnInputs, TurnOutcome,
};

/// A no-op approval sink (the turn runs ungated). Mirrors the NullSink in
/// query_blackbox.rs -- the real one is private to the session module.
struct NullSink;
impl ApprovalSink for NullSink {
    fn emit_request(&self, _body: &ApprovalRequestBody) {}
    fn emit_resolved(&self, _body: &ApprovalRequestBody, _response: ApprovalResponse) {}
}

/// The k-th user message's text (0-based) of a captured request -- history
/// pairs each user turn with an assistant reply, so user message k counts
/// only the User variants.
fn message_text(
    request: &toptopduck_lib::provider::tool_calling::ToolTurnRequest,
    k: usize,
) -> String {
    let mut seen = 0;
    for m in &request.messages {
        if let toptopduck_lib::provider::tool_calling::ToolTurnMessage::User { content } = m {
            if seen == k {
                return content.clone();
            }
            seen += 1;
        }
    }
    panic!("no user message #{k}");
}

/// Write one skill directory with a spec-valid SKILL.md (frontmatter + body).
fn put_skill(root: &Path, name: &str, description: &str, body: &str) {
    let dir = root.join(name);
    fs::create_dir_all(&dir).unwrap();
    let content = format!("---\nname: {name}\ndescription: {description}\n---\n{body}");
    fs::write(dir.join("SKILL.md"), content).unwrap();
}

/// The recipe's Turn entries in timeline order -- the single extraction
/// point for the turn-level reads (issue #707: the `RecipeEntry::Turn`
/// unwrap had been hand-rolled per site). The last entry is the most recent
/// turn, which the provenance asserts target.
fn turns(recipe: &Recipe) -> Vec<&RecipeTurn> {
    recipe
        .history
        .iter()
        .filter_map(|e| match e {
            RecipeEntry::Turn(t) => Some(t),
            _ => None,
        })
        .collect()
}

/// The recipe's LAST turn entry, or None when no turn has landed yet.
fn last_turn(recipe: &Recipe) -> Option<&RecipeTurn> {
    turns(recipe).pop()
}

/// ADR-0119 (issue #983): a USER invocation expands at its call site -- the
/// body rides the asking turn's input AHEAD of the question (never the
/// standing system prompt), the record persists on the turn, and the turn's
/// provenance is the invocation records' name set (each with its
/// invocation-time whole-file hash).
#[test]
fn user_invocation_body_in_prompt_and_provenance() {
    let skills_root = tempfile::tempdir().unwrap();
    let skills_root = skills_root.path().to_path_buf();
    let body = "When you use a native statistical method, name it in your answer.\n";
    put_skill(
        &skills_root,
        "sql-coach",
        "Coach the user on honest SQL reporting.",
        body,
    );
    // Capture the on-disk whole-file hash before building the provider so the
    // provenance assertion has its expected value keyed off the same bytes the
    // resolver hashed at submit time.
    let skill_md_bytes = fs::read(skills_root.join("sql-coach").join("SKILL.md")).unwrap();
    let expected_hash = sha256_hex(&skill_md_bytes);

    // Script the fake to terminate immediately with a text reply (no tool
    // calls) so the single round-trip surfaces the assembled request in
    // capture[0] and the turn ends without touching DuckDB.
    let provider =
        FakeProvider::new().scripted_tool_turn("查询", ToolTurnReply::Text("done".into()));
    let captured = provider.captured_tool_turns();
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    // Materialize the discovery snapshot (creation-time) + the user's staged
    // invocation at the command boundary (mirroring `commands::ask`).
    session.set_discovery_snapshot(vec!["sql-coach".to_string()]);
    let snapshot = session.discovery_snapshot();
    let fragments: Vec<SkillPromptFragment> = resolve_prompt_fragments(&skills_root, &snapshot);
    assert_eq!(fragments.len(), 1);
    assert_eq!(fragments[0].name, "sql-coach");
    assert_eq!(fragments[0].content_hash, expected_hash);
    let user_invocations =
        session.materialize_user_invocations(&["sql-coach".to_string()], &skills_root, &[]);
    assert_eq!(user_invocations.len(), 1);
    assert_eq!(user_invocations[0].body, body);
    assert_eq!(user_invocations[0].actor, SkillLifecycleActor::User);

    let approval = ApprovalState::new();
    let sink = NullSink;
    let outcome = session.ask_with_phase(
        "查询",
        &approval,
        &sink,
        |_| {},
        &TurnInputs {
            mcp_servers: &[],
            keychain: &KeychainStore::new(),
            skills: &fragments,
            skills_root: &skills_root,
            user_invocations: &user_invocations,
            disabled_skills: &[],
            cli_tools: &[],
            delegations: &[],
        },
    );
    // The scripted text reply lands as a textual outcome.
    assert!(
        matches!(outcome, TurnOutcome::Textual { .. }),
        "got {outcome:?}"
    );

    let guard = captured.lock().expect("capture lock");
    assert_eq!(
        guard.len(),
        1,
        "exactly one round-trip (terminal text reply)"
    );
    // The standing system prompt carries ONLY the metadata index -- the body
    // never rides it (ADR-0119 Decision 3).
    let system = &guard[0].system;
    assert!(
        system.contains("【可用技能】"),
        "metadata index present in the system prompt"
    );
    assert!(
        system.contains("- `sql-coach` — Coach the user on honest SQL reporting."),
        "index row present in the system prompt"
    );
    assert!(
        !system.contains(body.trim()),
        "the invocation body never rides the standing system prompt"
    );
    assert!(
        !system.contains("【技能调用】"),
        "no invocation frame in the system prompt"
    );
    // The tool-selection section (ADR-0087) rides the base prompt, guiding
    // the agent to use matching external tools regardless of source.
    assert!(
        system.contains("默认工具"),
        "tool-selection section missing"
    );
    assert!(
        system.contains("不区分工具来源"),
        "source-agnostic tool guidance missing"
    );
    // A USER invocation is turn input, not a mid-turn mutation (ADR-0119
    // Decision 4): its skill's attachments are readable within its OWN turn
    // -- the read surface mounts on the asking turn already.
    assert!(
        guard[0].tools.iter().any(|t| t.name == "read_skill_file"),
        "a user-invoked skill mounts the read surface on its own turn"
    );
    // The invocation body rides the turn input, AHEAD of the question: the
    // first user message is the framed preamble + the question.
    let first_user = guard[0]
        .messages
        .iter()
        .find_map(|m| match m {
            toptopduck_lib::provider::tool_calling::ToolTurnMessage::User { content } => {
                Some(content.clone())
            }
            _ => None,
        })
        .expect("at least one user message");
    let frame_pos = first_user
        .find("【技能调用】技能 `sql-coach`：")
        .expect("invocation frame in the turn input");
    let body_pos = first_user
        .find(body.trim())
        .expect("invocation body verbatim in the turn input");
    let question_pos = first_user.find("查询").expect("question in the turn input");
    assert!(
        body_pos < question_pos && frame_pos < body_pos,
        "frame + body precede the question"
    );
    drop(guard);

    // The turn's provenance is the invocation records' name set, and the
    // record itself persists on the turn.
    let recipe = session.build_recipe();
    let turn = last_turn(&recipe).expect("at least one turn in the recipe");
    assert_eq!(
        turn.provenance.skills,
        vec![SkillProvenance {
            name: "sql-coach".into(),
            content_hash: expected_hash.clone(),
        }],
        "provenance is the invocation name set with its pinned hash"
    );
    assert_eq!(turn.invocations.len(), 1, "the record persists on the turn");
    assert_eq!(turn.invocations[0].name, "sql-coach");
    assert_eq!(turn.invocations[0].body, body);
    assert_eq!(turn.invocations[0].actor, SkillLifecycleActor::User);
    assert_eq!(turn.invocations[0].content_hash, expected_hash);
}

/// ADR-0119 (issue #983) index shape: a snapshot skill nobody invoked lands
/// as a metadata index row -- name + description, no body -- and the turn's
/// provenance records the EMPTY invocation set (nothing shaped the answer).
/// The index wording names the `invoke_skill` channel.
#[test]
fn snapshot_skill_without_invocation_lands_index_row_not_body() {
    let skills_root = tempfile::tempdir().unwrap();
    let skills_root = skills_root.path().to_path_buf();
    let body = "When you use a native statistical method, name it in your answer.\n";
    put_skill(
        &skills_root,
        "sql-coach",
        "Coach the user on honest SQL reporting.",
        body,
    );

    let provider =
        FakeProvider::new().scripted_tool_turn("查询", ToolTurnReply::Text("done".into()));
    let captured = provider.captured_tool_turns();
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    session.set_discovery_snapshot(vec!["sql-coach".to_string()]);
    let snapshot = session.discovery_snapshot();
    let fragments: Vec<SkillPromptFragment> = resolve_prompt_fragments(&skills_root, &snapshot);

    let approval = ApprovalState::new();
    let sink = NullSink;
    let outcome = session.ask_with_phase(
        "查询",
        &approval,
        &sink,
        |_| {},
        &TurnInputs {
            mcp_servers: &[],
            keychain: &KeychainStore::new(),
            skills: &fragments,
            skills_root: &skills_root,
            user_invocations: &[],
            disabled_skills: &[],
            cli_tools: &[],
            delegations: &[],
        },
    );
    assert!(
        matches!(outcome, TurnOutcome::Textual { .. }),
        "got {outcome:?}"
    );

    let guard = captured.lock().expect("capture lock");
    let system = &guard[0].system;
    // The index block, word-for-word.
    assert!(
        system.contains(
            "\n\n【可用技能】\n以下技能可用。任务与某技能的描述匹配、或用户点名某技能时，调用 invoke_skill 工具展开其完整说明：\n\
             - `sql-coach` — Coach the user on honest SQL reporting.\n"
        ),
        "index entry must match the wording verbatim, got:\n{system}"
    );
    // No body, no invocation frame.
    assert!(
        !system.contains("【技能调用】"),
        "an uninvoked skill injects no invocation frame"
    );
    assert!(
        !system.contains(body.trim()),
        "an uninvoked skill injects no body"
    );
    drop(guard);

    // The turn's provenance records the (empty) invocation set.
    let recipe = session.build_recipe();
    let turn = last_turn(&recipe).expect("at least one turn");
    assert!(
        turn.provenance.skills.is_empty(),
        "an uninvoked skill contributes nothing to the turn's provenance"
    );
    assert!(
        turn.invocations.is_empty(),
        "no invocation record lands without an invocation"
    );
}

/// ADR-0119 (issue #983) multi-turn semantics: invocation bodies ride the
/// TURN input (never the standing prompt), repeat benefit comes from history
/// residence (a later turn reads the earlier frame from the windowed
/// messages, without re-invoking), the discovery index stays
/// byte-identical turn over turn (the snapshot never changes), and each
/// turn's provenance is exactly ITS OWN invocation name set.
#[test]
fn invocation_resides_in_history_and_index_stays_constant() {
    let skills_root = tempfile::tempdir().unwrap();
    let skills_root = skills_root.path().to_path_buf();
    put_skill(&skills_root, "alpha", "Alpha skill.", "Alpha body.\n");
    put_skill(&skills_root, "beta", "Beta skill.", "Beta body.\n");

    // Four scripted questions -- one per turn of the timeline.
    let provider = FakeProvider::new()
        .scripted_tool_turn("第一轮", ToolTurnReply::Text("one".into()))
        .scripted_tool_turn("第二轮", ToolTurnReply::Text("two".into()))
        .scripted_tool_turn("第三轮", ToolTurnReply::Text("three".into()))
        .scripted_tool_turn("第四轮", ToolTurnReply::Text("four".into()));
    let captured = provider.captured_tool_turns();
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    // The snapshot (immutable, creation-time) names BOTH skills: every turn
    // lists both index rows.
    session.set_discovery_snapshot(vec!["alpha".to_string(), "beta".to_string()]);

    let approval = ApprovalState::new();
    let sink = NullSink;
    let ask = |session: &mut Session, question: &str, skills_root: &Path, staged: &[&str]| {
        let snapshot = session.discovery_snapshot();
        let fragments = resolve_prompt_fragments(skills_root, &snapshot);
        let staged: Vec<String> = staged.iter().map(|s| s.to_string()).collect();
        let user_invocations = session.materialize_user_invocations(&staged, skills_root, &[]);
        session.ask_with_phase(
            question,
            &approval,
            &sink,
            |_| {},
            &TurnInputs {
                mcp_servers: &[],
                keychain: &KeychainStore::new(),
                skills: &fragments,
                skills_root,
                user_invocations: &user_invocations,
                disabled_skills: &[],
                cli_tools: &[],
                delegations: &[],
            },
        )
    };
    // The provenance names of the recipe's nth Turn entry (0-based).
    let provenance_names = |session: &Session, n: usize| -> Vec<String> {
        let recipe = session.build_recipe();
        let entries = turns(&recipe);
        entries[n]
            .provenance
            .skills
            .iter()
            .map(|s| s.name.clone())
            .collect()
    };

    // Turn 1: the user invokes beta -- its frame rides the turn input ahead
    // of the question; the standing prompt carries the wholesale index only.
    let outcome = ask(&mut session, "第一轮", &skills_root, &["beta"]);
    assert!(
        matches!(outcome, TurnOutcome::Textual { .. }),
        "got {outcome:?}"
    );
    {
        let guard = captured.lock().expect("capture lock");
        let system = &guard[0].system;
        assert!(
            system.contains("【可用技能】") && system.contains("- `alpha` — Alpha skill.\n"),
            "the wholesale index lists alpha"
        );
        assert!(
            system.contains("- `beta` — Beta skill.\n"),
            "the invoked skill keeps its index row too (wholesale listing)"
        );
        assert!(
            !system.contains("Beta body."),
            "no body in the standing prompt"
        );
        let user_text = message_text(&guard[0], 0);
        let frame = user_text
            .find("【技能调用】技能 `beta`：")
            .expect("invocation frame on the asking turn");
        let question = user_text.find("第一轮").expect("the question");
        assert!(frame < question, "the frame precedes the question");
        // Both meta-tools mount under a non-empty snapshot (the legacy
        // activate_skill stays live through the coexistence period;
        // invoke_skill is its successor).
        assert!(
            guard[0].tools.iter().any(|t| t.name == "activate_skill"),
            "a non-empty snapshot keeps the legacy activate_skill mounted"
        );
        assert!(
            guard[0].tools.iter().any(|t| t.name == "invoke_skill"),
            "a non-empty snapshot mounts invoke_skill"
        );
        drop(guard);
    }
    assert_eq!(
        provenance_names(&session, 0),
        vec!["beta".to_string()],
        "turn 1's provenance is exactly its own invocation set"
    );

    // Turn 2 (no new invocation): the standing prompt carries NO body -- the
    // persistent-injection tax is gone -- but beta's body stays reachable
    // through HISTORY: turn 1's frame replays in the windowed messages.
    let outcome = ask(&mut session, "第二轮", &skills_root, &[]);
    assert!(
        matches!(outcome, TurnOutcome::Textual { .. }),
        "got {outcome:?}"
    );
    {
        let guard = captured.lock().expect("capture lock");
        assert!(
            !guard[1].system.contains("Beta body."),
            "no re-injection into the standing prompt on an uninvoked turn"
        );
        let turn1_input = message_text(&guard[1], 0);
        assert!(
            turn1_input.contains("【技能调用】技能 `beta`："),
            "history replays turn 1's invocation frame: {}",
            turn1_input
        );
        drop(guard);
    }
    assert!(
        provenance_names(&session, 1).is_empty(),
        "an uninvoked turn records an empty provenance"
    );

    // Turn 3: the user invokes alpha -- the OTHER skill -- same mechanics.
    let outcome = ask(&mut session, "第三轮", &skills_root, &["alpha"]);
    assert!(
        matches!(outcome, TurnOutcome::Textual { .. }),
        "got {outcome:?}"
    );
    {
        let guard = captured.lock().expect("capture lock");
        let user_text = message_text(&guard[2], 2);
        assert!(user_text.contains("【技能调用】技能 `alpha`："));
        drop(guard);
    }
    assert_eq!(
        provenance_names(&session, 2),
        vec!["alpha".to_string()],
        "turn 3's provenance is exactly its own invocation set"
    );

    // Turn 4: beta again -- history accumulates both frames; the standing
    // prompt stayed byte-identical across every turn (the index never
    // changed).
    let outcome = ask(&mut session, "第四轮", &skills_root, &["beta"]);
    assert!(
        matches!(outcome, TurnOutcome::Textual { .. }),
        "got {outcome:?}"
    );
    {
        let guard = captured.lock().expect("capture lock");
        let user_text = message_text(&guard[3], 3);
        assert!(user_text.contains("【技能调用】技能 `beta`："));
        assert!(
            guard[0].system == guard[1].system
                && guard[1].system == guard[2].system
                && guard[2].system == guard[3].system,
            "the standing prompt is byte-identical across turns (prefix stability)"
        );
        drop(guard);
    }
    assert_eq!(
        provenance_names(&session, 3),
        vec!["beta".to_string()],
        "turn 4's provenance is exactly its own invocation set"
    );
    // The guard[n] indexing throughout assumes exactly one round-trip per
    // turn (every scripted reply is terminal) -- pinned so a future retry
    // round-trip cannot silently shift the indices.
    let guard = captured.lock().expect("capture lock");
    assert_eq!(guard.len(), 4, "one round-trip per turn");
}

/// AC #3 (negative space): with no skills mounted, the system prompt carries no
/// skill section at all (the base prompt's tool-selection section is always
/// present), and the provenance skills vec is empty. Every existing black-box
/// test also exercises this via `&[]`; pinned here for locality.
#[test]
fn empty_mount_set_omits_skill_section_and_provenance() {
    let provider = FakeProvider::new().scripted_tool_turn("你好", ToolTurnReply::Text("hi".into()));
    let captured = provider.captured_tool_turns();
    let mut session = Session::with_provider(Box::new(provider)).expect("session");

    let approval = ApprovalState::new();
    let sink = NullSink;
    let outcome = session.ask_with_phase(
        "你好",
        &approval,
        &sink,
        |_| {},
        &TurnInputs::empty(&KeychainStore::new()),
    );
    assert!(
        matches!(outcome, TurnOutcome::Textual { .. }),
        "got {outcome:?}"
    );

    let guard = captured.lock().expect("capture lock");
    let system = &guard[0].system;
    assert!(
        !system.contains("【可用技能】"),
        "no index block when nothing is mounted"
    );
    assert!(
        !system.contains("【激活技能】"),
        "no body block when nothing is mounted"
    );
    // The tool-selection section is always present in the base prompt
    // (ADR-0087) -- it names DuckDB as the default tool without injecting
    // a skill body.
    assert!(
        system.contains("默认工具"),
        "tool-selection section missing"
    );
    // The mount-conditional surface (issue #701): an EMPTY mounted set pays
    // no standing tool cost -- the trio's posture (ADR-0105 D6).
    assert!(
        !guard[0].tools.iter().any(|t| t.name == "activate_skill"),
        "an empty mounted set must not mount activate_skill"
    );
    drop(guard);

    let recipe = session.build_recipe();
    let turn = last_turn(&recipe).expect("at least one turn");
    assert!(
        turn.provenance.skills.is_empty(),
        "no skills in provenance when nothing is mounted"
    );
}

/// #656 / ADR-0106: enablement is the machine-level single axis -- a
/// configured-but-DISABLED server stays out of the enabled slice entirely
/// (dormant = no catalog tools; the agent refuses honestly at the capability
/// boundary).
#[test]
fn disabled_mcp_server_stays_out_of_the_enabled_slice() {
    // A live config carrying the server, toggled OFF.
    let cfg_dir = tempfile::tempdir().unwrap();
    let live = LiveProviderConfig::new(KeychainStore::new(), cfg_dir.path().join("config.json"));
    live.upsert_mcp_server(McpServerConfig {
        id: McpServerId("off-b".into()),
        display_name: "Off B".into(),
        transport: McpTransport::stdio("/bin/srv", Vec::new()),
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        keychain_header_keys: Vec::new(),
        timeout_ms: None,
        enabled: false,
    })
    .expect("upsert off-b");

    // The slice `ask` feeds the aggregator stays without it.
    assert!(
        live.enabled_mcp_servers()
            .iter()
            .all(|s| s.id.as_str() != "off-b"),
        "a disabled server never reaches the enabled slice"
    );
}

/// The mid-turn persistence probe (issue #701): round 1 emits the
/// `activate_skill` call; round 2 -- after the dispatch has returned, before
/// the turn has ended -- reads the bound `.duck` off the disk, records
/// whether the `Activate` event is already there, and fails the turn
/// (permanent NotWired). A batched-at-turn-end persist would miss the read.
struct ProbeThenFailProvider {
    duck_path: std::path::PathBuf,
    calls: std::sync::atomic::AtomicUsize,
    midturn_activate_on_disk: std::sync::atomic::AtomicBool,
}

impl toptopduck_lib::Provider for ProbeThenFailProvider {
    fn generate_tool_turn(
        &self,
        _request: &toptopduck_lib::provider::tool_calling::ToolTurnRequest,
    ) -> Result<
        toptopduck_lib::provider::tool_calling::ToolTurnOutcome,
        toptopduck_lib::ProviderError,
    > {
        use std::sync::atomic::Ordering;
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            Ok(toptopduck_lib::provider::tool_calling::ToolTurnOutcome {
                thinking: Vec::new(),
                reply: ToolTurnReply::tool_calls(vec![
                    toptopduck_lib::provider::tool_calling::ToolUse {
                        id: "tu_s".into(),
                        name: "activate_skill".into(),
                        input: serde_json::json!({"name": "sql-coach"}),
                    },
                ]),
            })
        } else {
            let text = fs::read_to_string(&self.duck_path).unwrap_or_default();
            self.midturn_activate_on_disk.store(
                text.contains("\"Activate\"") && text.contains("sql-coach"),
                Ordering::SeqCst,
            );
            Err(toptopduck_lib::ProviderError::NotWired)
        }
    }
}

/// AC (issue #701, the session-level pin): an agent activation lands on the
/// timeline AND persists to the bound recipe INSIDE the dispatch call
/// (real-time, atomic), the `Activate` marker precedes the turn's own entry
/// (fact-order rendering), and a turn that FAILS afterwards keeps the
/// activation on disk + on resume (the exit is unmount, never a failed
/// turn).
#[test]
fn agent_activation_persists_midturn_and_survives_turn_failure() {
    use std::sync::atomic::Ordering;
    let skills_root = tempfile::tempdir().unwrap();
    let skills_root = skills_root.path().to_path_buf();
    put_skill(&skills_root, "sql-coach", "Coach SQL.", "Coach the SQL.\n");

    let duck_dir = tempfile::tempdir().unwrap();
    let duck_path = duck_dir.path().join("mid.duck");

    let provider = ProbeThenFailProvider {
        duck_path: duck_path.clone(),
        calls: std::sync::atomic::AtomicUsize::new(0),
        midturn_activate_on_disk: std::sync::atomic::AtomicBool::new(false),
    };
    let probe = Arc::new(provider);
    let mut session = Session::with_provider(Box::new(ProbeHandle {
        inner: Arc::clone(&probe),
    }))
    .expect("session");
    session.mount_skill("sql-coach").expect("mount");
    session
        .bind_duck(duck_path.clone(), "mid".into())
        .expect("bind");
    let fragments = resolve_prompt_fragments(&skills_root, &session.mounted_skills());

    let approval = ApprovalState::new();
    let outcome = session.ask_with_phase(
        "查询",
        &approval,
        &NullSink,
        |_| {},
        &TurnInputs {
            mcp_servers: &[],
            keychain: &KeychainStore::new(),
            skills: &fragments,
            skills_root: &skills_root,
            user_invocations: &[],
            disabled_skills: &[],
            cli_tools: &[],
            delegations: &[],
        },
    );
    // The turn itself failed (the probe's round 2 is a permanent fault)...
    assert!(
        matches!(outcome, TurnOutcome::Failed { .. }),
        "got {outcome:?}"
    );
    // ...but the activation had already crossed to disk INSIDE the dispatch.
    assert!(
        probe.midturn_activate_on_disk.load(Ordering::SeqCst),
        "the Activate event must be on disk before the turn ends"
    );
    // ...and it survives the failed turn on the live session state.
    assert_eq!(session.activated_skills(), vec!["sql-coach".to_string()]);
    // Fact-order rendering: the Activate marker precedes the turn's own
    // entry in the persisted history (the event happened mid-turn).
    let recipe = session.build_recipe();
    let activate_pos = recipe
        .history
        .iter()
        .position(|e| matches!(e, RecipeEntry::Skill(ev) if ev.name == "sql-coach"))
        .expect("an Activate entry in history");
    let last_turn_pos = recipe
        .history
        .iter()
        .rposition(|e| matches!(e, RecipeEntry::Turn(_)))
        .expect("the failed turn in history");
    assert!(
        activate_pos < last_turn_pos,
        "the Activate marker precedes the failed turn's entry"
    );

    // Resume rebuilds the activated set off the persisted events -- the
    // activation outlives the failed turn across a restart. The live
    // session must drop first: it owns the canonical key.
    drop(session);
    let resumed = Session::open_duck(
        &duck_path,
        Arc::new(toptopduck_lib::CancelToken::new()),
        Box::new(toptopduck_lib::UnwiredProvider),
        Default::default(),
        |_| {},
        |_| toptopduck_lib::SourceResolution::Abort,
        |_| toptopduck_lib::ActiveResolution::Abort,
    )
    .expect("resume");
    assert_eq!(
        resumed.activated_skills(),
        vec!["sql-coach".to_string()],
        "the activation survives the restart"
    );
}

/// The Arc-backed handle so the session owns a `Box<dyn Provider>` while
/// the test keeps read access to the probe's atomics.
struct ProbeHandle {
    inner: Arc<ProbeThenFailProvider>,
}

impl toptopduck_lib::Provider for ProbeHandle {
    fn generate_tool_turn(
        &self,
        request: &toptopduck_lib::provider::tool_calling::ToolTurnRequest,
    ) -> Result<
        toptopduck_lib::provider::tool_calling::ToolTurnOutcome,
        toptopduck_lib::ProviderError,
    > {
        self.inner.generate_tool_turn(request)
    }
}

/// The read-surface probe (issue #714): round 1 of each turn inspects the
/// turn's tool table (does `read_skill_file` ride it?); round 1 of turn 1
/// activates mid-turn; round 2 of turn 2 captures the served read result the
/// provider sees fed back.
struct ReadSurfaceProbeProvider {
    calls: std::sync::atomic::AtomicUsize,
    read_mounted: [std::sync::atomic::AtomicBool; 2],
    served_text: std::sync::Mutex<String>,
}

impl toptopduck_lib::Provider for ReadSurfaceProbeProvider {
    fn generate_tool_turn(
        &self,
        request: &toptopduck_lib::provider::tool_calling::ToolTurnRequest,
    ) -> Result<
        toptopduck_lib::provider::tool_calling::ToolTurnOutcome,
        toptopduck_lib::ProviderError,
    > {
        use std::sync::atomic::Ordering;
        let has_read = request.tools.iter().any(|t| t.name == "read_skill_file");
        match self.calls.fetch_add(1, Ordering::SeqCst) {
            0 => {
                self.read_mounted[0].store(has_read, Ordering::SeqCst);
                Ok(toptopduck_lib::provider::tool_calling::ToolTurnOutcome {
                    thinking: Vec::new(),
                    reply: ToolTurnReply::tool_calls(vec![
                        toptopduck_lib::provider::tool_calling::ToolUse {
                            id: "tu_s".into(),
                            name: "invoke_skill".into(),
                            input: serde_json::json!({"name": "sql-coach"}),
                        },
                    ]),
                })
            }
            1 => Ok(toptopduck_lib::provider::tool_calling::ToolTurnOutcome {
                thinking: Vec::new(),
                reply: ToolTurnReply::Text("turn one done".into()),
            }),
            2 => {
                self.read_mounted[1].store(has_read, Ordering::SeqCst);
                Ok(toptopduck_lib::provider::tool_calling::ToolTurnOutcome {
                    thinking: Vec::new(),
                    reply: ToolTurnReply::tool_calls(vec![
                        toptopduck_lib::provider::tool_calling::ToolUse {
                            id: "tu_r".into(),
                            name: "read_skill_file".into(),
                            input: serde_json::json!({
                                "name": "sql-coach",
                                "path": "references/notes.md"
                            }),
                        },
                    ]),
                })
            }
            _ => {
                *self.served_text.lock().unwrap() = request
                    .messages
                    .iter()
                    .find_map(|m| match m {
                        toptopduck_lib::provider::tool_calling::ToolTurnMessage::ToolResult {
                            content,
                            ..
                        } => Some(content.clone()),
                        _ => None,
                    })
                    .unwrap_or_default();
                Ok(toptopduck_lib::provider::tool_calling::ToolTurnOutcome {
                    thinking: Vec::new(),
                    reply: ToolTurnReply::Text("turn two done".into()),
                })
            }
        }
    }
}

/// The Arc-backed handle for [`ReadSurfaceProbeProvider`] (the
/// [`ProbeHandle`] shape).
struct ReadProbeHandle {
    inner: Arc<ReadSurfaceProbeProvider>,
}

impl toptopduck_lib::Provider for ReadProbeHandle {
    fn generate_tool_turn(
        &self,
        request: &toptopduck_lib::provider::tool_calling::ToolTurnRequest,
    ) -> Result<
        toptopduck_lib::provider::tool_calling::ToolTurnOutcome,
        toptopduck_lib::ProviderError,
    > {
        self.inner.generate_tool_turn(request)
    }
}

/// The read surface's mount condition + mid-turn timing, end to end (issue
/// #714, ADR-0111 Decisions 1/3 calibrated by ADR-0119 Decision 4): turn 1
/// (invoked set EMPTY) mounts NO `read_skill_file` even though the skill is
/// in the snapshot -- reading rides the invoked gate; the agent's mid-turn
/// `invoke_skill` lands the record on the turn but never widens the CURRENT
/// turn's table; turn 2 -- whose turn-start fold carries the name -- mounts
/// the tool and serves the file text into the tool result the provider's
/// next round sees.
#[test]
fn read_surface_mounts_next_turn_and_serves_after_midturn_invocation() {
    use std::sync::atomic::Ordering;
    let skills_root = tempfile::tempdir().unwrap();
    let skills_root = skills_root.path().to_path_buf();
    put_skill(&skills_root, "sql-coach", "Coach SQL.", "Coach the SQL.\n");
    fs::create_dir_all(skills_root.join("sql-coach").join("references")).unwrap();
    fs::write(
        skills_root
            .join("sql-coach")
            .join("references")
            .join("notes.md"),
        "Use CTEs.\n",
    )
    .unwrap();

    let provider = Arc::new(ReadSurfaceProbeProvider {
        calls: std::sync::atomic::AtomicUsize::new(0),
        read_mounted: [
            std::sync::atomic::AtomicBool::new(false),
            std::sync::atomic::AtomicBool::new(false),
        ],
        served_text: std::sync::Mutex::new(String::new()),
    });
    let mut session = Session::with_provider(Box::new(ReadProbeHandle {
        inner: Arc::clone(&provider),
    }))
    .expect("session");
    session.set_discovery_snapshot(vec!["sql-coach".to_string()]);
    let fragments = resolve_prompt_fragments(&skills_root, &session.discovery_snapshot());
    let approval = ApprovalState::new();

    // Turn 1: the invoked set is empty -- no read surface.
    let outcome = session.ask_with_phase(
        "查询",
        &approval,
        &NullSink,
        |_| {},
        &TurnInputs {
            mcp_servers: &[],
            keychain: &KeychainStore::new(),
            skills: &fragments,
            user_invocations: &[],
            disabled_skills: &[],
            skills_root: &skills_root,
            cli_tools: &[],
            delegations: &[],
        },
    );
    assert!(
        matches!(outcome, TurnOutcome::Textual { .. }),
        "got {outcome:?}"
    );
    assert!(
        !provider.read_mounted[0].load(Ordering::SeqCst),
        "an empty invoked set mounts no read tool"
    );
    assert_eq!(
        session.invoked_skills(),
        vec!["sql-coach".to_string()],
        "the mid-turn agent invocation landed on the session fold"
    );
    // The mid-turn invocation's record rides turn 1 with the AGENT actor +
    // the pinned body.
    let recipe = session.build_recipe();
    let turn = last_turn(&recipe).expect("turn 1");
    assert_eq!(turn.invocations.len(), 1);
    assert_eq!(turn.invocations[0].name, "sql-coach");
    assert_eq!(turn.invocations[0].actor, SkillLifecycleActor::Agent);
    assert_eq!(turn.invocations[0].body, "Coach the SQL.\n");

    // Turn 2: the turn-start fold now carries the name.
    let outcome = session.ask_with_phase(
        "再查",
        &approval,
        &NullSink,
        |_| {},
        &TurnInputs {
            mcp_servers: &[],
            keychain: &KeychainStore::new(),
            skills: &fragments,
            user_invocations: &[],
            disabled_skills: &[],
            skills_root: &skills_root,
            cli_tools: &[],
            delegations: &[],
        },
    );
    assert!(
        matches!(outcome, TurnOutcome::Textual { .. }),
        "got {outcome:?}"
    );
    assert!(
        provider.read_mounted[1].load(Ordering::SeqCst),
        "the next turn's snapshot mounts the read tool"
    );
    assert_eq!(
        *provider.served_text.lock().unwrap(),
        "Use CTEs.\n",
        "the file text rode the tool result back to the provider"
    );
}
