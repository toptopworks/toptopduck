//! The tree-internal companion DB (ADR-0136): `analytics.duckdb` beside the recipe,
//! a DERIVED CACHE of the result history -- the recipe stays the authority.
//!
//! The companion holds the `result_N` base tables (the admin engine opens this
//! file once materialized) plus one metadata row (`_meta`) carrying:
//! - the watermark: a digest over the recipe's REBUILD-RELEVANT projection
//!   (source identity + promotion SQL + stale marks). Equal digests mean the
//!   recorded chain reproduces exactly the cached tables, so resume skips the
//!   whole re-read + re-execute replay (ADR-0136 Decision 3).
//! - the settled working-set shape (descriptors, result membership,
//!   provenance edges, the active source pointer) so the hit path restores
//!   without deriving any of it from the data files.
//! - per-source (mtime, size) stamps captured at settle, the cheap
//!   existence/drift heuristic the hit path's non-blocking source notice reads.
//!
//! Recipe write and watermark stamp are two files, not atomic: a crash between
//! them leaves a stale watermark, which the next open sees as a mismatch and
//! resolves with one full replay -- benign (ADR-0136 Decision 3).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use duckdb::{params, AccessMode, Config, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::model::{DatasetDescriptor, RectifyProvenance, StaleAnchor};
use crate::persistence::recipe::{
    Recipe, RecipeEntry, RecipeOutcome, RecipePromotion, RECIPE_FORMAT_VERSION,
};
use crate::workingset::WorkingSet;

/// The companion DB file name inside the per-session tree (ADR-0136 D1/D2).
pub(super) const COMPANION_FILE_NAME: &str = "analytics.duckdb";
/// The source-snapshot subdirectory inside the per-session tree. A dedicated
/// subdirectory keeps `<ref>.duckdb` snapshots clear of the recipe name, the
/// companion, and `assets/` / `artifacts/` (implementation-time layout call,
/// ADR-0136 D1).
pub(super) const SNAPSHOTS_DIR_NAME: &str = "snapshots";
/// The `_meta` row's payload version. A row stamped by a future build is not
/// interpreted -- the probe treats it as a miss and replay rebuilds.
const META_VERSION: u32 = 1;
const META_KEY: &str = "meta";

/// The companion DB path derived from a bound recipe path. `None` when the
/// recipe has no parent directory (no tree to live in).
pub(super) fn companion_path(recipe_path: &Path) -> Option<PathBuf> {
    recipe_path
        .parent()
        .map(|dir| dir.join(COMPANION_FILE_NAME))
}

/// The tree snapshot directory for a session tree root (the recipe's parent).
pub(super) fn snapshots_dir(tree_dir: &Path) -> PathBuf {
    tree_dir.join(SNAPSHOTS_DIR_NAME)
}

/// One source snapshot file's path inside the tree.
pub(super) fn snapshot_file(tree_dir: &Path, reference_name: &str) -> PathBuf {
    snapshots_dir(tree_dir).join(format!("{reference_name}.duckdb"))
}

/// The settled working-set shape the hit path restores from. All fields are
/// captured at settle from the live [`WorkingSet`], so restoring reproduces
/// the post-settle state without touching DuckDB or the source files.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub(super) struct WorkingSetMeta {
    pub descriptors: Vec<DatasetDescriptor>,
    /// The `results` membership set (reference names registered as results).
    pub results: Vec<String>,
    /// Provenance edges (result -> dependency reference names), the stale
    /// cascade's input.
    pub provenance: Vec<(String, Vec<String>)>,
    /// The persisted active-SOURCE pointer name.
    pub active: Option<String>,
    /// Per-source (mtime, size) captured at settle -- the hit path's
    /// existence/drift heuristic. Sources without a readable stat at settle
    /// are absent; the hit path then checks existence only.
    pub source_stats: HashMap<String, SourceStat>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct SourceStat {
    pub mtime_ms: u64,
    pub size: u64,
}

/// The cheap existence/drift fingerprint of a source file: (mtime, size) --
/// readable with one stat, no file read. A same-stat edit still slips through
/// (only a full content hash would catch it, and that is the read the hit
/// path exists to avoid); a false "changed" on a same-stat rewrite is the
/// harmless direction -- the hit path's notice is informational.
pub(super) fn source_stat(path: &Path) -> Option<SourceStat> {
    let meta = fs::metadata(path).ok()?;
    let mtime_ms = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    Some(SourceStat {
        mtime_ms,
        size: meta.len(),
    })
}

impl WorkingSetMeta {
    /// Capture the meta from a live working set at settle time.
    pub(super) fn capture(
        working_set: &WorkingSet,
        source_stats: HashMap<String, SourceStat>,
    ) -> Self {
        Self {
            descriptors: working_set.list().to_vec(),
            results: working_set
                .list()
                .iter()
                .filter(|d| working_set.is_result(&d.reference_name))
                .map(|d| d.reference_name.clone())
                .collect(),
            provenance: working_set
                .provenance_map()
                .into_iter()
                .map(|(k, v)| (k, v.into_iter().collect()))
                .collect(),
            active: working_set.active_name().map(str::to_owned),
            source_stats,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct CompanionMeta {
    version: u32,
    watermark: String,
    working_set: WorkingSetMeta,
}

/// The digest over the recipe's rebuild-relevant projection (ADR-0136 D3).
/// Covers source identity (name + rectify + fingerprint), every promotion's
/// SQL + stale mark in history order, and the format version. Deliberately
/// EXCLUDES the display half (session name, timeline prose) and the source
/// PATHS (a re-link relocates the same fingerprint without changing data), so
/// those edits never cost a replay.
/// The recipe's live promotions in history order -- the one traversal shared
/// by the digest (what a rebuild would re-execute) and the degraded-settle
/// check (each live promotion's result must be in the working set), so the
/// two views can never drift apart.
fn live_promotions(recipe: &Recipe) -> impl Iterator<Item = &RecipePromotion> {
    recipe
        .history
        .iter()
        .filter_map(|entry| {
            // Source/skill lifecycle events are not replay inputs; a
            // non-materialized turn executes no SQL on replay.
            let RecipeEntry::Turn(turn) = entry else {
                return None;
            };
            let RecipeOutcome::Materialized { promotions, .. } = &turn.outcome else {
                return None;
            };
            Some(promotions.iter())
        })
        .flatten()
}

fn chain_digest(recipe: &Recipe) -> String {
    #[derive(Serialize)]
    struct ChainSource<'a> {
        reference_name: &'a str,
        rectify: &'a RectifyProvenance,
        fingerprint: &'a str,
    }
    #[derive(Serialize)]
    struct ChainPromotion<'a> {
        reference_name: &'a str,
        sql: &'a str,
        stale: Option<&'a StaleAnchor>,
    }

    let mut hasher = Sha256::new();
    hasher.update(RECIPE_FORMAT_VERSION.to_le_bytes());
    for src in &recipe.sources {
        let bytes = serde_json::to_vec(&ChainSource {
            reference_name: &src.reference_name,
            rectify: &src.rectify,
            fingerprint: &src.fingerprint,
        })
        .expect("recipe projection serializes");
        hasher.update(bytes);
    }
    for p in live_promotions(recipe) {
        let bytes = serde_json::to_vec(&ChainPromotion {
            reference_name: &p.reference_name,
            sql: &p.sql,
            stale: p.stale.as_ref(),
        })
        .expect("recipe projection serializes");
        hasher.update(bytes);
    }
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Stamp the watermark + settled working-set shape into the companion's
/// `_meta` row (ADR-0136 D3: stamped at recipe settle). Called on the ADMIN
/// engine's connection, so the companion already exists. Best-effort at the
/// call site -- a failed stamp only costs one replay on the next open.
///
/// Deliberately NOT stamped for a degraded settle: a live recorded promotion
/// whose result is absent from the working set means the chain failed to
/// reproduce (a replay break). The watermark asserts "chain == cached tables
/// AND complete"; a degraded session must keep taking the replay path so its
/// recurring break (and the recovery once the cause is fixed) stays reachable
/// -- a watermark on a degraded state would freeze it behind a hit forever.
pub(super) fn stamp(
    conn: &Connection,
    recipe: &Recipe,
    working_set: &WorkingSet,
    source_stats: HashMap<String, SourceStat>,
) -> anyhow::Result<()> {
    for p in live_promotions(recipe) {
        if p.stale.is_none() && working_set.get(&p.reference_name).is_none() {
            log::info!(
                target: "toptopduck::session",
                "companion watermark skipped: recorded result {} is degraded out of the \
                 working set -- the session stays on the replay path (ADR-0136 D3)",
                p.reference_name
            );
            return Ok(());
        }
    }
    let meta = CompanionMeta {
        version: META_VERSION,
        watermark: chain_digest(recipe),
        working_set: WorkingSetMeta::capture(working_set, source_stats),
    };
    let json = serde_json::to_string(&meta)?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)")?;
    conn.execute("DELETE FROM _meta WHERE key = ?", params![META_KEY])?;
    conn.execute(
        "INSERT INTO _meta (key, value) VALUES (?, ?)",
        params![META_KEY, json],
    )?;
    Ok(())
}

/// Probe the companion for a watermark hit (ADR-0136 D3). `Some(meta)` only
/// when the companion exists, opens, carries a `_meta` row of a known version
/// whose watermark equals the recipe's current digest, AND every recipe
/// source still has its tree snapshot file (a snapshot cannot be re-created
/// without re-reading the source, so a missing one falls back to replay).
/// Any failure is a miss -- never an error; the caller discards the file and
/// the existing replay path rebuilds it.
pub(super) fn probe(recipe_path: &Path, recipe: &Recipe) -> Option<WorkingSetMeta> {
    let companion = companion_path(recipe_path)?;
    let meta = read_meta(&companion)?;
    if meta.version != META_VERSION || meta.watermark != chain_digest(recipe) {
        return None;
    }
    let tree = recipe_path.parent()?;
    // Every tree snapshot must exist AND open as a DuckDB database: a missing
    // or corrupt snapshot cannot be re-created without re-reading the source,
    // so it falls back to replay. Opening read-only also pre-validates the
    // exact file the hit path attaches a moment later (the restore surfaces a
    // residual TOCTOU failure as an honest error rather than a fallback that
    // could not proceed either).
    for s in &recipe.sources {
        let file = snapshot_file(tree, &s.reference_name);
        if Connection::open_with_flags(&file, read_only_config()?).is_err() {
            return None;
        }
    }
    Some(meta.working_set)
}

/// Read + parse the `_meta` row off a companion file, read-only. `None` on
/// any open/query/parse failure (missing table, corrupt file, foreign row).
fn read_meta(companion: &Path) -> Option<CompanionMeta> {
    let conn = Connection::open_with_flags(companion, read_only_config()?).ok()?;
    let json: String = conn
        .query_row(
            "SELECT value FROM _meta WHERE key = ?",
            params![META_KEY],
            |r| r.get(0),
        )
        .ok()?;
    serde_json::from_str(&json).ok()
}

/// A read-only open config; `None` when DuckDB rejects the flag combination
/// (a broken build-time environment, de-facto unreachable).
fn read_only_config() -> Option<Config> {
    Config::default().access_mode(AccessMode::ReadOnly).ok()
}

/// Remove the companion + its WAL (ADR-0136 D3: a miss rebuilds from a clean
/// file). Best-effort + logged -- the replay path recreates the DB on open,
/// so a leftover file would be truncated by DuckDB anyway, but a clean remove
/// keeps the tree honest. A Windows-held handle (should not happen -- callers
/// run before the admin engine opens) surfaces in the log.
pub(super) fn discard(recipe_path: &Path) {
    let Some(dir) = recipe_path.parent() else {
        return;
    };
    let wal = format!("{COMPANION_FILE_NAME}.wal");
    for name in [COMPANION_FILE_NAME, wal.as_str()] {
        if let Err(e) = fs::remove_file(dir.join(name)) {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    target: "toptopduck::session",
                    "companion discard failed for {name} in {}: {e}",
                    dir.display()
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::RectifyProvenance;
    use crate::persistence::recipe::{Recipe, RecipePromotion, RecipeTurn, SourceRef};

    fn recipe_with(sql: &str) -> Recipe {
        Recipe::build(
            "s".into(),
            vec![SourceRef {
                reference_name: "people".into(),
                display_name: "people".into(),
                source_path: "/data/people.csv".into(),
                relative_path: None,
                rectify: RectifyProvenance::NotApplicable,
                fingerprint: "fp".into(),
            }],
            vec![RecipeEntry::Turn(RecipeTurn::without_audit(
                "q",
                RecipeOutcome::Materialized {
                    promotions: vec![RecipePromotion {
                        reference_name: "result_1".into(),
                        display_name: "result_1".into(),
                        sql: sql.into(),
                        stale: None,
                    }],
                    body: None,
                    assumption: None,
                },
            ))],
            Some("people".into()),
        )
        .expect("recipe builds")
    }

    fn tree_with_companion() -> (tempfile::TempDir, Recipe) {
        let dir = tempfile::tempdir().expect("tempdir");
        let recipe = recipe_with("SELECT 1");
        // A REAL DuckDB snapshot file -- the probe validates each snapshot
        // opens before declaring a hit.
        std::fs::create_dir_all(snapshots_dir(dir.path())).expect("snapshots dir");
        let snap = Connection::open(snapshot_file(dir.path(), "people")).expect("snapshot");
        snap.execute_batch("CREATE TABLE data AS SELECT 1 AS n")
            .expect("snapshot data");
        drop(snap);
        let conn = Connection::open(dir.path().join(COMPANION_FILE_NAME)).expect("companion");
        // A consistent settle: the recipe's live promotion result_1 is
        // present in the working set (a degraded settle skips the stamp).
        let mut ws = WorkingSet::default();
        ws.register_result(DatasetDescriptor {
            reference_name: "result_1".into(),
            display_name: "result_1".into(),
            source_path: String::new(),
            columns: Vec::new(),
            row_count: 0,
            sample: Vec::new(),
            fingerprint: "fp".into(),
            rectify: RectifyProvenance::NotApplicable,
            privacy: Default::default(),
            stale: None,
        });
        stamp(&conn, &recipe, &ws, HashMap::new()).expect("stamp");
        drop(conn);
        (dir, recipe)
    }

    #[test]
    fn stamp_skips_a_degraded_settle() {
        // ADR-0136 D3: a live recorded result absent from the working set is
        // a replay break -- stamping it would freeze the degraded state
        // behind a hit forever, so the stamp refuses. Asserted against the
        // companion's own _meta row -- the probe would also miss for a
        // missing tree snapshot, so it cannot discriminate here.
        let dir = tempfile::tempdir().expect("tempdir");
        let recipe = recipe_with("SELECT 1");
        let companion = dir.path().join(COMPANION_FILE_NAME);
        let conn = Connection::open(&companion).expect("companion");
        stamp(&conn, &recipe, &WorkingSet::default(), HashMap::new()).expect("stamp call");
        drop(conn);
        let row: Option<String> = Connection::open(&companion)
            .expect("companion readable")
            .query_row(
                "SELECT value FROM _meta WHERE key = ?",
                params![META_KEY],
                |r| r.get(0),
            )
            .ok();
        assert!(
            row.is_none(),
            "no _meta row was written for the degraded settle"
        );
    }

    #[test]
    fn probe_misses_on_a_future_meta_version() {
        // The version gate is forward-looking insurance: a _meta row from a
        // future build -- even one carrying the correct digest -- must not be
        // interpreted; the probe treats it as a miss and replay rebuilds.
        let (dir, recipe) = tree_with_companion();
        let future = serde_json::to_string(&CompanionMeta {
            version: META_VERSION + 1,
            watermark: chain_digest(&recipe),
            working_set: WorkingSetMeta::default(),
        })
        .expect("meta serializes");
        let conn = Connection::open(dir.path().join(COMPANION_FILE_NAME)).expect("companion");
        conn.execute(
            "INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)",
            params![META_KEY, future],
        )
        .expect("rewrite row");
        drop(conn);
        let duck = dir.path().join("recipe.json");
        assert!(probe(&duck, &recipe).is_none(), "future version -> miss");
    }

    #[test]
    fn probe_hits_after_stamp_and_misses_on_chain_change() {
        // ADR-0136 D3: equal digest -> hit; the digest tracks the promotion
        // SQL, so a changed chain misses.
        let (dir, recipe) = tree_with_companion();
        let duck = dir.path().join("recipe.json");
        assert!(probe(&duck, &recipe).is_some(), "fresh stamp hits");
        let changed = recipe_with("SELECT 2");
        assert!(probe(&duck, &changed).is_none(), "changed chain misses");
    }

    #[test]
    fn probe_ignores_display_only_changes() {
        // The digest excludes the display half + source paths: a rename or a
        // re-link must not cost a replay.
        let (dir, mut recipe) = tree_with_companion();
        recipe.session_name = "renamed".into();
        recipe.sources[0].source_path = "/moved/people.csv".into();
        let duck = dir.path().join("recipe.json");
        assert!(
            probe(&duck, &recipe).is_some(),
            "display-only change still hits"
        );
    }

    #[test]
    fn probe_misses_when_a_tree_snapshot_is_gone() {
        // A missing snapshot cannot be restored without re-reading the
        // source, so the probe falls back to replay even on a digest hit.
        let (dir, recipe) = tree_with_companion();
        std::fs::remove_file(snapshot_file(dir.path(), "people")).expect("remove snapshot");
        let duck = dir.path().join("recipe.json");
        assert!(probe(&duck, &recipe).is_none());
    }

    #[test]
    fn probe_misses_on_missing_companion_and_foreign_meta() {
        let dir = tempfile::tempdir().expect("tempdir");
        let recipe = recipe_with("SELECT 1");
        let duck = dir.path().join("recipe.json");
        assert!(probe(&duck, &recipe).is_none(), "no companion -> miss");
        // A companion file that is not a DuckDB database at all.
        std::fs::write(dir.path().join(COMPANION_FILE_NAME), b"not a duckdb").expect("write");
        assert!(probe(&duck, &recipe).is_none(), "corrupt file -> miss");
    }

    #[test]
    fn discard_removes_companion_and_wal() {
        let (dir, _) = tree_with_companion();
        std::fs::write(dir.path().join("analytics.duckdb.wal"), b"wal").expect("wal");
        let duck = dir.path().join("recipe.json");
        discard(&duck);
        assert!(!dir.path().join(COMPANION_FILE_NAME).exists());
        assert!(!dir.path().join("analytics.duckdb.wal").exists());
        assert!(
            dir.path().join(SNAPSHOTS_DIR_NAME).exists(),
            "snapshots stay"
        );
    }

    #[test]
    fn meta_round_trips_the_settled_shape() {
        // The meta the hit path restores is the settled shape verbatim: the
        // one registered result + its membership + the active pointer.
        let (dir, recipe) = tree_with_companion();
        let duck = dir.path().join("recipe.json");
        let ws = probe(&duck, &recipe).expect("hit");
        assert_eq!(ws.descriptors.len(), 1);
        assert_eq!(ws.descriptors[0].reference_name, "result_1");
        assert_eq!(ws.results, vec!["result_1".to_string()]);
        assert!(ws.active.is_none(), "register_result does not move active");
    }
}
