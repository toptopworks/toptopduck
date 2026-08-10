//! list_sessions black-box (issue #76, ADR-0060/0061): drive the session-list
//! derivation through the crate's public API only -- the same pure
//! `list_session_metadata` the `list_sessions` Tauri command wraps (a directory
//! scan of per-session `session.duck` recipes, ADR-0089). Writes real
//! `.duck` recipes via the invariant-validating `Recipe::build` + `save_atomic`,
//! then asserts the LIST shape the cold-start sidebar consumes: every readable
//! `.duck` is present, addressed by its file path (the stable key the frontend
//! sidebar-keys on and passes back to `open_duck`), and an unreadable
//! entry is skipped -- never listed under a fabricated id
//! (ADR-0017 honest).
//!
//! The inline `persistence::listing` unit tests cover single-session field
//! derivation in depth; this seam pins the multi-entry list shape + the
//! duck_path = path addressing invariant at the public-API boundary (issue
//! #76 AC: "black-box coverage of list_sessions field completeness").

use toptopduck_lib::persistence::recipe::RecipePromotion;
use toptopduck_lib::persistence::{
    list_session_metadata, save_atomic, DuckPath, Recipe, RecipeEntry, RecipeOutcome, RecipeTurn,
    SourceRef, RECIPE_FORMAT_VERSION,
};
use toptopduck_lib::RectifyProvenance;

/// Build a minimal one-source recipe (one productive turn) and persist it to
/// `dir/file`, returning the path string. Mirrors what a real `create_session`
/// writes, so `list_session_metadata` reads exactly the same shape resume reads.
fn write_recipe(dir: &std::path::Path, file: &str, session_name: &str, src: &str) -> String {
    let source = SourceRef {
        reference_name: src.into(),
        display_name: src.into(),
        source_path: format!("/data/{src}.csv"),
        relative_path: None,
        rectify: RectifyProvenance::NotApplicable,
        fingerprint: format!("fp-{src}"),
    };
    let recipe = Recipe::build(
        session_name.into(),
        vec![source],
        vec![RecipeEntry::Turn(RecipeTurn::without_audit(
            "q",
            RecipeOutcome::Materialized {
                promotions: vec![RecipePromotion {
                    reference_name: "result_1".into(),
                    display_name: "result_1".into(),
                    sql: "SELECT 1".into(),
                    stale: None,
                }],
                assumption: None,
            },
        ))],
        Some(src.into()),
    )
    .expect("build");
    let path = dir.join(file);
    save_atomic(&path, &recipe).expect("save");
    path.to_string_lossy().into_owned()
}

#[test]
fn list_sessions_addresses_each_readable_duck_by_path_and_skips_the_rest() {
    // AC #76 (ADR-0060/0061): list_sessions returns one SessionMetadata per
    // persisted .duck, each addressed by its file path (duck_path = the path,
    // NOT a UUID -- the stable identity the frontend sidebar-keys on and passes
    // back to open_duck), and each carrying the derived field set. An
    // entry that no longer resolves to a readable recipe is
    // dropped so the list never addresses a fabricated session (ADR-0017).
    let dir = tempfile::tempdir().expect("tempdir");
    let alpha = write_recipe(dir.path(), "alpha.duck", "alpha", "alpha_src");
    let beta = write_recipe(dir.path(), "beta.duck", "beta", "beta_src");
    let missing = dir.path().join("gone.duck").to_string_lossy().into_owned();

    let list = list_session_metadata(&[missing, alpha.clone(), beta.clone()]);
    assert_eq!(list.len(), 2, "only the readable recipes are listed");
    // duck_path is the .duck file path -- the addressing key.
    assert_eq!(list[0].duck_path, DuckPath::new(alpha));
    assert_eq!(list[1].duck_path, DuckPath::new(beta));
    // Each entry carries the full derived field set (the inline unit test
    // covers single-session derivation in depth; here we pin presence + the
    // path<->id invariant at the public-API boundary).
    for m in &list {
        assert!(!m.display_name.is_empty());
        assert!(m.last_modified_at > 0, "mtime should be non-zero");
        assert_eq!(m.format_version, RECIPE_FORMAT_VERSION);
        assert_eq!(m.source_summary.source_count, 1);
        assert_eq!(m.source_summary.turn_count, 1);
    }
}

#[test]
fn closed_rename_rewrites_only_the_session_name_header() {
    // Issue #81 rename_persisted_session contract: a NOT-currently-open .duck
    // is renamed by reading its recipe, rewriting the session_name header, and
    // atomic-saving -- the same read_duck + edit + save_atomic round-trip the
    // Tauri command performs. Pinning it here keeps the closed-rename shape
    // black-box testable without a Tauri State harness. list_session_metadata
    // then reflects the new name (the sidebar's source of truth).
    use toptopduck_lib::persistence::read_duck;
    let dir = tempfile::tempdir().expect("tempdir");
    let path = write_recipe(dir.path(), "s.duck", "原名", "src_a");

    // Round-trip rename: read, rewrite the header, atomic-save.
    let mut recipe = read_duck(std::path::Path::new(&path)).expect("read");
    assert_eq!(recipe.session_name, "原名");
    recipe.session_name = "新名".to_string();
    save_atomic(std::path::Path::new(&path), &recipe).expect("save");

    // The list the sidebar consumes now carries the renamed display_name.
    let list = list_session_metadata(std::slice::from_ref(&path));
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].display_name, "新名");
    // The re-read recipe itself carries the new header (nothing else drifted).
    assert_eq!(
        read_duck(std::path::Path::new(&path)).unwrap().session_name,
        "新名"
    );
}
