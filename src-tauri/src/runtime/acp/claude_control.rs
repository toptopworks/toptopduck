//! The claude-code stream-json control-plane diagnostic query (ADR-0097
//! Decision 5, issue #561).
//!
//! The ClaudeStreamJson half of the probe: spawn claude-code on the turn
//! argv extended with `--input-format stream-json` (the adapter's
//! `probe_argv`), send ONE `control_request{initialize}` frame on stdin,
//! and fold the success `control_response`'s `models[]` into a
//! [`ModelCatalogOutcome`]. This is the ONLY catalog channel claude-code
//! exposes (`claude model list` is not a subcommand -- a bare invocation
//! treats it as a prompt; the turn-path `system{init}` data frame carries
//! only the current model). The response is provider-aware (a third-party
//! endpoint environment reports the provider-resolved model set, measured
//! on 2.1.222) and costs no API call.
//!
//! The control wire is claude-code's PRIVATE vocabulary, not a reusable
//! stream-format surface (the issue #544 precedent): `control_request` /
//! `control_response` frames keyed by `request_id` (NOT JSON-RPC `id`),
//! mixed freely with `system` hook frames on the same stdout -- the query
//! sniffs for its own response and drops everything else.
//!
//! Degrade footing (ADR-0097 Decision 5 "无响应降级空目录"): a success
//! response yields `Available` with the extracted models (possibly none);
//! an ERROR control response degrades to `Unavailable` (the process being
//! alive is diagnostic signal, the ADR-0096 D2 precedent); a child that
//! never answers -- silence, garbage, or stdout EOF -- degrades to an
//! EMPTY catalog (`Available` with no models), never a failure. Only a
//! write fault, the deadline, or a response envelope that fails to parse
//! fail outright.

use std::process::{ChildStdin, ChildStdout};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::runtime::acp::probe::{
    attach_stderr_tail, with_stderr_tail, CatalogModel, ModelCatalogOutcome, ProbeError, StderrTail,
};

/// The probe's request id: the response must echo it. A fixed literal is
/// fine -- one query, one child, one lifetime.
const INITIALIZE_REQUEST_ID: &str = "probe-initialize";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// The initialize control frame. claude-code's control plane keys frames by
/// `request_id` (NOT JSON-RPC `id`); the request payload is the bare
/// `{"subtype": "initialize"}`.
#[derive(serde::Serialize)]
struct InitializeControlRequest {
    #[serde(rename = "type")]
    frame_type: &'static str,
    request_id: &'static str,
    request: InitializeRequestPayload,
}

#[derive(serde::Serialize)]
struct InitializeRequestPayload {
    subtype: &'static str,
}

/// One model entry on the initialize response wire (measured on 2.1.222).
/// Everything but `value` is optional data -- a third-party provider's
/// response may carry a subset; the extraction degrades per field, per
/// entry, never failing the query.
struct InitializeModel {
    id: String,
    display_name: String,
    is_default: bool,
    default_reasoning_effort: String,
    supported_reasoning_efforts: Vec<String>,
}

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

/// The deadline-bounded blocking `initialize` catalog query on an
/// already-spawned child's stdio (the claude-code counterpart of
/// [`super::app_server::query_catalog`]). Sends the control frame, sniffs
/// the matching success `control_response` past any mixed hook frames, and
/// folds `models[]`. Process management stays with the caller, who must
/// [`super::probe::ChildHandle::kill_and_wait`] on every exit path.
pub fn query_catalog(
    stdin: ChildStdin,
    stdout: ChildStdout,
    stderr_tail: StderrTail,
    timeout: Duration,
) -> Result<ModelCatalogOutcome, ProbeError> {
    let mut io = super::ndjson::NdjsonIo::new(stdin, stdout);
    let deadline = Instant::now() + timeout;

    let req = InitializeControlRequest {
        frame_type: "control_request",
        request_id: INITIALIZE_REQUEST_ID,
        request: InitializeRequestPayload {
            subtype: "initialize",
        },
    };
    if let Err(e) = io.write_json(&req) {
        return Err(attach_stderr_tail(
            ProbeError::HandshakeFailure(format!("write: {e}")),
            &stderr_tail,
        ));
    }

    // Sniff for the matching control_response. claude-code mixes `system`
    // hook frames with control frames on the same stdout (measured), so
    // unrelated / unparseable lines drop silently; EOF degrades to the
    // empty catalog (the no-response shape, ADR-0097 Decision 5), the
    // deadline to a structured Timeout.
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ProbeError::Timeout);
        }
        match io.recv_timeout(remaining) {
            Ok(line) => {
                if let Some(outcome) = match_control_response(&line, &stderr_tail) {
                    return outcome;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                // No response before stdout EOF: the honest empty catalog.
                return Ok(ModelCatalogOutcome::Available { models: Vec::new() });
            }
        }
    }
}

/// One incoming line against the awaited control response:
/// `Some(Ok(outcome))` when the line IS the probe's control_response (a
/// success folds the catalog, an error / foreign subtype degrades to
/// `Unavailable`), `Some(Err(_))` when the envelope matched but failed to
/// parse (a hard failure, the app_server malformed-response precedent),
/// `None` for a stray to keep sniffing past.
fn match_control_response(
    line: &str,
    stderr_tail: &StderrTail,
) -> Option<Result<ModelCatalogOutcome, ProbeError>> {
    let v: Value = serde_json::from_str(line).ok()?;
    if v.get("type").and_then(Value::as_str) != Some("control_response") {
        return None;
    }
    if v.get("request_id").and_then(Value::as_str) != Some(INITIALIZE_REQUEST_ID) {
        return None;
    }
    let payload = v.get("response").cloned().unwrap_or(Value::Null);
    let subtype = payload
        .get("subtype")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Some(match subtype.as_str() {
        "success" => Ok(ModelCatalogOutcome::Available {
            models: extract_models(payload.get("response").unwrap_or(&Value::Null)),
        }),
        "error" => {
            let message = payload
                .get("message")
                .and_then(Value::as_str)
                .filter(|m| !m.is_empty())
                .unwrap_or("initialize error");
            Ok(degraded(message.to_string(), stderr_tail))
        }
        other => Ok(degraded(
            format!("unexpected control_response subtype `{other}`"),
            stderr_tail,
        )),
    })
}

/// Fold the initialize response payload's `models[]` into the catalog,
/// preserving the CLI's declared order and skipping entries without a
/// usable `value` (per-entry tolerance: one drifted entry never discards
/// the rest).
fn extract_models(payload: &Value) -> Vec<CatalogModel> {
    let Some(entries) = payload.get("models").and_then(Value::as_array) else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(model_from_initialize)
        .map(|m| CatalogModel {
            id: m.id,
            display_name: m.display_name,
            is_default: m.is_default,
            default_reasoning_effort: m.default_reasoning_effort,
            supported_reasoning_efforts: m.supported_reasoning_efforts,
        })
        .collect()
}

/// Project one initialize `models[]` entry onto the catalog shape. The
/// alias `value` is the `--model` injection key and the only REQUIRED
/// field; `displayName` is the display pick with `resolvedModel` (the
/// provider-resolved name) as the fallback; `supportedEffortLevels`
/// tolerates both bare strings and `{value}`-shaped objects; `isDefault` /
/// `defaultEffort` are optional markers (an absent default marker leaves
/// the selector's "CLI default" row unannotated -- honest, never guessed).
fn model_from_initialize(entry: &Value) -> Option<InitializeModel> {
    // `value` is the `--model` injection key: an entry without a usable
    // (non-empty) alias contributes nothing.
    let id = string_field(entry, "value")?;
    let display_name = string_field(entry, "displayName")
        .or_else(|| string_field(entry, "resolvedModel"))
        .unwrap_or_else(|| id.clone());
    let is_default = entry
        .get("isDefault")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let default_reasoning_effort = string_field(entry, "defaultEffort").unwrap_or_default();
    let supported_reasoning_efforts = entry
        .get("supportedEffortLevels")
        .and_then(Value::as_array)
        .map(|levels| {
            levels
                .iter()
                .filter_map(|level| {
                    level
                        .as_str()
                        .map(str::to_string)
                        .or_else(|| string_field(level, "value"))
                })
                .collect()
        })
        .unwrap_or_default();
    Some(InitializeModel {
        id,
        display_name,
        is_default,
        default_reasoning_effort,
        supported_reasoning_efforts,
    })
}

/// A non-empty string field, if present.
fn string_field(entry: &Value, key: &str) -> Option<String> {
    entry
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Build the degraded `Unavailable` outcome, appending the stderr tail to
/// its detail when non-empty (the same `; stderr tail: ` shape the failure
/// path attaches -- the detail is the only diagnostic surface a degraded
/// outcome has, issue #543 precedent).
fn degraded(detail: String, stderr_tail: &StderrTail) -> ModelCatalogOutcome {
    ModelCatalogOutcome::Unavailable {
        detail: with_stderr_tail(detail, stderr_tail),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The full happy-path wire shape, frozen against the 2.1.222
    /// measurement (third-party endpoint): `value` / `resolvedModel` /
    /// `displayName` / `description` / `supportedEffortLevels` plus the
    /// `supportsEffort` / `supportsAdaptiveThinking` / `supportsAutoMode`
    /// capability bits the extraction ignores (no consumer, ADR-0097 D5
    /// catalog shape reuse). The optional `isDefault` / `defaultEffort`
    /// markers were absent in the measured response (the `default` alias
    /// entry is the CLI's own default pointer) but are tolerated when a
    /// provider sends them.
    #[test]
    fn extract_models_maps_the_measured_wire_shape() {
        let payload = json!({
            "models": [
                {
                    "value": "claude-sonnet-4",
                    "resolvedModel": "claude-sonnet-4-20250514",
                    "displayName": "Claude Sonnet 4",
                    "isDefault": true,
                    "defaultEffort": "medium",
                    "supportedEffortLevels": ["low", "medium", "high"],
                    "description": "Recommended model",
                    "supportsEffort": true,
                    "supportsAdaptiveThinking": true,
                    "supportsAutoMode": true
                },
                {
                    "value": "claude-opus-4",
                    "supportedEffortLevels": ["high"]
                }
            ]
        });
        let models = extract_models(&payload);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "claude-sonnet-4");
        assert_eq!(models[0].display_name, "Claude Sonnet 4");
        assert!(models[0].is_default);
        assert_eq!(models[0].default_reasoning_effort, "medium");
        assert_eq!(
            models[0].supported_reasoning_efforts,
            vec!["low", "medium", "high"],
            "the declared effort order is preserved (ADR-0096 D3 precedent)"
        );
        assert_eq!(models[1].id, "claude-opus-4");
        // No displayName: the resolved model name is the display fallback.
        assert_eq!(models[1].display_name, "claude-opus-4");
        assert!(!models[1].is_default);
        assert!(
            models[1].default_reasoning_effort.is_empty(),
            "an absent defaultEffort leaves the marker empty, never guessed"
        );
        assert_eq!(models[1].supported_reasoning_efforts, vec!["high"]);
    }

    /// Entries without a usable `value` skip; `{value}`-shaped effort
    /// objects tolerate; a missing `models` key yields the empty catalog.
    #[test]
    fn extract_models_is_tolerant_per_entry_and_per_field() {
        let payload = json!({
            "models": [
                { "resolvedModel": "no-alias" },
                {
                    "value": "glm-5.3[1m]",
                    "supportedEffortLevels": [
                        {"value": "low"},
                        "high",
                        42
                    ]
                },
                { "value": "" }
            ]
        });
        let models = extract_models(&payload);
        assert_eq!(models.len(), 1, "only the usable entry survives");
        assert_eq!(models[0].id, "glm-5.3[1m]");
        assert_eq!(models[0].supported_reasoning_efforts, vec!["low", "high"]);
        assert!(extract_models(&json!({})).is_empty());
        assert!(extract_models(&json!({"models": "not-an-array"})).is_empty());
    }

    /// The sniff matches ONLY a `control_response` echoing the probe's
    /// request id; success folds the catalog from `response.response`.
    #[test]
    fn match_control_response_sniffs_past_strays() {
        let tail = silent_tail();
        // Stray frames: hook noise, another request's response.
        assert!(match_control_response(
            &json!({"type": "system", "subtype": "hook"}).to_string(),
            &tail
        )
        .is_none());
        assert!(match_control_response(
            &json!({"type": "control_response", "request_id": "other",
                    "response": {"subtype": "success"}})
            .to_string(),
            &tail
        )
        .is_none());
        assert!(match_control_response("not json at all", &tail).is_none());
        // The real response.
        let line = json!({
            "type": "control_response",
            "request_id": INITIALIZE_REQUEST_ID,
            "response": {
                "subtype": "success",
                "response": { "models": [{ "value": "m1" }] }
            }
        })
        .to_string();
        let outcome = match_control_response(&line, &tail)
            .expect("the matching response resolves")
            .expect("success folds the catalog");
        match outcome {
            ModelCatalogOutcome::Available { models } => {
                assert_eq!(models.len(), 1);
                assert_eq!(models[0].id, "m1");
            }
            other => panic!("expected Available, got {other:?}"),
        }
    }

    /// An error control response degrades to `Unavailable` carrying the
    /// message; a foreign subtype degrades with its name.
    #[test]
    fn match_control_response_degrades_error_subtypes() {
        let tail = silent_tail();
        let line = json!({
            "type": "control_response",
            "request_id": INITIALIZE_REQUEST_ID,
            "response": { "subtype": "error", "message": "auth required" }
        })
        .to_string();
        let outcome = match_control_response(&line, &tail).unwrap().unwrap();
        match outcome {
            ModelCatalogOutcome::Unavailable { detail } => {
                assert!(detail.contains("auth required"), "{detail}")
            }
            other => panic!("expected Unavailable, got {other:?}"),
        }
        let line = json!({
            "type": "control_response",
            "request_id": INITIALIZE_REQUEST_ID,
            "response": { "subtype": "from-the-future" }
        })
        .to_string();
        let outcome = match_control_response(&line, &tail).unwrap().unwrap();
        match outcome {
            ModelCatalogOutcome::Unavailable { detail } => {
                assert!(detail.contains("from-the-future"), "{detail}")
            }
            other => panic!("expected Unavailable, got {other:?}"),
        }
    }

    /// A success response without a `models` key yields the honest empty
    /// catalog (still `Available` -- the CLI answered, it offered nothing).
    #[test]
    fn match_control_response_success_without_models_is_empty_available() {
        let tail = silent_tail();
        let line = json!({
            "type": "control_response",
            "request_id": INITIALIZE_REQUEST_ID,
            "response": { "subtype": "success", "response": {} }
        })
        .to_string();
        let outcome = match_control_response(&line, &tail).unwrap().unwrap();
        match outcome {
            ModelCatalogOutcome::Available { models } => assert!(models.is_empty()),
            other => panic!("expected Available, got {other:?}"),
        }
    }

    /// A StderrTail over a silent, immediately-EOF'ing stderr: the reader
    /// thread drains nothing and exits, snapshotting the empty string (the
    /// no-tail-marker assertions' baseline, issue #542 precedent).
    fn silent_tail() -> StderrTail {
        let mut child = std::process::Command::new(env!("CARGO"))
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn cargo --version");
        let stderr = child.stderr.take().expect("piped stderr");
        let tail = StderrTail::spawn(stderr);
        // Reap the child (it exits right away); the stderr pipe's EOF lets
        // the reader thread finish draining, so the wait cannot deadlock.
        let _ = child.wait();
        tail
    }
}
