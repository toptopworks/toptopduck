//! The codex `app-server` diagnostic query (ADR-0096 D2/D3, issue #535).
//!
//! The JsonEventStream half of the probe: spawn `codex app-server` (the
//! official JSON-RPC-over-stdio process interface that drives codex's rich
//! client), send `model/list`, and fold the per-model catalog into a
//! [`CodexCatalogOutcome`]. This is a DIFFERENT wire surface from the turn
//! path's `exec --json` event stream (ADR-0094) -- the probe only reads the
//! catalog here, it never drives a turn.
//!
//! The app-server wire is JSON-RPC-shaped but deliberately NOT JSON-RPC 2.0:
//! it neither sends nor expects the `jsonrpc` field (codex's `rpc.rs`
//! documents this). A request is `{ id, method, params? }`; a response is
//! `{ id, result }` or `{ id, error: { code, message, data? } }`, one NDJSON
//! line each.
//!
//! The app-server protocol v2 has NO `initialize` handshake step -- the client
//! sends `model/list` directly once the process starts (the ADR-0096 open
//! initialize-shape question resolves to "none": the v2 protocol is
//! request-driven with no client-capabilities preamble). The probe's only
//! round-trip is the catalog query itself.
//!
//! Degraded-vs-failure (ADR-0096 D2): the process starting is itself a valid
//! diagnostic result. A `model/list` RPC error (old codex without the RPC /
//! not logged in) or an unparseable catalog degrades to
//! `CodexCatalogOutcome::Unavailable`, NOT a [`ProbeError`] -- only a spawn
//! failure, a timeout, or the process dying mid-query fail outright.

use std::io::{BufRead, BufReader, Write};
use std::process::{ChildStdin, ChildStdout};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::runtime::acp::probe::{CodexCatalogOutcome, CodexModel, ProbeError};

// ---------------------------------------------------------------------------
// Wire types (the app-server carries no `jsonrpc` field)
// ---------------------------------------------------------------------------

/// A `model/list` request (serialized without the `jsonrpc` marker).
#[derive(serde::Serialize)]
struct AppServerRequest {
    id: u64,
    method: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}

/// A response envelope. Exactly one of `result` / `error` is set; both are
/// optional so a malformed line deserializes rather than rejects (the query
/// treats a neither-set response as degraded). The `id` is matched on the raw
/// line in [`AppServerIo::request_roundtrip`] before this deserializes, so it
/// is not modeled here.
#[derive(serde::Deserialize)]
struct AppServerResponse {
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<AppServerError>,
}

/// A JSON-RPC error object. Only `message` is projected (the degraded
/// detail); `code` / `data` are ignored.
#[derive(serde::Deserialize)]
struct AppServerError {
    #[serde(default)]
    message: String,
}

/// The `model/list` result (openai/codex `ModelListResponse`): a page of
/// models + an optional pagination cursor.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelListResponse {
    data: Vec<ModelWire>,
    #[serde(default)]
    next_cursor: Option<String>,
}

/// One model on the wire. Only the fields the probe reads are modeled; the
/// schema's other fields (description / hidden / model / input modalities /
/// tiers) are ignored by serde.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelWire {
    id: String,
    display_name: String,
    #[serde(default)]
    is_default: bool,
    default_reasoning_effort: String,
    supported_reasoning_efforts: Vec<ReasoningEffortWire>,
}

/// One reasoning-effort option (`{ reasoningEffort, description }`); only the
/// value is projected (the description is display-only and dropped).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReasoningEffortWire {
    reasoning_effort: String,
}

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

/// The deadline-bounded blocking `model/list` query on an already-spawned
/// child's stdio (the app-server counterpart of
/// [`super::probe::handshake_with`]). Follows `nextCursor` until the last
/// page, folding each page into the catalog; a wedged cursor loop is bounded
/// by the wall-clock deadline (surfaces as [`ProbeError::Timeout`], never a
/// hang). Process management stays with the caller, who must
/// [`super::probe::ChildHandle::kill_and_wait`] on every exit path.
pub fn query_catalog(
    stdin: ChildStdin,
    stdout: ChildStdout,
    timeout: Duration,
) -> Result<CodexCatalogOutcome, ProbeError> {
    let mut io = AppServerIo::new(stdin, stdout);
    let deadline = Instant::now() + timeout;

    let mut models: Vec<CodexModel> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let params = cursor.as_ref().map(|c| serde_json::json!({ "cursor": c }));
        let resp = io.request_roundtrip("model/list", params, deadline)?;
        let page = match fold_page(resp) {
            Ok(page) => page,
            Err(unavailable) => return Ok(unavailable),
        };
        models.extend(page.data.into_iter().map(model_from_wire));
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    Ok(CodexCatalogOutcome::Available { models })
}

/// Fold one `model/list` response into its catalog page, degrading to
/// `Unavailable` on an RPC error / empty response / unparseable result
/// (ADR-0096 D2 -- the process is alive, the catalog just is not available).
/// The `Err` arm is the degraded SUCCESS value the caller short-circuits on,
/// never a hard failure.
fn fold_page(resp: AppServerResponse) -> Result<ModelListResponse, CodexCatalogOutcome> {
    let Some(result) = resp.result else {
        let detail = resp
            .error
            .map(|e| e.message)
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| "empty response".to_string());
        return Err(CodexCatalogOutcome::Unavailable { detail });
    };
    // A result that is not a catalog (protocol skew) degrades the same way --
    // never a false success.
    serde_json::from_value(result).map_err(|e| CodexCatalogOutcome::Unavailable {
        detail: format!("catalog parse: {e}"),
    })
}

/// Project one wire model onto the public catalog entry, preserving the
/// declared order of the reasoning efforts (ADR-0096 D3).
fn model_from_wire(m: ModelWire) -> CodexModel {
    CodexModel {
        id: m.id,
        display_name: m.display_name,
        is_default: m.is_default,
        default_reasoning_effort: m.default_reasoning_effort,
        supported_reasoning_efforts: m
            .supported_reasoning_efforts
            .into_iter()
            .map(|e| e.reasoning_effort)
            .collect(),
    }
}

// ---------------------------------------------------------------------------
// NDJSON stdio I/O
// ---------------------------------------------------------------------------

/// A line-delimited request/response channel over the app-server's stdio,
/// deadline-driven (the kernel's minimal counterpart of the ACP
/// [`super::probe::ProbeIo`]: the only abort condition is the wall clock).
struct AppServerIo {
    stdin: ChildStdin,
    rx: mpsc::Receiver<String>,
    next_id: u64,
}

impl AppServerIo {
    fn new(stdin: ChildStdin, stdout: ChildStdout) -> Self {
        let (tx, rx) = mpsc::channel::<String>();
        // The reader thread owns stdout; EOF drops tx, which the round-trip
        // treats as the process dying mid-query.
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break, // EOF
                    Ok(_) => {
                        let trimmed = line.trim_end_matches(['\n', '\r']);
                        if trimmed.is_empty() {
                            continue;
                        }
                        if tx.send(trimmed.to_string()).is_err() {
                            break; // round-trip gone
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            stdin,
            rx,
            next_id: 1,
        }
    }

    /// Send a request and pump incoming lines until its response arrives or
    /// the deadline passes. A stray notification / unrelated response is
    /// dropped (not an error) so a chatty server cannot break the query.
    fn request_roundtrip(
        &mut self,
        method: &'static str,
        params: Option<Value>,
        deadline: Instant,
    ) -> Result<AppServerResponse, ProbeError> {
        let id = self.next_id;
        self.next_id += 1;
        let req = AppServerRequest { id, method, params };
        let target = Value::from(id);
        let mut msg = serde_json::to_string(&req)
            .map_err(|e| ProbeError::HandshakeFailure(format!("serialize: {e}")))?;
        msg.push('\n');
        self.stdin
            .write_all(msg.as_bytes())
            .and_then(|_| self.stdin.flush())
            .map_err(|e| ProbeError::HandshakeFailure(format!("write: {e}")))?;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(ProbeError::Timeout);
            }
            match self.rx.recv_timeout(remaining) {
                Ok(line) => {
                    let v: Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if v.get("id") == Some(&target) && v.get("method").is_none() {
                        return serde_json::from_value(v).map_err(|e| {
                            ProbeError::HandshakeFailure(format!("response parse: {e}"))
                        });
                    }
                }
                // The next loop iteration re-derives the remaining time; a
                // partial-wait Timeout only ends the query when the deadline
                // has actually passed.
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(ProbeError::HandshakeFailure(
                        "codex app-server closed stdout".into(),
                    ))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire shape is frozen against openai/codex
    /// `ModelListResponse.json` (camelCase fields; `data` required,
    /// `nextCursor` optional). A regression here silently mis-reads the
    /// catalog.
    #[test]
    fn model_list_response_deserializes_camelcase_and_ordered_efforts() {
        let raw = serde_json::json!({
            "data": [
                {
                    "id": "gpt-5.2-codex",
                    "model": "gpt-5.2-codex",
                    "displayName": "GPT-5.2 Codex",
                    "description": "fast",
                    "hidden": false,
                    "isDefault": true,
                    "defaultReasoningEffort": "medium",
                    "supportedReasoningEfforts": [
                        { "reasoningEffort": "low", "description": "fast" },
                        { "reasoningEffort": "medium", "description": "balanced" },
                        { "reasoningEffort": "high", "description": "thorough" }
                    ]
                }
            ],
            "nextCursor": null
        });
        let page: ModelListResponse = serde_json::from_value(raw).expect("valid wire shape");
        assert_eq!(page.data.len(), 1);
        assert!(page.next_cursor.is_none());
        let model = model_from_wire(page.data.into_iter().next().unwrap());
        assert_eq!(model.id, "gpt-5.2-codex");
        assert_eq!(model.display_name, "GPT-5.2 Codex");
        assert!(model.is_default);
        assert_eq!(model.default_reasoning_effort, "medium");
        assert_eq!(
            model.supported_reasoning_efforts,
            vec!["low", "medium", "high"],
            "the declared effort order is preserved (ADR-0096 D3)"
        );
    }

    /// An absent `nextCursor` deserializes as `None` (single-page catalog).
    #[test]
    fn model_list_response_tolerates_absent_cursor() {
        let raw = serde_json::json!({ "data": [] });
        let page: ModelListResponse = serde_json::from_value(raw).expect("cursor optional");
        assert!(page.next_cursor.is_none());
    }
}
