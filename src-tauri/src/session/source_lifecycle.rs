//! Source lifecycle I/O orchestration on [`Session`] (ADR-0053 Decision 5, issue #67).
//!
//! These are the methods that change the set of loaded sources:
//! replace_source (re-upload onto an existing name), remove_source /
//! remove_active_source (delete), and the two private commit/event helpers they
//! share (commit_removal, append_source_event). They are a physical move out of
//! `session/mod.rs` for locality -- NOT a deep module: ADR-0053 Decision 5 evaluated
//! extracting them as an independent object and found it moves complexity
//! rather than concentrating it (the removal tests do not pass without the
//! `&mut Session` reach), so they stay `&mut Session` methods and only the
//! physical location changes. The testable kernel (cascade_stale / active /
//! deconflict) already lives in [`WorkingSet`]; what remains here is ATTACH /
//! DETACH orchestration, snapshot-file deletion, and atomic recipe persistence.
//!
//! The impl block is a sibling of the ones in `session/mod.rs` and
//! `session/ingest.rs`: Rust lets a descendant module
//! (`session::source_lifecycle`) add methods to a type defined in the ancestor
//! (`session`) and reach its private fields and helpers across sibling modules.
//! `release_snapshot` (in `session::ingest`) is `pub(super)` so
//! `commit_removal` here can call it; `append_source_event` below is also
//! `pub(super)` so the add-path helpers (`ingest_structured`, `commit_excel`)
//! now in `session::ingest` can record `Added` events.

use std::fs;
use std::path::{Path, PathBuf};

use crate::ingest;
use crate::ingest::schema::quote_ident;
use crate::model::{
    DatasetDescriptor, LoadError, LoadOutcome, RectifyProvenance, RemoveSourceError,
    SourceLifecycleEvent, SourceLifecycleKind, StaleAnchor, StaleReason,
};

impl super::Session {
    /// Remove a source Dataset from the working set (issue #38, ADR-0040). The
    /// first source-removal path: detaches the read-only snapshot, deletes its
    /// file, drops the dataset from the shared namespace, and appends a
    /// `Deleted` source lifecycle event to the thread. The event is first-class
    /// (always visible, occupies a timeline slot) but NOT a turn -- it never
    /// enters the LLM window or advances result_N.
    ///
    /// This slice handles only **non-active sources with no derived results**:
    /// - Removing the active source would silently change the user's analysis
    ///   focus; ADR-0035 forbids a silent jump, so explicit re-selection lands
    ///   in #39 and removal of the active source is refused here.
    /// - Removing a source while any `result_N` exists needs the stale-cascade
    ///   engine (#40) to mark dependent derivations stale honestly; without it,
    ///   removal is refused. The conservative "any result exists" guard is the
    ///   only provenance-free way to guarantee "no derived dependency" today.
    ///
    /// DETACH and snapshot-file removal are best-effort + logged (never silently
    /// swallowed): a failure leaves a ghost attachment or a stray temp file, but
    /// the working set (the source of truth) still reflects the removal and the
    /// session temp dir is wiped on drop. The session Mutex serializes this
    /// against an in-flight turn (correctness); the frontend's shared `loading`
    /// flag additionally disables source-management UI during the ADR-0040
    /// execution window (UX), so no in-flight guard is needed here.
    pub fn remove_source(&mut self, reference_name: &str) -> Result<(), RemoveSourceError> {
        // Snapshot the descriptor before any mutation: its display label rides
        // the Deleted event (the thread must still name what was removed after
        // the dataset is gone), and the active/unknown checks need it up front.
        let descriptor = self
            .working_set
            .get(reference_name)
            .ok_or_else(|| RemoveSourceError::NotFound(reference_name.to_string()))?
            .clone();

        // Dependent results no longer block removal (#40 stale-cascade engine):
        // commit_removal transitively marks every downstream result_N stale
        // (ADR-0013/0040), so a delete always cascades instead of refusing.

        // Refuse the active source WHEN other sources remain: removing it would
        // silently move the user's focus (ADR-0035) -- the caller must go
        // through `remove_active_source` (issue #39) to name an explicit
        // continuation. AC4 exception: when this is the LAST source, fall
        // through to `commit_removal` -- the working set goes empty and the UI
        // prompts upload, which IS the user's explicit end state (no silent
        // jump happens because there is nothing left to jump to).
        // NOTE: `working_set.active()` (the active-SOURCE pointer = most-recent
        // source) is the right check here, not `Session::active`/resolve_active
        // (user focus = latest result, else active source). Removing a source
        // concerns only the source pointer: a result may exist and the cascade
        // marks its downstream stale, but that does not move the source pointer
        // -- the focus pointer is handled by remove_active_source's explicit
        // continuation path.
        let is_active = self
            .working_set
            .active()
            .map(|a| a.reference_name == reference_name)
            .unwrap_or(false);
        if is_active && self.working_set.list().len() > 1 {
            return Err(RemoveSourceError::IsActive {
                reference_name: reference_name.to_string(),
                display_name: descriptor.display_name,
            });
        }

        self.commit_removal(reference_name, &descriptor.display_name);
        Ok(())
    }

    /// Delete the current ACTIVE source and repoint the focus pointer at an
    /// explicit continuation source the user chose from the remaining set
    /// (issue #39, ADR-0035 -- no silent fallback). Atomic w.r.t. the working
    /// set: the focus moves to `continue_with` AND the removed source is
    /// dropped + a `Deleted` event appended in one call.
    ///
    /// Guards (each surfaces a distinct `RemoveSourceError` so a stale view /
    /// direct IPC cannot smuggle an inconsistent state):
    /// - `reference_name` must be the active source (else `NotActive`);
    /// - `continue_with` must be a remaining source -- registered, not the
    ///   removed name, not a `result_N` (else `InvalidContinueWith`).
    ///
    /// Dependent results no longer block removal (#40 cascade marks them stale
    /// on commit), so there is no `HasDerivatives` refusal on this path.
    ///
    /// The frontend's confirm dialog already excludes every
    /// `InvalidContinueWith` / `NotActive` case, so reaching those branches
    /// means the view raced a concurrent mutation; the working set is left
    /// untouched and the caller refreshes and retries.
    pub fn remove_active_source(
        &mut self,
        reference_name: &str,
        continue_with: &str,
    ) -> Result<(), RemoveSourceError> {
        // Snapshot the descriptor before any mutation: its display label rides
        // the Deleted event once the source is gone.
        let descriptor = self
            .working_set
            .get(reference_name)
            .ok_or_else(|| RemoveSourceError::NotFound(reference_name.to_string()))?
            .clone();

        // The dialog only fires for the active source; a non-active `ref` here
        // is a stale view or a direct IPC. Refuse before touching anything --
        // the caller should refresh and pick the right path (`remove_source`).
        let is_active = self
            .working_set
            .active()
            .map(|a| a.reference_name == reference_name)
            .unwrap_or(false);
        if !is_active {
            return Err(RemoveSourceError::NotActive(reference_name.to_string()));
        }

        // The continuation must differ from the removed name (the dialog lists
        // only the OTHER sources; an equal name is a logic bug / stale view).
        if continue_with == reference_name {
            return Err(RemoveSourceError::InvalidContinueWith(
                continue_with.to_string(),
            ));
        }

        // No derived-dependency guard: #40's cascade marks downstream results
        // stale on commit, so removal proceeds regardless of results.

        // Repoint the focus at the chosen continuation BEFORE the removal.
        // `set_active` gates on registered + non-result, so a `false` here =
        // `continue_with` is not a remaining source (missing or a `result_N`);
        // nothing was mutated yet (active stays on the original focus).
        if !self.working_set.set_active(continue_with) {
            return Err(RemoveSourceError::InvalidContinueWith(
                continue_with.to_string(),
            ));
        }

        // Active now names `continue_with`, so `commit_removal`'s
        // `working_set.remove(reference_name)` will NOT clear active (the
        // matched-name branch only fires when active == the removed name) --
        // the focus stays on the user's explicit choice.
        self.commit_removal(reference_name, &descriptor.display_name);
        Ok(())
    }

    /// Commit a source removal: DETACH the read-only snapshot catalog, delete
    /// its snapshot file, drop the working-set entry, and append a `Deleted`
    /// lifecycle event. Extracted from `remove_source` so `remove_active_source`
    /// shares the exact same commit steps (KISS / DRY -- one place that owns
    /// the best-effort I/O + event append). All I/O here is best-effort +
    /// logged: a failure leaves a ghost attachment or a stray temp file, but
    /// the working set (source of truth) still reflects the removal and the
    /// session temp dir is wiped on drop. The session Mutex serializes this
    /// against an in-flight turn; the frontend's shared `loading` flag adds the
    /// ADR-0040 execution-window UX guard, so no in-flight guard is needed here.
    fn commit_removal(&mut self, reference_name: &str, display_name: &str) {
        // Cascade stale (issue #40, ADR-0013/0025/0040): before the source
        // leaves the working set, transitively mark every result_N downstream
        // of it (direct + via chained results) as stale, each carrying this
        // Deleted event's identity as its traceability anchor. Stale results
        // stay registered (visible) -- only the source is removed below.
        let newly_stale = self.working_set.cascade_stale(
            reference_name,
            StaleAnchor {
                reference_name: reference_name.to_string(),
                display_name: display_name.to_string(),
                reason: StaleReason::Deleted,
            },
        );
        if !newly_stale.is_empty() {
            log::info!(
                target: "toptopduck::session",
                "删除源「{reference_name}」级联失效：{}", newly_stale.join(", ")
            );
        }

        // Release the snapshot (DETACH + remove file + drop working-set entry).
        // Shared with `detach_snapshot`; best-effort + logged I/O. A failure
        // leaves a ghost attachment or a stray temp file, but the working set
        // (source of truth) already reflects the removal and the session temp
        // dir is wiped on drop.
        self.release_snapshot(reference_name);

        // Append the Deleted event. The display label was captured by the
        // caller, so the event still names what was removed.
        self.append_source_event(SourceLifecycleKind::Deleted, reference_name, display_name);
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
                return LoadOutcome::Error(LoadError::UnknownDataset {
                    reference_name: reference_name.to_string(),
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
                    detail:
                        "xlsx replace is not supported (multi-sheet semantics pending); use a structured file"
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
        if let Err(e) = self.admin_engine.conn().execute_batch(&format!(
            "ATTACH '{swap_path}' AS {} (READ_ONLY);",
            quote_ident(&swap_alias),
        )) {
            log::warn!(
                target: "toptopduck::session",
                "pre-attach of new snapshot failed during replace for {reference_name}: {e}"
            );
            let _ = fs::remove_file(&new_snap.file_path);
            return LoadOutcome::Error(LoadError::Other {
                // English technical detail for the fold (issue #131): the primary
                // message is the fixed catalog wording; the DuckDB attach error
                // rides in the technical-details fold, not the primary message.
                detail: format!("failed to mount new snapshot: {e}"),
            });
        }
        // Release the swap file's handle so the promote step can rename it. This
        // DETACHes the very attachment just confirmed, so it cannot fail for a
        // file-content reason; on failure the old snapshot is still attached and
        // queryable, so we abort before any damage (the swap file is best-effort
        // removed, though the held handle may keep it until session drop).
        if let Err(e) = self
            .admin_engine
            .conn()
            .execute_batch(&format!("DETACH {};", quote_ident(&swap_alias)))
        {
            log::warn!(
                target: "toptopduck::session",
                "DETACH swap failed during replace for {reference_name}: {e}"
            );
            let _ = fs::remove_file(&new_snap.file_path);
            return LoadOutcome::Error(LoadError::Other {
                detail: format!("failed to release new snapshot: {e}"),
            });
        }

        // New snapshot confirmed -- retire the old one. DETACH first to release
        // the old file's handle (Windows won't remove a held file); if DETACH
        // fails the old snapshot is still attached and usable, so the swap file is
        // orphaned and removed, and the error is reported with the working set
        // untouched.
        if let Err(e) = self
            .admin_engine
            .conn()
            .execute_batch(&format!("DETACH {};", quote_ident(reference_name)))
        {
            log::warn!(
                target: "toptopduck::session",
                "DETACH old failed during replace for {reference_name}: {e}"
            );
            let _ = fs::remove_file(&new_snap.file_path);
            return LoadOutcome::Error(LoadError::Other {
                detail: format!("failed to release old snapshot: {e}"),
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
        // renamed path). Recovery is a session restart; accepted as the
        // implementation-level cost of skipping a swap-then-cleanup round-trip
        // (not an ADR-level decision -- a second attach-pass would complicate
        // the replace path for a near-zero-probability OS-level failure).
        if let Err(e) = self.admin_engine.conn().execute_batch(&format!(
            "ATTACH '{attach_path}' AS {} (READ_ONLY);",
            quote_ident(reference_name)
        )) {
            return LoadOutcome::Error(LoadError::Other {
                detail: format!("failed to mount new snapshot: {e}"),
            });
        }

        // Record the post-replace attached file (formal name, or the swap path
        // when the rename fallback fired) for the sandbox re-attach path.
        self.source_files
            .insert(reference_name.to_string(), PathBuf::from(&attach_path));

        // Capture the carried-over display label before the descriptor swap --
        // the Replaced event + cascade anchor name what was replaced, and a
        // future carry-over rule change must not retroactively alter either.
        let display_name = existing.display_name.clone();

        // Cascade stale (issue #41, ADR-0025/0041): before the new descriptor
        // commits, transitively mark every result_N downstream of this source
        // stale, each carrying this Replaced event's identity with reason =
        // Replaced. The reference name is stable (the new snapshot just took it
        // over), so the cascade keys correctly; a result already stale keeps
        // its first anchor (ADR-0041 终局死轮). Mirrors `commit_removal`'s
        // delete-cascade -- distinct in reason, and in that the source stays
        // registered (the descriptor swap happens just below).
        let newly_stale = self.working_set.cascade_stale(
            reference_name,
            StaleAnchor {
                reference_name: reference_name.to_string(),
                display_name: display_name.clone(),
                reason: StaleReason::Replaced,
            },
        );
        if !newly_stale.is_empty() {
            log::info!(
                target: "toptopduck::session",
                "换源「{reference_name}」级联失效：{}", newly_stale.join(", ")
            );
        }

        // Commit: update the descriptor in place. The reference name is stable
        // (every existing reference now resolves to the new data); the display
        // label carries over (a user rename survives the replace, ADR-0037); the
        // privacy config carries over too (issue #9 AC4: a source's privacy
        // intent survives a re-upload -- entries for columns that no longer exist
        // are ignored at read time, ADR-0011); the body reflects the new snapshot.
        // A source itself is never stale (the cascade marks result_N, not the
        // source descriptor).
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
            stale: None,
        };
        // `replace` returns `false` only on an unregistered name -- a logic bug,
        // not a user error (the `existing` lookup at the top confirmed
        // registration, and the cascade above marks result_N, not the source
        // descriptor). Assert so a future regression can't silently leave the
        // source unswapped while the Replaced event still lands below.
        assert!(
            self.working_set.replace(updated.clone()),
            "replace_source targets a confirmed-existing source"
        );

        // Append the Replaced source lifecycle event (ADR-0040, issue #41):
        // first-class in the thread (always visible, occupies a slot) but NOT a
        // turn -- never enters the LLM window or advances result_N. The display
        // label was captured above so the event still names what was replaced.
        self.append_source_event(SourceLifecycleKind::Replaced, reference_name, &display_name);

        LoadOutcome::Loaded(updated)
    }

    /// Append a source lifecycle event (Added / Deleted / Replaced / Renamed) to
    /// the conversation thread and atomically persist the recipe (ADR-0034 /
    /// ADR-0040).
    ///
    /// `pub(super)`: callers span both this module (`commit_removal`,
    /// `replace_source`) and the add-path helpers in `session::ingest`
    /// (`ingest_structured`, `commit_excel`), which record `Added` events. The
    /// parent cannot reach a child-module private method, so the minimal
    /// visibility that still names the boundary is `pub(super)`.
    pub(super) fn append_source_event(
        &mut self,
        kind: SourceLifecycleKind,
        reference_name: &str,
        display_name: &str,
    ) {
        self.timeline
            .push(super::TimelineEntry::Source(SourceLifecycleEvent {
                kind,
                reference_name: reference_name.to_string(),
                display_name: display_name.to_string(),
            }));
        // ADR-0034 / ADR-0040: a source lifecycle operation also lands its
        // terminal state to the recipe atomically (changing the current
        // source set is a recipe mutation, not just a thread entry).
        self.persist_if_bound();
    }
}
