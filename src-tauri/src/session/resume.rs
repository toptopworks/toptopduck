//! The resume deep module (ADR-0053 Decision 3, issue #66).
//!
//! [`Resumer`] owns phase 2/3/4 of `Session::open_duck`: active-pointer
//! resolution (pure logic over the working set + recipe), productive-SQL-chain
//! replay (driving the shared [`Materializer`] trait), and conversation
//! timeline rebuild (pure logic). It does NOT hold the `Session` -- phase
//! methods borrow `working_set` / [`TurnDeps`] and return structured results,
//! and `open_duck` applies them. Phase 1 (source file I/O) and phase 5
//! (persist) stay on `Session::open_duck`.
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
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use super::materializer::{Materializer, TurnDeps};
use super::{ActiveAbandoned, ActiveResolution, ResumeError, ResumeEvent};
use crate::cancel::CancelToken;
use crate::model::{
    DatasetDescriptor, DatasetPrivacy, RectifyProvenance, ThreadEntry, TraceEntryView, TurnFailure,
    TurnOutcome, TurnRecord,
};
use crate::persistence::recipe::{Recipe, RecipeEntry, RecipeOutcome, RecipeTraceEntry};
use crate::persistence::registry::{release, try_acquire};
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
    /// SAME defenses a live turn relies on (sandbox `LocalFileSystem` disabled,
    /// subquery wrapping rejects non-SELECT) rather than a recipe-specific SQL
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
                        // ADR-0035 honest signal: log a label-restore failure
                        // during replay instead of swallowing it silently.
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
    /// Returns the rebuilt timeline; `open_duck` assigns it to `session.history`.
    /// The rebuild is a 1:1 map over `recipe.history[..end]` (never filtered),
    /// so the returned length IS `end` -- `open_duck` relies on this to index-
    /// align the per-turn audit substructures against the same slice (ADR-0078,
    /// issue #319). Registers stale placeholders into `working_set` as a
    /// pre-pass (ADR-0041 dead turns stay visible but carry no backing data).
    pub(crate) fn rebuild_timeline(
        &self,
        working_set: &mut WorkingSet,
        break_at: Option<&ReplayBreak>,
    ) -> Result<Vec<ThreadEntry>, ResumeError> {
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
                    Ok(ThreadEntry::Turn(TurnRecord {
                        question: turn.question.clone(),
                        outcome,
                        // ADR-0078 (issue #297): the display trace round-trips
                        // from the recipe's persisted entries -- the same
                        // bounded shape the live turn emitted, so a resumed
                        // session expands identical trace rows. Empty for
                        // v1-era migrated turns (their RecipeTurn carries no
                        // trace; the v2+ synthetic single-call trace does).
                        trace: turn.trace.iter().map(TraceEntryView::from).collect(),
                    }))
                }
                RecipeEntry::Source(ev) => Ok(ThreadEntry::Source(ev.clone())),
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
    use crate::model::{StaleAnchor, StaleReason};
    use crate::persistence::recipe::{
        RecipeEntry, RecipeOutcome, RecipePromotion, RecipeTurn, SourceRef,
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
        RecipeEntry::Turn(RecipeTurn::new(
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
        RecipeEntry::Turn(RecipeTurn::new(
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
        sources: &'a HashMap<String, std::path::PathBuf>,
    ) -> TurnDeps<'a> {
        TurnDeps {
            conn,
            source_files: sources,
            working_set: ws,
            result_row_cap: 1_000,
            result_count_cap: 100,
            temp_path: Path::new("."),
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
        let sources = HashMap::new();
        let mut deps = inert_deps(&conn, &mut ws, &sources);
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
        let sources = HashMap::new();
        let mut deps = inert_deps(&conn, &mut ws, &sources);
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
        let sources = HashMap::new();
        let mut deps = inert_deps(&conn, &mut ws, &sources);
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
            let ThreadEntry::Turn(t) = entry else {
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
        let ThreadEntry::Turn(t1) = &timeline[0] else {
            panic!("expected Turn, got {:?}", timeline[0])
        };
        assert!(
            matches!(t1.outcome, TurnOutcome::Materialized { .. }),
            "result_1 should still be Materialized: {:?}",
            t1.outcome
        );
        let ThreadEntry::Turn(t2) = &timeline[1] else {
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
