//! LLM-SQL sandbox lifecycle (ADR-0005, ADR-0088).
//!
//! Provider SQL runs on a *separate* DuckDB instance per turn. The CTAS
//! wrapping bars mutating statements (DROP/INSERT/COPY/ATTACH/INSTALL/LOAD),
//! narrowing the in-SELECT file surface to `read_*` functions. File-
//! reachability for `read_*` is constrained solely by the gateway FsAcl
//! preflight (ADR-0080 + ADR-0088 Decision 2 + Decision 3: literal-path
//! whitelist + non-literal refusal) -- the engine-level `disabled_filesystems` lockdown
//! was removed so DuckDB can read in-bounds files (external-tool output,
//! session temp). This module owns the per-turn sandbox lifecycle.
//!
//! Why a second instance, not a setting on the admin connection: provider SQL
//! must never touch the admin connection (security boundary). A per-turn
//! `open_in_memory` gives each turn a clean instance with its own catalog,
//! resource caps, and interrupt handle (ADR-0027).
//!
//! How sources/results reach the sandbox so provider SQL resolves identically:
//! - **Sources** (`"<ref>".data`) are READ_ONLY-attached by file. Two instances
//!   can attach the same `.duckdb` file READ_ONLY concurrently (probe), so the
//!   sandbox re-attaches admin's source files zero-copy.
//! - **Prior results** (`result_N`, main-catalog base tables on admin) are
//!   mirrored into the sandbox as base tables via a type-agnostic Value
//!   round-trip (probe). The new result is mirrored back onto admin the same
//!   way, then admin derives/registers it unchanged.
//!
//! Security boundary: only the sandbox ever executes provider SQL. The admin
//! connection runs only tool-controlled statements (ATTACH/CREATE/INSERT over
//! tool-generated identifiers, derive, read).

use std::collections::HashMap;
use std::path::PathBuf;

use duckdb::types::Value;
use duckdb::{appender_params_from_iter, Connection};

use crate::app_config::model::{EngineDefaults, ExtensionChannel};
use crate::guardrail::{apply_resource_caps, classify_duckdb_error, ExecError, ExecErrorKind};
use crate::ingest::schema::{attach_sql, quote_ident};
use crate::workingset::WorkingSet;

/// Open a fresh sandbox instance with the engine resource caps from the
/// session-level engine-defaults snapshot applied (issue #741: the LLM SQL
/// the caps constrain runs HERE, so the sandbox must cap from the same
/// snapshot the admin engine holds), plus the extension-channel tier settings
/// (ADR-0150: implicit autoinstall/autoload zeroed in EVERY tier, the
/// community gate opened only on the community tier, extension binaries
/// redirected under the app-data dir). Sources and results are
/// attached/mirrored after opening.
pub(crate) fn open(engine_defaults: &EngineDefaults) -> Result<Connection, ExecError> {
    let config = extension_channel_config(engine_defaults.extension_channel)?;
    let conn = Connection::open_in_memory_with_flags(config).map_err(duck_err)?;
    apply_resource_caps(
        &conn,
        &engine_defaults.memory_limit,
        engine_defaults.threads,
    );
    Ok(conn)
}

/// Build the STARTUP-TIME config carrying the ADR-0150 extension-channel tier
/// settings. Unlike the resource caps (best-effort: a rejected setting only
/// loosens a ceiling), these are SAFETY settings, and `allow_community_extensions`
/// can only be set before the database runs -- so they ride the connection
/// config, and any rejected key refuses the sandbox outright (fail-closed)
/// instead of degrading.
///
/// - `autoinstall_known_extensions` / `autoload_known_extensions` are forced
///   false in EVERY tier (the ADR's implicit-channel-to-zero): bundled static
///   extensions are unaffected; everything else loads only through an
///   explicit `INSTALL` / `LOAD` statement boundary.
/// - `allow_community_extensions` is opened only on [`ExtensionChannel::Community`].
/// - `extension_directory` is redirected under the app-data dir when the
///   setup hook anchored one (never `~/.duckdb` in production).
fn extension_channel_config(channel: ExtensionChannel) -> Result<duckdb::Config, ExecError> {
    let refused = |what: &str, e: duckdb::Error| {
        ExecError::new(
            ExecErrorKind::Runtime,
            format!("extension-channel setting {what} refused the sandbox (fail-closed): {e}"),
        )
    };
    let config = duckdb::Config::default()
        .with("autoinstall_known_extensions", "false")
        .map_err(|e| refused("autoinstall zeroing", e))?
        .with("autoload_known_extensions", "false")
        .map_err(|e| refused("autoload zeroing", e))?
        // Explicit in EVERY tier: this DuckDB build's observed default for
        // allow_community_extensions is true, so off/core must pin it false
        // rather than lean on the (wrong) default.
        .with(
            "allow_community_extensions",
            if channel == ExtensionChannel::Community {
                "true"
            } else {
                "false"
            },
        )
        .map_err(|e| refused("allow_community_extensions", e))?;
    match crate::paths::extensions_dir() {
        Some(dir) => config
            .with("extension_directory", dir.display().to_string())
            .map_err(|e| refused("extension_directory", e)),
        None => Ok(config),
    }
}

/// Attach every loaded source into the sandbox READ_ONLY so the `"<ref>".data`
/// FROM form resolves identically to the admin instance. Iteration is over the
/// working set's registered sources (the source of truth), not the `source_files`
/// map directly: the map is insert-only and a rolled-back multi-sheet ingest can
/// leave stale entries for already-removed files, which must not be re-attached.
/// `source_files` maps each source's reference name to the `.duckdb` file admin
/// currently holds attached (tracked by Session at each attach site -- needed
/// because a replace may leave the file at a swap path, not the canonical
/// `<ref>.duckdb`). Concurrent READ_ONLY attach of the same file by two
/// instances is allowed (probe), so admin's attachment is undisturbed.
pub(crate) fn attach_sources(
    sandbox: &Connection,
    working_set: &WorkingSet,
    source_files: &HashMap<String, PathBuf>,
) -> Result<(), ExecError> {
    for d in working_set.list() {
        if working_set.is_result(&d.reference_name) {
            continue; // results are mirrored separately, not attached
        }
        // Every registered source records its file at attach, so a miss is an
        // invariant break -- surface it honestly rather than silently skip.
        let file = source_files.get(&d.reference_name).ok_or_else(|| {
            ExecError::new(
                ExecErrorKind::Runtime,
                format!("源「{}」缺少快照文件记录", d.reference_name),
            )
        })?;
        let attach_sql = attach_sql(&file.to_string_lossy(), &d.reference_name);
        sandbox.execute_batch(&attach_sql).map_err(|e| {
            ExecError::new(
                classify_duckdb_error(&e.to_string()),
                format!("沙箱挂载源「{}」失败：{e}", d.reference_name),
            )
        })?;
    }
    Ok(())
}

/// Mirror each prior turn result (`result_N`, a base table on admin) into the
/// sandbox as a base table so chained references resolve. The mirror is a
/// type-agnostic Value round-trip via [`copy_table`]. Streaming (one row at a
/// time), so memory is O(one row), not O(whole table). Stale results (issue
/// #40, ADR-0013 invariant 2) are NOT mirrored: a stale result may not anchor a
/// new derivation, so a `FROM result_N` against one fails at execution ("Table
/// does not exist") -- a defense-in-depth backstop for the provenance pre-check
/// that catches the common case before execution. read_rows reads stale
/// results from admin directly, so visibility is unaffected.
pub(crate) fn mirror_results(
    sandbox: &Connection,
    admin: &Connection,
    working_set: &WorkingSet,
) -> Result<(), ExecError> {
    for d in working_set.list() {
        if working_set.is_result(&d.reference_name) && !working_set.is_stale(&d.reference_name) {
            copy_table(admin, &d.reference_name, sandbox, &d.reference_name)?;
        }
    }
    Ok(())
}

/// Install the sandbox's new result onto admin as `dst_table` (the canonical
/// `result_N`); admin then derives/registers it. Same Value round-trip as
/// [`mirror_results`], reversed. A failure can leave a partial `dst_table` on
/// admin, so the caller rolls back (ADR-0022 never-reused).
pub(crate) fn install_result(
    admin: &Connection,
    sandbox: &Connection,
    sandbox_table: &str,
    dst_table: &str,
) -> Result<(), ExecError> {
    copy_table(sandbox, sandbox_table, admin, dst_table)
}

/// Copy a base table `src_table` on `src` into `dst` as `dst_table` (same column
/// names + raw DuckDB types, rows round-tripped via `Value`). The shared
/// primitive for both directions -- mirroring admin's prior results into the
/// sandbox, and installing the sandbox's new result back onto admin. All
/// identifiers here are tool-generated (`result_N`), never provider SQL.
fn copy_table(
    src: &Connection,
    src_table: &str,
    dst: &Connection,
    dst_table: &str,
) -> Result<(), ExecError> {
    let columns = describe_columns(src, src_table)?;
    // CREATE the destination with the source's raw types verbatim -- preserves
    // fidelity so DECIMAL(p,s)/VARCHAR(n) survive the round-trip unchanged.
    let ddl: Vec<String> = columns
        .iter()
        .map(|(name, ty)| format!("{} {}", quote_ident(name), ty))
        .collect();
    dst.execute_batch(&format!(
        "CREATE TABLE {} ({})",
        quote_ident(dst_table),
        ddl.join(", ")
    ))
    .map_err(duck_err)?;

    let select_list = columns
        .iter()
        .map(|(n, _)| quote_ident(n))
        .collect::<Vec<_>>()
        .join(", ");
    let mut read = src
        .prepare(&format!(
            "SELECT {select_list} FROM {}",
            quote_ident(src_table)
        ))
        .map_err(duck_err)?;
    let mut rows = read.query([]).map_err(duck_err)?;
    let mut app = dst.appender(dst_table).map_err(duck_err)?;
    let n_cols = columns.len();
    while let Some(row) = rows.next().map_err(duck_err)? {
        let values: Vec<Value> = (0..n_cols)
            .map(|i| row.get::<_, Value>(i).map_err(duck_err))
            .collect::<Result<_, _>>()?;
        app.append_row(appender_params_from_iter(values))
            .map_err(duck_err)?;
    }
    Ok(())
}

/// Read `(column_name, raw DuckDB type)` pairs for a table. Raw types (not
/// canonicalized) so CREATE TABLE reproduces the source shape exactly.
fn describe_columns(conn: &Connection, table: &str) -> Result<Vec<(String, String)>, ExecError> {
    let mut stmt = conn
        .prepare(&format!("DESCRIBE {}", quote_ident(table)))
        .map_err(duck_err)?;
    let mut rows = stmt.query([]).map_err(duck_err)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(duck_err)? {
        let name: String = row.get(0).map_err(duck_err)?;
        let ty: String = row.get(1).map_err(duck_err)?;
        out.push((name, ty));
    }
    Ok(out)
}

/// Lift a DuckDB error into a classified [`ExecError`]. Sandbox-internal ops
/// (attach/mirror/install) are tool-controlled, so a failure is operational --
/// classification only picks retry-vs-abort, and most land Runtime.
fn duck_err(e: duckdb::Error) -> ExecError {
    let detail = e.to_string();
    ExecError::new(classify_duckdb_error(&detail), detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Issue #741 AC (sandbox face): the session snapshot's caps land on the
    /// sandbox instance the provider SQL actually runs on. Same readback the
    /// admin-face test uses, so the two surfaces are pinned to one snapshot.
    #[test]
    fn open_applies_the_session_snapshot_caps() {
        let snapshot = EngineDefaults {
            memory_limit: "256MB".to_string(),
            threads: 2,
            row_cap: 500,
            extension_channel: crate::app_config::ExtensionChannel::default(),
        };
        let conn = open(&snapshot).expect("sandbox opens");
        crate::guardrail::tests::assert_memory_cap_lands(&conn, 256e6);
        let (_, threads) = crate::guardrail::tests::read_caps(&conn);
        assert_eq!(threads, "2", "threads PRAGMA lands");
    }

    /// Issue #741 AC: an ill-formed memory_limit never reaches the sandbox
    /// either -- the shared apply-time gate reverts to the tightened
    /// constant, the sandbox still opens and serves queries, and the
    /// well-formed sibling still lands.
    #[test]
    fn open_survives_a_malformed_memory_limit() {
        let snapshot = EngineDefaults {
            memory_limit: "not-a-limit".to_string(),
            threads: 1,
            row_cap: 100,
            extension_channel: crate::app_config::ExtensionChannel::default(),
        };
        let conn = open(&snapshot).expect("sandbox opens despite malformed limit");
        let one: i64 = conn
            .query_row("SELECT 1", [], |r| r.get(0))
            .expect("usable");
        assert_eq!(one, 1);
        crate::guardrail::tests::assert_memory_cap_lands(
            &conn, 512e6, // the `MEMORY_LIMIT` constant, not DuckDB's default
        );
        let (_, threads) = crate::guardrail::tests::read_caps(&conn);
        assert_eq!(threads, "1", "the well-formed threads PRAGMA still lands");
    }

    // --- #1583: extension-channel tier settings (ADR-0150) -------------------

    use crate::app_config::ExtensionChannel;

    fn read_bool_setting(conn: &Connection, name: &str) -> bool {
        conn.query_row(&format!("SELECT current_setting('{name}')"), [], |r| {
            r.get(0)
        })
        .expect("setting readback")
    }

    fn read_string_setting(conn: &Connection, name: &str) -> String {
        conn.query_row(&format!("SELECT current_setting('{name}')"), [], |r| {
            r.get(0)
        })
        .expect("setting readback")
    }

    fn snapshot_for(channel: ExtensionChannel) -> EngineDefaults {
        EngineDefaults {
            memory_limit: "256MB".to_string(),
            threads: 2,
            row_cap: 500,
            extension_channel: channel,
        }
    }

    /// ADR-0150 AC: the implicit autoinstall/autoload channel is zeroed in
    /// EVERY tier -- an extension reaches the engine only through an explicit
    /// INSTALL / LOAD statement boundary.
    #[test]
    fn open_zeroes_the_implicit_extension_channels_in_every_tier() {
        for channel in [
            ExtensionChannel::Off,
            ExtensionChannel::Core,
            ExtensionChannel::Community,
        ] {
            let conn = open(&snapshot_for(channel)).expect("sandbox opens");
            assert!(
                !read_bool_setting(&conn, "autoinstall_known_extensions"),
                "autoinstall zeroed on {channel:?}"
            );
            assert!(
                !read_bool_setting(&conn, "autoload_known_extensions"),
                "autoload zeroed on {channel:?}"
            );
        }
    }

    /// ADR-0150 AC: the community gate opens only on the community tier.
    #[test]
    fn open_gates_community_only_on_the_community_tier() {
        for channel in [ExtensionChannel::Off, ExtensionChannel::Core] {
            let conn = open(&snapshot_for(channel)).expect("sandbox opens");
            assert!(
                !read_bool_setting(&conn, "allow_community_extensions"),
                "community gated on {channel:?}"
            );
        }
        let conn = open(&snapshot_for(ExtensionChannel::Community)).expect("sandbox opens");
        assert!(
            read_bool_setting(&conn, "allow_community_extensions"),
            "community tier opens the gate"
        );
    }

    /// ADR-0150 AC: extension binaries land under the anchored app-data dir,
    /// never `~/.duckdb`. The anchor is process-global; this test holds it
    /// for the duration of its own assertions only (the only reset site is
    /// this test's own tail, so no parallel test can strip it mid-assert).
    #[test]
    fn open_redirects_the_extension_directory_when_anchored() {
        use tempfile::TempDir;
        let dir = TempDir::new().unwrap();
        crate::paths::set_extensions_dir(dir.path().to_path_buf());
        let conn = open(&snapshot_for(ExtensionChannel::Off)).expect("sandbox opens");
        let landed = read_string_setting(&conn, "extension_directory");
        assert_eq!(
            landed,
            dir.path().display().to_string(),
            "extension_directory redirected under the app-data anchor"
        );
        crate::paths::reset_extensions_dir_for_tests();
    }

    // The shared mirror primitive carries prior results into the sandbox AND the
    // new result back to admin, so it must preserve column types AND NULLs
    // across instances. Covers INT/VARCHAR/DOUBLE + a NULL cell.
    #[test]
    fn copy_table_preserves_types_and_nulls() {
        let src = Connection::open_in_memory().unwrap();
        src.execute_batch("CREATE TABLE result_1 (a INTEGER, b VARCHAR, c DOUBLE)")
            .unwrap();
        src.execute(
            "INSERT INTO result_1 VALUES (?, ?, ?), (?, ?, ?)",
            duckdb::params![
                1i64,
                "foo",
                1.5f64,
                2i64,
                duckdb::types::Value::Null,
                2.5f64
            ],
        )
        .unwrap();

        let dst = Connection::open_in_memory().unwrap();
        copy_table(&src, "result_1", &dst, "result_1").expect("copy");

        let count: i64 = dst
            .query_row("SELECT COUNT(*) FROM result_1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);

        // Values survive (typed reads succeed -> types preserved).
        let row1: (i64, String, f64) = dst
            .query_row("SELECT a, b, c FROM result_1 WHERE a = 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(row1, (1, "foo".to_string(), 1.5));

        // NULL survives (not coerced to "" or 0).
        let b_null: Option<String> = dst
            .query_row("SELECT b FROM result_1 WHERE a = 2", [], |r| r.get(0))
            .unwrap();
        assert!(b_null.is_none(), "NULL must round-trip, got {b_null:?}");
        let c2: f64 = dst
            .query_row("SELECT c FROM result_1 WHERE a = 2", [], |r| r.get(0))
            .unwrap();
        assert_eq!(c2, 2.5);
    }
}
