//! RecipePersister: the session's persistence concern, extracted as a deep
//! module (issue #415). Owns the 6 persistence state fields formerly on
//! [`Session`](super::Session), plus the projection ([`Self::build_recipe`]),
//! write loop ([`Self::save_if_bound`]), conflict resolution, and the
//! single-writer gate ([`Self::bind`] / [`Self::adopt_resumed`] /
//! [`Self::release_key`]). Session delegates to this struct via thin facade
//! methods -- the 12 existing `build_recipe_*` integration tests stay on
//! Session (end-to-end coverage via the facade) while this module adds pure
//! unit tests that need no DuckDB / provider / tempdir.

use std::path::{Path, PathBuf};

use crate::persistence::recipe::{
    Recipe, RecipeEntry, RecipeOutcome, RecipePromotion, RecipeTurn, SourceRef,
};
use crate::persistence::registry::{canonicalize_duck, release, try_acquire};
use crate::persistence::{save_atomic, SaveError};
use crate::workingset::WorkingSet;

use super::TimelineEntry;

/// Why a `.duck` auto-write was suspended (ADR-0035 Decision 3, issue #50).
/// Surfaced by [`RecipePersister::take_pending_conflict`] so the caller can
/// render the three-option conflict UI (reload / keep mine / save as new).
/// The engine NEVER silently clobbers the externally-edited file; the caller
/// resolves the conflict via [`RecipePersister::conflict_keep_mine`] /
/// [`RecipePersister::conflict_save_as_new`] (and drop + reopen for reload).
#[derive(Debug, Clone, serde::Serialize)]
pub struct PendingConflict {
    /// The bound `.duck` path whose on-disk content diverged.
    pub path: PathBuf,
    /// The hash the session recorded after its last successful write -- what
    /// the session believes the disk file SHOULD look like.
    pub expected_hash: String,
    /// The hash the session just computed from the file on disk -- evidence
    /// that an external edit (another window, a text editor, a sync tool)
    /// changed the file under us.
    pub found_hash: String,
}

/// SHA-256 of a `.duck` file's bytes (ADR-0035 Decision 3, issue #50). Used as the
/// pre-write external-change baseline: the persister records this after every
/// successful write and compares the file's current hash before the next write.
/// The recipe is small text, so a whole-file read is the KISS choice (no
/// streaming needed at v1). Returns `Ok(None)` when the file does not exist --
/// a missing file is not a conflict (the next write recreates it; there is
/// nothing on disk to clobber), so the caller proceeds without a baseline.
pub(super) fn hash_file(path: &Path) -> Result<Option<String>, std::io::Error> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    // ADR-0086 / issue #364 review I3: the bytes->hex step is shared via
    // crate::util::sha256_hex (also used by the skills module's content hash).
    Ok(Some(crate::util::sha256_hex(&bytes)))
}

/// The session's persistence concern (issue #415): owns the `.duck` binding,
/// the external-change baseline, the single-writer registry key, and the
/// projection from the live working set + timeline to a persisted
/// [`Recipe`]. Extracted from [`Session`](super::Session) so the projection
/// logic and the write-loop state machine are testable without a DuckDB
/// connection, provider, or tempdir.
///
/// The persister does NOT own a [`Drop`] impl -- the single-writer key's
/// release path is [`Session::Drop`](super::Session), which calls
/// [`Self::release_key`] BEFORE firing the drop signal. A separate Drop on
/// this struct would introduce a second release path and break the explicit
/// ordering guarantee.
pub(super) struct RecipePersister {
    /// The bound `.duck` path (ADR-0034). When `Some`, every terminal turn
    /// and source lifecycle event atomically rewrites the recipe at this path.
    duck_path: Option<PathBuf>,
    /// The user-facing session name (ADR-0034). Carried in the recipe header.
    session_name: Option<String>,
    /// The most recent per-turn atomic-write failure (ADR-0034).
    persist_error: Option<SaveError>,
    /// The canonical form of [`Self::duck_path`] (ADR-0035 Decision 3): the
    /// registry key under which this persister holds the file.
    duck_canonical: Option<PathBuf>,
    /// SHA-256 of the `.duck` file's bytes as of the last successful write
    /// (ADR-0035 Decision 3).
    last_written_hash: Option<String>,
    /// A pre-write external-change conflict surfaced by the hash check
    /// (ADR-0035 Decision 3).
    pending_conflict: Option<PendingConflict>,
}

impl RecipePersister {
    /// A fresh, unbound persister -- no `.duck` path, no baseline, no errors.
    pub(super) fn new() -> Self {
        Self {
            duck_path: None,
            session_name: None,
            persist_error: None,
            duck_canonical: None,
            last_written_hash: None,
            pending_conflict: None,
        }
    }

    /// The bound `.duck` path, if any (ADR-0034).
    pub(super) fn duck_path(&self) -> Option<&Path> {
        self.duck_path.as_deref()
    }

    /// The user-facing session name, if bound to a `.duck` (ADR-0034).
    pub(super) fn session_name(&self) -> Option<&str> {
        self.session_name.as_deref()
    }

    /// Set the session name (for rename, ADR-0060). Does NOT persist -- the
    /// caller follows with [`Self::save_if_bound`].
    pub(super) fn set_session_name(&mut self, name: String) {
        self.session_name = Some(name);
    }

    // --- Projection --------------------------------------------------------

    /// Project the live working set + timeline into a persisted [`Recipe`]
    /// (ADR-0034/0036/0041/0078/0084/0086). The persister supplies the `.duck`
    /// path (for relative-path resolution, ADR-0036 Decision 4) and the session
    /// name; the working set and timeline are passed by reference because they
    /// live on [`Session`](super::Session).
    pub(super) fn build_recipe(
        &self,
        working_set: &WorkingSet,
        timeline: &[TimelineEntry],
    ) -> Recipe {
        // ADR-0036 Decision 4 hybrid paths: `source_path` is always absolute
        // (fallback resolver); `relative_path` is set when the source lives
        // inside the .duck file's directory subtree (primary resolver,
        // survives "move the folder").
        let duck_dir = self.duck_path.as_deref().and_then(Path::parent);
        let sources: Vec<SourceRef> = working_set
            .list()
            .iter()
            .filter(|d| !working_set.is_result(&d.reference_name))
            .map(|d| {
                let relative_path = duck_dir
                    .and_then(|dir| Path::new(&d.source_path).strip_prefix(dir).ok())
                    .map(|rel| {
                        rel.components()
                            .filter_map(|c| c.as_os_str().to_str())
                            .collect::<Vec<_>>()
                            .join("/")
                    });
                SourceRef {
                    reference_name: d.reference_name.clone(),
                    display_name: d.display_name.clone(),
                    source_path: d.source_path.clone(),
                    relative_path,
                    rectify: d.rectify.clone(),
                    fingerprint: d.fingerprint.clone(),
                }
            })
            .collect();

        // The unified timeline carries each turn's audit inline (issue #325).
        // A Materialized turn whose every result_N is gone is filtered out --
        // without a descriptor the turn cannot replay or render.
        let history: Vec<RecipeEntry> = timeline
            .iter()
            .filter_map(|entry| match entry {
                TimelineEntry::Turn { record, audit } => {
                    // Build the trimmed outcome; the persisted trace +
                    // provenance come from the turn's recorded audit
                    // (ADR-0078, issue #319).
                    let outcome = match &record.outcome {
                        crate::model::TurnOutcome::Materialized {
                            promotions,
                            viz: _,
                            assumption,
                        } => {
                            // ADR-0084: persist EVERY promotion as its own
                            // RecipePromotion. display_name + stale come from
                            // the working set's CURRENT state. A promotion
                            // whose result_N is gone (GC'd / removed, no
                            // descriptor) is dropped.
                            let recipe_promotions: Vec<RecipePromotion> = promotions
                                .iter()
                                .filter_map(|p| {
                                    let descriptor = working_set.get(&p.dataset.reference_name)?;
                                    Some(RecipePromotion {
                                        reference_name: p.dataset.reference_name.clone(),
                                        display_name: descriptor.display_name.clone(),
                                        sql: p.sql.clone(),
                                        // ADR-0041: a live result -> stale None
                                        // (replayed); a cascade-invalidated
                                        // result -> the anchor from its
                                        // descriptor.
                                        stale: descriptor.stale.clone(),
                                    })
                                })
                                .collect();
                            // If no promotion survived (every result_N GC'd),
                            // the turn cannot replay or render -- drop it.
                            if recipe_promotions.is_empty() {
                                return None;
                            }
                            RecipeOutcome::Materialized {
                                promotions: recipe_promotions,
                                assumption: assumption.clone(),
                            }
                        }
                        crate::model::TurnOutcome::Textual {
                            text_kind,
                            body,
                            assumption,
                        } => RecipeOutcome::Textual {
                            text_kind: *text_kind,
                            body: body.clone(),
                            assumption: assumption.clone(),
                        },
                        crate::model::TurnOutcome::Failed(failure) => {
                            RecipeOutcome::Failed(failure.clone())
                        }
                        crate::model::TurnOutcome::Cancelled => RecipeOutcome::Cancelled,
                    };
                    // The turn's recorded audit (ADR-0078, issue #319).
                    // Construction routes through the audit-bearing
                    // constructor (issue #316).
                    Some(RecipeEntry::Turn(RecipeTurn::with_audit(
                        record.question.clone(),
                        outcome,
                        audit.trace().to_vec(),
                        audit.provenance().clone(),
                    )))
                }
                TimelineEntry::Source(ev) => Some(RecipeEntry::Source(ev.clone())),
                TimelineEntry::Skill(ev) => Some(RecipeEntry::Skill(ev.clone())),
            })
            .collect();

        let active = working_set.active().map(|d| d.reference_name.clone());

        Recipe::build(
            self.session_name.clone().unwrap_or_default(),
            sources,
            history,
            active,
        )
        .expect(
            "RecipePersister::build_recipe produces a recipe satisfying Recipe::build invariants",
        )
    }

    // --- Write loop --------------------------------------------------------

    /// Write the recipe at the bound path (ADR-0034 atomic write). No-op when
    /// no `.duck` is bound.
    fn persist(
        &self,
        working_set: &WorkingSet,
        timeline: &[TimelineEntry],
    ) -> Result<(), SaveError> {
        let Some(path) = &self.duck_path else {
            return Ok(());
        };
        let recipe = self.build_recipe(working_set, timeline);
        save_atomic(path, &recipe)
    }

    /// Fire [`Self::persist`] after a terminal event, capturing a failure
    /// instead of propagating (ADR-0035 honest signal). Runs the external-
    /// change hash check before writing; suspends the auto-write and stashes
    /// a [`PendingConflict`] when the on-disk file diverged.
    pub(super) fn save_if_bound(&mut self, working_set: &WorkingSet, timeline: &[TimelineEntry]) {
        let Some(path) = self.duck_path.as_deref() else {
            return; // unbound -- in-memory-only session, nothing to persist.
        };
        // While a conflict is pending, the auto-write is SUSPENDED.
        if self.pending_conflict.is_some() {
            return;
        }
        // External-change check (ADR-0035 Decision 3, issue #50).
        if let Some(baseline) = self.last_written_hash.clone() {
            match hash_file(path) {
                Ok(Some(current)) if current != baseline => {
                    self.pending_conflict = Some(PendingConflict {
                        path: path.to_path_buf(),
                        expected_hash: baseline,
                        found_hash: current,
                    });
                    log::warn!(
                        target: "toptopduck::session",
                        "检测到 .duck 外部变更，挂起自动写盘：{}",
                        path.display()
                    );
                    return;
                }
                Ok(_) => {} // Match (or file missing) -> proceed.
                Err(e) => {
                    self.pending_conflict = Some(PendingConflict {
                        path: path.to_path_buf(),
                        expected_hash: baseline,
                        found_hash: format!("<read failed: {e}>"),
                    });
                    log::warn!(
                        target: "toptopduck::session",
                        "外部变更检测读 .duck 失败，保守挂起自动写盘：{}",
                        path.display()
                    );
                    return;
                }
            }
        }
        if let Err(e) = self.persist(working_set, timeline) {
            log::error!(target: "toptopduck::session", "自动保存 .duck 失败：{e}");
            self.persist_error = Some(e);
            return;
        }
        // Successful write -- refresh the baseline.
        if let Some(h) = hash_file(path).ok().flatten() {
            self.last_written_hash = Some(h);
        }
    }

    // --- Bind / adopt / release (single-writer gate) -----------------------

    /// Bind to a `.duck` path (ADR-0034/0035 Decision 3). Canonicalizes the
    /// path, acquires the single-writer registry key (releasing the old one if
    /// re-binding to a different path), sets the path + name, and performs the
    /// first write + baseline seed.
    pub(super) fn bind(
        &mut self,
        path: PathBuf,
        session_name: String,
        working_set: &WorkingSet,
        timeline: &[TimelineEntry],
    ) -> Result<(), SaveError> {
        let canonical = canonicalize_duck(&path).map_err(|e| SaveError::Io(e.to_string()))?;
        // Single-writer gate: re-binding the SAME canonical path is an update;
        // any other path goes through try_acquire.
        if self.duck_canonical.as_deref() != Some(canonical.as_path()) {
            if !try_acquire(&canonical) {
                return Err(SaveError::AlreadyOpen(canonical));
            }
            if let Some(old) = self.duck_canonical.take() {
                release(&old);
            }
        }
        self.duck_canonical = Some(canonical);
        self.duck_path = Some(path);
        self.session_name = Some(session_name);
        let result = self.persist(working_set, timeline);
        if result.is_ok() {
            if let Some(path) = self.duck_path.as_deref() {
                if let Some(h) = hash_file(path).ok().flatten() {
                    self.last_written_hash = Some(h);
                }
            }
            self.pending_conflict = None;
        }
        result
    }

    /// Adopt a resumed `.duck` binding (ADR-0035 resume path). The single-
    /// writer key is acquired externally by `open_duck`'s `OpenDuckGuard`;
    /// this method records the canonical path for later release and sets all
    /// four persistence fields in one shot.
    pub(super) fn adopt_resumed(
        &mut self,
        path: PathBuf,
        canonical: PathBuf,
        session_name: String,
        baseline_hash: Option<String>,
    ) {
        self.duck_path = Some(path);
        self.duck_canonical = Some(canonical);
        self.session_name = Some(session_name);
        self.last_written_hash = baseline_hash;
    }

    /// Release the single-writer registry key, if held (ADR-0035 Decision 3).
    /// Idempotent -- calling when unbound is a no-op. The Session's `Drop`
    /// calls this BEFORE firing the drop signal so the delete-path awaiter
    /// resolves precisely when the gate will succeed.
    pub(super) fn release_key(&mut self) {
        if let Some(canonical) = self.duck_canonical.take() {
            release(&canonical);
        }
    }

    // --- Conflict resolution ----------------------------------------------

    /// Resolve a pending conflict with "Keep Mine" (ADR-0035 Decision 3):
    /// force-write the in-memory recipe, overwriting the externally-edited
    /// file. Refreshes the baseline hash and clears the pending conflict.
    pub(super) fn conflict_keep_mine(
        &mut self,
        working_set: &WorkingSet,
        timeline: &[TimelineEntry],
    ) -> Result<(), SaveError> {
        let path = self
            .duck_path
            .clone()
            .ok_or_else(|| SaveError::Io("no .duck path bound; cannot resolve conflict".into()))?;
        let recipe = self.build_recipe(working_set, timeline);
        save_atomic(&path, &recipe)?;
        if let Some(h) = hash_file(&path).ok().flatten() {
            self.last_written_hash = Some(h);
        }
        self.pending_conflict = None;
        Ok(())
    }

    /// Resolve a pending conflict with "Save As New" (ADR-0035 Decision 3):
    /// write to a NEW path, re-bind, release the old key. The new path must
    /// not be held by another session.
    pub(super) fn conflict_save_as_new(
        &mut self,
        new_path: PathBuf,
        working_set: &WorkingSet,
        timeline: &[TimelineEntry],
    ) -> Result<(), SaveError> {
        let canonical = canonicalize_duck(&new_path).map_err(|e| SaveError::Io(e.to_string()))?;
        if self.duck_canonical.as_deref() == Some(canonical.as_path()) {
            return Err(SaveError::AlreadyOpen(canonical));
        }
        if !try_acquire(&canonical) {
            return Err(SaveError::AlreadyOpen(canonical));
        }
        let recipe = self.build_recipe(working_set, timeline);
        if let Err(e) = save_atomic(&new_path, &recipe) {
            release(&canonical);
            return Err(e);
        }
        let new_hash = hash_file(&new_path).ok().flatten();
        if let Some(old) = self.duck_canonical.take() {
            release(&old);
        }
        self.duck_canonical = Some(canonical);
        self.duck_path = Some(new_path);
        self.last_written_hash = new_hash;
        self.pending_conflict = None;
        Ok(())
    }

    // --- Error / conflict accessors ---------------------------------------

    /// Take (read + clear) the most recent per-turn persistence failure.
    pub(super) fn take_persist_error(&mut self) -> Option<SaveError> {
        self.persist_error.take()
    }

    /// Take (read + clear) the pending external-change conflict.
    pub(super) fn take_pending_conflict(&mut self) -> Option<PendingConflict> {
        self.pending_conflict.take()
    }
}

impl Default for RecipePersister {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        DatasetDescriptor, SourceLifecycleEvent, SourceLifecycleKind, TextKind, TurnOutcome,
        TurnRecord,
    };
    use crate::persistence::recipe::{
        RecipeEntry, RecipeOutcome, RecipeTraceEntry, RuntimeKind,
        TurnProvenance as PersistedTurnProvenance,
    };
    use crate::persistence::RECIPE_FORMAT_VERSION;
    // TurnAudit is pub(super) in session/mod.rs -- reachable from this child.
    use super::super::TurnAudit;

    /// Minimal source descriptor for projection tests: name + path, empty
    /// columns / sample, no rectify, no stale.
    fn test_source(reference_name: &str, source_path: &str) -> DatasetDescriptor {
        DatasetDescriptor {
            reference_name: reference_name.into(),
            display_name: reference_name.into(),
            source_path: source_path.into(),
            columns: Vec::new(),
            row_count: 0,
            sample: Vec::new(),
            fingerprint: "fp".into(),
            rectify: crate::model::RectifyProvenance::NotApplicable,
            privacy: Default::default(),
            stale: None,
        }
    }

    /// A Turn timeline entry with the given question + outcome + an empty
    /// audit (BuiltIn runtime, no skills, no trace).
    fn turn_entry(question: &str, outcome: TurnOutcome) -> TimelineEntry {
        TimelineEntry::Turn {
            record: TurnRecord {
                question: question.into(),
                outcome,
                trace: Vec::new(),
                provenance: Default::default(),
            },
            audit: TurnAudit::test_new(
                Vec::new(),
                PersistedTurnProvenance {
                    runtime: Some(RuntimeKind::BuiltIn),
                    skills: Vec::new(),
                },
            ),
        }
    }

    /// A Source lifecycle event timeline entry.
    fn source_event(reference_name: &str) -> TimelineEntry {
        TimelineEntry::Source(SourceLifecycleEvent {
            kind: SourceLifecycleKind::Added,
            reference_name: reference_name.into(),
            display_name: reference_name.into(),
        })
    }

    // --- Projection: empty persister --------------------------------------

    #[test]
    fn build_recipe_for_unbound_persister_is_empty() {
        let persister = RecipePersister::new();
        let ws = WorkingSet::default();
        let recipe = persister.build_recipe(&ws, &[]);
        assert_eq!(recipe.format_version(), RECIPE_FORMAT_VERSION);
        assert!(recipe.sources.is_empty());
        assert!(recipe.history.is_empty());
        assert!(recipe.active.is_none());
        assert!(recipe.session_name.is_empty());
    }

    #[test]
    fn build_recipe_carries_session_name() {
        let mut persister = RecipePersister::new();
        persister.set_session_name("my session".into());
        let ws = WorkingSet::default();
        let recipe = persister.build_recipe(&ws, &[]);
        assert_eq!(recipe.session_name, "my session");
    }

    // --- Projection: source filtering + path resolution -------------------

    #[test]
    fn build_recipe_projects_sources_and_filters_results() {
        let mut ws = WorkingSet::default();
        ws.register(test_source("people", "/data/people.csv"));
        ws.register_result(test_source("result_1", "/tmp/result_1")); // a result, filtered out

        let persister = RecipePersister::new();
        let recipe = persister.build_recipe(&ws, &[]);
        assert_eq!(recipe.sources.len(), 1, "result_N is filtered out");
        assert_eq!(recipe.sources[0].reference_name, "people");
    }

    #[test]
    fn build_recipe_records_relative_path_for_in_subtree_source() {
        let dir = tempfile::tempdir().expect("tempdir");
        let duck = dir.path().join("session.duck");
        let csv = dir.path().join("data.csv");

        let mut ws = WorkingSet::default();
        ws.register(test_source("people", csv.to_str().unwrap()));

        let mut persister = RecipePersister::new();
        persister.duck_path = Some(duck);

        let recipe = persister.build_recipe(&ws, &[]);
        let src = &recipe.sources[0];
        assert_eq!(
            src.relative_path.as_deref(),
            Some("data.csv"),
            "in-subtree source carries a relative path"
        );
        assert!(
            std::path::Path::new(&src.source_path).is_absolute(),
            "absolute path is always present"
        );
    }

    #[test]
    fn build_recipe_omits_relative_path_for_out_of_subtree_source() {
        let dir = tempfile::tempdir().expect("tempdir");
        let duck = dir.path().join("session.duck");
        // A source in a DIFFERENT tempdir (outside the .duck subtree).
        let other_dir = tempfile::tempdir().expect("other tempdir");
        let csv = other_dir.path().join("outside.csv");

        let mut ws = WorkingSet::default();
        ws.register(test_source("people", csv.to_str().unwrap()));

        let mut persister = RecipePersister::new();
        persister.duck_path = Some(duck);

        let recipe = persister.build_recipe(&ws, &[]);
        assert!(
            recipe.sources[0].relative_path.is_none(),
            "out-of-subtree source has no relative path"
        );
    }

    // --- Projection: timeline (turns, sources, skills) --------------------

    #[test]
    fn build_recipe_projects_textual_turn() {
        let ws = WorkingSet::default();
        let timeline = vec![turn_entry(
            "hello",
            TurnOutcome::Textual {
                text_kind: TextKind::Agent,
                body: "hi there".into(),
                assumption: None,
            },
        )];

        let persister = RecipePersister::new();
        let recipe = persister.build_recipe(&ws, &timeline);
        assert_eq!(recipe.history.len(), 1);
        match &recipe.history[0] {
            RecipeEntry::Turn(t) => {
                assert_eq!(t.question, "hello");
                assert!(matches!(t.outcome, RecipeOutcome::Textual { .. }));
                assert_eq!(
                    t.provenance.runtime,
                    Some(RuntimeKind::BuiltIn),
                    "audit provenance round-trips"
                );
            }
            other => panic!("expected Turn, got {other:?}"),
        }
    }

    #[test]
    fn build_recipe_projects_source_lifecycle_event() {
        let ws = WorkingSet::default();
        let timeline = vec![source_event("people")];

        let persister = RecipePersister::new();
        let recipe = persister.build_recipe(&ws, &timeline);
        assert_eq!(recipe.history.len(), 1);
        assert!(matches!(
            &recipe.history[0],
            RecipeEntry::Source(ev) if ev.reference_name == "people"
        ));
    }

    #[test]
    fn build_recipe_harvests_trace_and_provenance_from_audit() {
        // A turn whose audit carries a non-empty trace + External provenance.
        let trace = vec![RecipeTraceEntry {
            name: "explore".into(),
            operation_kind: crate::approval::OperationKind::Read,
            summary: "SELECT 1".into(),
            success: true,
            result_excerpt: String::new(),
        }];
        let provenance = PersistedTurnProvenance {
            runtime: Some(RuntimeKind::External),
            skills: vec![],
        };

        let timeline = vec![TimelineEntry::Turn {
            record: TurnRecord {
                question: "q".into(),
                outcome: TurnOutcome::Textual {
                    text_kind: TextKind::Agent,
                    body: "a".into(),
                    assumption: None,
                },
                trace: Vec::new(),
                provenance: Default::default(),
            },
            audit: TurnAudit::test_new(trace.clone(), provenance.clone()),
        }];

        let persister = RecipePersister::new();
        let recipe = persister.build_recipe(&WorkingSet::default(), &timeline);
        match &recipe.history[0] {
            RecipeEntry::Turn(t) => {
                assert_eq!(t.trace, trace, "trace round-trips from audit");
                assert_eq!(
                    t.provenance, provenance,
                    "provenance round-trips from audit (External preserved)"
                );
            }
            other => panic!("expected Turn, got {other:?}"),
        }
    }

    #[test]
    fn build_recipe_drops_materialized_turn_with_no_surviving_promotions() {
        // A Materialized turn whose result_1 is NOT in the working set (GC'd)
        // -> the turn is dropped (ADR-0041 GC exception).
        let ws = WorkingSet::default();
        // No result_1 registered -> promotion will be filtered -> turn dropped.

        let timeline = vec![TimelineEntry::Turn {
            record: TurnRecord {
                question: "q1".into(),
                outcome: TurnOutcome::Materialized {
                    promotions: vec![crate::model::Promotion {
                        dataset: test_source("result_1", "/tmp/r1"),
                        sql: "SELECT 1".into(),
                    }],
                    viz: None,
                    assumption: None,
                },
                trace: Vec::new(),
                provenance: Default::default(),
            },
            audit: TurnAudit::test_new(Vec::new(), Default::default()),
        }];

        let persister = RecipePersister::new();
        let recipe = persister.build_recipe(&ws, &timeline);
        assert!(
            recipe.history.is_empty(),
            "turn with no surviving promotions is dropped"
        );
    }

    // --- Write loop --------------------------------------------------------

    #[test]
    fn save_if_bound_is_noop_when_unbound() {
        let mut persister = RecipePersister::new();
        let ws = WorkingSet::default();
        persister.save_if_bound(&ws, &[]);
        // No error, no conflict, no state change.
        assert!(persister.take_persist_error().is_none());
        assert!(persister.take_pending_conflict().is_none());
    }

    #[test]
    fn bind_writes_recipe_and_seeds_baseline() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("test.duck");

        let mut persister = RecipePersister::new();
        let ws = WorkingSet::default();
        persister
            .bind(path.clone(), "test session".into(), &ws, &[])
            .expect("bind");

        assert_eq!(persister.duck_path(), Some(path.as_path()));
        assert!(persister.last_written_hash.is_some(), "baseline seeded");
        assert!(path.exists(), "file written");

        let recipe = crate::persistence::read_duck(&path).expect("read back");
        assert_eq!(recipe.session_name, "test session");
    }

    #[test]
    fn save_if_bound_after_bind_writes_updated_recipe() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("test.duck");

        let mut persister = RecipePersister::new();
        let ws = WorkingSet::default();
        persister
            .bind(path.clone(), "initial".into(), &ws, &[])
            .expect("bind");

        // Change the name and save again.
        persister.set_session_name("updated".into());
        persister.save_if_bound(&ws, &[]);

        let recipe = crate::persistence::read_duck(&path).expect("read back");
        assert_eq!(recipe.session_name, "updated");
    }

    #[test]
    fn save_if_bound_detects_external_edit_and_stashes_conflict() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("test.duck");

        let mut persister = RecipePersister::new();
        let ws = WorkingSet::default();
        persister
            .bind(path.clone(), "mine".into(), &ws, &[])
            .expect("bind");

        // Simulate an external edit: overwrite the file AFTER bind seeded the
        // baseline.
        std::fs::write(&path, r#"{"externally":"edited"}"#).expect("external write");

        persister.set_session_name("new content".into());
        persister.save_if_bound(&ws, &[]);

        let conflict = persister.take_pending_conflict().expect("conflict stashed");
        assert_eq!(conflict.path, path);
        assert!(
            conflict.expected_hash != conflict.found_hash,
            "hashes differ"
        );
    }

    #[test]
    fn conflict_keep_mine_overwrites_and_clears_conflict() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("test.duck");

        let mut persister = RecipePersister::new();
        let ws = WorkingSet::default();
        persister
            .bind(path.clone(), "mine".into(), &ws, &[])
            .expect("bind");

        // External edit -> conflict.
        std::fs::write(&path, r#"{"externally":"edited"}"#).expect("external write");
        persister.save_if_bound(&ws, &[]);
        assert!(persister.take_pending_conflict().is_some());

        // Simulate re-detection (save_if_bound sets conflict again).
        std::fs::write(&path, r#"{"another":"edit"}"#).expect("external write 2");
        persister.save_if_bound(&ws, &[]);

        // Keep mine -> overwrites the external edit.
        persister
            .conflict_keep_mine(&ws, &[])
            .expect("keep mine succeeds");

        assert!(
            persister.take_pending_conflict().is_none(),
            "conflict cleared"
        );
        let recipe = crate::persistence::read_duck(&path).expect("read back");
        assert_eq!(recipe.session_name, "mine");
    }

    #[test]
    fn conflict_save_as_new_writes_new_file_and_rebinds() {
        let dir = tempfile::tempdir().expect("tempdir");
        let old_path = dir.path().join("old.duck");
        let new_path = dir.path().join("new.duck");

        let mut persister = RecipePersister::new();
        let ws = WorkingSet::default();
        persister
            .bind(old_path.clone(), "session".into(), &ws, &[])
            .expect("bind");

        // External edit -> conflict.
        std::fs::write(&old_path, r#"{"externally":"edited"}"#).expect("external write");
        persister.save_if_bound(&ws, &[]);
        assert!(persister.take_pending_conflict().is_some());

        // Re-detect for the resolution path.
        std::fs::write(&old_path, r#"{"another":"edit"}"#).expect("external write 2");
        persister.save_if_bound(&ws, &[]);

        // Save as new.
        persister
            .conflict_save_as_new(new_path.clone(), &ws, &[])
            .expect("save as new");

        assert_eq!(persister.duck_path(), Some(new_path.as_path()));
        assert!(new_path.exists(), "new file written");
        assert!(
            persister.take_pending_conflict().is_none(),
            "conflict cleared"
        );
    }

    // --- Single-writer gate -----------------------------------------------

    #[test]
    fn adopt_resumed_sets_all_four_fields() {
        let mut persister = RecipePersister::new();
        persister.adopt_resumed(
            PathBuf::from("/tmp/resumed.duck"),
            PathBuf::from("/tmp/resumed.duck"),
            "resumed".into(),
            Some("abc123".into()),
        );
        assert_eq!(
            persister.duck_path(),
            Some(std::path::Path::new("/tmp/resumed.duck"))
        );
        assert_eq!(persister.session_name(), Some("resumed"));
        assert_eq!(
            persister.last_written_hash,
            Some("abc123".into()),
            "baseline hash set"
        );
    }

    #[test]
    fn release_key_is_idempotent() {
        let mut persister = RecipePersister::new();
        // Unbound -> no-op.
        persister.release_key();
        // After bind -> releases; second call is a no-op.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("gate.duck");
        let ws = WorkingSet::default();
        persister
            .bind(path, "gated".into(), &ws, &[])
            .expect("bind");
        assert!(persister.duck_canonical.is_some());

        persister.release_key();
        assert!(persister.duck_canonical.is_none(), "key released");

        // Idempotent: second release is a no-op (no panic).
        persister.release_key();
    }

    #[test]
    fn take_persist_error_clears_on_read() {
        let mut persister = RecipePersister::new();
        // Manually simulate an error (the write loop sets this field).
        persister.persist_error = Some(SaveError::Io("test failure".into()));

        let err = persister.take_persist_error();
        assert!(err.is_some());
        assert!(persister.take_persist_error().is_none(), "cleared on read");
    }
}
