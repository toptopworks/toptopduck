//! Per-session state: an in-memory DuckDB parent (working-set metadata + future
//! result_N) plus READ_ONLY-attached source snapshots (ADR-0004/0005/0012). The
//! per-session temp dir holds the snapshot files and is cleared on drop (ADR-0012).

pub mod snapshot;

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use calamine::Data;
use duckdb::Connection;
use tempfile::TempDir;

use crate::guardrail::{
    apply_resource_caps, classify_duckdb_error, ExecError, ExecErrorKind, DEFAULT_MAX_RESULT_ROWS,
};
use crate::ingest;
use crate::ingest::schema::quote_ident;
use crate::ingest::tidy::{auto_tidy, forward_fill_merges, TidyOutcome};
use crate::model::{
    DatasetDescriptor, DatasetPrivacy, GuidanceRequest, GuidanceSheet, LoadError, LoadOutcome,
    RectifyProvenance, RenameError, RowPage, SheetGuidance, SheetRectify, TurnError, TurnOutcome,
    TurnRecord, EXECUTE_FAIL_PREFIX, RESOURCE_FAIL_PREFIX,
};
use crate::provider::{Provider, ProviderError, ProviderReply, UnwiredProvider};
use crate::session::snapshot::derive_table;
use crate::window;
use crate::workingset::WorkingSet;

/// Raw rows surfaced per sheet in the guided-load preview -- enough to spot the
/// header row and any separator/sub-header/footer rows to skip (ADR-0015).
const GUIDANCE_PREVIEW_ROWS: usize = 12;

/// Upper bound on a single read_rows page (ADR-0005/0024 display cap). A larger
/// requested limit is clamped so a malformed/hostile caller can't pull the whole
/// table into memory; the physical table still holds the full result.
const MAX_READ_ROWS: u64 = 10_000;

/// Single retry budget per turn (ADR-0028): malformed contract violations and
/// schema/runtime execution errors share one budget. The initial attempt plus
/// this many retries (default 2 -> 3 total attempts); exhaustion yields a
/// failed outcome with an honest reason. Resource caps / timeouts do NOT enter
/// the loop (the same SQL would hit the same wall) -- those become the cancel
/// outcome in #28. The retry is invisible to the user: one question = one
/// thread entry = one outcome.
const TURN_RETRY_BUDGET: u32 = 2;

pub struct Session {
    conn: Connection,
    working_set: WorkingSet,
    _temp_dir: TempDir, // held to keep its dir alive; cleared on drop (ADR-0012)
    temp_path: PathBuf,
    /// The LLM provider behind the turn orchestrator (ADR-0007). Defaults to
    /// [`UnwiredProvider`] (real Claude wires in #29); tests inject a scripted
    /// fake via [`Self::with_provider`]. `Send` so the session is shareable
    /// behind an `Arc<Mutex>` and turns can run on a blocking thread.
    provider: Box<dyn Provider>,
    /// The conversation thread (ADR-0028/0039): every turn, in order, each
    /// labeled by its verbatim question. The source of truth the frontend
    /// renders and the window assembler (`crate::window`, #24) reads each turn.
    history: Vec<TurnRecord>,
    /// Ceiling on a materialized result's row count (ADR-0005 L3). A query whose
    /// result would exceed it is aborted with a resource error rather than
    /// allowed to balloon memory. Defaults to [`DEFAULT_MAX_RESULT_ROWS`];
    /// tunable via [`Self::set_result_row_cap`] (e.g. tests lower it for a fast,
    /// deterministic cap-hit).
    result_row_cap: u64,
}

impl Session {
    pub fn new() -> anyhow::Result<Self> {
        let temp_dir = tempfile::Builder::new()
            .prefix("toptopduck-session-")
            .tempdir()?;
        let temp_path = temp_dir.path().to_path_buf();
        let conn = Connection::open_in_memory()?;
        // Engine-level resource caps (ADR-0005 L3): bind memory + threads before
        // any query runs so a runaway LLM SQL cannot OOM or monopolize the
        // machine. Best-effort; apply_resource_caps logs+swallows a rejection.
        apply_resource_caps(&conn);
        Ok(Self {
            conn,
            working_set: WorkingSet::default(),
            _temp_dir: temp_dir,
            temp_path,
            provider: Box::new(UnwiredProvider),
            history: Vec::new(),
            result_row_cap: DEFAULT_MAX_RESULT_ROWS,
        })
    }

    /// Tune the materialized-result row ceiling (ADR-0005 L3, "可调"). A query
    /// whose result would exceed `cap` rows aborts with a resource error. The
    /// default is [`DEFAULT_MAX_RESULT_ROWS`]; tests lower it for a fast,
    /// deterministic cap-hit, and a future preferences surface may expose it.
    pub fn set_result_row_cap(&mut self, cap: u64) {
        self.result_row_cap = cap;
    }

    /// Build a session with an explicit provider (tests inject a scripted fake;
    /// the real LLM client wires in #29). The default [`Self::new`] uses
    /// [`UnwiredProvider`] -- every turn is refused until a provider is set.
    pub fn with_provider(provider: Box<dyn Provider>) -> anyhow::Result<Self> {
        let mut session = Self::new()?;
        session.provider = provider;
        Ok(session)
    }

    /// Ingest a file. Transactional: on any failure the working set is unchanged
    /// (bad files never pollute the session -- PRD AC7). CSV/Parquet/JSON share
    /// one copy-in path -- only the DuckDB reader differs (ADR-0032 shared
    /// contract, no format-specific branches). Excel (.xlsx) goes through
    /// [`Self::ingest_excel`]: each sheet becomes its own Dataset.
    pub fn ingest(&mut self, path: &Path) -> LoadOutcome {
        let dispatched = ingest::dispatch(path);
        match dispatched {
            // Legacy .xls is rejected up front with an actionable hint (ADR-0015)
            // -- never reaches copy-in, leaves the working set untouched.
            ingest::Dispatched::Xls => LoadOutcome::Error(LoadError::LegacyExcel),
            ingest::Dispatched::Xlsx => self.ingest_excel(path),
            _ => {
                let Some(reader) = ingest::reader_for(&dispatched) else {
                    let requested = match dispatched {
                        ingest::Dispatched::Unsupported(ext) => ext,
                        // Unreachable today (Xls/Xlsx are handled above); kept
                        // total so a future variant can't silently fall through.
                        _ => String::new(),
                    };
                    return LoadOutcome::Error(LoadError::UnsupportedFormat { requested });
                };
                self.ingest_structured(path, reader)
            }
        }
    }

    fn ingest_structured(&mut self, path: &Path, reader: &str) -> LoadOutcome {
        let reference_name = match ingest::derive_reference_name(path) {
            Some(n) => self.working_set.deconflict(&n),
            None => {
                return LoadOutcome::Error(LoadError::Io {
                    detail: "无法从路径推导数据集名".into(),
                })
            }
        };

        // copy-in must succeed before the working set is touched.
        let snap = match ingest::loader::copy_in(path, &self.temp_path, &reference_name, reader) {
            Ok(s) => s,
            Err(e) => return LoadOutcome::Error(e),
        };

        // Attach the snapshot read-only (ADR-0005 engine-level enforcement).
        // `attach_path` is tool-controlled (temp dir + sanitized alias), not user
        // input, so interpolation is safe; the user-supplied source path is bound
        // as a parameter during copy-in (see ingest::loader).
        let attach_path = snap.file_path.to_string_lossy();
        let attach_sql = format!(
            "ATTACH '{attach_path}' AS {} (READ_ONLY);",
            quote_ident(&reference_name),
        );
        if let Err(e) = self.conn.execute_batch(&attach_sql) {
            let _ = std::fs::remove_file(&snap.file_path);
            return LoadOutcome::Error(LoadError::Other {
                detail: format!("挂载快照失败：{e}"),
            });
        }

        // ADR-0037: the display label is the readable original filename stem (the
        // SQL-safe reference name is sanitized above), display-layer de-conflicted
        // so two sources sharing a stem never show identical labels in the UI
        // (slice 4a, issue #8).
        let raw_display = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(reference_name.as_str());
        let display_name = self.working_set.deconflict_display(raw_display);

        let descriptor = DatasetDescriptor {
            reference_name: reference_name.clone(),
            display_name,
            source_path: path.to_string_lossy().to_string(),
            columns: snap.columns,
            row_count: snap.row_count,
            sample: snap.sample,
            fingerprint: snap.fingerprint,
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
        };
        self.working_set.register(descriptor.clone());
        LoadOutcome::Loaded(descriptor)
    }

    /// Read a workbook's visible sheets and drop blank ones -- the shared
    /// preamble for both Excel ingest paths (auto-tidy and guided). Returns
    /// `Err` with a single shared message when no sheet carries data, so the
    /// "工作簿不含任何含数据的 sheet" wording lives in one place.
    fn read_non_empty_sheets(path: &Path) -> Result<Vec<ingest::excel::SheetRows>, LoadError> {
        let mut sheets = ingest::excel::read_sheets(path)?;
        sheets.retain(|s| !s.rows.is_empty());
        if sheets.is_empty() {
            return Err(LoadError::Parse {
                detail: "工作簿不含任何含数据的 sheet".into(),
            });
        }
        Ok(sheets)
    }

    /// Ingest a .xlsx workbook (slice 3b, issue #10): best-effort auto-tidy each
    /// sheet (ADR-0015) -- forward-fill merged cells + single-header detection.
    /// If every sheet tidies confidently, each becomes a Dataset (`rectify =
    /// Auto`: the auto algorithm's choices aren't recorded, ADR-0042). If *any*
    /// sheet can't be confidently tidied, NO sheet is loaded -- the working set
    /// stays untouched and a [`LoadOutcome::NeedsGuidance`] carries each sheet's
    /// raw preview so the UI can gather explicit header/skip choices. Formula
    /// cells use their cached value (ADR-0015). Transactional: on any failure
    /// already-attached snapshots roll back (AC6/AC7).
    fn ingest_excel(&mut self, path: &Path) -> LoadOutcome {
        let sheets = match Self::read_non_empty_sheets(path) {
            Ok(s) => s,
            Err(e) => return LoadOutcome::Error(e),
        };

        // Auto-tidy each sheet; the first that can't be confidently tidied sends
        // the whole workbook to guided loading (no partial load -- transactional).
        let mut entries: Vec<(String, Vec<Vec<Data>>, RectifyProvenance)> =
            Vec::with_capacity(sheets.len());
        for sheet in &sheets {
            match auto_tidy(sheet) {
                TidyOutcome::Tidied(t) => {
                    entries.push((sheet.name.clone(), t.rows, RectifyProvenance::Auto))
                }
                TidyOutcome::NeedsGuidance => {
                    return LoadOutcome::NeedsGuidance(Self::build_guidance(path, &sheets));
                }
            }
        }

        match self.commit_excel(path, entries) {
            Ok(active) => LoadOutcome::Loaded(active),
            Err(e) => LoadOutcome::Error(e),
        }
    }

    /// Re-ingest an Excel workbook with the user's explicit rectify choices
    /// (ADR-0015 guided fallback / ADR-0042 user decisions). Each sheet is
    /// rectified by its [`SheetRectify`] (header row + skipped rows) and
    /// forward-filled over merged cells, then loaded with `rectify = User(...)`
    /// recorded on the descriptor. Transactional like [`Self::ingest`].
    pub fn ingest_guided(&mut self, path: &Path, guidance: &[SheetGuidance]) -> LoadOutcome {
        let sheets = match Self::read_non_empty_sheets(path) {
            Ok(s) => s,
            Err(e) => return LoadOutcome::Error(e),
        };

        // Apply each sheet's user rectify. A sheet with no guidance entry
        // defaults to a plain single-header rectify (header_row 1, no skips) --
        // the dialog sends one entry per visible sheet, this just stays safe.
        // Any out-of-range header_row aborts before copy-in so no partial load
        // escapes (transactional -- ADR-0042).
        let entries: Vec<(String, Vec<Vec<Data>>, RectifyProvenance)> = match sheets
            .iter()
            .map(|sheet| {
                let rectify = guidance
                    .iter()
                    .find(|g| g.name == sheet.name)
                    .map(|g| g.rectify.clone())
                    .unwrap_or_default();
                let rows = Self::apply_rectify(sheet, &rectify)?;
                Ok::<_, LoadError>((sheet.name.clone(), rows, RectifyProvenance::User(rectify)))
            })
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(e) => e,
            Err(e) => return LoadOutcome::Error(e),
        };

        match self.commit_excel(path, entries) {
            Ok(active) => LoadOutcome::Loaded(active),
            Err(e) => LoadOutcome::Error(e),
        }
    }

    /// Attach every `(display name, tidied rows, rectify)` entry as a read-only
    /// snapshot and register them atomically. De-conflicts both reference names
    /// and display labels up front (against the working set + each other) so
    /// duplicate sanitized names never collide at ATTACH time and no two sheets
    /// show identical labels in the UI (ADR-0037). Rolls back on any failure
    /// (AC6/AC7). Returns the active (last) descriptor.
    fn commit_excel(
        &mut self,
        path: &Path,
        entries: Vec<(String, Vec<Vec<Data>>, RectifyProvenance)>,
    ) -> Result<DatasetDescriptor, LoadError> {
        let mut reserved_ref: HashSet<String> = HashSet::new();
        let mut reserved_disp: HashSet<String> = HashSet::new();
        // De-conflict both names up front against the working set AND each other:
        // reference names (SQL-safe machine name) so two sheets that sanitize
        // alike never collide at ATTACH time, display labels so two sheets
        // sharing a name never show identical labels in the UI (ADR-0037, slice
        // 4a issue #8).
        let resolved: Vec<(String, String)> = entries
            .iter()
            .map(|(display, _, _)| {
                let reference = self
                    .working_set
                    .deconflict_with(&ingest::sanitize_sheet_name(display), &reserved_ref);
                reserved_ref.insert(reference.clone());
                let display = self
                    .working_set
                    .deconflict_display_with(display, &reserved_disp);
                reserved_disp.insert(display.clone());
                (reference, display)
            })
            .collect();

        // Copy-in + attach each entry; roll back on any failure. Panic-safety
        // invariant (carried from slice 3a): `attach_sheet` does only infallible
        // ops after ATTACH succeeds, so a just-attached snapshot never escapes
        // rollback -- keep it so when editing.
        let mut attached: Vec<String> = Vec::with_capacity(entries.len());
        let mut descriptors: Vec<DatasetDescriptor> = Vec::with_capacity(entries.len());
        for ((_, rows, rectify), (reference_name, display_name)) in
            entries.into_iter().zip(&resolved)
        {
            match self.attach_sheet(
                path,
                display_name,
                reference_name,
                &rows,
                rectify,
                &mut attached,
            ) {
                Ok(d) => descriptors.push(d),
                Err(e) => {
                    self.rollback_excel(&attached);
                    return Err(e);
                }
            }
        }

        // All attached: commit atomically. Callers guard entries non-empty
        // (read_non_empty_sheets rejects an empty workbook before reaching here),
        // but prefer a returned error over a reachable panic regardless.
        let Some(active) = descriptors.last().cloned() else {
            return Err(LoadError::Parse {
                detail: "工作簿不含任何含数据的 sheet".into(),
            });
        };
        for d in descriptors {
            self.working_set.register(d);
        }
        Ok(active)
    }

    /// Copy-in one tidied sheet's rows to a read-only snapshot and attach it.
    /// On failure the snapshot file is removed; the caller records successful
    /// attaches (`attached`) for transactional rollback.
    fn attach_sheet(
        &mut self,
        path: &Path,
        display_name: &str,
        reference_name: &str,
        rows: &[Vec<Data>],
        rectify: RectifyProvenance,
        attached: &mut Vec<String>,
    ) -> Result<DatasetDescriptor, LoadError> {
        // tidied rows -> temp CSV -> read_csv_auto copy-in. DuckDB infers types
        // from the CSV, keeping the single-source-of-truth contract (ADR-0032).
        let csv_path =
            ingest::excel::write_sheet_csv(rows, display_name, &self.temp_path, reference_name)?;
        // If copy-in fails the temp CSV must still be cleaned up -- the snapshot
        // file is copy_in's own responsibility, but the CSV is ours to remove.
        let snap = match ingest::loader::copy_in(
            &csv_path,
            &self.temp_path,
            reference_name,
            "read_csv_auto",
        ) {
            Ok(s) => s,
            Err(e) => {
                let _ = fs::remove_file(&csv_path);
                return Err(e);
            }
        };
        // The temp CSV is only needed during copy-in; the snapshot holds the data.
        let _ = fs::remove_file(&csv_path);

        let attach_path = snap.file_path.to_string_lossy();
        let attach_sql = format!(
            "ATTACH '{attach_path}' AS {} (READ_ONLY);",
            quote_ident(reference_name)
        );
        if let Err(e) = self.conn.execute_batch(&attach_sql) {
            let _ = fs::remove_file(&snap.file_path);
            return Err(LoadError::Other {
                detail: format!("挂载快照失败：{e}"),
            });
        }
        attached.push(reference_name.to_string());

        Ok(DatasetDescriptor {
            reference_name: reference_name.to_string(),
            display_name: display_name.to_string(),
            source_path: path.to_string_lossy().to_string(),
            columns: snap.columns,
            row_count: snap.row_count,
            sample: snap.sample,
            fingerprint: snap.fingerprint,
            rectify,
            privacy: DatasetPrivacy::default(),
        })
    }

    /// Build a [`GuidanceRequest`] from a workbook's sheets: each visible
    /// non-blank sheet's raw top rows rendered as strings (pre-rectify preview).
    fn build_guidance(path: &Path, sheets: &[ingest::excel::SheetRows]) -> GuidanceRequest {
        let workbook_name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("workbook")
            .to_string();
        let sheets_preview = sheets
            .iter()
            .map(|s| GuidanceSheet {
                name: s.name.clone(),
                preview: ingest::excel::render_preview(s, GUIDANCE_PREVIEW_ROWS),
            })
            .collect();
        GuidanceRequest {
            source_path: path.to_string_lossy().to_string(),
            workbook_name,
            sheets: sheets_preview,
        }
    }

    /// Apply a user's rectify choices to a sheet's raw grid: forward-fill merged
    /// cells, then take the header from `header_row` (1-based) and the data rows
    /// below it minus `skip_rows` (1-based absolute). Deterministic for the same
    /// input + params (ADR-0042).
    ///
    /// `header_row` is validated to be in `1..=rows.len()`: a guided ingest is a
    /// `#[tauri::command]`, so the value crosses the IPC boundary, and an
    /// out-of-range header_row would otherwise silently yield a header-less table
    /// (range miss) or a header-duplicated table (`0` -- the first row serves as
    /// both header and data). Rejecting it keeps the user's explicit decision
    /// producing exactly the table they asked for (ADR-0042).
    fn apply_rectify(
        sheet: &ingest::excel::SheetRows,
        rectify: &SheetRectify,
    ) -> Result<Vec<Vec<Data>>, LoadError> {
        let mut rows = sheet.rows.clone();
        forward_fill_merges(&mut rows, &sheet.merges);
        if rectify.header_row == 0 || rectify.header_row as usize > rows.len() {
            return Err(LoadError::Parse {
                detail: format!(
                    "表头行号 {} 越界（sheet \"{}\" 共 {} 行，需在 1..={} 内）",
                    rectify.header_row,
                    sheet.name,
                    rows.len(),
                    rows.len()
                ),
            });
        }
        let header_idx = rectify.header_row as usize - 1;
        let mut out = Vec::with_capacity(rows.len());
        out.push(rows[header_idx].clone());
        let skip: HashSet<u32> = rectify.skip_rows.iter().copied().collect();
        for (i, row) in rows.iter().enumerate() {
            let abs = (i + 1) as u32; // 1-based absolute row
            if abs > rectify.header_row && !skip.contains(&abs) {
                out.push(row.clone());
            }
        }
        Ok(out)
    }

    /// Detach already-attached excel snapshots and delete their files (rollback).
    /// Best-effort: a DETACH or remove_file failure is logged, not swallowed
    /// silently. A failed DETACH can leave a ghost attachment on the connection
    /// (breaking a later same-name re-ATTACH), and on Windows a held handle can
    /// make remove_file fail too -- logging keeps either failure diagnosable.
    fn rollback_excel(&mut self, attached: &[String]) {
        for reference_name in attached.iter().rev() {
            if let Err(e) = self
                .conn
                .execute_batch(&format!("DETACH {};", quote_ident(reference_name)))
            {
                log::warn!(
                    target: "toptopduck::session",
                    "DETACH failed during excel rollback for {reference_name}: {e}"
                );
            }
            if let Err(e) = fs::remove_file(self.temp_path.join(format!("{reference_name}.duckdb")))
            {
                log::warn!(
                    target: "toptopduck::session",
                    "snapshot file removal failed during excel rollback for {reference_name}: {e}"
                );
            }
        }
    }

    pub fn list(&self) -> Vec<DatasetDescriptor> {
        self.working_set.list().to_vec()
    }

    pub fn active(&self) -> Option<DatasetDescriptor> {
        self.working_set.active().cloned()
    }

    pub fn get(&self, reference_name: &str) -> Option<DatasetDescriptor> {
        self.working_set.get(reference_name).cloned()
    }

    /// Rename a dataset's display label (ADR-0037): display-only -- the reference
    /// name is untouched, so every existing reference (SQL FROM, the recipe
    /// chain, the active pointer) stays valid and nothing is rewritten or
    /// propagated. Delegates to the working set, returning the updated
    /// descriptor, or a [`RenameError`] when the reference is unknown or the new
    /// label collides with another dataset's display label (display-layer
    /// uniqueness).
    pub fn rename_display(
        &mut self,
        reference_name: &str,
        new_display: &str,
    ) -> Result<DatasetDescriptor, RenameError> {
        self.working_set.rename_display(reference_name, new_display)
    }

    /// Set a dataset's privacy controls (ADR-0011, issue #9 slice 5): per-
    /// dataset sample switch + per-column type-only marking. The config rides
    /// the descriptor in the working set, so it persists across UI resize /
    /// active-dataset switch / source replace, and the query-loop window
    /// assembler (PRD #1) reads it off the same descriptor to prune the LLM
    /// payload (cross-PRD contract). Returns the updated descriptor, or `None`
    /// when the reference name isn't loaded -- the command boundary maps that to
    /// an error string.
    pub fn set_privacy(
        &mut self,
        reference_name: &str,
        privacy: DatasetPrivacy,
    ) -> Option<DatasetDescriptor> {
        self.working_set.set_privacy(reference_name, privacy)
    }

    /// Re-upload a file onto an existing dataset's reference name (ADR-0042,
    /// issue #11 slice 4b): a fresh snapshot takes over the name and the old
    /// snapshot is discarded. Distinct from [`Self::ingest`] (add): the reference
    /// name to take over is explicit, and the new snapshot does **not** receive a
    /// de-conflicted new name.
    ///
    /// Transactional up to the file swap. The new snapshot is pre-attached under
    /// a `__swap` alias and confirmed readable **before** the old one is touched,
    /// so any failure up to and including that confirmation (copy-in parse, new-
    /// snapshot mount, swap/release, old-DETACH) leaves the working set and the
    /// old snapshot untouched and still queryable. Only after the new snapshot is
    /// confirmed is the old one detached and its file removed; the swap file is
    /// then promoted to the formal name (or attached in place when the rename is
    /// blocked by a lingering old handle). That promote operates on an already-
    /// verified file, so the post-confirm steps are deterministic file moves plus
    /// a re-ATTACH of the same file under the reference name.
    ///
    /// Only structured files (CSV/Parquet/JSON) are supported here -- they map
    /// 1:1 to a single snapshot taking over the name. Excel workbooks (multi-
    /// sheet semantics, guided rectify) need their own replace path and are out
    /// of scope for this slice; passing one returns an error and leaves the
    /// working set untouched. `.xls` is rejected with the same actionable hint as
    /// ingest. This is also the sole way to fix a mis-inferred type or a bad
    /// rectify: source snapshots are read-only, so the data can only be swapped
    /// by re-uploading (ADR-0020).
    pub fn replace_source(&mut self, reference_name: &str, path: &Path) -> LoadOutcome {
        // The reference name must already be loaded -- a replace targets an
        // existing source, it never creates one.
        let existing = match self.working_set.get(reference_name) {
            Some(d) => d.clone(),
            None => {
                return LoadOutcome::Error(LoadError::Other {
                    detail: format!("找不到引用名为「{reference_name}」的数据集，无法换源"),
                })
            }
        };

        // Dispatch the new file. Same front door as ingest: .xls rejected up
        // front; structured formats go to copy-in; .xlsx is refused here (its
        // multi-sheet / guided replace semantics are a separate slice).
        let dispatched = ingest::dispatch(path);
        let reader = match dispatched {
            ingest::Dispatched::Xls => return LoadOutcome::Error(LoadError::LegacyExcel),
            ingest::Dispatched::Xlsx => {
                return LoadOutcome::Error(LoadError::Other {
                    detail: "换源暂不支持 Excel 工作簿（多 sheet 语义待定），请改用结构化文件"
                        .into(),
                });
            }
            _ => match ingest::reader_for(&dispatched) {
                Some(r) => r,
                None => {
                    let requested = match dispatched {
                        ingest::Dispatched::Unsupported(ext) => ext,
                        _ => String::new(),
                    };
                    return LoadOutcome::Error(LoadError::UnsupportedFormat { requested });
                }
            },
        };

        // Copy-in the new file under a swap stem: the old snapshot's file
        // (`<ref>.duckdb`) is still attached and held, so the new one must land
        // elsewhere first. copy_in clears any stale swap file from a prior failed
        // attempt before writing.
        let swap_alias = format!("{reference_name}__swap");
        let new_snap = match ingest::loader::copy_in(path, &self.temp_path, &swap_alias, reader) {
            Ok(s) => s,
            Err(e) => return LoadOutcome::Error(e),
        };

        // Confirm the new snapshot mounts BEFORE retiring the old one: pre-attach
        // it under the swap alias (distinct from `<ref>`, so both co-exist). A
        // mount failure here means the new file is unusable -- the swap file is
        // removed and the old snapshot stays attached and queryable, working set
        // untouched. This front-loads the only non-deterministic failure (can the
        // engine open this snapshot?) ahead of any destructive step, so a bad new
        // file never costs the user the old one.
        let swap_path = new_snap.file_path.to_string_lossy().into_owned();
        if let Err(e) = self.conn.execute_batch(&format!(
            "ATTACH '{swap_path}' AS {} (READ_ONLY);",
            quote_ident(&swap_alias),
        )) {
            log::warn!(
                target: "toptopduck::session",
                "pre-attach of new snapshot failed during replace for {reference_name}: {e}"
            );
            let _ = fs::remove_file(&new_snap.file_path);
            return LoadOutcome::Error(LoadError::Other {
                // Prefix-free: App.tsx prepends "换源失败：" for kind "replace",
                // matching the load path (loadErrorMessage surfaces detail verbatim).
                detail: format!("无法挂载新快照（{e}）"),
            });
        }
        // Release the swap file's handle so the promote step can rename it. This
        // DETACHes the very attachment just confirmed, so it cannot fail for a
        // file-content reason; on failure the old snapshot is still attached and
        // queryable, so we abort before any damage (the swap file is best-effort
        // removed, though the held handle may keep it until session drop).
        if let Err(e) = self
            .conn
            .execute_batch(&format!("DETACH {};", quote_ident(&swap_alias)))
        {
            log::warn!(
                target: "toptopduck::session",
                "DETACH swap failed during replace for {reference_name}: {e}"
            );
            let _ = fs::remove_file(&new_snap.file_path);
            return LoadOutcome::Error(LoadError::Other {
                detail: format!("无法释放新快照（{e}）"),
            });
        }

        // New snapshot confirmed -- retire the old one. DETACH first to release
        // the old file's handle (Windows won't remove a held file); if DETACH
        // fails the old snapshot is still attached and usable, so the swap file is
        // orphaned and removed, and the error is reported with the working set
        // untouched.
        if let Err(e) = self
            .conn
            .execute_batch(&format!("DETACH {};", quote_ident(reference_name)))
        {
            log::warn!(
                target: "toptopduck::session",
                "DETACH old failed during replace for {reference_name}: {e}"
            );
            let _ = fs::remove_file(&new_snap.file_path);
            return LoadOutcome::Error(LoadError::Other {
                detail: format!("无法释放旧快照（{e}）"),
            });
        }
        // Old detached -- remove its file. Best-effort (mirrors rollback_excel):
        // a remove failure (e.g. a lingering handle on Windows) is logged, then
        // the promote step falls back to attaching the swap file in place.
        let formal = self.temp_path.join(format!("{reference_name}.duckdb"));
        if let Err(e) = fs::remove_file(&formal) {
            log::warn!(
                target: "toptopduck::session",
                "old snapshot file removal during replace for {reference_name}: {e}"
            );
        }
        // Promote the swap file to the formal name when possible; if rename
        // fails (the old file couldn't be cleared), attach the swap file where
        // it is -- the session temp dir is wiped on drop either way.
        let attach_path = match fs::rename(&new_snap.file_path, &formal) {
            Ok(()) => formal.to_string_lossy().into_owned(),
            Err(e) => {
                log::warn!(
                    target: "toptopduck::session",
                    "rename swap->formal during replace for {reference_name}: {e}"
                );
                swap_path
            }
        };
        // Post-confirm window -- unrecoverable from here on. The old snapshot
        // is already detached and its file best-effort removed, so a failure at
        // this final ATTACH leaves the session half-attached: `reference_name`
        // has no attachment, yet `working_set` still holds the stale descriptor
        // (it is updated only after this succeeds). In practice this ATTACH
        // cannot fail -- the same file attached successfully in the pre-attach
        // step, and the session is single-threaded under its Mutex -- so the
        // only realistic triggers are OS-level (e.g. an AV scan locking the
        // renamed path). Recovery is a session restart; accepted as the cost of
        // skipping a swap-then-cleanup round-trip (ADR-0042).
        if let Err(e) = self.conn.execute_batch(&format!(
            "ATTACH '{attach_path}' AS {} (READ_ONLY);",
            quote_ident(reference_name)
        )) {
            return LoadOutcome::Error(LoadError::Other {
                detail: format!("无法挂载新快照（{e}）"),
            });
        }

        // Commit: update the descriptor in place. The reference name is stable
        // (every existing reference now resolves to the new data); the display
        // label carries over (a user rename survives the replace, ADR-0037); the
        // privacy config carries over too (issue #9 AC4: a source's privacy
        // intent survives a re-upload -- entries for columns that no longer exist
        // are ignored at read time, ADR-0011); the body reflects the new snapshot.
        let updated = DatasetDescriptor {
            reference_name: reference_name.to_string(),
            display_name: existing.display_name,
            source_path: path.to_string_lossy().to_string(),
            columns: new_snap.columns,
            row_count: new_snap.row_count,
            sample: new_snap.sample,
            fingerprint: new_snap.fingerprint,
            rectify: RectifyProvenance::NotApplicable,
            privacy: existing.privacy,
        };
        self.working_set.replace(updated.clone());
        LoadOutcome::Loaded(updated)
    }

    /// Run one turn (PRD #1): assemble a schema-aware request, ask the provider
    /// (ADR-0009 contract: SQL or textual), and produce exactly one ADR-0028
    /// outcome -- result / textual / failed (cancelled arrives in #28). The
    /// single retry budget (malformed output + schema/runtime error) is consumed
    /// invisibly; on exhaustion the turn fails honestly. Every turn is recorded
    /// in the conversation thread (always visible, ADR-0028/0039); only a result
    /// advances result_N. Infallible -- a question always yields one outcome.
    pub fn ask(&mut self, question: &str) -> TurnOutcome {
        let request = window::assemble(question, &self.working_set, &self.history);
        // Collect each attempt's failure so exhaustion surfaces them all, not
        // just the last -- a SQL execution error (the actionable kind) would
        // otherwise be overwritten by a later transient Unavailable. Consecutive
        // identical failures dedupe so a persistently-bad SQL isn't repeated
        // across attempts.
        let mut failures: Vec<String> = Vec::new();
        for _attempt in 0..=TURN_RETRY_BUDGET {
            match self.provider.generate(&request) {
                // Textual branch (ADR-0017/0018): a valid non-result turn -- no
                // retry, no result_N. The provider's text + assumption ride the
                // outcome verbatim.
                Ok(ProviderReply::Text {
                    kind,
                    body,
                    assumption,
                }) => {
                    let outcome = TurnOutcome::Textual {
                        text_kind: kind,
                        body,
                        assumption,
                    };
                    return self.record_turn(question, outcome);
                }
                // SQL branch: execute + materialize. A schema/runtime failure
                // (bad reference, type error) consumes the budget and retries;
                // a resource-cap hit does NOT retry (the same SQL would hit the
                // same wall, ADR-0005/0028) and fails immediately. Success
                // materializes result_N.
                Ok(ProviderReply::Sql {
                    sql, assumption, ..
                }) => match self.try_materialize(&sql) {
                    Ok(dataset) => {
                        let outcome = TurnOutcome::Materialized {
                            dataset: Box::new(dataset),
                            sql: Some(sql),
                            assumption,
                        };
                        return self.record_turn(question, outcome);
                    }
                    Err(exec_err) => match exec_err.kind {
                        // Resource cap: abort now -- retrying cannot help.
                        ExecErrorKind::Resource => {
                            let outcome = TurnOutcome::Failed {
                                reason: format!("{}{}", RESOURCE_FAIL_PREFIX, exec_err.detail),
                            };
                            return self.record_turn(question, outcome);
                        }
                        // Schema/runtime: feed the budget and retry.
                        _ => Self::push_failure(
                            &mut failures,
                            format!("{}{}", EXECUTE_FAIL_PREFIX, exec_err.detail),
                        ),
                    },
                },
                // NotWired is permanent (no provider configured) -- retrying
                // cannot help, so the turn fails immediately without consuming
                // the budget.
                Err(ProviderError::NotWired) => {
                    let outcome = TurnOutcome::Failed {
                        reason: ProviderError::NotWired.to_string(),
                    };
                    return self.record_turn(question, outcome);
                }
                // A contract violation / transient call failure -- consume the
                // budget and retry with the SAME request (blind retry). The real
                // client's error re-feed lands in #29; the scripted fake's queue
                // advances per call.
                Err(ProviderError::Unavailable(detail)) => {
                    Self::push_failure(
                        &mut failures,
                        ProviderError::Unavailable(detail).to_string(),
                    );
                }
            }
        }
        // Budget exhausted: surface the accumulated failures honestly as a failed
        // turn. The "重试预算耗尽" prefix distinguishes this from a permanent
        // NotWired failure (which never consumes the budget, ADR-0028), so the
        // two failure paths read distinctly to the user.
        let detail = if failures.is_empty() {
            "未知错误".to_string()
        } else {
            failures.join("；")
        };
        let outcome = TurnOutcome::Failed {
            reason: format!("重试预算耗尽：{detail}"),
        };
        self.record_turn(question, outcome)
    }

    /// Record one retry attempt's failure, deduping consecutive identical
    /// failures: a persistent error isn't repeated across attempts, while
    /// distinct failures (e.g. a SQL error then a transient Unavailable) are
    /// all kept so budget exhaustion surfaces the full picture, not just the
    /// last attempt.
    fn push_failure(failures: &mut Vec<String>, detail: String) {
        match failures.last() {
            Some(last) if last == &detail => {} // consecutive duplicate -- skip
            _ => failures.push(detail),
        }
    }

    /// Append a turn to the conversation thread and return its outcome. Every
    /// outcome kind is recorded (ADR-0028 always-visible); the caller has
    /// already decided the outcome, so this just persists + returns it.
    fn record_turn(&mut self, question: &str, outcome: TurnOutcome) -> TurnOutcome {
        self.history.push(TurnRecord {
            question: question.to_string(),
            outcome: outcome.clone(),
        });
        outcome
    }

    /// Execute one provider SQL and materialize it as result_N (ADR-0003/0024),
    /// deriving + registering the result. Returns `Err` carrying a classified
    /// [`ExecError`] on any failure: a rejected CREATE (engine error -- the
    /// wrapping rejects mutating statements and COPY/ATTACH/INSTALL/LOAD as
    /// parser errors; ADR-0005), a hit resource cap, or a shape-derivation
    /// failure. The caller's retry loop routes on the kind: Resource aborts,
    /// Schema/Runtime retry (ADR-0028).
    ///
    /// On a shape-derivation failure the just-created result_N is rolled back
    /// first: an orphan table left unregistered would make the next attempt's
    /// `next_result_number` reuse N and clash on CREATE, wedging every later
    /// turn (ADR-0022 never-reused). The DROP is best-effort but its own failure
    /// is folded into the detail so a wedged session is observable, not
    /// silently masked (M1 regression).
    ///
    /// Engine guardrails (ADR-0005): the SQL is embedded as
    /// `CREATE TABLE result_N AS SELECT * FROM (<sql>) LIMIT cap+1`. The
    /// subquery wrapping means a non-SELECT statement (DROP/ALTER/INSERT/
    /// UPDATE/DELETE, COPY/ATTACH/INSTALL/LOAD) is a parser error before it can
    /// touch a source or the filesystem; the LIMIT pushes down into the scan so
    /// at most cap+1 rows materialize, capping memory on a runaway join. The
    /// result name is tool-generated; the SQL is provider-supplied -- the only
    /// live provider returning SQL today is the scripted test fake (the real
    /// LLM wires in #29).
    fn try_materialize(&mut self, sql: &str) -> Result<DatasetDescriptor, ExecError> {
        // result_N is max+1, never reused (ADR-0022). Re-derived each attempt:
        // a failed attempt registers nothing, so N is stable across retries.
        let n = self.working_set.next_result_number();
        let result_name = format!("result_{n}");
        // Resource cap (ADR-0005 L3): bracket the query and LIMIT to cap+1 so a
        // runaway cross-join cannot balloon memory (DuckDB pushes LIMIT into the
        // scan, so only cap+1 rows ever materialize). The brackets make LIMIT
        // bind to the whole query output; a trailing ';' is stripped so the
        // subquery parses. Below, a count of cap+1 means the true result
        // exceeded the cap -> abort (silent truncation is forbidden, ADR-0030).
        let inner = sql.trim().trim_end_matches(';').trim_end();
        let cap_plus_one = self.result_row_cap.saturating_add(1);
        let create_sql = format!(
            "CREATE TABLE {} AS SELECT * FROM ({inner}) AS _src LIMIT {cap_plus_one}",
            quote_ident(&result_name),
        );
        if let Err(e) = self.conn.execute_batch(&create_sql) {
            // The engine rejected the CREATE -- a parser error from a mutating
            // statement / COPY / ATTACH / etc. the wrapping bars (ADR-0005), a
            // schema error (bad reference), or a runtime error (type). Classify
            // so the caller can route retry vs abort.
            return Err(ExecError::new(
                classify_duckdb_error(&e.to_string()),
                e.to_string(),
            ));
        }
        // Row-count governor: count == cap+1 -> the true result exceeded the cap.
        let rows: i64 = match self.conn.query_row(
            &format!("SELECT COUNT(*) FROM {}", quote_ident(&result_name)),
            [],
            |r| r.get(0),
        ) {
            Ok(n) => n,
            Err(e) => {
                // The count itself failed (engine error on the just-created
                // table) -- roll back and surface as a runtime error.
                let _ = self
                    .conn
                    .execute_batch(&format!("DROP TABLE {}", quote_ident(&result_name)));
                return Err(ExecError::new(ExecErrorKind::Runtime, e.to_string()));
            }
        };
        if rows as u64 > self.result_row_cap {
            // Over the cap: abort with a resource error and roll back result_N
            // so the next attempt's N is stable (ADR-0022).
            let _ = self
                .conn
                .execute_batch(&format!("DROP TABLE {}", quote_ident(&result_name)));
            return Err(ExecError::new(
                ExecErrorKind::Resource,
                format!("结果行数（{rows}）超过上限 {}", self.result_row_cap),
            ));
        }

        // Derive the result's shape from the just-created table -- the same
        // derivation a source snapshot uses (DRY).
        let shape = match derive_table(&self.conn, &result_name, &self.temp_path, &result_name) {
            Ok(shape) => shape,
            Err(e) => {
                let drop_sql = format!("DROP TABLE {}", quote_ident(&result_name));
                let detail = match self.conn.execute_batch(&drop_sql) {
                    Ok(()) => e.to_string(),
                    // The cleanup DROP itself failed: the orphan result_N likely
                    // lingers and will clash on a later CREATE -- surface it so a
                    // wedged session is observable, not silently masked.
                    Err(drop_err) => format!(
                        "{e}; cleanup DROP of {result_name} also failed: {drop_err} (orphan table may wedge later turns)"
                    ),
                };
                return Err(ExecError::new(ExecErrorKind::Runtime, detail));
            }
        };
        let descriptor = DatasetDescriptor {
            reference_name: result_name.clone(),
            display_name: result_name,
            source_path: String::new(), // derived -- no source file (ADR-0004)
            columns: shape.columns,
            row_count: shape.row_count,
            sample: shape.sample,
            fingerprint: shape.fingerprint,
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
        };
        self.working_set.register_result(descriptor.clone());
        Ok(descriptor)
    }

    /// The conversation thread (ADR-0028/0039): every turn, in order, each
    /// labeled by its verbatim question. The thread is the source of truth the
    /// frontend renders and the window assembler (`crate::window`) reads each
    /// turn to build the provider payload (ADR-0023 window + ADR-0039 summary).
    pub fn conversation(&self) -> &[TurnRecord] {
        &self.history
    }

    /// Read one page of a dataset's rows (ADR-0024 windowed display). Cells are
    /// CAST to VARCHAR (NULL -> "") for uniform frontend rendering. `total` is
    /// the full row count, returned alongside the page so a truncated view never
    /// masquerades as complete (ADR-0030). Sources read `"<ref>".data`; results
    /// read `"<ref>"`. The FROM fragment, identifiers, and numeric LIMIT/OFFSET
    /// are all tool-generated, so the interpolation is safe.
    pub fn read_rows(
        &self,
        reference_name: &str,
        offset: u64,
        limit: u64,
    ) -> Result<RowPage, TurnError> {
        // Clamp the page size to the display cap (ADR-0005/0024) so a malformed
        // or hostile caller can't pull the whole table into memory.
        let limit = limit.min(MAX_READ_ROWS);
        let descriptor = self
            .working_set
            .get(reference_name)
            .ok_or_else(|| TurnError::UnknownDataset(reference_name.to_string()))?;
        let from = self
            .working_set
            .sql_from(reference_name)
            .ok_or_else(|| TurnError::UnknownDataset(reference_name.to_string()))?;
        let columns = descriptor.columns.clone();
        let selects: Vec<String> = columns
            .iter()
            .map(|c| format!("CAST({} AS VARCHAR)", quote_ident(&c.name)))
            .collect();
        let sql = format!(
            "SELECT {} FROM {} LIMIT {} OFFSET {}",
            selects.join(", "),
            from,
            limit,
            offset
        );
        let mut stmt = self
            .conn
            .prepare(&sql)
            .map_err(|e| TurnError::Execute(e.to_string()))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| TurnError::Execute(e.to_string()))?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| TurnError::Execute(e.to_string()))? {
            let mut cells = Vec::with_capacity(columns.len());
            for i in 0..columns.len() {
                let v: Option<String> =
                    row.get(i).map_err(|e| TurnError::Execute(e.to_string()))?;
                cells.push(v.unwrap_or_default());
            }
            out.push(cells);
        }
        Ok(RowPage {
            columns,
            rows: out,
            total: descriptor.row_count,
            offset,
            limit,
        })
    }

    /// Run arbitrary SQL on the session connection. Exposed for the read-only
    /// enforcement tests (AC5): writes against a source snapshot are rejected by
    /// the engine. Not part of the public ingest contract.
    pub fn execute_batch(&self, sql: &str) -> Result<(), duckdb::Error> {
        self.conn.execute_batch(sql)
    }

    /// Count rows in a snapshot's `data` table through its reference name
    /// (issue #11 AC1: a replace must make a later query see the *new* data).
    /// Exposed for the black-box tests alongside [`Self::execute_batch`] -- not
    /// part of the public ingest contract (the real query path arrives with the
    /// query loop, PRD #1).
    pub fn snapshot_row_count(&self, reference_name: &str) -> Result<i64, duckdb::Error> {
        self.conn.query_row(
            &format!("SELECT COUNT(*) FROM {}.data", quote_ident(reference_name)),
            [],
            |r| r.get(0),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::Session;
    use crate::model::TurnOutcome;
    use crate::provider::fake::FakeProvider;
    use crate::provider::ProviderReply;
    use tempfile::NamedTempFile;

    // M1 regression: a turn whose shape derivation fails must roll back the
    // already-created result_N. Here the derivation's fingerprint dump cannot be
    // written -- temp_path points at a file, so its "child" dump path has a file
    // as parent and the COPY ... TO fails, but only AFTER CREATE TABLE result_1
    // has succeeded. Without the DROP rollback the orphan table lingers
    // unregistered; within this turn's retry loop the next attempt's
    // next_result_number reuses N and clashes on CREATE, and across later turns
    // every ask wedges on the same clash (ADR-0022 never-reused). The derive
    // failure is retried up to the budget (ADR-0028 single loop), then the turn
    // fails honestly -- but every failed attempt must still roll back result_1.
    #[test]
    fn ask_drops_the_result_table_when_shape_derivation_fails() {
        let provider = FakeProvider::new().scripted(
            "建表",
            ProviderReply::Sql {
                sql: "SELECT 1 AS n".into(),
                viz: None,
                assumption: None,
            },
        );
        let mut session = Session::with_provider(Box::new(provider)).expect("session");
        // Derivation work dir whose parent is a file -> the fingerprint
        // COPY ... TO '<path>/result_1.fingerprint.csv' fails after CREATE.
        let file = NamedTempFile::new().expect("temp file");
        session.temp_path = file.path().to_path_buf();

        // The derive failure exhausts the retry budget and surfaces as a failed
        // turn whose reason carries the execution-step failure.
        let reason = match session.ask("建表") {
            TurnOutcome::Failed { reason } => reason,
            other => panic!("expected Failed after derive failure, got {other:?}"),
        };
        assert!(
            reason.contains("执行查询失败"),
            "derive failure reason should carry the execution prefix, got {reason:?}"
        );

        // result_1 was rolled back on every attempt: it is no longer a table in
        // the session DB. (A broken rollback would leave it lingering -> the
        // retry's next CREATE clashes and the probe below is non-zero.)
        let remaining: i64 = session
            .conn
            .query_row(
                "SELECT count(*) FROM information_schema.tables WHERE table_name = 'result_1'",
                [],
                |r| r.get(0),
            )
            .expect("information_schema probe");
        assert_eq!(
            remaining, 0,
            "result_1 must be dropped after the derive failure (M1)"
        );
    }

    #[test]
    fn resource_caps_are_applied_to_the_session_connection() {
        // AC3 (issue #25): the engine-level resource caps are set on the session
        // connection at construction (ADR-0005 L3). Read back via duckdb_settings
        // (PRAGMA-as-query is unsupported in this DuckDB for these keys).
        let session = Session::new().expect("session");
        let threads: String = session
            .conn
            .query_row(
                "SELECT value FROM duckdb_settings() WHERE name='threads'",
                [],
                |r| r.get(0),
            )
            .expect("threads setting");
        assert_eq!(threads, crate::guardrail::MAX_THREADS.to_string());
        let mem: String = session
            .conn
            .query_row(
                "SELECT value FROM duckdb_settings() WHERE name='memory_limit'",
                [],
                |r| r.get(0),
            )
            .expect("memory_limit setting");
        assert!(
            mem.contains('2') || mem.contains("512"),
            "memory_limit={mem}"
        );
    }
}
