//! Output-cap truncation surfacing (issues #1003/#1044): the length
//! signal's two presentations on both driver faces -- the main loop's and
//! a delegated sub-agent's. Both trace back to the #1001 cap formula,
//! but only the re-attribution keys on the stamp's presence; the marker
//! rides any `FinishReason::Length` stop, stamped or not.
//!
//! The signal lives in rig's stream-terminal `finish_reason`. The
//! run-level `FinalResponse` the driver's fold consumes carries no
//! top-level reason (each call's reason does ride the stream as the
//! per-call usage record, so reading it off the stream items would be
//! fidelity-equivalent); the hook seam is the chosen observation point --
//! the registration seam the cancel watcher already rides, no changes to
//! the fold's consumption loop, and the assembled turn's normalized
//! `FinishReason` handed over directly. [`FinishReasonWatcher`]
//! records the last turn's reason off that seam; [`terminal_reply`] turns a
//! Length-stopped final answer from a silent `Termination::Text` into one
//! carrying an explicit truncation marker (the partial answer stays
//! visible).
//!
//! A tool-call turn truncated mid-arguments never reaches the hook: rig's
//! tool-input accumulator surfaces the pending parse error at the stream
//! terminal, pre-empting the completion event that carried the reason --
//! on the rig 0.42 public surface the Length bit for that shape is gone.
//! [`reattribute_tool_input_truncation`] closes that shape at the
//! termination mapping instead: the accumulator's EOF-family parse detail
//! (the input ended mid-parse -- truncation-shaped, distinct from a
//! model's own malformed JSON) on a cap-stamped run is re-attributed as an
//! output-truncation failure. Genuine upstream error text keeps its
//! verbatim passthrough (#669): only the EOF family inside the
//! accumulator's own tool-input wording is rewritten, and only on runs
//! whose request carried the #1001 cap stamp. The rewrite is hedged
//! (#1045): the stamp says the request carried a cap, not that THIS stop
//! was caused by one -- a live model halting its own output mid-JSON
//! matches the same predicate -- so the prefix claims the high-probability
//! reading while the verbatim detail after it keeps the evidence (the
//! marker needs no hedge: `FinishReason::Length` is the endpoint's own
//! assertion). The match gates on the error variant before any string is
//! scanned (#1045): in production the wording originates only in the two
//! string-carrying variants, and the gate additionally refuses to scan
//! any other variant's Display, however closely the embedded text
//! matches.

use std::sync::{Arc, Mutex};

use rig_agent::agent::{AgentHook, HookContext, ModelTurnAction, ModelTurnFinished};
use rig_core::completion::{CompletionError, FinishReason};

use crate::session::loop_contract::{truncate_trace_excerpt, Termination};

/// Marker appended to a terminal reply whose turn stopped at the output
/// cap (issue #1003).
pub(crate) const TRUNCATED_REPLY_MARKER: &str = "\n\n[output truncated at the token cap]";

/// The re-attribution's prefix (issues #1003/#1045): hedged, unlike the
/// marker -- the marker rides the endpoint's own `FinishReason::Length`
/// assertion, while the re-attribution infers the cap from a parse shape
/// plus the request's stamp, and a live model halting its own output
/// mid-JSON matches the same predicate. The high-probability wording
/// states the honest claim; the verbatim detail after it keeps the
/// evidence.
pub(crate) const LIKELY_TRUNCATION_PREFIX: &str = "output likely truncated at the token cap: ";

/// The per-turn finish-reason observer: records the last turn's
/// `finish_reason` off the hook seam so the driver can read it once the
/// stream ends. Last-wins is the terminal-turn semantics the reply mapping
/// needs: the final model turn is the one whose reason the reply carries.
/// Constructed as a pair with [`FinishReasonRecord`] -- the watcher moves
/// into the agent's hook stack, the record stays with the driver.
pub(crate) struct FinishReasonWatcher {
    last: Arc<Mutex<Option<FinishReason>>>,
}

/// The driver's reader half: the last recorded reason, read once after
/// the stream ends. The lock discipline stays inside the pair.
pub(crate) struct FinishReasonRecord {
    last: Arc<Mutex<Option<FinishReason>>>,
}

impl FinishReasonWatcher {
    pub(crate) fn new() -> (Self, FinishReasonRecord) {
        let last = Arc::new(Mutex::new(None));
        (
            Self {
                last: Arc::clone(&last),
            },
            FinishReasonRecord { last },
        )
    }

    /// Record one turn's reason (the hook body's whole job).
    fn record(&self, reason: Option<&FinishReason>) {
        *self.last.lock().expect("finish-reason lock poisoned") = reason.cloned();
    }
}

impl FinishReasonRecord {
    /// The last turn's reason: `None` before the first turn completes,
    /// and `None` again when the last completed turn reported no reason
    /// (the honest last-turn semantics -- an earlier reason is not kept).
    pub(crate) fn last(&self) -> Option<FinishReason> {
        self.last
            .lock()
            .expect("finish-reason lock poisoned")
            .clone()
    }
}

impl AgentHook for FinishReasonWatcher {
    fn on_model_turn_finished(
        &self,
        _ctx: &HookContext,
        event: ModelTurnFinished<'_>,
    ) -> impl std::future::Future<Output = ModelTurnAction> + Send {
        self.record(event.finish_reason);
        std::future::ready(ModelTurnAction::Continue)
    }
}

/// The output-cap predicate every face of the signal keys on (issues
/// #1003/#1047): a stream terminal that stopped at `FinishReason::Length`
/// -- the endpoint's own assertion that the output was cut. ContentFilter
/// also reads as truncated output on rig's own predicate; the signal
/// states the cap's fact, so it stays Length-only.
pub(crate) fn is_output_capped(finish_reason: Option<&FinishReason>) -> bool {
    matches!(finish_reason, Some(FinishReason::Length))
}

/// The reply body shared by the two reply mappings -- the main turn's
/// terminal reply and a sub-agent's final report (issue #1044): a turn
/// that stopped at the output cap ([`is_output_capped`]) gets the
/// truncation marker appended -- the answer was cut, not finished --
/// while every other reason (or none) keeps the verbatim text.
pub(crate) fn marked_reply(text: String, finish_reason: Option<&FinishReason>) -> String {
    if is_output_capped(finish_reason) {
        format!("{text}{TRUNCATED_REPLY_MARKER}")
    } else {
        text
    }
}

/// The terminal reply's termination, over [`marked_reply`].
pub(crate) fn terminal_reply(text: String, finish_reason: Option<&FinishReason>) -> Termination {
    Termination::Text(marked_reply(text, finish_reason))
}

/// The delegation report's trace excerpt (issue #1047): the marker rides
/// the reply's tail, so the head-preserving excerpt cut drops it exactly
/// when the report ran long -- the over-cap shape whose signal the trace
/// surfaces must keep. Reserve tail room for the marker before the cut so
/// the bounded excerpt still ends with it; an unmarked report truncates
/// through the plain excerpt path, unchanged. Markedness at this stage
/// keys on the marker suffix in the text itself -- the entry's flag keys
/// the projections' half.
pub(crate) fn marked_reply_excerpt(report: &str, max: usize) -> String {
    debug_assert!(
        max > TRUNCATED_REPLY_MARKER.chars().count(),
        "the excerpt cap must exceed the marker or the bounded result cannot carry it"
    );
    match report.strip_suffix(TRUNCATED_REPLY_MARKER) {
        Some(body) => format!(
            "{}{TRUNCATED_REPLY_MARKER}",
            truncate_trace_excerpt(
                body,
                max.saturating_sub(TRUNCATED_REPLY_MARKER.chars().count()),
            )
        ),
        None => truncate_trace_excerpt(report, max),
    }
}

/// Re-attribute the tool-input parse-error family as an output truncation
/// (issue #1003, narrowed per #1045): the EOF-family detail is
/// truncation-shaped (the input ended mid-parse), and on a run whose
/// request carried the cap stamp the honest attribution is the cap, not a
/// JSON fault. The variant gate leads the string match: in production
/// the accumulator's wording originates only in the two string-carrying
/// variants -- `ResponseError` (rig's accumulator on the live face,
/// Display-prefixed by the `to_string` fallback) and `ProviderError`
/// (the bridged face's verbatim relay) -- and the gate additionally
/// refuses to scan any other variant's Display, however closely the
/// embedded detail matches. Every other
/// termination -- other details, other variants -- passes through
/// untouched, preserving the #669 verbatim contract for genuine upstream
/// errors.
pub(crate) fn reattribute_tool_input_truncation(
    err: &CompletionError,
    cap_stamped: bool,
) -> Termination {
    let termination = super::termination_for_completion(err);
    match (termination, err) {
        (
            Termination::Transient(detail),
            CompletionError::ResponseError(_) | CompletionError::ProviderError(_),
        ) if cap_stamped && is_truncated_tool_input(&detail) => {
            Termination::Transient(format!("{LIKELY_TRUNCATION_PREFIX}{detail}"))
        }
        (termination, _) => termination,
    }
}

/// rig's tool-input accumulator wording for a wire-promised block whose
/// JSON never completed, narrowed to the EOF family: the input ended
/// mid-parse (truncation-shaped). A model's own malformed JSON surfaces in
/// the same wording with a different parser fault and stays verbatim.
fn is_truncated_tool_input(detail: &str) -> bool {
    detail.contains("arrived with malformed JSON input") && detail.contains("EOF while parsing")
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::session::loop_contract::TRACE_EXCERPT_MAX;

    /// The accumulator's bare wording, the `ResponseError` payload on the
    /// live face.
    const ACCUMULATOR_DETAIL: &str = "tool call `python` arrived with malformed JSON input: EOF while parsing a string at line 1 column 5232";

    /// The #1001 incident's detail exactly as the live face feeds the
    /// matcher: the accumulator wording Display-composed with its
    /// variant's "ResponseError: " prefix by the `to_string` fallback in
    /// `termination_for_completion` -- the fixture the module hangs off.
    /// The bridged face relays this same composed string verbatim through
    /// `ProviderError` (the wiring pins' injection route).
    const INCIDENT_DETAIL: &str = "ResponseError: tool call `python` arrived with malformed JSON input: EOF while parsing a string at line 1 column 5232";

    /// A boxed error whose Display is an arbitrary relayed string: the
    /// variant-gate pin's vehicle -- `RequestError` can carry any text
    /// without the text ever being the accumulator's own wording.
    #[derive(Debug)]
    struct RelayedDetail(String);

    impl std::fmt::Display for RelayedDetail {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(&self.0)
        }
    }

    impl std::error::Error for RelayedDetail {}

    #[test]
    fn length_stop_appends_the_marker_other_reasons_stay_verbatim() {
        assert_eq!(
            terminal_reply("partial answer".to_string(), Some(&FinishReason::Length)),
            Termination::Text(format!("partial answer{TRUNCATED_REPLY_MARKER}"))
        );
        assert_eq!(
            terminal_reply("done".to_string(), Some(&FinishReason::Stop)),
            Termination::Text("done".to_string())
        );
        assert_eq!(
            terminal_reply("done".to_string(), None),
            Termination::Text("done".to_string())
        );
        // ContentFilter also reads as truncated output on rig's own
        // predicate -- the marker states the cap's fact, so it stays
        // Length-only here.
        assert_eq!(
            terminal_reply("done".to_string(), Some(&FinishReason::ContentFilter)),
            Termination::Text("done".to_string())
        );
    }

    /// The over-cap shape #1047 exists for: a marked report longer than
    /// the excerpt cap keeps its tail marker through the cut -- the plain
    /// head-preserving truncator would drop the signal exactly when the
    /// report ran long -- and the bounded result stays within the cap.
    #[test]
    fn an_over_cap_marked_report_keeps_the_marker_in_its_excerpt() {
        let report = format!("{}{TRUNCATED_REPLY_MARKER}", "a".repeat(600));
        let excerpt = marked_reply_excerpt(&report, TRACE_EXCERPT_MAX);
        assert!(
            excerpt.ends_with(TRUNCATED_REPLY_MARKER),
            "the marker rides the excerpt's tail: {excerpt}"
        );
        assert!(
            excerpt.chars().count() <= TRACE_EXCERPT_MAX,
            "the bounded excerpt stays within the cap"
        );
        assert!(
            excerpt.starts_with(&"a".repeat(100)),
            "the report's head survives the cut"
        );
    }

    /// The under-cap half: a marked report that fits the cap passes
    /// through verbatim -- marker included, no re-arrangement.
    #[test]
    fn an_under_cap_marked_report_passes_through_verbatim() {
        let report = format!("short answer{TRUNCATED_REPLY_MARKER}");
        assert_eq!(marked_reply_excerpt(&report, TRACE_EXCERPT_MAX), report);
    }

    /// The unmarked path is the plain excerpt, unchanged (#1047's
    /// no-widening constraint): a report without the marker truncates
    /// exactly as `truncate_trace_excerpt` would.
    #[test]
    fn an_unmarked_report_truncates_through_the_plain_excerpt_path() {
        let plain = "b".repeat(600);
        assert_eq!(
            marked_reply_excerpt(&plain, TRACE_EXCERPT_MAX),
            truncate_trace_excerpt(&plain, TRACE_EXCERPT_MAX)
        );
    }

    /// The reserve's boundary (issue #1047): a body sized exactly to the
    /// reserved room passes through whole -- the report fits the cap with
    /// its marker and no ellipsis, so the reserve never costs a cut that
    /// was not needed.
    #[test]
    fn a_report_sized_exactly_to_the_reserved_room_passes_whole() {
        let body_len = TRACE_EXCERPT_MAX - TRUNCATED_REPLY_MARKER.chars().count();
        let report = format!("{}{TRUNCATED_REPLY_MARKER}", "c".repeat(body_len));
        let excerpt = marked_reply_excerpt(&report, TRACE_EXCERPT_MAX);
        assert_eq!(excerpt, report, "the exactly-full report is verbatim");
        assert_eq!(
            excerpt.chars().count(),
            TRACE_EXCERPT_MAX,
            "the verbatim pass lands exactly on the cap"
        );
        assert!(!excerpt.contains('…'), "no ellipsis on an uncut report");
    }

    #[test]
    fn eof_family_reattributes_only_on_a_cap_stamped_run() {
        // The live face's shape: the accumulator wording rides
        // `ResponseError`, Display-prefixed by the `to_string` fallback.
        let live = CompletionError::ResponseError(ACCUMULATOR_DETAIL.to_string());
        assert_eq!(
            reattribute_tool_input_truncation(&live, true),
            Termination::Transient(format!(
                "output likely truncated at the token cap: {INCIDENT_DETAIL}"
            ))
        );
        // No cap stamp (the bridged production face keeps `None`) -- the
        // detail passes through verbatim.
        assert_eq!(
            reattribute_tool_input_truncation(&live, false),
            Termination::Transient(INCIDENT_DETAIL.to_string())
        );
    }

    /// The bridged face's shape: the bridge relays the app's detail
    /// verbatim through `ProviderError` (no Display prefix of its own), so
    /// the same composed incident text matches there -- the wiring pins'
    /// injection route (tests.rs), pinned at the unit level here.
    #[test]
    fn the_bridged_relay_reattributes_the_same_wording() {
        let relayed = CompletionError::ProviderError(INCIDENT_DETAIL.to_string());
        assert_eq!(
            reattribute_tool_input_truncation(&relayed, true),
            Termination::Transient(format!(
                "output likely truncated at the token cap: {INCIDENT_DETAIL}"
            ))
        );
    }

    #[test]
    fn non_eof_faults_and_other_terminations_pass_through_verbatim() {
        // The same accumulator wording with a non-EOF parser fault is a
        // model's own malformed JSON, not a cap cut (#669 verbatim); the
        // Display prefix rides the same `to_string` fallback.
        let own_fault = "tool call `python` arrived with malformed JSON input: expected `,` or `}` at line 1 column 12";
        let live = CompletionError::ResponseError(own_fault.to_string());
        assert_eq!(
            reattribute_tool_input_truncation(&live, true),
            Termination::Transient(format!("ResponseError: {own_fault}"))
        );
        // Other transient details and other termination classes never rewrite.
        let transport = CompletionError::ProviderError("connection reset".to_string());
        assert_eq!(
            reattribute_tool_input_truncation(&transport, true),
            Termination::Transient("connection reset".to_string())
        );
        let not_wired = CompletionError::ProviderResponse(rig_core::ProviderResponseError::new(
            http::StatusCode::UNAUTHORIZED,
            "no LLM provider wired",
        ));
        assert_eq!(
            reattribute_tool_input_truncation(&not_wired, true),
            Termination::NotWired
        );
    }

    /// The variant gate's own pin (#1045): the incident wording relayed
    /// through a variant that cannot originate it stays verbatim however
    /// closely the text matches -- the string predicate never scans
    /// Display-merged text from unrelated variants.
    #[test]
    fn wording_relayed_through_an_unrelated_variant_stays_verbatim() {
        let relayed =
            CompletionError::RequestError(Box::new(RelayedDetail(INCIDENT_DETAIL.to_string())));
        assert_eq!(
            reattribute_tool_input_truncation(&relayed, true),
            Termination::Transient(format!("RequestError: {INCIDENT_DETAIL}"))
        );
    }

    #[test]
    fn watcher_records_the_last_turns_reason() {
        let (watcher, record) = FinishReasonWatcher::new();
        assert_eq!(record.last(), None, "no turn observed yet");

        watcher.record(Some(&FinishReason::Length));
        assert_eq!(record.last(), Some(FinishReason::Length));

        // Last-wins: the terminal turn's reason is the one that stays.
        watcher.record(Some(&FinishReason::Stop));
        assert_eq!(record.last(), Some(FinishReason::Stop));

        // A completed turn that reports no reason overwrites: the last
        // turn's None is the honest answer, not an earlier reason.
        watcher.record(None);
        assert_eq!(record.last(), None);
    }
}
