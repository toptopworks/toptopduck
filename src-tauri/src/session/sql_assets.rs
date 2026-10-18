//! Turn-SQL temp-reference materialization: the settle-time half of resume
//! resilience for `read_*` paths. The agent freely writes scratch data
//! (csv/json) into the session temp dir and references it by bare path in
//! its SQL; live preflight allows the read (the file is under the temp
//! root), but the temp dir does not survive the process -- a recorded
//! `turn.sql` pointing into it is structurally dead on resume.
//!
//! At settle, every `read_*` reference into the session temp dir is copied
//! into the per-session `assets/` dir (ADR-0089) as a DEAD FILE -- it never
//! enters the working set, the dataset UI, or fingerprinting; it exists only
//! so the stored SQL has something to read at replay. The SQL text is
//! rewritten to the assets path (a migration-update, the
//! derived-source-migration precedent) so the recipe's productive chain
//! replays against the persistent copy. Best-effort + logged: a copy
//! failure leaves the temp path in place (the write still succeeds; a later
//! resume breaks at this turn and, with replay preservation, does not
//! destroy the recorded history).

use std::path::{Path, PathBuf};

use crate::model::TurnOutcome;
use crate::tools::read_paths::extract_read_paths;

/// The per-session directory's `assets/` subdirectory name (ADR-0089: the
/// per-session tree holds `session.duck` + `assets/`).
pub(super) const ASSETS_DIR_NAME: &str = "assets";

/// The session's `assets/` dir derived from the bound `.duck` path. `None`
/// when unbound (nothing to materialize for -- there is no resume) or the
/// duck path has no parent directory.
pub(super) fn assets_dir(duck_path: Option<&Path>) -> Option<PathBuf> {
    duck_path
        .and_then(Path::parent)
        .map(|dir| dir.join(ASSETS_DIR_NAME))
}

/// Rewrite the turn's promotion SQL so every `read_*` reference into the
/// session temp dir points at a materialized copy under `assets/`.
///
/// The reference extraction is the SAME one live preflight runs, so the
/// materialization face and the enforcement face cannot drift apart. Paths
/// outside the temp dir (user-directory originals -- the app does not copy
/// user files, the materialize precedent) and missing files are untouched;
/// an unparseable or non-literal SQL is left verbatim (live preflight
/// refused such SQL before it could settle, so this only guards hand-built
/// recipes).
pub(super) fn materialize_sql_references(
    outcome: &mut TurnOutcome,
    temp_path: &Path,
    duck_path: Option<&Path>,
) {
    let Some(assets_dir) = assets_dir(duck_path) else {
        return;
    };
    let TurnOutcome::Materialized { promotions, .. } = outcome else {
        return;
    };
    let temp_root = std::fs::canonicalize(temp_path).unwrap_or_else(|_| temp_path.to_path_buf());
    // Canonical-path -> staged-target cache: one file referenced under two
    // spellings (or across promotions) copies once and rewrites everywhere.
    let mut staged: Vec<(PathBuf, PathBuf)> = Vec::new();
    for promotion in promotions.iter_mut() {
        let Ok(analysis) = extract_read_paths(&promotion.sql) else {
            continue;
        };
        if analysis.non_literal_read_found {
            continue;
        }
        // Longest-first rewrite order: one referenced temp path can be a
        // substring of another (`kline.csv` inside `kline.csv.bak` under the
        // same temp prefix); a blind shorter-first replace would rewrite the
        // longer literal's text in place and leave it half-migrated (the
        // assets path, which does not exist). Rewriting the longest literal
        // first leaves only true independent occurrences for the shorter.
        let mut originals = analysis.paths;
        originals.sort_by_key(|p| std::cmp::Reverse(p.len()));
        for original in originals {
            let Some(canonical) = std::fs::canonicalize(&original).ok() else {
                continue; // a missing reference: dead either way, not ours to fix
            };
            if !canonical.starts_with(&temp_root) || !canonical.is_file() {
                continue;
            }
            let target = match staged.iter().find(|(src, _)| *src == canonical) {
                Some((_, target)) => target.clone(),
                None => {
                    let Some(target) = materialize_one(&canonical, &assets_dir) else {
                        continue;
                    };
                    staged.push((canonical, target.clone()));
                    target
                }
            };
            promotion.sql = promotion.sql.replace(&original, &target.to_string_lossy());
        }
    }
}

/// Copy `src` into `assets_dir` under its own file name, disambiguating
/// same-named collisions with the `_2` suffix loop (the artifact
/// materialization precedent: stem/ext constant per attempt, an empty
/// extension formats without the separator dot). `None` on failure --
/// logged, the caller leaves the original path in place.
fn materialize_one(src: &Path, assets_dir: &Path) -> Option<PathBuf> {
    if let Err(e) = std::fs::create_dir_all(assets_dir) {
        log::warn!(
            target: "toptopduck::session",
            "sql-reference materialization skipped: cannot create {}: {e}",
            assets_dir.display()
        );
        return None;
    }
    let file_name = src.file_name()?.to_str()?.to_string();
    let stem = Path::new(&file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("asset");
    let ext = Path::new(&file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    let mut target = assets_dir.join(&file_name);
    let mut counter = 2u32;
    while target.exists() {
        target = assets_dir.join(if ext.is_empty() {
            format!("{stem}_{counter}")
        } else {
            format!("{stem}_{counter}.{ext}")
        });
        counter += 1;
    }
    match std::fs::copy(src, &target) {
        Ok(_) => Some(target),
        Err(e) => {
            log::warn!(
                target: "toptopduck::session",
                "sql-reference materialization failed for {}: {e}",
                src.display()
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{DatasetDescriptor, DatasetPrivacy, Promotion, RectifyProvenance};

    fn promotion_with(sql: &str) -> TurnOutcome {
        TurnOutcome::Materialized {
            promotions: vec![Promotion {
                dataset: DatasetDescriptor {
                    reference_name: "result_1".into(),
                    display_name: "r1".into(),
                    source_path: String::new(),
                    columns: Vec::new(),
                    row_count: 0,
                    sample: Vec::new(),
                    fingerprint: String::new(),
                    rectify: RectifyProvenance::NotApplicable,
                    privacy: DatasetPrivacy::default(),
                    stale: None,
                },
                sql: sql.into(),
            }],
            viz: None,
            body: Some("done".into()),
            assumption: None,
        }
    }

    fn temp_csv(temp: &Path, name: &str) -> String {
        let p = temp.join(name);
        std::fs::write(&p, "a,b\n1,2\n").expect("write temp csv");
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn temp_reference_is_copied_into_assets_and_sql_rewritten() {
        let temp = tempfile::tempdir().expect("tempdir");
        let session = tempfile::tempdir().expect("session dir");
        let duck = session.path().join("session.duck");
        let csv = temp_csv(temp.path(), "kline.csv");

        let mut outcome =
            promotion_with(&format!("SELECT * FROM read_csv_auto('{}') LIMIT 1", csv));
        materialize_sql_references(&mut outcome, temp.path(), Some(&duck));

        let assets_copy = session.path().join("assets").join("kline.csv");
        assert!(assets_copy.is_file(), "temp file copied into assets/");
        let TurnOutcome::Materialized { promotions, .. } = &outcome else {
            panic!("outcome kind unchanged");
        };
        assert_eq!(
            promotions[0].sql,
            format!(
                "SELECT * FROM read_csv_auto('{}') LIMIT 1",
                assets_copy.to_string_lossy()
            ),
            "SQL rewritten to the assets path"
        );
    }

    #[test]
    fn same_named_files_disambiguate_with_suffix() {
        let temp = tempfile::tempdir().expect("tempdir");
        let session = tempfile::tempdir().expect("session dir");
        let duck = session.path().join("session.duck");
        let sub_a = temp.path().join("a");
        let sub_b = temp.path().join("b");
        std::fs::create_dir_all(&sub_a).expect("dir a");
        std::fs::create_dir_all(&sub_b).expect("dir b");
        std::fs::write(sub_a.join("data.csv"), "x\n").expect("csv a");
        std::fs::write(sub_b.join("data.csv"), "y\n").expect("csv b");
        let a = sub_a.join("data.csv").to_string_lossy().into_owned();
        let b = sub_b.join("data.csv").to_string_lossy().into_owned();

        let sql = format!(
            "SELECT * FROM read_csv_auto('{}') UNION ALL SELECT * FROM read_csv_auto('{}')",
            a, b
        );
        let mut outcome = promotion_with(&sql);
        materialize_sql_references(&mut outcome, temp.path(), Some(&duck));

        assert!(session.path().join("assets").join("data.csv").is_file());
        assert!(session.path().join("assets").join("data_2.csv").is_file());
        let TurnOutcome::Materialized { promotions, .. } = &outcome else {
            panic!("outcome kind unchanged");
        };
        assert!(
            promotions[0].sql.contains("data_2.csv"),
            "second same-named reference rewrote to the disambiguated copy"
        );
    }

    #[test]
    fn user_directory_and_missing_references_are_untouched() {
        let temp = tempfile::tempdir().expect("session temp");
        let elsewhere = tempfile::tempdir().expect("user dir");
        let session = tempfile::tempdir().expect("session dir");
        let duck = session.path().join("session.duck");
        let user_csv = elsewhere.path().join("user.csv");
        std::fs::write(&user_csv, "x\n").expect("user csv");
        let user = user_csv.to_string_lossy().into_owned();
        let missing = temp.path().join("never.csv").to_string_lossy().into_owned();

        let sql = format!(
            "SELECT * FROM read_csv_auto('{}') UNION ALL SELECT * FROM read_csv_auto('{}')",
            user, missing
        );
        let mut outcome = promotion_with(&sql);
        materialize_sql_references(&mut outcome, temp.path(), Some(&duck));

        let TurnOutcome::Materialized { promotions, .. } = &outcome else {
            panic!("outcome kind unchanged");
        };
        assert_eq!(
            promotions[0].sql, sql,
            "user-directory originals and missing files keep their paths verbatim"
        );
        assert!(
            !session.path().join("assets").exists(),
            "nothing materialized for non-temp references"
        );
    }

    #[test]
    fn unbound_duck_is_a_no_op() {
        let temp = tempfile::tempdir().expect("tempdir");
        let csv = temp_csv(temp.path(), "x.csv");
        let sql = format!("SELECT * FROM read_csv_auto('{}')", csv);
        let mut outcome = promotion_with(&sql);
        materialize_sql_references(&mut outcome, temp.path(), None);
        let TurnOutcome::Materialized { promotions, .. } = &outcome else {
            panic!("outcome kind unchanged");
        };
        assert_eq!(
            promotions[0].sql, sql,
            "unbound session keeps the SQL verbatim"
        );
    }

    #[test]
    fn overlapping_path_prefixes_rewrite_independently() {
        // `kline.csv` is a substring of `kline.csv.bak` under the same temp
        // prefix, AND a same-named file already sits in assets/ -- so the
        // shorter path stages as `kline_2.csv` while the longer stages as
        // `kline.csv.bak`. A shorter-first blind replace would rewrite the
        // longer literal's text in place to `kline_2.csv.bak`, a copy that
        // does not exist; longest-first lands each literal on its OWN copy.
        let temp = tempfile::tempdir().expect("tempdir");
        let session = tempfile::tempdir().expect("session dir");
        let duck = session.path().join("session.duck");
        let assets = session.path().join("assets");
        std::fs::create_dir_all(&assets).expect("assets dir");
        std::fs::write(
            assets.join("kline.csv"),
            "prior turn
",
        )
        .expect("occupy kline.csv");
        let csv = temp_csv(temp.path(), "kline.csv");
        let bak_path = temp.path().join("kline.csv.bak");
        std::fs::write(
            &bak_path, "b
",
        )
        .expect("write bak");
        let bak = bak_path.to_string_lossy().into_owned();

        let mut outcome = promotion_with(&format!(
            "SELECT * FROM read_csv_auto('{}') UNION ALL SELECT * FROM read_csv_auto('{}')",
            csv, bak
        ));
        materialize_sql_references(&mut outcome, temp.path(), Some(&duck));

        let staged_csv = assets.join("kline_2.csv");
        let staged_bak = assets.join("kline.csv.bak");
        assert!(
            staged_csv.is_file(),
            "the shorter path disambiguated to kline_2.csv"
        );
        assert!(
            staged_bak.is_file(),
            "the longer path staged under its own name"
        );
        let TurnOutcome::Materialized { promotions, .. } = &outcome else {
            panic!("outcome kind unchanged");
        };
        let expected = format!(
            "SELECT * FROM read_csv_auto('{}') UNION ALL SELECT * FROM read_csv_auto('{}')",
            staged_csv.to_string_lossy(),
            staged_bak.to_string_lossy()
        );
        assert_eq!(
            promotions[0].sql, expected,
            "each overlapping literal rewrites onto its own staged copy"
        );
    }

    #[test]
    fn same_file_under_two_spellings_copies_once() {
        let temp = tempfile::tempdir().expect("tempdir");
        let session = tempfile::tempdir().expect("session dir");
        let duck = session.path().join("session.duck");
        let csv = temp_csv(temp.path(), "one.csv");
        #[cfg(windows)]
        let alias = {
            let mut upper = csv.clone();
            upper[1..2].make_ascii_uppercase();
            upper
        };
        #[cfg(not(windows))]
        let alias = csv.clone();

        let sql = format!(
            "SELECT * FROM read_csv_auto('{}') UNION ALL SELECT * FROM read_csv_auto('{}')",
            csv, alias
        );
        let mut outcome = promotion_with(&sql);
        materialize_sql_references(&mut outcome, temp.path(), Some(&duck));

        let entries = std::fs::read_dir(session.path().join("assets"))
            .expect("assets dir")
            .count();
        assert_eq!(entries, 1, "two spellings of one file staged one copy");
    }
}
