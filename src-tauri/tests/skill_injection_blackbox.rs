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

/// AC #2 (activated bodies) + AC #6 (built-in provenance): an ACTIVATED
/// skill's body rides the system prompt in the 【激活技能】 frame and its
/// `{name, content_hash}` rides the turn's provenance -- the built-in turn
/// records the activated subset (ADR-0110 Decision 5; issue #700).
#[test]
fn activated_skill_body_in_prompt_and_provenance() {
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
    // resolver hashed at turn time.
    let skill_md_bytes = fs::read(skills_root.join("sql-coach").join("SKILL.md")).unwrap();
    let expected_hash = sha256_hex(&skill_md_bytes);

    // Script the fake to terminate immediately with a text reply (no tool
    // calls) so the single round-trip surfaces the assembled system prompt in
    // capture[0] and the turn ends without touching DuckDB.
    let provider =
        FakeProvider::new().scripted_tool_turn("查询", ToolTurnReply::Text("done".into()));
    let captured = provider.captured_tool_turns();
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    // Mount + activate the skill on the session timeline, then resolve its
    // fragments + the activated list at the command boundary (mirroring
    // `commands::ask`).
    session.mount_skill("sql-coach").expect("mount");
    session
        .activate_skill("sql-coach", SkillLifecycleActor::User)
        .expect("activate");
    let mounted = session.mounted_skills();
    let activated = session.activated_skills();
    let fragments: Vec<SkillPromptFragment> = resolve_prompt_fragments(&skills_root, &mounted);
    assert_eq!(fragments.len(), 1);
    assert_eq!(fragments[0].name, "sql-coach");
    assert_eq!(fragments[0].content_hash, expected_hash);

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
            activated: &activated,
            cli_tools: &[],
        },
    );
    // The scripted text reply lands as a textual outcome.
    assert!(
        matches!(outcome, TurnOutcome::Textual { .. }),
        "got {outcome:?}"
    );

    // The activated body + its ADR-0110 frame landed in the system prompt the
    // provider received (captured on the first / only round-trip).
    let guard = captured.lock().expect("capture lock");
    assert_eq!(
        guard.len(),
        1,
        "exactly one round-trip (terminal text reply)"
    );
    let system = &guard[0].system;
    assert!(
        system.contains("【激活技能】技能 `sql-coach`："),
        "activated skill frame missing from system prompt"
    );
    assert!(
        system.contains(body.trim()),
        "activated skill body must be verbatim in the system prompt"
    );
    assert!(
        !system.contains("【可用技能】"),
        "no index block when the only mount is activated"
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
    drop(guard);

    // The turn's provenance records {name, content_hash}. The recipe is
    // the persisted form -- its last turn entry carries the audit's provenance.
    let recipe = session.build_recipe();
    let turn = last_turn(&recipe).expect("at least one turn in the recipe");
    assert_eq!(
        turn.provenance.skills,
        vec![SkillProvenance {
            name: "sql-coach".into(),
            content_hash: expected_hash,
        }],
        "provenance must snapshot the activated skill's name + whole-file hash"
    );
}

/// AC #1 + AC #3 (index shape): a mounted-but-not-activated skill lands as a
/// metadata index entry -- name + description, no body -- and the built-in
/// turn's provenance records the EMPTY activated set (nothing shaped the
/// answer). The index wording is the locked terminal contract from issue
/// #700's brief.
#[test]
fn mounted_not_activated_lands_index_entry_not_body() {
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
    session.mount_skill("sql-coach").expect("mount");
    let mounted = session.mounted_skills();
    let activated = session.activated_skills();
    assert!(activated.is_empty(), "mounting alone never activates");
    let fragments: Vec<SkillPromptFragment> = resolve_prompt_fragments(&skills_root, &mounted);

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
            activated: &activated,
            cli_tools: &[],
        },
    );
    assert!(
        matches!(outcome, TurnOutcome::Textual { .. }),
        "got {outcome:?}"
    );

    let guard = captured.lock().expect("capture lock");
    let system = &guard[0].system;
    // The index block, word-for-word per the locked contract.
    assert!(
        system.contains(
            "\n\n【可用技能】\n以下技能已挂载。任务与某技能的描述匹配、或用户点名某技能时，调用 activate_skill 工具加载其完整说明：\n\
             - `sql-coach` — Coach the user on honest SQL reporting.\n"
        ),
        "index entry must match the locked terminal wording, got:\n{system}"
    );
    // No body, no activated frame.
    assert!(
        !system.contains("【激活技能】"),
        "an unactivated skill injects no body frame"
    );
    assert!(
        !system.contains(body.trim()),
        "an unactivated skill injects no body"
    );
    drop(guard);

    // The built-in provenance records the (empty) activated set.
    let recipe = session.build_recipe();
    let turn = last_turn(&recipe).expect("at least one turn");
    assert!(
        turn.provenance.skills.is_empty(),
        "an unactivated mount contributes nothing to the built-in provenance"
    );
}

/// AC #2/#3 tails + the both-present block order: with one skill mounted and
/// another activated, the index block precedes the activated body; unmounting
/// the activated skill cascades it out of BOTH blocks (and the index-only
/// skill leaves the index when unmounted) -- ADR-0110 Decision 2.
#[test]
fn disclosure_orders_index_before_bodies_and_unmount_cascades() {
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
    session.mount_skill("alpha").expect("mount alpha");
    session.mount_skill("beta").expect("mount beta");
    session
        .activate_skill("beta", SkillLifecycleActor::User)
        .expect("activate beta");

    let approval = ApprovalState::new();
    let sink = NullSink;
    let ask = |session: &mut Session, question: &str, skills_root: &Path| {
        let mounted = session.mounted_skills();
        let activated = session.activated_skills();
        let fragments = resolve_prompt_fragments(skills_root, &mounted);
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
                activated: &activated,
                cli_tools: &[],
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

    // Turn 1: index (alpha) precedes the activated body (beta); each skill
    // appears on exactly its own level.
    let outcome = ask(&mut session, "第一轮", &skills_root);
    assert!(
        matches!(outcome, TurnOutcome::Textual { .. }),
        "got {outcome:?}"
    );
    {
        let guard = captured.lock().expect("capture lock");
        let system = &guard[0].system;
        let index_pos = system.find("【可用技能】").expect("index block present");
        let body_pos = system
            .find("【激活技能】技能 `beta`")
            .expect("activated body present");
        assert!(
            index_pos < body_pos,
            "index block precedes activated bodies"
        );
        assert!(
            system.contains("- `alpha` — Alpha skill.\n"),
            "alpha index entry missing"
        );
        assert!(!system.contains("Alpha body."), "inactive body absent");
        assert!(!system.contains("- `beta`"), "activated skill not indexed");
        // The built-in face's mount-conditional surface (issue #701): a
        // non-empty mounted set advertises the activation channel.
        assert!(
            guard[0].tools.iter().any(|t| t.name == "activate_skill"),
            "a non-empty mounted set mounts activate_skill on the tool table"
        );
        drop(guard);
    }
    // The same turn's provenance records exactly the activated subset -- the
    // render fork and the provenance fork live in different files, so pinning
    // both here catches them diverging.
    assert_eq!(
        provenance_names(&session, 0),
        vec!["beta".to_string()],
        "the mixed turn's provenance records exactly the activated set"
    );

    // Turn 2 (nothing changed): the activated body keeps injecting turn over
    // turn -- activation is a persistent state, not a one-shot (ADR-0110
    // Decision 3).
    let outcome = ask(&mut session, "第二轮", &skills_root);
    assert!(
        matches!(outcome, TurnOutcome::Textual { .. }),
        "got {outcome:?}"
    );
    {
        let guard = captured.lock().expect("capture lock");
        let system = &guard[1].system;
        assert!(
            system.contains("【激活技能】技能 `beta`："),
            "activated body frame missing on the unchanged turn"
        );
        assert!(
            system.contains("Beta body."),
            "the activated body rides the unchanged turn"
        );
        drop(guard);
    }
    assert_eq!(
        provenance_names(&session, 1),
        vec!["beta".to_string()],
        "an unchanged activation keeps recording in the provenance"
    );

    // Unmount the ACTIVATED skill: it leaves both the activated set (cascade)
    // and the mounted set, so turn 3 shows beta nowhere and alpha still
    // indexed.
    session.unmount_skill("beta").expect("unmount beta");
    let outcome = ask(&mut session, "第三轮", &skills_root);
    assert!(
        matches!(outcome, TurnOutcome::Textual { .. }),
        "got {outcome:?}"
    );
    {
        let guard = captured.lock().expect("capture lock");
        let system = &guard[2].system;
        assert!(
            !system.contains("beta"),
            "an unmounted skill is gone entirely"
        );
        assert!(
            system.contains("- `alpha` — Alpha skill.\n"),
            "alpha still indexed after beta's unmount"
        );
        drop(guard);
    }
    assert!(
        provenance_names(&session, 2).is_empty(),
        "the unmounted skill's activation leaves the provenance too"
    );

    // Unmount the INDEX-ONLY skill: it leaves the index; with no mount and no
    // activation left, turn 4 renders neither block at all.
    session.unmount_skill("alpha").expect("unmount alpha");
    let outcome = ask(&mut session, "第四轮", &skills_root);
    assert!(
        matches!(outcome, TurnOutcome::Textual { .. }),
        "got {outcome:?}"
    );
    {
        let guard = captured.lock().expect("capture lock");
        let system = &guard[3].system;
        assert!(
            !system.contains("alpha"),
            "the last unmount clears the index"
        );
        assert!(
            !system.contains("【可用技能】") && !system.contains("【激活技能】"),
            "an empty mount set renders neither block"
        );
        drop(guard);
    }
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

/// #656 AC7 / ADR-0106: a skill's MCP references are declarative metadata.
/// Fragment resolution never consults MCP enablement, and a
/// configured-but-DISABLED referenced server contributes nothing to the
/// effective set (its tools stay out of the catalog; the agent refuses
/// honestly at the capability boundary). The fragment itself resolves
/// undegraded -- the body injects and the declaration rides along as data.
#[test]
fn skill_declaring_disabled_server_mounts_and_stays_declarative() {
    let skills_root = tempfile::tempdir().unwrap();
    let skill_dir = skills_root.path().join("duck-writer");
    fs::create_dir_all(&skill_dir).unwrap();
    fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: duck-writer\ndescription: Write .duck files.\nmetadata:\n  toptopduck_mcp_servers: off-b\n---\nUse the duck-tools server when it is available.\n",
    )
    .unwrap();

    // A live config carrying the declared server, toggled OFF.
    let cfg_dir = tempfile::tempdir().unwrap();
    let live = LiveProviderConfig::new(KeychainStore::new(), cfg_dir.path().join("config.json"));
    live.upsert_mcp_server(McpServerConfig {
        id: McpServerId("off-b".into()),
        display_name: "Off B".into(),
        transport: McpTransport::stdio("/bin/srv", Vec::new()),
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        timeout_ms: None,
        enabled: false,
    })
    .expect("upsert off-b");

    // Mount side: the fragment resolves from the registry alone -- the body
    // is injected verbatim and the declaration is retained as metadata.
    let fragments = resolve_prompt_fragments(skills_root.path(), &["duck-writer".to_string()]);
    assert_eq!(fragments.len(), 1);
    assert_eq!(fragments[0].name, "duck-writer");
    assert!(
        fragments[0].body.contains("duck-tools"),
        "the declared body resolves undegraded"
    );
    assert_eq!(fragments[0].mcp_servers, vec!["off-b".to_string()]);

    // Effective-set side: the declaration never re-arms the disabled server
    // -- the slice `ask` feeds the aggregator stays without it.
    assert!(
        live.enabled_mcp_servers()
            .iter()
            .all(|s| s.id.as_str() != "off-b"),
        "a skill declaration never re-arms a disabled server"
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
            activated: &[],
            cli_tools: &[],
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
                            name: "activate_skill".into(),
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
/// #714, ADR-0111 Decisions 1/3): turn 1 (activated snapshot EMPTY) mounts
/// NO `read_skill_file` even though the skill is mounted -- reading rides
/// the activation gate; the agent's mid-turn activation lands but never
/// widens the CURRENT turn's table; turn 2 -- whose turn-start snapshot
/// carries the name -- mounts the tool and serves the file text into the
/// tool result the provider's next round sees.
#[test]
fn read_surface_mounts_next_turn_and_serves_after_midturn_activation() {
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
    session.mount_skill("sql-coach").expect("mount");
    let fragments = resolve_prompt_fragments(&skills_root, &session.mounted_skills());
    let approval = ApprovalState::new();

    // Turn 1: the activated snapshot is empty -- no read surface.
    let outcome = session.ask_with_phase(
        "查询",
        &approval,
        &NullSink,
        |_| {},
        &TurnInputs {
            mcp_servers: &[],
            keychain: &KeychainStore::new(),
            skills: &fragments,
            activated: &[],
            skills_root: &skills_root,
            cli_tools: &[],
        },
    );
    assert!(
        matches!(outcome, TurnOutcome::Textual { .. }),
        "got {outcome:?}"
    );
    assert!(
        !provider.read_mounted[0].load(Ordering::SeqCst),
        "an empty activated snapshot mounts no read tool"
    );
    assert_eq!(
        session.activated_skills(),
        vec!["sql-coach".to_string()],
        "the mid-turn agent activation landed"
    );

    // Turn 2: the turn-start snapshot now carries the name.
    let activated = vec!["sql-coach".to_string()];
    let outcome = session.ask_with_phase(
        "再查",
        &approval,
        &NullSink,
        |_| {},
        &TurnInputs {
            mcp_servers: &[],
            keychain: &KeychainStore::new(),
            skills: &fragments,
            activated: &activated,
            skills_root: &skills_root,
            cli_tools: &[],
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
