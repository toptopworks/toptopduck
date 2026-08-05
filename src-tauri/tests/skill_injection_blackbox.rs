//! Integration test: mounted-skill prompt injection + provenance (issue #364,
//! ADR-0086).
//!
//! Drives the built-in agent loop end-to-end with a skill mounted, then asserts
//! the two surfaces issue #364 wires:
//!   1. The skill's body lands in the system prompt the provider receives
//!      (framed per ADR-0086, mount order, verbatim) -- AC #1.
//!   2. The turn's persisted provenance records `{name, content_hash}` with the
//!      SHA-256 of the whole `SKILL.md` -- AC #3.
//!
//! The empty-mount case (AC #4) is covered by every existing black-box test --
//! they pass `&[]` for skills and see no skill section -- so this file focuses
//! on the positive path.

use std::fs;
use std::path::Path;

use toptopduck_lib::model::SkillProvenance;
use toptopduck_lib::persistence::recipe::RecipeEntry;
use toptopduck_lib::provider::tool_calling::ToolTurnReply;
use toptopduck_lib::skills::{resolve_prompt_fragments, SkillPromptFragment};
use toptopduck_lib::util::sha256_hex;
use toptopduck_lib::{
    ApprovalRequestBody, ApprovalResponse, ApprovalSink, ApprovalState, FakeProvider,
    KeychainStore, Session, TurnOutcome,
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

/// AC #1 + AC #3: a mounted skill's body rides the system prompt and its
/// `{name, content_hash}` rides the turn's provenance.
#[test]
fn mounted_skill_body_in_prompt_and_provenance() {
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
    // Mount the skill on the session timeline, then resolve its body + hash
    // from the registry root at the command boundary (mirroring `commands::ask`).
    session.mount_skill("sql-coach").expect("mount");
    let mounted = session.mounted_skills();
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
        &[],
        &KeychainStore::new(),
        &fragments,
    );
    // The scripted text reply lands as a textual outcome.
    assert!(
        matches!(outcome, TurnOutcome::Textual { .. }),
        "got {outcome:?}"
    );

    // AC #1: the skill body + its ADR-0086 frame landed in the system prompt
    // the provider received (captured on the first / only round-trip).
    let guard = captured.lock().expect("capture lock");
    assert_eq!(
        guard.len(),
        1,
        "exactly one round-trip (terminal text reply)"
    );
    let system = &guard[0].system;
    assert!(
        system.contains("【挂载技能】技能 `sql-coach`："),
        "skill frame missing from system prompt"
    );
    assert!(
        system.contains(body.trim()),
        "skill body must be verbatim in the system prompt"
    );
    // The skill-aware boundary clause (AC #2) also rides the base prompt.
    assert!(system.contains("挂载技能"));
    assert!(system.contains("显式提供"));
    drop(guard);

    // AC #3: the turn's provenance records {name, content_hash}. The recipe is
    // the persisted form -- its last turn entry carries the audit's provenance.
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
        "provenance must snapshot the skill's name + whole-file hash"
    );
}

/// AC #4 (negative space): with no skills mounted, the system prompt carries no
/// skill-body section (only the always-on skill-aware clause in the base
/// prompt), and the provenance skills vec is empty. Every existing black-box
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
        &[],
        &KeychainStore::new(),
        &[],
    );
    assert!(
        matches!(outcome, TurnOutcome::Textual { .. }),
        "got {outcome:?}"
    );

    let guard = captured.lock().expect("capture lock");
    let system = &guard[0].system;
    assert!(
        !system.contains("【挂载技能】"),
        "no skill-body section when nothing is mounted"
    );
    // The skill-aware clause is always present in the base prompt (AC #2) --
    // it names 挂载技能 in prose without injecting a body.
    assert!(system.contains("挂载技能"));
    drop(guard);

    let recipe = session.build_recipe();
    let last_turn = recipe
        .history
        .iter()
        .rev()
        .find_map(|e| match e {
            RecipeEntry::Turn(t) => Some(t),
            _ => None,
        })
        .expect("at least one turn");
    assert!(
        last_turn.provenance.skills.is_empty(),
        "no skills in provenance when nothing is mounted"
    );
}
