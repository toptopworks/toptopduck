//! Token usage vocabulary (ADR-0129, issue #1270): the five-field
//! normalized shape every collection channel funnels into, the turn-level
//! aggregate (+ the built-in sub-agent subtotal table, Decision 6), and the
//! process-cumulative differentiator the external runtimes' counters feed
//! (Decision 2). Pure data + pure folds -- no channel (rig loop, ACP wire,
//! claude stream-json, codex events) knows these internals; each normalizes
//! at its own collection point (Decision 1: upstream field names never pass
//! through to the persistence layer).
//!
//! Vocabulary (ADR-0129): a *turn* is the user-facing conversation unit; a
//! *round-trip* is one provider call inside it (= one round of the execution
//! trace). Usage persists at turn level only (Decision 4); the session total
//! is derived by the consumer, never stored.

use serde::{Deserialize, Serialize};

/// Five-field normalized token usage (ADR-0129 Decision 1): total-side
/// input (ordinary + cache write + cache read) with its two breakdown
/// subsets, output, and the optional reasoning split of output.
///
/// Invariants every construction site upholds (the normalization contract):
/// - `cache_read_tokens + cache_write_tokens <= input_tokens` -- the
///   breakdowns are subsets, never addends (any summary that adds them into
///   input double-counts cache).
/// - `reasoning_tokens <= output_tokens`; `None` when the upstream does not
///   split reasoning out of output.
/// - The grand total is DERIVED ([`Self::total_tokens`]), never stored --
///   one upstream reports no such field and the other's is always the sum.
///
/// Zero-valued usage is the fail-closed sentinel: a channel that reports
/// nothing leaves the turn's usage `None`, never a zero bill
/// ([`Self::is_zero`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    /// Total input tokens = ordinary input + cache write + cache read (the
    /// total-side formula, ADR-0129 Decision 1). Also the occupancy
    /// snapshot when this is the last round-trip's usage (Decision 5).
    pub input_tokens: u64,
    /// Input tokens served from the provider cache; a breakdown subset of
    /// [`Self::input_tokens`].
    #[serde(default)]
    pub cache_read_tokens: u64,
    /// Input tokens written to the provider cache (Anthropic
    /// `cache_creation`); a breakdown subset of [`Self::input_tokens`].
    #[serde(default)]
    pub cache_write_tokens: u64,
    pub output_tokens: u64,
    /// Reasoning tokens, a breakdown subset of [`Self::output_tokens`]
    /// (Anthropic `output_tokens_details.thinking`, OpenAI
    /// `reasoning_output`). `None` when the upstream does not split it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
}

impl TokenUsage {
    /// The derived grand total: input + output (ADR-0129 Decision 1 -- no
    /// stored total field, so no upstream-vs-derived reconciliation
    /// sentinel can ever disagree).
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens.saturating_add(self.output_tokens)
    }

    /// Whether every field is zero / absent -- the upstream-reported-nothing
    /// sentinel (rig documents zero `Usage` as exactly this). Drives the
    /// turn-level fail-closed rule (ADR-0129 Decision 3): a zero report
    /// yields `None`, never a zero bill.
    pub fn is_zero(&self) -> bool {
        self.input_tokens == 0
            && self.cache_read_tokens == 0
            && self.cache_write_tokens == 0
            && self.output_tokens == 0
            && self.reasoning_tokens.is_none_or(|n| n == 0)
    }

    /// Saturating accumulate (per-field): the round-trip sum of one turn,
    /// and the evidence-turn sum of a session total. Saturating because a
    /// malicious/buggy upstream counter must never overflow-panic the turn.
    pub fn add(&mut self, other: &Self) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.cache_read_tokens = self
            .cache_read_tokens
            .saturating_add(other.cache_read_tokens);
        self.cache_write_tokens = self
            .cache_write_tokens
            .saturating_add(other.cache_write_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.reasoning_tokens = match (self.reasoning_tokens, other.reasoning_tokens) {
            (None, None) => None,
            (a, b) => {
                // A zero split folds away to "unsplit" (`None`): the
                // invariant's wording -- upstream did not split, or split
                // nothing, are indistinguishable and render identically.
                let n = a.unwrap_or(0).saturating_add(b.unwrap_or(0));
                (n > 0).then_some(n)
            }
        };
    }

    /// Per-field subtraction; `None` when any field would go negative --
    /// the caller's counter-reset signal (the resume signature the
    /// differentiator treats as a broken baseline, ADR-0129 Decision 2).
    fn checked_sub(&self, other: &Self) -> Option<Self> {
        let field = |a: u64, b: u64| a.checked_sub(b);
        Some(Self {
            input_tokens: field(self.input_tokens, other.input_tokens)?,
            cache_read_tokens: field(self.cache_read_tokens, other.cache_read_tokens)?,
            cache_write_tokens: field(self.cache_write_tokens, other.cache_write_tokens)?,
            output_tokens: field(self.output_tokens, other.output_tokens)?,
            reasoning_tokens: match (self.reasoning_tokens, other.reasoning_tokens) {
                (Some(a), Some(b)) => Some(field(a, b)?),
                (Some(a), None) => Some(a),
                (None, _) => None,
            },
        })
    }
}

/// One turn's usage aggregate (ADR-0129 Decision 6): the turn total plus,
/// for built-in runs that delegated, the per-sub-agent subtotal table.
/// External runtimes report only a process aggregate, so their turns carry
/// `subagents` empty -- attribution falls to the host turn unannotated
/// (Decision 6: never a fabricated split).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TurnUsage {
    pub total: TokenUsage,
    /// The built-in sub-agent subtotals (ADR-0129 Decision 6), in
    /// collection order. Empty for external-runtime turns and for built-in
    /// turns that never delegated.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subagents: Vec<SubagentUsage>,
}

/// One named built-in sub-agent's usage subtotal (ADR-0129 Decision 6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubagentUsage {
    /// The delegation spec's name (the same identity the approval cards
    /// and the delegation trace dialog key on, issue #933).
    pub name: String,
    pub usage: TokenUsage,
}

/// The turn's context-occupancy reading (ADR-0130): the last round-trip's
/// measured context size plus, when the reporting channel knows it, the
/// window it filled. A reference figure for the composer ring, never
/// billing evidence (ADR-0130 Decision 3) -- it never enters
/// [`TurnUsage`], and the billing channel's fail-closed posture is
/// untouched by its presence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct OccupancySnapshot {
    /// The numerator: the context size measured at the last round-trip.
    /// Built-in: protocol-split off the last round-trip's usage (Decision 2
    /// -- the two wire families' totals read oppositely, so the split
    /// happens once at the collection point). ACP: the occupancy snapshot's
    /// `used`.
    pub tokens: u64,
    /// The denominator: the context window, when one is known -- a window
    /// the channel itself reported (ACP occupancy `size`) outranks the
    /// catalog stamp the built-in / CLI collection points apply off the
    /// serving model (#1290, Decision 4 as calibrated); unknown stays
    /// `None`, the hollow ring.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
}

impl OccupancySnapshot {
    /// The built-in channel's numerator (ADR-0130 Decision 2), protocol-split
    /// off one round-trip's normalized usage: Anthropic's full-resend
    /// semantics make the last input (total-side: ordinary + both cache
    /// buckets) the measured context; the OpenAI family's server-side
    /// chaining makes its derived total the active context. `None` protocol
    /// rides the OpenAI arm (the same fallback the normalization applies).
    pub fn from_last_roundtrip(last: TokenUsage, protocol: Option<super::Protocol>) -> Self {
        let tokens = match protocol {
            Some(super::Protocol::Anthropic) => last.input_tokens,
            Some(super::Protocol::Openai) | None => last.total_tokens(),
        };
        Self {
            tokens,
            limit: None,
        }
    }
}

impl TurnUsage {
    /// Compose one built-in turn's aggregate (ADR-0129 Decision 6): the
    /// sub-agents' usage folds INTO the total (a subtotal is a split OF
    /// the total -- the turn card's footer and the session header's sum
    /// must carry the delegation spend, not silently drop it), and rides
    /// the table alongside it.
    pub fn compose(main: TokenUsage, subagents: Vec<SubagentUsage>) -> Self {
        let mut total = main;
        for sub in &subagents {
            total.add(&sub.usage);
        }
        Self { total, subagents }
    }
}

/// The process-cumulative differentiator (ADR-0129 Decision 2): external
/// runtimes report usage as monotone process-level counters, and a turn's
/// usage is the counter's growth across the turn. The baseline starts at
/// zero (every external engine here spawns a fresh process per turn), each
/// feed latches the new counter value, and a NEGATIVE delta in any field is
/// the resume signature -- a new process reset the counter -- which
/// re-latches the baseline and fails the turn closed (Decision 3: a turn
/// whose evidence chain broke lands NO usage, not a partial bill).
#[derive(Debug, Default)]
pub struct CumulativeUsageDelta {
    /// The last latched cumulative counter (zero before the first feed --
    /// a fresh process's counter starts at zero, so the first reading
    /// counts in full).
    baseline: TokenUsage,
    /// A negative delta landed (the baseline failed). Latched for the rest
    /// of the turn: [`Self::settle`] reports `None` even if later deltas
    /// are positive again.
    broken: bool,
    accumulated: TokenUsage,
}

impl CumulativeUsageDelta {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one cumulative counter reading. A positive delta accumulates;
    /// a negative delta in ANY field re-latches the baseline and breaks the
    /// turn (ADR-0129 Decision 2's resume signature).
    pub fn feed(&mut self, cumulative: &TokenUsage) {
        match cumulative.checked_sub(&self.baseline) {
            Some(delta) => self.accumulated.add(&delta),
            None => {
                // A negative field: the counter reset under us (a resumed
                // process). Re-latch so subsequent feeds difference
                // correctly again, and fail the turn closed -- a partial
                // bill would read as the complete one (ADR-0129 Decision 3).
                self.broken = true;
            }
        }
        self.baseline = *cumulative;
    }

    /// The turn's usage: the accumulated growth, or `None` when the chain
    /// broke or nothing was ever reported (fail-closed, ADR-0129 Decision 3).
    pub fn settle(&self) -> Option<TokenUsage> {
        if self.broken || self.accumulated.is_zero() {
            None
        } else {
            Some(self.accumulated)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(input: u64, output: u64) -> TokenUsage {
        TokenUsage {
            input_tokens: input,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            output_tokens: output,
            reasoning_tokens: None,
        }
    }

    /// ADR-0129 Decision 1: the total is derived, never stored -- and the
    /// derivation saturates instead of panicking on a hostile counter.
    #[test]
    fn total_is_derived_and_saturates() {
        let u = usage(30, 12);
        assert_eq!(u.total_tokens(), 42);
        let hostile = usage(u64::MAX, 1);
        assert_eq!(hostile.total_tokens(), u64::MAX);
    }

    /// ADR-0129 Decision 3: a zero/absent report is the fail-closed
    /// sentinel. A reasoning split of zero folds away to "unsplit"
    /// (`None`), matching the "upstream did not split" wording.
    #[test]
    fn zero_is_the_fail_closed_sentinel() {
        assert!(TokenUsage::default().is_zero());
        assert!(!usage(0, 5).is_zero());
        assert!(!usage(1, 0).is_zero());
        let mut folded = TokenUsage::default();
        folded.add(&TokenUsage {
            reasoning_tokens: Some(0),
            ..usage(0, 0)
        });
        assert_eq!(folded.reasoning_tokens, None);
    }

    /// The round-trip sum (ADR-0129 Decision 2): per-field saturating
    /// accumulation; a `None` reasoning split stays absent until a split
    /// value arrives.
    #[test]
    fn add_accumulates_per_field_and_merges_reasoning() {
        let mut sum = usage(10, 4);
        sum.add(&TokenUsage {
            input_tokens: 5,
            cache_read_tokens: 3,
            cache_write_tokens: 2,
            output_tokens: 6,
            reasoning_tokens: Some(4),
        });
        assert_eq!(sum.input_tokens, 15);
        assert_eq!(sum.cache_read_tokens, 3);
        assert_eq!(sum.cache_write_tokens, 2);
        assert_eq!(sum.output_tokens, 10);
        assert_eq!(sum.reasoning_tokens, Some(4));
        // A later unsplit round-trip keeps the split present.
        sum.add(&usage(1, 1));
        assert_eq!(sum.reasoning_tokens, Some(4));
    }

    /// The subset invariants of the normalization contract (ADR-0129
    /// Decision 1): breakdowns fold into input, reasoning into output --
    /// and the checked subtraction inverts per field.
    #[test]
    fn checked_sub_is_per_field_and_flags_any_negative() {
        let a = TokenUsage {
            input_tokens: 10,
            cache_read_tokens: 4,
            cache_write_tokens: 2,
            output_tokens: 8,
            reasoning_tokens: Some(3),
        };
        let b = TokenUsage {
            input_tokens: 4,
            cache_read_tokens: 1,
            cache_write_tokens: 1,
            output_tokens: 3,
            reasoning_tokens: Some(1),
        };
        let d = a.checked_sub(&b).expect("all fields positive");
        assert_eq!(d.input_tokens, 6);
        assert_eq!(d.reasoning_tokens, Some(2));
        // One negative field poisons the whole subtraction.
        assert!(b.checked_sub(&a).is_none());
        // A split baseline against an unsplit reading keeps the split.
        let unsplit = TokenUsage {
            reasoning_tokens: None,
            ..b
        };
        assert_eq!(a.checked_sub(&unsplit).unwrap().reasoning_tokens, Some(3));
    }

    /// ADR-0129 Decision 2: a fresh process's counter starts at zero, so
    /// the FIRST cumulative reading counts in full and later feeds
    /// difference against the last latch (a skipped intermediate sample is
    /// harmless -- the boundary difference self-heals).
    #[test]
    fn cumulative_delta_counts_the_first_reading_in_full() {
        let mut d = CumulativeUsageDelta::new();
        d.feed(&usage(500, 20));
        d.feed(&usage(800, 45)); // sample skipped in between: no matter
        d.feed(&usage(900, 60));
        let settled = d.settle().expect("a monotone chain settles");
        assert_eq!(settled.input_tokens, 900);
        assert_eq!(settled.output_tokens, 60);
    }

    /// ADR-0129 Decision 2/3: a negative delta is the resume signature --
    /// the baseline re-latches (later feeds difference correctly again)
    /// and the turn lands NO usage even if the post-reset growth is
    /// positive: a partial bill is indistinguishable from a complete one.
    #[test]
    fn cumulative_negative_delta_re_latches_and_fails_the_turn_closed() {
        let mut d = CumulativeUsageDelta::new();
        d.feed(&usage(800, 100));
        d.feed(&usage(300, 40)); // process reset under us
        assert!(d.settle().is_none(), "the turn fails closed");
        // The re-latch: subsequent feeds accumulate from the reset point.
        d.feed(&usage(350, 50));
        assert!(d.settle().is_none(), "still closed for this turn");
        // And a fresh differentiator sees only the post-reset growth.
        let mut d2 = CumulativeUsageDelta::new();
        d2.feed(&usage(350, 50));
        assert_eq!(d2.settle(), Some(usage(350, 50)));
    }

    /// ADR-0129 Decision 6: the sub-agents' usage folds INTO the total --
    /// a delegated turn's footer and the session header's sum carry the
    /// delegation spend, while the table keeps the split.
    #[test]
    fn compose_folds_subagents_into_the_total() {
        let composed = TurnUsage::compose(
            usage(100, 40),
            vec![
                SubagentUsage {
                    name: "analyst".into(),
                    usage: usage(30, 10),
                },
                SubagentUsage {
                    name: "analyst".into(),
                    usage: usage(5, 2),
                },
            ],
        );
        assert_eq!(composed.total.input_tokens, 135);
        assert_eq!(composed.total.output_tokens, 52);
        assert_eq!(composed.subagents.len(), 2);
    }

    /// The normalization contract's subset invariants (ADR-0129 Decision 1):
    /// the cache breakdowns sit inside the total-side input and the
    /// reasoning split inside output -- held by construction on both wire
    /// families' arms, pinned here so a future arm cannot silently break
    /// them.
    #[test]
    fn subset_invariants_hold_for_the_accumulated_shape() {
        let mut u = TokenUsage {
            input_tokens: 10,
            cache_read_tokens: 4,
            cache_write_tokens: 3,
            output_tokens: 8,
            reasoning_tokens: Some(5),
        };
        let copy = u; // TokenUsage is Copy -- self-accumulate without the borrow clash
        u.add(&copy); // any accumulation of an invariant-holder holds it too
        assert!(
            u.cache_read_tokens + u.cache_write_tokens <= u.input_tokens,
            "breakdowns stay subsets of the total-side input"
        );
        assert!(u.reasoning_tokens.unwrap_or(0) <= u.output_tokens);
    }

    /// A turn that never saw a counter (or only ever saw zero) settles
    /// `None` -- the fail-closed rule for an unreporting channel
    /// (ADR-0129 Decision 3).
    #[test]
    fn cumulative_with_no_reports_settles_none() {
        let d = CumulativeUsageDelta::new();
        assert!(d.settle().is_none());
        let mut d = CumulativeUsageDelta::new();
        d.feed(&usage(0, 0));
        assert!(d.settle().is_none());
    }

    /// ADR-0130 Decision 2: the built-in occupancy numerator is
    /// protocol-split off the last round-trip's normalized usage -- the two
    /// wire families' totals read oppositely, so the split is the one place
    /// it happens. Anthropic: the total-side input (the breakdowns are
    /// subsets, never re-added). OpenAI (+ the None fallback): the derived
    /// total.
    #[test]
    fn occupancy_numerator_splits_on_protocol() {
        let last = usage(150, 50);
        assert_eq!(
            OccupancySnapshot::from_last_roundtrip(last, Some(crate::model::Protocol::Anthropic))
                .tokens,
            150,
            "Anthropic: the total-side input as-is -- breakdowns never re-added"
        );
        assert_eq!(
            OccupancySnapshot::from_last_roundtrip(last, Some(crate::model::Protocol::Openai))
                .tokens,
            200,
            "OpenAI: input + output (the active context under chaining)"
        );
        assert_eq!(
            OccupancySnapshot::from_last_roundtrip(last, None).tokens,
            200,
            "None protocol rides the OpenAI arm (the normalization fallback)"
        );
        // The built-in snapshot never carries a window (Decision 4: the
        // denominator is a config matter, never guessed).
        assert_eq!(
            OccupancySnapshot::from_last_roundtrip(last, Some(crate::model::Protocol::Anthropic))
                .limit,
            None
        );
    }
}
