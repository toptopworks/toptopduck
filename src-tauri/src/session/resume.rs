//! The resume module -- all session-restart logic in one place (ADR-0053
//! Decision 3).
//!
//! [`Resumer`] owns phase 2/3/4: active-pointer resolution (pure logic over
//! the working set + recipe), productive-SQL-chain replay (driving the shared
//! [`Materializer`] trait), and conversation timeline rebuild (pure logic).
//! It does NOT hold the [`super::Session`] -- phase methods borrow `working_set` /
//! [`TurnDeps`] and return structured results.
//!
//! [`super::Session::open_duck`] is the entry point that owns the full 5-phase
//! orchestration: phase 1 (source re-ingest via [`super::Session::resume_sources`] +
//! [`super::Session::resume_ingest_at`] + [`super::Session::resolve_source_path`]), phases 2-4
//! (delegated to [`Resumer`]), and phase 5 (persist). It lives here alongside
//! the [`Resumer`] so a reader of resume holds one file, not two.
//!
//! The pre-ADR-0056 resume global state also lives here --
//! [`RESUMING_COUNT`] / [`ResumeFlagGuard`] / [`OpenDuckGuard`] (ADR-0053
//! Decision 3 extension of ADR-0035). NOTE: since ADR-0056 the LIVE
//! command-layer resume gate is per-session (`SessionHandle::is_resuming`,
//! read by `commands::reject_if_resuming`); the process-global
//! [`is_resuming`] / [`resuming_count`] below are retained ONLY as a
//! test/diagnostic RAII probe -- `persistence_blackbox.rs` asserts
//! `Session::open_duck` raises and clears the count around a resume, and no
//! production call site reads them. They are re-exported by the parent module
//! and from `lib.rs` so those integration tests can reach them.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use super::materializer::{Materializer, TurnDeps};
use super::{
    ActiveAbandoned, ActiveResolution, ResumeError, ResumeEvent, SourceIssue, SourceResolution,
    TimelineEntry, TurnAudit,
};
use crate::cancel::CancelToken;
use crate::ingest::schema::quote_ident;
use crate::model::{
    DatasetDescriptor, DatasetPrivacy, LoadError, RectifyProvenance, TraceEntryView, TraceRound,
    TurnFailure, TurnOutcome, TurnProvenance, TurnRecord, TurnRuntime,
};
use crate::persistence::read_duck;
use crate::persistence::recipe::{
    Recipe, RecipeEntry, RecipeOutcome, RecipeTraceEntry, RecipeTraceRound, RuntimeKind, SourceRef,
};
use crate::persistence::registry::{canonicalize_duck, release, try_acquire};
use crate::provider::Provider;
use crate::workingset::WorkingSet;

// --- Resume global state (ADR-0035 Decision 3, ADR-0053 Decision 3) ---------

/// Process-global count of in-flight resumes: > 0 while any `Session::open_duck`
/// is rebuilding a session across the restart boundary.
///
/// Historical role (pre-ADR-0056): this was the Rust-side backstop that
/// `commands::reject_if_resuming` read to refuse a concurrent mutating IPC
/// command (`ask` / `ingest_file` / `replace_source` / `remove_source` /
/// `remove_active_source`) during resume -- without it, such a command would
/// silently operate on the stale pre-resume session and have its work
/// overwritten when the resumed session lands (`*s = new_session`). The
/// frontend's shared `loading` flag was the primary defense; this counter was
/// the backstop for cases the frontend cannot see (a second window, an IPC
/// replay).
///
/// Current role (ADR-0056): the LIVE command-layer gate is now per-session
/// (`SessionHandle::is_resuming`, read by `commands::reject_if_resuming`), so
/// this counter has NO production reader. It is retained ONLY as a RAII probe
/// that `persistence_blackbox.rs` asserts rises and falls around a resume
/// (`is_resuming_flag_is_true_during_open_duck_and_cleared_after`).
///
/// A COUNT (not a boolean) so concurrent resumes compose: two `open_duck`
/// calls each acquire (+1), one finishing (-1) leaves it > 0 while the other
/// runs. Process-global (not per-Session) because the hazard historically
/// spanned two Session instances -- the old one in managed state and the new
/// one under construction.
static RESUMING_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Whether any `Session::open_duck` resume is currently in flight.
///
/// Historical role (pre-ADR-0056): checked at the top of every mutating
/// command to reject a concurrent IPC call during resume. Since ADR-0056 the
/// LIVE command-layer gate is the per-session `SessionHandle::is_resuming`
/// (read by `commands::reject_if_resuming`); this free function now has NO
/// production caller and is retained only as the integration-test probe over
/// [`RESUMING_COUNT`]. The count returns to zero on every exit from
/// `open_duck` (success or error) via the [`ResumeFlagGuard`] RAII guard, so a
/// resume failure can never leave it stuck > 0.
pub fn is_resuming() -> bool {
    RESUMING_COUNT.load(Ordering::SeqCst) > 0
}

/// The number of in-flight resumes (0 when idle). Exposed for tests and
/// diagnostics so an observer can distinguish "one resume" from "many" --
/// [`is_resuming`] folds the count to a bool, losing that detail.
pub fn resuming_count() -> usize {
    RESUMING_COUNT.load(Ordering::SeqCst)
}

/// RAII guard that increments [`RESUMING_COUNT`] on construction and
/// decrements on drop. Acquired at the top of `Session::open_duck`; held to the
/// end of the function so every exit path (success, load error, cancel, abort,
/// replay invariant violation) drops the guard and decrements. NOT
/// `mem::forget`-transferred to the resumed Session (unlike the registry key)
/// -- the counter marks "resume is running", and resume ends when `open_duck`
/// returns, not when the Session later drops.
#[must_use = "dropping the guard early decrements RESUMING_COUNT; keep it bound for the whole resume scope"]
pub(crate) struct ResumeFlagGuard;

impl ResumeFlagGuard {
    pub(crate) fn acquire() -> Self {
        RESUMING_COUNT.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for ResumeFlagGuard {
    fn drop(&mut self) {
        RESUMING_COUNT.fetch_sub(1, Ordering::SeqCst);
    }
}

/// RAII guard for the single-writer registry key acquired at the top of
/// `Session::open_duck` (ADR-0035 Decision 3, issue #50). Resume can fail at
/// several points (load, source verify, replay, history rebuild) -- each `?`
/// would leak the registry entry, blocking the path until process exit. The
/// guard's Drop releases the key on every error exit; on success,
/// [`std::mem::forget`] disarms the guard so the resumed Session owns the key
/// (and releases it on its own Drop).
pub(crate) struct OpenDuckGuard(PathBuf);

impl OpenDuckGuard {
    /// Acquire the canonical path or return [`ResumeError::AlreadyOpen`] --
    /// the file is already held by another Session in this process.
    pub(crate) fn acquire(canonical: PathBuf) -> Result<Self, ResumeError> {
        if try_acquire(&canonical) {
            Ok(Self(canonical))
        } else {
            Err(ResumeError::AlreadyOpen(canonical))
        }
    }
}

impl Drop for OpenDuckGuard {
    fn drop(&mut self) {
        release(&self.0);
    }
}

// --- Resumer (ADR-0053 Decision 3) ------------------------------------------

/// Phase 2 decision summary returned by [`Resumer::resolve_active`]. The
/// method has ALREADY written the resolution into the working set (the pointer
/// restore / continuation is part of phase 2's contract); this enum is the
/// observable outcome so a unit test can assert which branch fired without
/// poking at `WorkingSet` internals, and `open_duck` can log it.
#[derive(Debug, PartialEq)]
pub(crate) enum ResolvedActive {
    /// `recipe.active` was `None`, or the last source was rebuilt so the
    /// working set is empty and the active pointer stays `None` (ADR-0035: the
    /// empty state IS the honest end -- nothing left to silently fall back to).
    None,
    /// `recipe.active` was still registered after phase 1 -- the pointer was
    /// restored to this source (re-applies an explicit prior user continuation
    /// choice, ADR-0035/0037).
    Restored(String),
    /// The active source was rebuilt (dropped) and the caller picked an
    /// explicit continuation from the `remaining` menu (ADR-0035 no-silent-
    /// fallback). The pointer was set to this source.
    Continued(String),
}

/// Where the replay chain broke (ADR-0035 honest partial state, issue #49 AC6).
/// Round K's SQL failed; the working set holds K-1 materialized results, and
/// the timeline ends at turn K rendered as `Failed` (ADR-0028 outcome C).
/// Turns after K in the recipe's history are dropped (the conversation stops at
/// the breakpoint). Internal to resume -- the partial state is observable via
/// the resumed Session's working set + history.
#[derive(Debug)]
pub(crate) struct ReplayBreak {
    reference_name: String,
    failure: TurnFailure,
}

/// Resume phase 2/3/4 orchestrator (ADR-0053 Decision 3, issue #66). Borrows
/// the shared cancel token, the [`Materializer`] (the same trait object the
/// live-turn agent loop drives through the `materialize` tool), and the
/// recipe -- never the `Session`. Each phase method borrows `working_set` /
/// [`TurnDeps`] and returns a structured result; `Session::open_duck` applies
/// it.
///
/// Why a deep module (ADR-0053 Why 1/3): reading resume means reading this file
/// only, not skipping around a 3500-line god module. Phase 2/4 are pure logic
/// over the working set + recipe; phase 3 drives the materializer (reused from
/// the live-turn path, so a [`FakeMaterializer`] injected in a unit test
/// exercises the replay truncation without DuckDB / a filesystem).
///
/// [`FakeMaterializer`]: super::materializer::FakeMaterializer
pub(crate) struct Resumer<'a> {
    cancel: &'a Arc<CancelToken>,
    materializer: &'a mut dyn Materializer,
    recipe: &'a Recipe,
}

impl<'a> Resumer<'a> {
    pub(crate) fn new(
        cancel: &'a Arc<CancelToken>,
        materializer: &'a mut dyn Materializer,
        recipe: &'a Recipe,
    ) -> Self {
        Self {
            cancel,
            materializer,
            recipe,
        }
    }

    /// Resume phase 2 (ADR-0035, issue #49 AC5): resolve the active-SOURCE
    /// pointer after the per-source integrity pass. The happy path restores
    /// `recipe.active` (still registered). If the active source was rebuilt
    /// (dropped) and other sources remain, ADR-0035 forbids auto-fallback --
    /// the caller must name an explicit continuation. When the last source was
    /// rebuilt (no sources remain), the working set stays empty + `active` is
    /// `None` without a callback (the empty state IS the honest end). A corrupt
    /// recipe whose `active` was never a registered source surfaces as
    /// [`ResumeError::ActiveMissing`] (never the interactive path).
    ///
    /// Writes the resolved pointer into `working_set` and returns the decision
    /// summary ([`ResolvedActive`]). Pure logic -- no DuckDB, no filesystem,
    /// no materializer; a unit test drives every branch with a hand-built
    /// working set + recipe.
    pub(crate) fn resolve_active(
        &self,
        working_set: &mut WorkingSet,
        rebuilt: &HashSet<String>,
        on_active_abandoned: &mut impl FnMut(ActiveAbandoned) -> ActiveResolution,
    ) -> Result<ResolvedActive, ResumeError> {
        let Some(active_name) = self.recipe.active.clone() else {
            return Ok(ResolvedActive::None); // no active pointer (empty working set recipe)
        };
        // Happy path: active still registered. Restore the pointer (ingest
        // left it on the last-registered source; an explicit prior user
        // continuation choice must be re-applied here, ADR-0035/0037).
        if working_set.get(&active_name).is_some() {
            return if working_set.set_active(&active_name) {
                Ok(ResolvedActive::Restored(active_name))
            } else {
                // set_active rejects a result_N name; the recipe invariant says
                // active is always a source, so a failure here is corruption.
                Err(ResumeError::ActiveMissing(active_name))
            };
        }
        // Active not in the working set. If it was NOT rebuilt, it names a
        // source that was never in recipe.sources -> corrupt recipe.
        if !rebuilt.contains(&active_name) {
            return Err(ResumeError::ActiveMissing(active_name));
        }
        // Active was rebuilt. ADR-0035: no silent fallback. The remaining
        // registered sources (excluding result_N) are the continuation menu.
        let remaining: Vec<String> = working_set
            .list()
            .iter()
            .filter(|d| !working_set.is_result(&d.reference_name))
            .map(|d| d.reference_name.clone())
            .collect();
        if remaining.is_empty() {
            // The last source was rebuilt -> empty working set, active None.
            // (working_set.remove already cleared active when the rebuilt
            // active source was detached.) No callback -- nothing to choose
            // from, and the empty state is the user's honest end (upload new).
            return Ok(ResolvedActive::None);
        }
        match on_active_abandoned(ActiveAbandoned {
            abandoned: active_name,
            remaining: remaining.clone(),
        }) {
            ActiveResolution::ContinueWith(name) => {
                if remaining.contains(&name) && working_set.set_active(&name) {
                    Ok(ResolvedActive::Continued(name))
                } else {
                    // Caller named a source not in `remaining` -- a stale view
                    // or a direct IPC race. Surface as ActiveMissing rather
                    // than silently writing a dangling pointer.
                    Err(ResumeError::ActiveMissing(name))
                }
            }
            ActiveResolution::Abort => Err(ResumeError::Aborted),
        }
    }

    /// Resume phase 3 (ADR-0034/0035, issue #49 AC6): eagerly re-execute the
    /// productive SQL chain LLM-free (the SQL lives in the recipe). Reuses the
    /// `#1` materialize path (via the shared [`Materializer`] trait) so
    /// result_N numbering, sandboxing, and shape derivation match a live turn
    /// (ADR-0009). Replay starts from an empty result set, so result_N numbers
    /// line up with the recipe's recording order. Fires one `Replay` progress
    /// event per turn.
    ///
    /// **Trust boundary (ADR-0036 Decision 5):** the recipe SQL re-executed
    /// here is parse-time untrusted at the resume boundary. v1 treats the
    /// `.duck` as a single-user, self-produced document, so resume reuses the
    /// SAME defenses a live turn relies on (sandbox preflight FsAcl
    /// read_* path whitelist, subquery wrapping rejects non-SELECT) rather
    /// than a recipe-specific SQL
    /// AST whitelist. A portable / cross-user `.duck` (email / USB / attach)
    /// would additionally need a SQL AST whitelist + PII redaction + an
    /// "opened an external .duck" risk prompt -- all three are explicitly v2.
    ///
    /// On a round-K SQL failure resume does NOT abort: turn K is rendered as
    /// `Failed` (ADR-0028 outcome C), turns K+1.. are dropped, and K-1's
    /// materialized results stay in the working set (ADR-0035 honest partial
    /// state). Returns the [`ReplayBreak`] so phase 4 knows where to truncate;
    /// `None` means the whole chain replayed.
    pub(crate) fn replay(
        &mut self,
        deps: &mut TurnDeps<'_>,
        on_progress: &mut impl FnMut(ResumeEvent),
    ) -> Result<Option<ReplayBreak>, ResumeError> {
        let chain = self.recipe.productive_chain();
        let total = chain.len();
        for (i, turn) in chain.iter().enumerate() {
            // Honor a user cancel between turns (ADR-0021): without this poll
            // a click of 停止 during replay would only get the engine interrupt
            // on the CURRENT SQL, surface as a partial break, and look
            // indistinguishable from data corruption. The cancel lands here as
            // ResumeError::Cancelled BEFORE the next turn's SQL starts.
            if self.cancel.is_requested() {
                return Err(ResumeError::Cancelled);
            }
            on_progress(ResumeEvent::Replay {
                index: i + 1,
                total,
                reference_name: turn.reference_name.clone(),
            });
            // Re-materialize via the shared materializer (ADR-0053): resume is
            // LLM-free -- it re-executes stored SQL. TurnDeps borrows the same
            // shared state the live turn path borrows; the block scope releases
            // those borrows before rename_display takes its own &mut.
            // self.cancel is &Arc<CancelToken>; deref coercion hands the
            // materializer its &CancelToken.
            let materialized = self.materializer.try_materialize(
                &turn.sql,
                self.cancel,
                turn.reference_name.clone(),
                deps,
            );
            match materialized {
                Ok(descriptor) => {
                    if descriptor.display_name != turn.display_name {
                        // Backend log only: a failure to restore the turn's
                        // recorded label is logged (not silently swallowed),
                        // but no IPC event or banner is emitted.
                        if let Err(e) = deps
                            .working_set
                            .rename_display(&turn.reference_name, &turn.display_name)
                        {
                            log::warn!(
                                target: "toptopduck::session",
                                "restore label「{}」for replayed turn {} failed: {e}",
                                turn.display_name,
                                turn.reference_name,
                            );
                        }
                    }
                }
                Err(e) => {
                    // Round K failed -- stop here. K-1 results are in the
                    // working set; K will render as Failed; K+1.. are dropped
                    // by rebuild_timeline (truncate at this reference name).
                    return Ok(Some(ReplayBreak {
                        reference_name: turn.reference_name.clone(),
                        failure: TurnFailure::Execute { detail: e.detail },
                    }));
                }
            }
        }
        Ok(None)
    }

    /// Resume phase 4 (ADR-0028/0039/0040, issue #49 AC6): rebuild the
    /// conversation timeline from the recipe, truncated at the replay
    /// breakpoint if any. The Materialized turns' descriptors come from the
    /// working set (just re-built by replay, display names restored); the break
    /// turn (if any) renders as `Failed` with the replay's reason (ADR-0028
    /// outcome C); entries strictly after the break turn are dropped (the
    /// conversation stops at the breakpoint). viz is `None` (ADR-0036 not
    /// persisted), so a reopened chart renders as a table (ADR-0033).
    ///
    /// Returns the rebuilt timeline; `open_duck` assigns it to `session.timeline`.
    /// The rebuild is a 1:1 map over `recipe.history[..end]` (never filtered),
    /// so the returned length IS `end`. Each turn entry carries its persisted
    /// audit (trace + provenance) harvested verbatim from the recipe, so
    /// alignment is structural (issue #325). Registers stale placeholders into
    /// `working_set` as a pre-pass (ADR-0041 dead turns stay visible but carry
    /// no backing data).
    pub(super) fn rebuild_timeline(
        &self,
        working_set: &mut WorkingSet,
        break_at: Option<&ReplayBreak>,
    ) -> Result<Vec<TimelineEntry>, ResumeError> {
        // Locate the break turn's history index (if any) to truncate there.
        // The productive_chain is the Materialized turns in timeline order, so
        // turn K in that order maps to one history entry by reference name.
        let break_idx = break_at.and_then(|brk| {
            self.recipe.history.iter().position(|entry| match entry {
                RecipeEntry::Turn(t) => matches!(
                    &t.outcome,
                    RecipeOutcome::Materialized { promotions, .. }
                        if promotions.iter().any(|p| p.reference_name == brk.reference_name)
                ),
                _ => false,
            })
        });
        // Invariant: if break_at is Some, the break turn's reference_name MUST
        // appear in recipe.history as a Materialized entry (the productive_chain
        // and the history are two views of the same turn list). A None
        // break_idx with a Some break_at means the invariant is violated (a
        // hand-edited recipe whose history lost the break turn, or a logic bug
        // in replay). Surfacing as Replay rather than silently rendering the
        // full timeline (which would hide the replay failure from the user) is
        // the ADR-0035 honest answer.
        let end = match (break_at, break_idx) {
            (None, _) => self.recipe.history.len(),
            (Some(_), Some(idx)) => idx + 1,
            (Some(brk), None) => {
                log::error!(
                    target: "toptopduck::session",
                    "replay break reference {} not found in recipe history -- invariant violation",
                    brk.reference_name
                );
                return Err(ResumeError::Replay {
                    reference_name: brk.reference_name.clone(),
                    detail: format!(
                        "重放断点「{}」在 history 中找不到对应条目（recipe 不一致）",
                        brk.reference_name
                    ),
                });
            }
        };

        // Stale turns are absent from the productive chain (ADR-0041), so the
        // rebuild closure below must find their descriptors already in the
        // working set -- register the placeholders first (ADR-0013: stale is
        // not silently discarded).
        register_stale_placeholders(working_set, self.recipe, end);

        let timeline = self.recipe.history[..end]
            .iter()
            .map(|entry| match entry {
                RecipeEntry::Turn(turn) => {
                    let outcome = match &turn.outcome {
                        RecipeOutcome::Materialized {
                            promotions,
                            assumption,
                        } => {
                            // ADR-0035 honest partial state + ADR-0084: if
                            // replay broke at ANY promotion in this turn's
                            // chain, the turn did not complete -- render it
                            // Failed (the break's failure), NOT Materialized.
                            // The chain replays in order, so a break at
                            // promotion K means K.. were never re-materialized.
                            let broke_here = break_at.filter(|b| {
                                promotions
                                    .iter()
                                    .any(|p| p.reference_name == b.reference_name)
                            });
                            if let Some(b) = broke_here {
                                TurnOutcome::Failed(b.failure.clone())
                            } else {
                                // Live turn: every promotion was re-materialized
                                // by replay (or, for a stale promotion, a
                                // placeholder was registered in the pre-pass
                                // above -- ADR-0041 dead result). Look up each
                                // descriptor in the working set; the chain rides
                                // the outcome in promotion order (ADR-0084), so
                                // the rebuilt history matches what the live turn
                                // produced and the stale flag carries through to
                                // the UI badge.
                                let mut rebuilt = Vec::with_capacity(promotions.len());
                                for p in promotions {
                                    let dataset = working_set
                                        .get(&p.reference_name)
                                        .cloned()
                                        .ok_or_else(|| ResumeError::Replay {
                                            reference_name: p.reference_name.clone(),
                                            detail: format!(
                                                "重放后未在 working_set 中找到 {}",
                                                p.reference_name
                                            ),
                                        })?;
                                    rebuilt.push(crate::model::Promotion {
                                        dataset,
                                        sql: p.sql.clone(),
                                    });
                                }
                                TurnOutcome::Materialized {
                                    promotions: rebuilt,
                                    viz: None,
                                    assumption: assumption.clone(),
                                }
                            }
                        }
                        RecipeOutcome::Textual {
                            text_kind,
                            body,
                            assumption,
                        } => TurnOutcome::Textual {
                            text_kind: *text_kind,
                            body: body.clone(),
                            assumption: assumption.clone(),
                        },
                        RecipeOutcome::Failed(failure) => TurnOutcome::Failed(failure.clone()),
                        RecipeOutcome::Cancelled => TurnOutcome::Cancelled,
                    };
                    Ok(TimelineEntry::Turn {
                        record: TurnRecord {
                            question: turn.question.clone(),
                            outcome,
                            // ADR-0078 (issue #297; grouped per ADR-0103,
                            // issue #608): the display trace round-trips from
                            // the recipe's persisted rounds -- the same bounded
                            // shape the live turn emitted, so a resumed session
                            // expands identical trace rows. Empty for v1-era
                            // migrated turns (their RecipeTurn carries no
                            // trace; the v2+ synthetic single-call trace does,
                            // wrapped into one round by the v4->v5 step).
                            trace: turn.trace.iter().map(TraceRound::from).collect(),
                            // ADR-0103 (issue #608): the turn's timestamps
                            // round-trip verbatim; a pre-v5 turn carries None
                            // and renders without a timestamp (honest degrade,
                            // never a synthetic one).
                            asked_at: turn.asked_at,
                            settled_at: turn.settled_at,
                            // Issue #381 (skills) + ADR-0101 (attribution):
                            // the IPC provenance mirrors the persisted pair --
                            // skills (already the model::SkillProvenance
                            // shape, a verbatim clone preserves each skill's
                            // assembly-time content_hash for the frontend
                            // drift check) and the runtime projection. A
                            // persisted External turn without an adapter id
                            // (pre-extension recording) projects to
                            // External { adapter_id: None } -- the thread's
                            // "not recorded" degradation.
                            provenance: TurnProvenance {
                                skills: turn.provenance.skills.clone(),
                                runtime: turn.provenance.runtime.map(|kind| match kind {
                                    RuntimeKind::BuiltIn => TurnRuntime::BuiltIn,
                                    RuntimeKind::External => TurnRuntime::External {
                                        adapter_id: turn.provenance.adapter_id.clone(),
                                    },
                                }),
                            },
                        },
                        // ADR-0078 (issue #319): the persisted audit round-trips
                        // verbatim from the recipe turn -- trace + provenance
                        // are read back as-is so the next persist re-writes the
                        // same values (no re-synthesis).
                        audit: TurnAudit::from_recipe_turn(turn),
                    })
                }
                RecipeEntry::Source(ev) => Ok(TimelineEntry::Source(ev.clone())),
                RecipeEntry::Skill(ev) => Ok(TimelineEntry::Skill(ev.clone())),
            })
            .collect::<Result<Vec<_>, ResumeError>>()?;
        Ok(timeline)
    }
}

impl From<&RecipeTraceEntry> for TraceEntryView {
    /// The resumed-trace mapping (ADR-0078, issue #297): the persisted recipe
    /// entry IS the display shape (the live->persisted mapping already dropped
    /// the tool_use_id + the success excerpt), so the rebuild copies fields
    /// verbatim. A resumed turn and the live turn that recorded it render the
    /// same expanded trace.
    fn from(entry: &RecipeTraceEntry) -> Self {
        Self {
            name: entry.name.clone(),
            operation_kind: entry.operation_kind,
            summary: entry.summary.clone(),
            success: entry.success,
            result_excerpt: entry.result_excerpt.clone(),
        }
    }
}

impl From<&RecipeTraceRound> for TraceRound {
    /// The round-level resumed-trace mapping (ADR-0103, issue #608): the
    /// persisted round round-trips onto the display view beside the
    /// entry-level mapping above, so a resumed session renders the same
    /// rounds the live turn recorded.
    fn from(round: &RecipeTraceRound) -> Self {
        Self {
            thinking: round.thinking.clone(),
            text: round.text.clone(),
            calls: round.calls.iter().map(TraceEntryView::from).collect(),
        }
    }
}

/// Pre-pass (ADR-0041, issue #52): register a placeholder descriptor for each
/// stale Materialized turn in the timeline slice `..end`. These dead turns are
/// absent from the productive chain, so [`Resumer::replay`] never re-
/// materialized their tables -- but they stay in history for display and feed
/// the LLM conversation-thread window (ADR-0041 point 2). The placeholder
/// carries no backing data (columns / sample empty -- the materialized rows are
/// not persisted, ADR-0036) but DOES carry the stale anchor, so:
///   - the conversation renders the stale badge (descriptor.stale);
///   - session.get / list surface it marked stale (ADR-0013 "not silently
///     discarded");
///   - resolve_active skips it (focus never lands on a dead turn);
///   - the placeholder is excluded from the LLM's dataset working set
///     (ADR-0013); the stale turn's verbatim SQL still reaches the model via
///     the conversation-thread window (ADR-0041 point 2).
///
/// Called ahead of the rebuild closure in [`Resumer::rebuild_timeline`] so that
/// closure stays `&self`-ish over the working set (a `&mut` register inside
/// the `&working_set` closure's get() would not borrow-check).
fn register_stale_placeholders(working_set: &mut WorkingSet, recipe: &Recipe, end: usize) {
    for entry in &recipe.history[..end] {
        let RecipeEntry::Turn(turn) = entry else {
            continue;
        };
        let RecipeOutcome::Materialized { promotions, .. } = &turn.outcome else {
            continue;
        };
        // ADR-0084: a turn carries a promotion chain; register a placeholder
        // for EACH stale promotion (each its own dead result_N, ADR-0041), so
        // the rebuild closure finds every dead result already in the working
        // set.
        for promotion in promotions {
            let Some(anchor) = &promotion.stale else {
                continue;
            };
            if working_set.get(&promotion.reference_name).is_some() {
                continue;
            }
            let placeholder = DatasetDescriptor {
                reference_name: promotion.reference_name.clone(),
                display_name: promotion.display_name.clone(),
                source_path: String::new(),
                columns: Vec::new(),
                row_count: 0,
                sample: Vec::new(),
                fingerprint: String::new(),
                rectify: RectifyProvenance::NotApplicable,
                privacy: DatasetPrivacy::default(),
                stale: Some(anchor.clone()),
            };
            working_set.register_result(placeholder);
        }
    }
}

// --- Session resume entry point (ADR-0053 Decision 3) -----------------
// The full 5-phase open_duck orchestrator + phase 1 source re-ingest
// helpers. Sibling impl block -- same pattern as source_lifecycle.rs
// and ingest.rs (ADR-0053 Decision 5 physical-move precedent).

impl super::Session {
    /// Open a `.duck` and resume the session across the restart boundary
    /// (ADR-0034/0035, issue #49). Reads the recipe, re-reads + fingerprint-
    /// verifies each source (interactive re-link / rebuild on Missing / Drift),
    /// resolves the active-SOURCE pointer (interactive continuation if the
    /// active was abandoned + others remain), eagerly re-executes the
    /// productive SQL chain LLM-free (partial on a round-K failure: K-1
    /// results preserved, K rendered as Failed, post-K turns dropped), and
    /// rebuilds the conversation timeline truncated at any replay breakpoint.
    ///
    /// The three callbacks are the honest-degrade decision points
    /// (ADR-0035 -- the engine NEVER silently picks):
    /// - `on_progress`: per-source verification + per-replayed-turn progress
    ///   (ADR-0034 visible progress).
    /// - `on_source_issue`: per-source Missing / Drift resolution. Each source
    ///   is handled independently (AC4); a Rebuild drops just that source.
    /// - `on_active_abandoned`: fired ONLY when the active source was rebuilt
    ///   AND other sources remain (AC5 -- no silent fallback).
    ///
    /// Resume itself is LLM-free (AC7): it re-executes stored SQL and asks the
    /// caller (not a cloud model) for every integrity decision. The provider is
    /// wired only so the next NEW turn after resume reaches a live model.
    ///
    /// On success the `.duck` is rewritten to reflect the post-resume state
    /// (relinked paths, rebuilt sources dropped, truncated timeline with the
    /// failed turn) -- a failure here is captured in `persist_error` (non-
    /// blocking; the session is live regardless, ADR-0035 honest signal). On
    /// [`ResumeError::Aborted`] the on-disk recipe is left untouched (AC2).
    ///
    /// ADR-0035 Decision 3 / issue #50 single-writer: the canonical path is acquired
    /// BEFORE the recipe is read -- a second opener in this process gets
    /// [`ResumeError::AlreadyOpen`] and never diverges a second in-memory
    /// session from the file. The acquire is RAII; any error exit (load,
    /// cancel, abort, replay invariant) releases the key. On success the
    /// resumed Session takes ownership (the guard is forgotten) and releases
    /// the key on its own Drop.
    pub fn open_duck(
        path: &Path,
        cancel: Arc<CancelToken>,
        provider: Box<dyn Provider>,
        mut on_progress: impl FnMut(ResumeEvent),
        mut on_source_issue: impl FnMut(SourceIssue) -> SourceResolution,
        mut on_active_abandoned: impl FnMut(ActiveAbandoned) -> ActiveResolution,
    ) -> Result<Self, ResumeError> {
        // Mark resume in-flight for the WHOLE function so concurrent mutating
        // commands reject at the command layer instead of silently racing the
        // stale pre-resume session. RAII -- every exit (including `?` error
        // propagation) drops the guard and clears the flag. Acquired FIRST so
        // even a registry-refuse / load-fail resume holds the flag for its
        // full (short) duration.
        let _resume_flag = ResumeFlagGuard::acquire();
        // Single-writer acquire (ADR-0035 Decision 3, issue #50). Held across all
        // resume phases; the guard's Drop releases the key on every error
        // exit, and `mem::forget` on success transfers ownership to the
        // resumed Session. Acquiring BEFORE the cancel guard / recipe read
        // means a duplicate-opener refusal never disturbs an in-flight cancel
        // state.
        let canonical = canonicalize_duck(path)
            .map_err(|e| ResumeError::Load(crate::persistence::io::LoadError::Io(e.to_string())))?;
        let registry = OpenDuckGuard::acquire(canonical.clone())?;

        // Mark resume as in-flight + clear any stale cancel request, mirroring
        // `ask`'s per-turn guard (ADR-0021). The resume_sources / replay
        // loops poll is_requested() between items so a user cancel lands as
        // [`ResumeError::Cancelled`] (a clean signal), not a masked partial
        // state indistinguishable from data corruption. Drop on exit clears
        // in-flight and the interrupt slot (RAII -- every exit from open_duck,
        // success or error, drops the guard). The resumed Session reuses the
        // SAME Arc<CancelToken>, so the next ask's begin_turn composes cleanly.
        let _guard = cancel.begin_turn();

        let mut recipe = read_duck(path).map_err(ResumeError::Load)?;
        // Seed the external-change baseline from the file AS READ (ADR-0035 Decision 3,
        // issue #50): any external edit during the resume phases (re-ingest /
        // replay can take seconds) surfaces at the post-resume persist via the
        // hash check, never as a silent clobber of the edited file.
        let resume_baseline = super::recipe_persister::hash_file(path)
            .map_err(|e| ResumeError::Load(crate::persistence::io::LoadError::Io(e.to_string())))?;
        let mut session = Self::with_provider_and_cancel(provider, cancel)
            .map_err(|e| ResumeError::Load(crate::persistence::io::LoadError::Io(e.to_string())))?;
        session.persister.adopt_resumed(
            path.to_path_buf(),
            canonical.clone(),
            recipe.session_name.clone(),
            resume_baseline,
        );

        // Phase 1: re-read + verify each source (interactive re-link / rebuild).
        // Returns the set of rebuilt (dropped) sources; recipe.sources[i] is
        // updated in place for any relinked path.
        let rebuilt =
            session.resume_sources(path, &mut recipe, &mut on_progress, &mut on_source_issue)?;

        // Phase 2/3/4 via the Resumer deep module (ADR-0053 Decision 3): the
        // Resumer borrows the shared cancel + the SAME Materializer trait
        // object the live-turn agent loop drives + the recipe. It does NOT
        // hold the Session -- each phase method borrows working_set / TurnDeps
        // and returns a structured result, which open_duck applies. Scoped so
        // the Resumer (and its disjoint-field borrows of session.cancel /
        // session.materializer) drops before phase 5's &mut session persist.
        {
            let mut resumer = Resumer::new(&session.cancel, &mut *session.materializer, &recipe);
            // Phase 2: resolve the active-SOURCE pointer. The happy path
            // restores recipe.active; if the active was rebuilt + others
            // remain, the caller picks an explicit continuation (ADR-0035
            // no-silent-fallback, AC5).
            resumer.resolve_active(&mut session.working_set, &rebuilt, &mut on_active_abandoned)?;
            // Phase 3: replay the productive SQL chain (partial on failure --
            // K-1 results preserved, K rendered as Failed, AC6).
            let replay_break = {
                let mut deps = TurnDeps {
                    conn: &session.conn,
                    source_files: &mut session.source_files,
                    working_set: &mut session.working_set,
                    result_row_cap: session.result_row_cap,
                    result_count_cap: session.result_count_cap,
                    temp_path: &session.temp_path,
                    tool_output_refs: &mut session.tool_output_refs,
                };
                resumer.replay(&mut deps, &mut on_progress)?
            };
            // Phase 4: rebuild the conversation timeline, truncated at the
            // replay breakpoint (if any). Post-break entries are dropped
            // ("对话停在断点"). rebuild_timeline returns the unified timeline
            // (ThreadEntry + audit paired per turn, issue #325) so alignment is
            // structural and no separate audit harvest is needed.
            session.timeline =
                resumer.rebuild_timeline(&mut session.working_set, replay_break.as_ref())?;
            // ADR-0086 (issue #363): seed the live mounted-skills cache from
            // the recipe's Mount/Unmount fold. The recipe never stores a
            // snapshot -- the timeline IS the source of truth -- so the cache
            // is rebuilt deterministically on every resume. Honest degrade
            // applies at assembly time (a name missing from the registry is
            // surfaced then); here every folded name lands regardless.
            session.mounted_skills = recipe.mounted_skills();
        }

        // ADR-0095 Decision 6 (+ ADR-0102 Decision 1's `last_runtime`):
        // restore the session-level runtime facts from the recipe header.
        // The selections + discovery cache + last runtime seed BOTH the
        // Session's recipe-header facts (so the post-resume persist below
        // rewrites them unchanged -- an undetected-adapter degrade at the
        // command layer never destroys the persisted value) and the
        // caller-visible read (open_duck at the command layer restores the
        // posture trio onto the handle and resolves `last_runtime` into the
        // restored runtime choice via `Session::runtime_facts`).
        session.runtime_facts = super::SessionRuntimeFacts {
            model: recipe.model.clone(),
            thought_level: recipe.thought_level.clone(),
            cached_discovered: recipe.cached_discovered.clone(),
            last_runtime: recipe.last_runtime.clone(),
        };

        // Phase 5: persist the post-resume state. adopt_resumed already set
        // duck_path + the baseline, so only the write remains. build_recipe
        // reads the live working set, so relinked paths, dropped (rebuilt)
        // sources, and the truncated timeline (failed turn at K) land in the
        // persisted recipe. A failure is non-blocking -- the session is live;
        // the banner surfaces the disk-vs-memory drift. The post-resume write
        // runs the external-change hash check against the resume_baseline --
        // if the file changed under us during resume, the write is suspended
        // and pending_conflict is set (never a silent clobber).
        session.persist_if_bound();

        // Success -- the resumed Session owns the registry key now. Disarm the
        // guard so its Drop does NOT release the key; the Session's own Drop
        // will. `registry` is moved into forget, so it is no longer reachable
        // for an accidental early release.
        std::mem::forget(registry);
        Ok(session)
    }

    /// Resolve a recipe source path to a filesystem path (ADR-0036 Decision 4
    /// hybrid paths). The relative form -- taken against the `.duck` file's
    /// directory -- wins when present and the candidate exists; that is the
    /// form that survives "move the folder" portability. Otherwise the
    /// absolute `source_path` is the fallback. Fingerprint verification
    /// upstream catches a wrong pick, so the choice here is safe.
    ///
    /// Trust boundary (rust/security.md Input Validation section + ADR-0036): the
    /// `.duck` is external input. A hand-edited or externally-sourced recipe
    /// whose `relative_path` escapes the `.duck`'s directory subtree
    /// (`../../etc/passwd`, `~/../.ssh/id_rsa`, ...) would otherwise let a
    /// malicious recipe pull arbitrary files into the DuckDB snapshot (and
    /// from there into LLM samples / column names). The relative candidate
    /// is canonicalized and MUST remain inside the `.duck`'s directory; an
    /// escape is rejected at this boundary as a `SourceMissing` (path
    /// traversal refused). A missing candidate falls through to the absolute
    /// fallback, which fingerprint verification then refuses if it is also
    /// missing or drifted (ADR-0035 honest degrade -- not a silent traversal).
    fn resolve_source_path(duck_path: &Path, src: &SourceRef) -> Result<PathBuf, ResumeError> {
        let absolute = PathBuf::from(&src.source_path);
        let Some(relative) = &src.relative_path else {
            return Ok(absolute);
        };
        let Some(base) = duck_path.parent() else {
            return Ok(absolute);
        };
        let candidate = base.join(relative);
        // canonicalize requires the file to exist; a missing candidate falls
        // through to the absolute fallback (fingerprint check decides there).
        let canonical = match candidate.canonicalize() {
            Ok(c) => c,
            Err(_) => return Ok(absolute),
        };
        let base_canonical = match base.canonicalize() {
            Ok(c) => c,
            Err(e) => {
                // candidate canonicalized but base did not (TOCTOU, transient
                // permission flip, Windows AV lock). The relative path is
                // safe direction-wise (a traversal leak would require base
                // resolution to succeed AND the starts_with check to accept
                // an escaping candidate), so we fall back to the absolute
                // path -- but log so ops can diagnose why the portable
                // relative path was skipped (the user may otherwise receive a
                // SourceIssue against the less portable absolute path).
                log::warn!(
                    target: "toptopduck::session",
                    "base canonicalize failed for {}: {e} -- relative path「{}」skipped, \
                     falling back to absolute「{}」",
                    base.display(),
                    relative,
                    absolute.display(),
                );
                return Ok(absolute);
            }
        };
        if !canonical.starts_with(&base_canonical) {
            return Err(ResumeError::SourceMissing {
                reference_name: src.reference_name.clone(),
                path: relative.clone(),
                detail: "相对路径越出 .duck 目录（已拒绝路径遍历）".into(),
            });
        }
        Ok(canonical)
    }

    /// Resume phase 1 (ADR-0034/0035/0036/0042, issue #49): re-read and verify
    /// every source, interactively. The source path resolves hybrid-style
    /// ([`Self::resolve_source_path`]); the source is ingested under the
    /// recipe's reference name via [`Self::resume_ingest_at`] (no name derive
    /// / de-conflict / Added-event -- resume replays the recipe's own events
    /// in phase 4, not new ones); the resulting post-rectify fingerprint must
    /// match the recipe (ADR-0035/0042). On Missing (path gone / unreadable)
    /// or Drift (present but fingerprint differs) the caller's `on_source_issue`
    /// callback decides: Relink (re-ingest a new path + re-verify, looping),
    /// Abort (stop resume, on-disk recipe untouched), or Rebuild (drop this one
    /// source, continue with the rest -- AC4 per-source independence).
    ///
    /// Returns the set of rebuilt source reference names so phase 2 can decide
    /// whether the active pointer needs an interactive continuation. Mutates
    /// `recipe.sources[i]` in place for any relinked path (source_path updated,
    /// relative_path cleared) so phase 5's persist writes the new path. Fires
    /// one `Source` progress event per source (ADR-0034 visible progress).
    fn resume_sources(
        &mut self,
        duck_path: &Path,
        recipe: &mut Recipe,
        on_progress: &mut impl FnMut(ResumeEvent),
        on_source_issue: &mut impl FnMut(SourceIssue) -> SourceResolution,
    ) -> Result<HashSet<String>, ResumeError> {
        let total = recipe.sources.len();
        let mut rebuilt: HashSet<String> = HashSet::new();
        for i in 0..recipe.sources.len() {
            if self.cancel.is_requested() {
                return Err(ResumeError::Cancelled);
            }
            // Snapshot the reference name for the progress event before any
            // mutable borrow of recipe.sources below.
            let reference_name = recipe.sources[i].reference_name.clone();
            on_progress(ResumeEvent::Source {
                index: i + 1,
                total,
                reference_name: reference_name.clone(),
            });
            // Re-link / drift retry loop: each iteration resolves the path,
            // ingests under the recipe's name, and verifies the fingerprint.
            // A Relink resolution updates the path and loops; Abort returns;
            // Rebuild drops the source and breaks to the next one.
            loop {
                let src = recipe.sources[i].clone();
                let path = Self::resolve_source_path(duck_path, &src)?;
                match self.resume_ingest_at(&src.reference_name, &src.display_name, &path) {
                    Ok(descriptor) => {
                        if descriptor.fingerprint == src.fingerprint {
                            // Match -- restore the recipe's display label over
                            // the path-derived one (ADR-0037 rename survives).
                            if descriptor.display_name != src.display_name {
                                // Backend log only: a failure to restore the
                                // recipe's label is logged (not silently
                                // swallowed), but no IPC event or banner is
                                // emitted -- the user would otherwise see a
                                // path-derived label without knowing the rename
                                // was lost. A future ResumeEvent variant could
                                // surface this to the frontend.
                                if let Err(e) =
                                    self.rename_display(&src.reference_name, &src.display_name)
                                {
                                    log::warn!(
                                        target: "toptopduck::session",
                                        "restore label「{}」for re-linked source {} failed: {e}",
                                        src.display_name, src.reference_name,
                                    );
                                }
                            }
                            break; // next source
                        }
                        // Drift: present at path, fingerprint differs. NEVER
                        // silently replay with the new data (ADR-0035).
                        let resolution = on_source_issue(SourceIssue::Drift {
                            reference_name: src.reference_name.clone(),
                            path: path.to_string_lossy().to_string(),
                            expected: src.fingerprint.clone(),
                            found: descriptor.fingerprint,
                        });
                        match resolution {
                            SourceResolution::Relink(new_path) => {
                                // Drop the just-ingested drifted snapshot so
                                // the next loop's copy-in can attach under the
                                // same name without colliding.
                                self.detach_snapshot(&src.reference_name);
                                recipe.sources[i].source_path =
                                    new_path.to_string_lossy().to_string();
                                recipe.sources[i].relative_path = None;
                                continue; // re-verify with the new path
                            }
                            SourceResolution::Abort => return Err(ResumeError::Aborted),
                            SourceResolution::Rebuild => {
                                self.detach_snapshot(&src.reference_name);
                                rebuilt.insert(src.reference_name.clone());
                                break; // next source (this one abandoned)
                            }
                        }
                    }
                    Err(e) => {
                        // Distinguish Absent (path doesn't exist -> re-link is
                        // the natural fix) from Unreadable (file present but
                        // parse / format / ATTACH failed -> the user needs the
                        // reason to diagnose). ADR-0035 honest signal: the
                        // issue kind drives the user's next action, so
                        // conflating them would offer a re-link dialog for a
                        // file that is right where the recipe recorded it.
                        // `path` is the resolved candidate (relative preferred,
                        // absolute fallback) from resolve_source_path above.
                        let issue = if path.exists() {
                            SourceIssue::Unreadable {
                                reference_name: src.reference_name.clone(),
                                path: path.to_string_lossy().to_string(),
                                reason: e.to_string(),
                            }
                        } else {
                            SourceIssue::Missing {
                                reference_name: src.reference_name.clone(),
                                recorded_path: src.source_path.clone(),
                            }
                        };
                        let resolution = on_source_issue(issue);
                        match resolution {
                            SourceResolution::Relink(new_path) => {
                                recipe.sources[i].source_path =
                                    new_path.to_string_lossy().to_string();
                                recipe.sources[i].relative_path = None;
                                continue; // re-verify with the new path
                            }
                            SourceResolution::Abort => return Err(ResumeError::Aborted),
                            SourceResolution::Rebuild => {
                                rebuilt.insert(src.reference_name.clone());
                                break; // next source (never ingested)
                            }
                        }
                    }
                }
            }
        }
        Ok(rebuilt)
    }

    /// Ingest a source for resume under an explicit reference name + display
    /// label (no derive / de-conflict / Added-event append). The recipe
    /// already fixed the name + the timeline; resume just needs the snapshot
    /// attached read-only + the descriptor registered so fingerprint
    /// verification and replay can proceed. CSV/JSON/Parquet share the single
    /// copy-in path; Excel is refused (its multi-sheet + guided rectify
    /// semantics need their own resume path, out of scope for #49 -- a
    /// refused resume is more honest than silently re-tidying into shapes the
    /// recipe did not record). Returns the freshly-read descriptor.
    fn resume_ingest_at(
        &mut self,
        reference_name: &str,
        display_name: &str,
        path: &Path,
    ) -> Result<DatasetDescriptor, LoadError> {
        let dispatched = crate::ingest::dispatch(path);
        let reader = match dispatched {
            crate::ingest::Dispatched::Xls => return Err(LoadError::LegacyExcel),
            crate::ingest::Dispatched::Xlsx => {
                return Err(LoadError::Other {
                    detail: "resume 不支持 Excel 工作簿（多 sheet 语义）".into(),
                });
            }
            _ => match crate::ingest::reader_for(&dispatched) {
                Some(r) => r,
                None => {
                    let requested = match dispatched {
                        crate::ingest::Dispatched::Unsupported(ext) => ext,
                        _ => String::new(),
                    };
                    return Err(LoadError::UnsupportedFormat { requested });
                }
            },
        };
        // copy-in + attach under the explicit reference name (no de-conflict:
        // the recipe's name is already unique, ADR-0036 parse-time check).
        let snap = crate::ingest::loader::copy_in(path, &self.temp_path, reference_name, reader)?;
        let attach_path = snap.file_path.to_string_lossy();
        let attach_sql = format!(
            "ATTACH '{attach_path}' AS {} (READ_ONLY);",
            quote_ident(reference_name)
        );
        if let Err(e) = self.conn.execute_batch(&attach_sql) {
            if let Err(io_err) = fs::remove_file(&snap.file_path) {
                log::warn!(
                    target: "toptopduck::session",
                    "snapshot file removal failed during resume_ingest_at for \
                     {reference_name}: {io_err}"
                );
            }
            return Err(LoadError::Other {
                detail: format!("挂载快照失败：{e}"),
            });
        }
        self.source_files
            .insert(reference_name.to_string(), snap.file_path);
        let descriptor = DatasetDescriptor {
            reference_name: reference_name.to_string(),
            display_name: display_name.to_string(),
            source_path: path.to_string_lossy().to_string(),
            columns: snap.columns,
            row_count: snap.row_count,
            sample: snap.sample,
            fingerprint: snap.fingerprint,
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: None,
        };
        self.working_set.register(descriptor.clone());
        Ok(descriptor)
    }
}
#[cfg(test)]
mod tests {
    //! Resumer phase 2/3/4 branch coverage (ADR-0053 / issue #66). Each test
    //! injects a precise fake materializer or a hand-built working set + recipe
    //! and asserts the structured phase result -- no DuckDB query runs (the
    //! fake materializer is query-free), no filesystem, no Session. The
    //! branches that previously needed a real SQL engine to reach (replay
    //! truncation on a specific ExecErrorKind, active-abandoned continuation,
    //! timeline truncation at the breakpoint, stale-placeholder pre-pass) are
    //! now one-line injections.

    use super::*;
    use crate::cancel::CancelToken;
    use crate::guardrail::{ExecError, ExecErrorKind};
    use crate::model::{StaleAnchor, StaleReason, TextKind};
    use crate::persistence::recipe::{
        RecipeEntry, RecipeOutcome, RecipePromotion, RecipeTurn, SourceRef, TurnTimestamps,
    };
    use crate::session::materializer::FakeMaterializer;
    use crate::session::{ActiveAbandoned, ActiveResolution};

    use duckdb::Connection;
    use std::collections::{HashMap, HashSet};
    use std::path::Path;
    use std::sync::Arc;

    // --- helpers -------------------------------------------------------------

    /// A source descriptor with a distinct fingerprint, so a working set built
    /// from these reads like a real post-ingest set in phase 2 assertions.
    fn source_descriptor(name: &str) -> DatasetDescriptor {
        DatasetDescriptor {
            reference_name: name.into(),
            display_name: name.into(),
            source_path: format!("/{name}.csv"),
            columns: Vec::new(),
            row_count: 1,
            sample: Vec::new(),
            fingerprint: format!("fp_{name}"),
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: None,
        }
    }

    /// A result_N descriptor -- the shape `FakeMaterializer` hands back on Ok.
    fn result_descriptor(name: &str) -> DatasetDescriptor {
        DatasetDescriptor {
            reference_name: name.into(),
            display_name: name.into(),
            source_path: String::new(),
            columns: Vec::new(),
            row_count: 0,
            sample: Vec::new(),
            fingerprint: String::new(),
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: None,
        }
    }

    fn source_ref(name: &str) -> SourceRef {
        SourceRef {
            reference_name: name.into(),
            display_name: name.into(),
            source_path: format!("/{name}.csv"),
            relative_path: None,
            rectify: RectifyProvenance::NotApplicable,
            fingerprint: format!("fp_{name}"),
        }
    }

    /// A live (non-stale) Materialized recipe entry producing `reference_name`.
    fn materialized_turn(reference_name: &str, sql: &str) -> RecipeEntry {
        RecipeEntry::Turn(RecipeTurn::without_audit(
            format!("q_{reference_name}"),
            RecipeOutcome::Materialized {
                promotions: vec![RecipePromotion {
                    reference_name: reference_name.into(),
                    display_name: reference_name.into(),
                    sql: sql.into(),
                    stale: None,
                }],
                assumption: None,
            },
        ))
    }

    /// A stale (cascade-invalidated) Materialized recipe entry -- the
    /// ADR-0041 dead turn that `rebuild_timeline` must register a placeholder
    /// for (absent from the productive chain, so phase 3 never re-materialized
    /// its table).
    fn stale_materialized_turn(reference_name: &str, sql: &str, anchor: &str) -> RecipeEntry {
        RecipeEntry::Turn(RecipeTurn::without_audit(
            format!("q_{reference_name}"),
            RecipeOutcome::Materialized {
                promotions: vec![RecipePromotion {
                    reference_name: reference_name.into(),
                    display_name: reference_name.into(),
                    sql: sql.into(),
                    stale: Some(StaleAnchor {
                        reference_name: anchor.into(),
                        display_name: anchor.into(),
                        reason: StaleReason::Deleted,
                    }),
                }],
                assumption: None,
            },
        ))
    }

    /// Build a recipe with one source (`active`, if `Some`) + the given
    /// history. `Recipe::build` validates `active` is in `sources`, so the
    /// source is added iff `active` is `Some`.
    fn recipe_with(history: Vec<RecipeEntry>, active: Option<&str>) -> Recipe {
        let sources = active.map(source_ref).into_iter().collect();
        Recipe::build("test".into(), sources, history, active.map(|s| s.into()))
            .expect("test recipe builds")
    }

    /// A throwaway `TurnDeps` for phase 3. `FakeMaterializer` never touches
    /// DuckDB / the working set / the temp dir, so the contents are inert --
    /// the struct only needs to satisfy the `&mut TurnDeps` parameter so the
    /// live signature is tested, not a parallel test-only one.
    fn inert_deps<'a>(
        conn: &'a Connection,
        ws: &'a mut WorkingSet,
        sources: &'a mut HashMap<String, std::path::PathBuf>,
        tool_output_refs: &'a mut HashMap<String, crate::session::materializer::CachedDerivedRef>,
    ) -> TurnDeps<'a> {
        TurnDeps {
            conn,
            source_files: sources,
            working_set: ws,
            result_row_cap: 1_000,
            result_count_cap: 100,
            temp_path: Path::new("."),
            tool_output_refs,
        }
    }

    // --- phase 2: resolve_active --------------------------------------------

    #[test]
    fn resolve_active_restores_when_recipe_active_still_registered() {
        // Happy path (ADR-0035/0037): recipe.active names a source still in the
        // working set after phase 1 -> pointer restored, no callback fires.
        let recipe = recipe_with(Vec::new(), Some("people"));
        let mut ws = WorkingSet::default();
        ws.register(source_descriptor("people"));
        let rebuilt = HashSet::new();
        let cancel = Arc::new(CancelToken::new());
        let mut fake = FakeMaterializer::new(Vec::new());
        let resumer = Resumer::new(&cancel, &mut fake, &recipe);
        let resolved = resumer
            .resolve_active(&mut ws, &rebuilt, &mut |_| unreachable!("no callback"))
            .unwrap();
        assert_eq!(resolved, ResolvedActive::Restored("people".into()));
        assert_eq!(
            ws.active().map(|d| d.reference_name.clone()),
            Some("people".into()),
        );
    }

    #[test]
    fn resolve_active_none_when_recipe_active_is_none() {
        // recipe.active = None -> empty working set recipe; no callback.
        let recipe = recipe_with(Vec::new(), None);
        let mut ws = WorkingSet::default();
        let rebuilt = HashSet::new();
        let cancel = Arc::new(CancelToken::new());
        let mut fake = FakeMaterializer::new(Vec::new());
        let resumer = Resumer::new(&cancel, &mut fake, &recipe);
        let resolved = resumer
            .resolve_active(&mut ws, &rebuilt, &mut |_| unreachable!("no callback"))
            .unwrap();
        assert_eq!(resolved, ResolvedActive::None);
    }

    #[test]
    fn resolve_active_continued_when_user_picks_from_remaining() {
        // ADR-0035 no-silent-fallback: the active source was rebuilt (detached
        // from the working set), other sources remain, and the caller picks an
        // explicit continuation from the `remaining` menu.
        let recipe = recipe_with(Vec::new(), Some("people"));
        let mut ws = WorkingSet::default();
        // "people" is NOT in ws (rebuilt -> detached); "orders" remains.
        ws.register(source_descriptor("orders"));
        let rebuilt: HashSet<String> = ["people".into()].into_iter().collect();
        let cancel = Arc::new(CancelToken::new());
        let mut fake = FakeMaterializer::new(Vec::new());
        let resumer = Resumer::new(&cancel, &mut fake, &recipe);
        let mut calls = 0;
        let resolved = resumer
            .resolve_active(&mut ws, &rebuilt, &mut |abandoned: ActiveAbandoned| {
                calls += 1;
                assert_eq!(abandoned.abandoned, "people");
                assert_eq!(abandoned.remaining, vec!["orders".to_string()]);
                ActiveResolution::ContinueWith("orders".into())
            })
            .unwrap();
        assert_eq!(calls, 1, "on_active_abandoned must fire exactly once");
        assert_eq!(resolved, ResolvedActive::Continued("orders".into()));
        assert_eq!(
            ws.active().map(|d| d.reference_name.clone()),
            Some("orders".into()),
        );
    }

    #[test]
    fn resolve_active_none_when_last_source_rebuilt_no_remaining() {
        // The last source was rebuilt -> empty working set, active None, no
        // callback (the empty state IS the honest end -- nothing to pick).
        let recipe = recipe_with(Vec::new(), Some("people"));
        let mut ws = WorkingSet::default(); // empty -- "people" detached
        let rebuilt: HashSet<String> = ["people".into()].into_iter().collect();
        let cancel = Arc::new(CancelToken::new());
        let mut fake = FakeMaterializer::new(Vec::new());
        let resumer = Resumer::new(&cancel, &mut fake, &recipe);
        let resolved = resumer
            .resolve_active(&mut ws, &rebuilt, &mut |_| unreachable!("no callback"))
            .unwrap();
        assert_eq!(resolved, ResolvedActive::None);
    }

    #[test]
    fn resolve_active_abort_surfaces_as_aborted_error() {
        // User chose Abort in the active-abandoned dialog -> Err(Aborted).
        let recipe = recipe_with(Vec::new(), Some("people"));
        let mut ws = WorkingSet::default();
        ws.register(source_descriptor("orders")); // "people" rebuilt + detached
        let rebuilt: HashSet<String> = ["people".into()].into_iter().collect();
        let cancel = Arc::new(CancelToken::new());
        let mut fake = FakeMaterializer::new(Vec::new());
        let resumer = Resumer::new(&cancel, &mut fake, &recipe);
        let err = resumer
            .resolve_active(&mut ws, &rebuilt, &mut |_| ActiveResolution::Abort)
            .unwrap_err();
        assert!(matches!(err, ResumeError::Aborted), "got {err:?}");
    }

    #[test]
    fn resolve_active_missing_when_active_never_registered() {
        // Corrupt recipe: active names a source never in recipe.sources and not
        // rebuilt -> ActiveMissing (never the interactive path).
        let recipe = recipe_with(Vec::new(), Some("people"));
        let mut ws = WorkingSet::default();
        ws.register(source_descriptor("orders")); // active "people" not in ws
        let rebuilt = HashSet::new();
        let cancel = Arc::new(CancelToken::new());
        let mut fake = FakeMaterializer::new(Vec::new());
        let resumer = Resumer::new(&cancel, &mut fake, &recipe);
        let err = resumer
            .resolve_active(&mut ws, &rebuilt, &mut |_| unreachable!("no callback"))
            .unwrap_err();
        match err {
            ResumeError::ActiveMissing(name) => assert_eq!(name, "people"),
            other => panic!("expected ActiveMissing, got {other:?}"),
        }
    }

    #[test]
    fn resolve_active_missing_when_callback_picks_source_not_in_remaining() {
        // Contract: the active-abandoned callback returns a name NOT in the
        // `remaining` menu (a stale view, or an IPC race). Phase 2 must refuse
        // to write a dangling active pointer -- ActiveMissing surfaces rather
        // than a silent guess. Unreachable from production today (commands.rs
        // returns Abort until the active-abandoned dialog lands); this test
        // fixes the contract the dialog will rely on.
        let recipe = recipe_with(Vec::new(), Some("people"));
        let mut ws = WorkingSet::default();
        // "people" was rebuilt + detached; "orders" is the only valid pick.
        ws.register(source_descriptor("orders"));
        let rebuilt: HashSet<String> = ["people".into()].into_iter().collect();
        let cancel = Arc::new(CancelToken::new());
        let mut fake = FakeMaterializer::new(Vec::new());
        let resumer = Resumer::new(&cancel, &mut fake, &recipe);
        let err = resumer
            .resolve_active(&mut ws, &rebuilt, &mut |abandoned: ActiveAbandoned| {
                assert_eq!(abandoned.remaining, vec!["orders".to_string()]);
                ActiveResolution::ContinueWith("ghost".into()) // not in remaining
            })
            .unwrap_err();
        match err {
            ResumeError::ActiveMissing(name) => assert_eq!(name, "ghost"),
            other => panic!("expected ActiveMissing, got {other:?}"),
        }
    }

    // --- phase 3: replay -----------------------------------------------------

    #[test]
    fn replay_returns_none_when_whole_chain_succeeds() {
        // 3 productive turns, all materialize Ok -> no break, all 3 results
        // registered in the working set.
        let recipe = recipe_with(
            vec![
                materialized_turn("result_1", "SELECT 1"),
                materialized_turn("result_2", "SELECT 2"),
                materialized_turn("result_3", "SELECT 3"),
            ],
            Some("people"),
        );
        let cancel = Arc::new(CancelToken::new());
        let mut fake = FakeMaterializer::new(vec![
            Ok(result_descriptor("result_1")),
            Ok(result_descriptor("result_2")),
            Ok(result_descriptor("result_3")),
        ]);
        let conn = Connection::open_in_memory().expect("in-memory db");
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut deps = inert_deps(&conn, &mut ws, &mut sources, &mut refs);
        let mut resumer = Resumer::new(&cancel, &mut fake, &recipe);
        let break_point = resumer.replay(&mut deps, &mut |_| {}).unwrap();
        assert!(break_point.is_none(), "whole chain succeeded -> no break");
        assert!(ws.get("result_1").is_some());
        assert!(ws.get("result_2").is_some());
        assert!(ws.get("result_3").is_some());
    }

    #[test]
    fn replay_breaks_at_the_first_failing_turn() {
        // ADR-0035 honest partial state: turn K fails -> ReplayBreak at K, K-1
        // results preserved in the working set, K is NOT registered. Resume
        // does not retry (unlike the live turn path) -- the chain stops at K.
        let recipe = recipe_with(
            vec![
                materialized_turn("result_1", "SELECT 1"),
                materialized_turn("result_2", "SELECT 2"),
                materialized_turn("result_3", "SELECT bad"),
            ],
            Some("people"),
        );
        let cancel = Arc::new(CancelToken::new());
        let mut fake = FakeMaterializer::new(vec![
            Ok(result_descriptor("result_1")),
            Ok(result_descriptor("result_2")),
            Err(ExecError::new(ExecErrorKind::Resource, "结果行数超过上限")),
        ]);
        let conn = Connection::open_in_memory().expect("in-memory db");
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut deps = inert_deps(&conn, &mut ws, &mut sources, &mut refs);
        let mut resumer = Resumer::new(&cancel, &mut fake, &recipe);
        let brk = resumer
            .replay(&mut deps, &mut |_| {})
            .unwrap()
            .expect("expected a break at result_3");
        assert_eq!(brk.reference_name, "result_3");
        // The replay break presents as an Execute failure (the turn's SQL failed
        // to re-materialize), carrying the engine error in the detail.
        match &brk.failure {
            TurnFailure::Execute { detail } => {
                assert!(detail.contains("结果行数"), "got {detail}");
            }
            other => panic!("expected Execute break, got {other:?}"),
        }
        // K-1 results preserved; result_3 (the failure) not registered.
        assert!(ws.get("result_1").is_some());
        assert!(ws.get("result_2").is_some());
        assert!(ws.get("result_3").is_none());
    }

    #[test]
    fn replay_cancel_between_turns_surfaces_as_cancelled() {
        // ADR-0021: cancel requested before the loop top -> Err(Cancelled)
        // BEFORE the first turn's SQL runs. The materializer is never called.
        let recipe = recipe_with(
            vec![materialized_turn("result_1", "SELECT 1")],
            Some("people"),
        );
        let cancel = Arc::new(CancelToken::new());
        cancel.request();
        let mut fake = FakeMaterializer::new(vec![Ok(result_descriptor("result_1"))]);
        let conn = Connection::open_in_memory().expect("in-memory db");
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut deps = inert_deps(&conn, &mut ws, &mut sources, &mut refs);
        let mut resumer = Resumer::new(&cancel, &mut fake, &recipe);
        let err = resumer.replay(&mut deps, &mut |_| {}).unwrap_err();
        assert!(matches!(err, ResumeError::Cancelled), "got {err:?}");
        assert!(ws.get("result_1").is_none(), "materializer never ran");
    }

    // --- phase 4: rebuild_timeline ------------------------------------------

    #[test]
    fn rebuild_timeline_returns_full_history_when_no_break() {
        // No replay break -> the whole recipe.history is rebuilt; a Materialized
        // turn's descriptor comes from the working set (re-materialized by
        // phase 3 in the live path).
        let recipe = recipe_with(
            vec![
                materialized_turn("result_1", "SELECT 1"),
                materialized_turn("result_2", "SELECT 2"),
            ],
            Some("people"),
        );
        let mut ws = WorkingSet::default();
        ws.register_result(result_descriptor("result_1"));
        ws.register_result(result_descriptor("result_2"));
        let cancel = Arc::new(CancelToken::new());
        let mut fake = FakeMaterializer::new(Vec::new());
        let resumer = Resumer::new(&cancel, &mut fake, &recipe);
        let timeline = resumer.rebuild_timeline(&mut ws, None).unwrap();
        assert_eq!(timeline.len(), 2);
        for entry in &timeline {
            let TimelineEntry::Turn { record: t, .. } = entry else {
                panic!("expected Turn, got {entry:?}")
            };
            assert!(
                matches!(t.outcome, TurnOutcome::Materialized { .. }),
                "got {:?}",
                t.outcome
            );
        }
    }

    #[test]
    fn rebuild_timeline_projects_runtime_attribution_to_the_wire() {
        // ADR-0101: the resume projection maps the persisted pair (runtime
        // kind + adapter id) onto the wire `TurnRuntime` the thread's segment
        // badges read. Every recorded shape survives the rebuild: an external
        // turn names its adapter, a pre-extension external turn degrades to
        // `External { adapter_id: None }` (never a fabricated id), a built-in
        // turn carries only the kind, and a v1-era turn without a runtime
        // stays unattributed.
        fn attributed(runtime: Option<RuntimeKind>, adapter_id: Option<&str>) -> RecipeEntry {
            RecipeEntry::Turn(RecipeTurn::with_audit(
                "q",
                RecipeOutcome::Textual {
                    text_kind: TextKind::Agent,
                    body: "a".into(),
                    assumption: None,
                },
                Vec::new(),
                crate::persistence::recipe::TurnProvenance {
                    runtime,
                    adapter_id: adapter_id.map(Into::into),
                    skills: Vec::new(),
                },
                TurnTimestamps::default(),
            ))
        }
        let recipe = recipe_with(
            vec![
                attributed(Some(RuntimeKind::External), Some("gemini-cli")),
                attributed(Some(RuntimeKind::External), None),
                attributed(Some(RuntimeKind::BuiltIn), None),
                attributed(None, None),
            ],
            None,
        );
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let mut fake = FakeMaterializer::new(Vec::new());
        let resumer = Resumer::new(&cancel, &mut fake, &recipe);
        let timeline = resumer.rebuild_timeline(&mut ws, None).unwrap();
        let runtimes: Vec<Option<TurnRuntime>> = timeline
            .iter()
            .map(|entry| match entry {
                TimelineEntry::Turn { record, .. } => record.provenance.runtime.clone(),
                other => panic!("expected Turn, got {other:?}"),
            })
            .collect();
        assert_eq!(
            runtimes,
            vec![
                Some(TurnRuntime::External {
                    adapter_id: Some("gemini-cli".into())
                }),
                Some(TurnRuntime::External { adapter_id: None }),
                Some(TurnRuntime::BuiltIn),
                None,
            ],
            "the rebuild projects every recorded attribution shape onto the wire"
        );
    }

    #[test]
    fn rebuild_timeline_truncates_and_marks_break_turn_failed() {
        // A replay break at result_2 -> timeline truncates at result_2; the
        // break turn renders as Failed (ADR-0028 outcome C); entries strictly
        // after the break are dropped ("对话停在断点").
        let recipe = recipe_with(
            vec![
                materialized_turn("result_1", "SELECT 1"),
                materialized_turn("result_2", "SELECT bad"),
                materialized_turn("result_3", "SELECT 3"),
            ],
            Some("people"),
        );
        let mut ws = WorkingSet::default();
        ws.register_result(result_descriptor("result_1"));
        // result_2 was re-materialized by phase 3 before it broke on the next
        // turn; result_3 is strictly after the break and never lands here.
        ws.register_result(result_descriptor("result_2"));
        let cancel = Arc::new(CancelToken::new());
        let mut fake = FakeMaterializer::new(Vec::new());
        let resumer = Resumer::new(&cancel, &mut fake, &recipe);
        let brk = ReplayBreak {
            reference_name: "result_2".into(),
            failure: TurnFailure::Execute {
                detail: "resource cap".into(),
            },
        };
        let timeline = resumer.rebuild_timeline(&mut ws, Some(&brk)).unwrap();
        // Truncated at result_2: [result_1, result_2] (result_3 dropped).
        assert_eq!(timeline.len(), 2);
        let TimelineEntry::Turn { record: t1, .. } = &timeline[0] else {
            panic!("expected Turn, got {:?}", timeline[0])
        };
        assert!(
            matches!(t1.outcome, TurnOutcome::Materialized { .. }),
            "result_1 should still be Materialized: {:?}",
            t1.outcome
        );
        let TimelineEntry::Turn { record: t2, .. } = &timeline[1] else {
            panic!("expected Turn, got {:?}", timeline[1])
        };
        match &t2.outcome {
            TurnOutcome::Failed(TurnFailure::Execute { .. }) => {}
            other => panic!("expected Execute Failed at break turn, got {other:?}"),
        }
    }

    #[test]
    fn rebuild_timeline_registers_stale_placeholders() {
        // ADR-0041: a stale Materialized turn absent from the productive chain
        // (so phase 3 never re-materialized it) gets a placeholder registered
        // by the pre-pass, so rebuild_timeline finds it in the working set and
        // the conversation renders the stale badge.
        let recipe = recipe_with(
            vec![
                materialized_turn("result_1", "SELECT 1"),
                stale_materialized_turn("result_2", "SELECT 2", "people"),
            ],
            Some("people"),
        );
        let mut ws = WorkingSet::default();
        ws.register_result(result_descriptor("result_1"));
        // NOTE: result_2 is NOT in the working set -- the pre-pass must add a
        // placeholder carrying the stale anchor.
        let cancel = Arc::new(CancelToken::new());
        let mut fake = FakeMaterializer::new(Vec::new());
        let resumer = Resumer::new(&cancel, &mut fake, &recipe);
        let timeline = resumer.rebuild_timeline(&mut ws, None).unwrap();
        assert_eq!(timeline.len(), 2);
        let placeholder = ws
            .get("result_2")
            .expect("placeholder must be registered by the pre-pass");
        assert!(
            placeholder.stale.is_some(),
            "placeholder must carry the stale anchor"
        );
    }

    #[test]
    fn rebuild_timeline_errors_when_break_reference_absent_from_history() {
        // Contract: replay returned a break whose reference_name is NOT in
        // recipe.history (a hand-edited recipe that lost the break turn, or a
        // logic bug). The productive_chain and the history are two views of one
        // turn list, so a missing break reference is an invariant violation --
        // fail loudly as ResumeError::Replay instead of silently rendering the
        // full timeline (which would hide the replay failure from the user).
        let recipe = recipe_with(
            vec![materialized_turn("result_1", "SELECT 1")],
            Some("people"),
        );
        let mut ws = WorkingSet::default();
        ws.register_result(result_descriptor("result_1"));
        let cancel = Arc::new(CancelToken::new());
        let mut fake = FakeMaterializer::new(Vec::new());
        let resumer = Resumer::new(&cancel, &mut fake, &recipe);
        // "result_99" is absent from recipe.history -> invariant violation.
        let brk = ReplayBreak {
            reference_name: "result_99".into(),
            failure: TurnFailure::Execute {
                detail: "resource cap".into(),
            },
        };
        let err = resumer.rebuild_timeline(&mut ws, Some(&brk)).unwrap_err();
        match err {
            ResumeError::Replay {
                reference_name,
                detail,
            } => {
                assert_eq!(reference_name, "result_99");
                assert!(detail.contains("result_99"), "got {detail}");
            }
            other => panic!("expected ResumeError::Replay, got {other:?}"),
        }
    }
}
