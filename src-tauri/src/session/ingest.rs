//! File ingestion pipeline on [`Session`] (ADR-0053 Decision 5 precedent).
//!
//! The methods that bring external files into the session: the `ingest`
//! dispatch entry (structured CSV/Parquet/JSON + Excel .xlsx), the Excel
//! auto-tidy / guided-rectify paths, and the snapshot release helpers shared
//! with resume and source-lifecycle removal. A physical move out of
//! `session/mod.rs` for locality -- NOT a deep module: ADR-0053 Decision 5
//! established the precedent (source lifecycle moved the same way), so they
//! stay `&mut Session` methods and only the physical location changes.
//!
//! The impl block is a sibling of the ones in `session/mod.rs` and
//! `session/source_lifecycle.rs`: Rust lets a descendant module
//! (`session::ingest`) add methods to a type defined in the ancestor
//! (`session`) and reach its private fields. `release_snapshot` /
//! `detach_snapshot` are `pub(super)` because `resume_sources` (in
//! `resume.rs`) and `commit_removal` (in `source_lifecycle.rs`) call them across
//! module boundaries.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use calamine::Data;

use crate::ingest;
use crate::ingest::schema::{attach_sql, quote_ident};
use crate::ingest::tidy::{auto_tidy, forward_fill_merges, TidyOutcome};
use crate::model::{
    DatasetDescriptor, DatasetPrivacy, GuidanceRequest, GuidanceSheet, GuidanceSheetState,
    LoadError, LoadOutcome, RectifyProvenance, SheetGuidance, SheetRectify, SourceLifecycleKind,
};

/// Raw rows surfaced per sheet in the guided-load preview -- enough to spot the
/// header row and any separator/sub-header/footer rows to skip (ADR-0015).
/// Doubles as the pager's window size (issue #750): the first inlined window
/// and every fetched window are the same height.
const GUIDANCE_PREVIEW_ROWS: usize = 12;

/// The defensive floor for a guided commit that selects nothing (ADR-0148):
/// shared wording for the empty-selection guard and the all-unknown-names
/// guard, so the two rejects can never drift apart.
const NO_SHEET_SELECTED: &str = "未选择任何 sheet";

/// The parsed sheets of a workbook parked on the guided-load dialog (issue
/// #750): `read_non_empty_sheets` already parsed the workbook fully for the
/// `NeedsGuidance` outcome, and holding that parse until the dialog resolves
/// makes preview-window paging zero-reparse. Keyed by the source path the
/// guidance was built from, so a superseding ingest's retention can never
/// serve a stale dialog's window request (the lookup misses instead).
/// Ephemeral -- never persisted, gone on session drop; the lifecycle is
/// set-on-NeedsGuidance / drop-on-guided-commit / drop-on-dialog-cancel.
pub(super) struct GuidanceRetention {
    pub(super) source_path: String,
    pub(super) sheets: Vec<ingest::excel::SheetRows>,
}

impl super::Session {
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

    /// Detach a source's read-only snapshot + drop it from the working set,
    /// WITHOUT appending a lifecycle event or cascading stale. Used during
    /// resume re-link / drift retry: the source is being re-ingested under
    /// the same name (re-link) or abandoned mid-resume (Rebuild), so the snapshot
    /// file must be released before a new copy-in can attach under the same
    /// name. Best-effort + logged I/O (mirrors `commit_removal`): a failure
    /// leaves a ghost attachment, but the working set is the source of truth
    /// and the session temp dir is wiped on drop.
    pub(super) fn detach_snapshot(&mut self, reference_name: &str) {
        // Shared best-effort I/O lives in `release_snapshot`.
        self.release_snapshot(reference_name);
    }

    /// Release a source's snapshot: DETACH the catalog + delete the snapshot
    /// file + drop the working-set entry. Best-effort + logged I/O shared by
    /// [`Self::detach_snapshot`] (resume re-link / drift retry) and
    /// [`Self::commit_removal`] (source removal). A failure leaves a ghost
    /// attachment or a stray temp file, but the working set (source of truth)
    /// still reflects the removal; the session temp dir is wiped on drop.
    pub(super) fn release_snapshot(&mut self, reference_name: &str) {
        if let Err(e) = self
            .admin_engine
            .execute_batch(&format!("DETACH {};", quote_ident(reference_name)))
        {
            log::warn!(
                target: "toptopduck::session",
                "DETACH failed for {reference_name}: {e}"
            );
        }
        let snapshot_path = self
            .source_files
            .remove(reference_name)
            .unwrap_or_else(|| self.snapshot_dir().join(format!("{reference_name}.duckdb")));
        // The reader entry is registration provenance (ADR-0137 D4) -- it
        // retires with the snapshot, so a later manual re-registration under
        // the same name can never inherit a stale reader.
        self.persister.source_readers.remove(reference_name);
        if let Err(e) = fs::remove_file(&snapshot_path) {
            log::warn!(
                target: "toptopduck::session",
                "snapshot file removal failed for {reference_name}: {e}"
            );
        }
        self.working_set.remove(reference_name);
        // Invalidate any derived-source dedup cache entry pointing at this ref
        // (issue #440): a later materialize referencing the same tool_output
        // file must re-stage + re-register, not reuse the dangling name.
        self.tool_output_refs
            .retain(|_, v| v.ref_name != reference_name);
    }

    fn ingest_structured(&mut self, path: &Path, reader: &str) -> LoadOutcome {
        let reference_name = match ingest::derive_reference_name(path) {
            // ADR-0141 D6: the private face yields to the shared vocabulary.
            Some(n) => super::shared_datasets::deconflict_with_shared(
                &n,
                &self.working_set,
                self.runtime_facts.workspace.as_deref(),
                Some(&self.shared_attaches),
            ),
            None => {
                return LoadOutcome::Error(LoadError::Io {
                    detail: "无法从路径推导数据集名".into(),
                })
            }
        };

        // copy-in must succeed before the working set is touched.
        let snap =
            match ingest::loader::copy_in(path, &self.snapshot_dir(), &reference_name, reader) {
                Ok(s) => s,
                Err(e) => return LoadOutcome::Error(e),
            };

        // Attach the snapshot read-only (ADR-0005 engine-level enforcement);
        // the user-supplied source path is bound as a parameter during
        // copy-in (see ingest::loader).
        let attach_sql = attach_sql(&snap.file_path.to_string_lossy(), &reference_name);
        if let Err(e) = self.admin_engine.execute_batch(&attach_sql) {
            if let Err(io_err) = std::fs::remove_file(&snap.file_path) {
                log::warn!(
                    target: "toptopduck::session",
                    "snapshot file removal failed during ingest_structured for {reference_name}: {io_err}"
                );
            }
            return LoadOutcome::Error(LoadError::Other {
                detail: format!("failed to mount snapshot: {e}"),
            });
        }

        // Stat BEFORE the file_path move, while the path is still borrowable;
        // the writing connection is long dropped (copy_in closed it), so the
        // on-disk size is final (issue #1485).
        let size_bytes = crate::session::snapshot::snapshot_len(&snap.file_path);
        // Record the attached snapshot's file so the sandbox can re-attach it
        // READ_ONLY (ADR-0005 read_* closure). file_path is moved here; the
        // descriptor below takes snap's remaining fields.
        self.source_files
            .insert(reference_name.clone(), snap.file_path);

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
            size_bytes,
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: None,
        };
        self.working_set.register(descriptor.clone());
        // ADR-0040: a successful add appends a source lifecycle event -- a
        // first-class thread entry that is NOT a turn (no question, no outcome),
        // so it never enters the LLM window or advances result_N.
        self.append_source_event(
            SourceLifecycleKind::Added,
            &descriptor.reference_name,
            &descriptor.display_name,
        );
        LoadOutcome::Loaded(descriptor)
    }

    /// Read a workbook's visible sheets and drop blank ones -- the shared
    /// preamble for both legs of the Excel ingest flow: the confirmation
    /// park and the guided commit. Returns
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

    /// Ingest a .xlsx workbook (ADR-0148): best-effort auto-tidy each sheet
    /// (ADR-0015) for its two-state -- the detected header row as the dialog's
    /// pre-fill guess (AutoTidied), or the failure reason (NeedsGuidance) --
    /// then park the WHOLE workbook on [`LoadOutcome::NeedsGuidance`] no matter
    /// the tidy outcome. Every import goes through the confirmation dialog and
    /// commits only via [`Self::ingest_guided`] with the user's per-sheet
    /// acceptance; the old full-green direct-commit branch is gone (a tidy
    /// guess is never confirmation -- ADR-0015's trust baseline). The payload
    /// carries each sheet's raw preview so the dialog renders without a second
    /// parse. Formula cells use their cached value (ADR-0015). The working set
    /// stays untouched here.
    fn ingest_excel(&mut self, path: &Path) -> LoadOutcome {
        let sheets = match Self::read_non_empty_sheets(path) {
            Ok(s) => s,
            Err(e) => return LoadOutcome::Error(e),
        };

        let states: Vec<GuidanceSheetState> = sheets
            .iter()
            .map(|sheet| match auto_tidy(sheet) {
                TidyOutcome::Tidied(t) => GuidanceSheetState::AutoTidied {
                    header_row: t.header_row,
                },
                TidyOutcome::NeedsGuidance(reason) => GuidanceSheetState::NeedsGuidance { reason },
            })
            .collect();
        let request = Self::build_guidance(path, &sheets, &states);
        // Retain the parse for zero-reparse preview paging (issue #750);
        // dropped on guided commit / dialog cancel (see GuidanceRetention).
        self.guidance_retained = Some(GuidanceRetention {
            source_path: path.to_string_lossy().to_string(),
            sheets,
        });
        LoadOutcome::NeedsGuidance(request)
    }

    /// Commit an Excel workbook the user confirmed on the dialog (ADR-0015
    /// guided path / ADR-0148 per-sheet confirmation / ADR-0042 user
    /// decisions). ONLY sheets with a guidance entry load -- the dialog sends
    /// one entry per CHECKED sheet, so an absent entry means the user left
    /// that sheet unticked and it is skipped. An empty selection is rejected
    /// as a defensive floor (the dialog disables its submit; this catches any
    /// client that bypasses it). Each loaded sheet is rectified by its
    /// [`SheetRectify`] (header row + skipped rows) and forward-filled over
    /// merged cells, then loaded with `rectify = User(...)` recorded on the
    /// descriptor. Transactional like [`Self::ingest`].
    pub fn ingest_guided(&mut self, path: &Path, guidance: &[SheetGuidance]) -> LoadOutcome {
        let sheets = match Self::read_non_empty_sheets(path) {
            Ok(s) => s,
            Err(e) => return LoadOutcome::Error(e),
        };
        if guidance.is_empty() {
            return LoadOutcome::Error(LoadError::Parse {
                detail: NO_SHEET_SELECTED.into(),
            });
        }

        // Apply each checked sheet's user rectify; skip the rest. Guidance
        // entries naming a sheet the workbook doesn't have are ignored (the
        // lookup keys off the workbook's sheets). Any out-of-range header_row
        // aborts before copy-in so no partial load escapes (transactional --
        // ADR-0042).
        let entries: Vec<(String, Vec<Vec<Data>>, RectifyProvenance)> = match sheets
            .iter()
            .filter_map(|sheet| {
                guidance
                    .iter()
                    .find(|g| g.name == sheet.name)
                    .map(|g| (sheet, g.rectify.clone()))
            })
            .map(|(sheet, rectify)| {
                let rows = Self::apply_rectify(sheet, &rectify)?;
                Ok::<_, LoadError>((sheet.name.clone(), rows, RectifyProvenance::User(rectify)))
            })
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(e) => e,
            Err(e) => return LoadOutcome::Error(e),
        };
        // Every entry named a sheet the workbook doesn't have: same defensive
        // floor as the empty-selection guard above.
        if entries.is_empty() {
            return LoadOutcome::Error(LoadError::Parse {
                detail: NO_SHEET_SELECTED.into(),
            });
        }
        // A checked entry that missed every workbook sheet means the file
        // changed under the open dialog (the lookup above keys off the
        // workbook's sheets): the survivors still commit, but the dropped
        // picks get a trace instead of vanishing silently.
        let missed: Vec<&str> = guidance
            .iter()
            .map(|g| g.name.as_str())
            .filter(|name| {
                !entries
                    .iter()
                    .any(|(matched, _, _)| matched.as_str() == *name)
            })
            .collect();
        if !missed.is_empty() {
            log::warn!("guided commit ignored checked sheets absent from the workbook: {missed:?}");
        }

        match self.commit_excel(path, entries) {
            Ok(active) => {
                // The dialog resolves on a successful commit: drop THIS path's
                // retained parse (issue #750). A failed commit keeps it -- the
                // dialog stays open for retry and its paging must keep working.
                let path_key = path.to_string_lossy();
                if self
                    .guidance_retained
                    .as_ref()
                    .is_some_and(|r| r.source_path == path_key)
                {
                    self.guidance_retained = None;
                }
                LoadOutcome::Loaded(active)
            }
            Err(e) => LoadOutcome::Error(e),
        }
    }

    /// Serve one preview window for a sheet parked on the guided-load dialog
    /// (issue #750), from the retained parse -- no workbook re-read. Rows are
    /// `[offset .. offset + limit)` clamped to the sheet's row count, rendered
    /// exactly like the first inlined window. `limit` is clamped to the
    /// preview window size, pinning the pager's window contract at this
    /// boundary (IPC input is untrusted). `None` when nothing is retained
    /// for the (path, sheet) pair -- a stale dialog whose guidance was
    /// committed, discarded, or superseded; the command layer maps the miss to
    /// an engine error.
    pub fn guidance_window(
        &self,
        path: &str,
        sheet_name: &str,
        offset: usize,
        limit: usize,
    ) -> Option<Vec<Vec<String>>> {
        let retained = self.guidance_retained.as_ref()?;
        if retained.source_path != path {
            return None;
        }
        let sheet = retained.sheets.iter().find(|s| s.name == sheet_name)?;
        Some(ingest::excel::render_preview_window(
            sheet,
            offset,
            limit.min(GUIDANCE_PREVIEW_ROWS),
        ))
    }

    /// Drop the retained guidance parse (issue #750): the dialog-cancel path.
    /// Idempotent -- a second discard finds nothing.
    pub fn discard_guidance_retention(&mut self) {
        self.guidance_retained = None;
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
        // (the guided path rejects an empty selection before reaching here),
        // but prefer a returned error over a reachable panic regardless.
        let Some(active) = descriptors.last().cloned() else {
            return Err(LoadError::Parse {
                detail: "工作簿不含任何含数据的 sheet".into(),
            });
        };
        for d in descriptors {
            // ADR-0040: each added sheet appends its own Add event, so a
            // multi-sheet workbook shows one event per sheet in the thread.
            let reference_name = d.reference_name.clone();
            let display_name = d.display_name.clone();
            self.working_set.register(d);
            self.append_source_event(SourceLifecycleKind::Added, &reference_name, &display_name);
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
            &self.snapshot_dir(),
            reference_name,
            "read_csv_auto",
        ) {
            Ok(s) => s,
            Err(e) => {
                if let Err(io_err) = fs::remove_file(&csv_path) {
                    log::warn!(
                        target: "toptopduck::session",
                        "temp CSV removal failed for {reference_name}: {io_err}"
                    );
                }
                return Err(e);
            }
        };
        // The temp CSV is only needed during copy-in; the snapshot holds the data.
        let _ = fs::remove_file(&csv_path);

        let attach_sql = attach_sql(&snap.file_path.to_string_lossy(), reference_name);
        if let Err(e) = self.admin_engine.execute_batch(&attach_sql) {
            if let Err(io_err) = fs::remove_file(&snap.file_path) {
                log::warn!(
                    target: "toptopduck::session",
                    "snapshot file removal failed during attach_sheet for {reference_name}: {io_err}"
                );
            }
            return Err(LoadError::Other {
                detail: format!("挂载快照失败：{e}"),
            });
        }
        attached.push(reference_name.to_string());
        // Same stat-before-move as the unguided path (issue #1485).
        let size_bytes = crate::session::snapshot::snapshot_len(&snap.file_path);
        // Record the attached snapshot's file for the sandbox re-attach path
        // (ADR-0005 read_* closure). file_path is moved here; the descriptor
        // below takes the remaining fields.
        self.source_files
            .insert(reference_name.to_string(), snap.file_path);

        Ok(DatasetDescriptor {
            reference_name: reference_name.to_string(),
            display_name: display_name.to_string(),
            source_path: path.to_string_lossy().to_string(),
            columns: snap.columns,
            row_count: snap.row_count,
            sample: snap.sample,
            fingerprint: snap.fingerprint,
            size_bytes,
            rectify,
            privacy: DatasetPrivacy::default(),
            stale: None,
        })
    }

    /// Build a [`GuidanceRequest`] from a workbook's sheets: each visible
    /// non-blank sheet's raw top rows rendered as strings (pre-rectify preview)
    /// plus the total row count + the per-sheet two-state (issue #750/#751:
    /// the failure reason or the auto-detected header guess). `states` is
    /// index-aligned with `sheets`.
    fn build_guidance(
        path: &Path,
        sheets: &[ingest::excel::SheetRows],
        states: &[GuidanceSheetState],
    ) -> GuidanceRequest {
        let workbook_name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("workbook")
            .to_string();
        // The zip below truncates silently on a length mismatch; both vecs
        // are filled in the same loop, so make that alignment loud.
        debug_assert_eq!(sheets.len(), states.len());
        let sheets_preview = sheets
            .iter()
            .zip(states)
            .map(|(s, state)| GuidanceSheet {
                name: s.name.clone(),
                preview: ingest::excel::render_preview(s, GUIDANCE_PREVIEW_ROWS),
                total_rows: s.rows.len(),
                state: *state,
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
                .admin_engine
                .execute_batch(&format!("DETACH {};", quote_ident(reference_name)))
            {
                log::warn!(
                    target: "toptopduck::session",
                    "DETACH failed during excel rollback for {reference_name}: {e}"
                );
            }
            // The snapshot file lives in the session tree (attach_sheet's
            // copy-in); `source_files` holds the recorded path, with the
            // snapshot-dir join as the fallback (mirrors release_snapshot).
            let snapshot_path = self
                .source_files
                .remove(reference_name)
                .unwrap_or_else(|| self.snapshot_dir().join(format!("{reference_name}.duckdb")));
            if let Err(e) = fs::remove_file(&snapshot_path) {
                log::warn!(
                    target: "toptopduck::session",
                    "snapshot file removal failed during excel rollback for {reference_name}: {e}"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Loaded descriptor's size_bytes must equal the store file's final
    /// on-disk length (issue #1485): the stat runs after the writing
    /// connection drops, and DuckDB flushes the main file on close -- a
    /// mid-open stat reads a partial figure, so this equality pins the
    /// ordering, not just that a stat happened.
    #[test]
    fn loaded_size_bytes_equals_the_store_file_length() {
        let dir = tempfile::tempdir().expect("tempdir");
        let src = dir.path().join("people.csv");
        fs::write(&src, "id,name\n1,a\n2,b\n").expect("csv");
        let mut session = crate::session::Session::new().expect("session");
        let d = match session.ingest(&src) {
            LoadOutcome::Loaded(d) => d,
            other => panic!("expected Loaded, got {other:?}"),
        };
        let store = session
            .snapshot_dir()
            .join(format!("{}.duckdb", d.reference_name));
        let len = fs::metadata(&store).expect("store file").len();
        assert_eq!(d.size_bytes, len);
    }
}
