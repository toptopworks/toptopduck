//! The codex `app-server` diagnostic query (ADR-0096 D2/D3, issue #535).
//!
//! The JsonEventStream half of the probe: spawn `codex app-server` (the
//! official JSON-RPC-over-stdio process interface that drives codex's rich
//! client), send `model/list`, and fold the per-model catalog into a
//! [`ModelCatalogOutcome`]. This is a DIFFERENT wire surface from the turn
//! path's `exec --json` event stream (ADR-0094) -- the probe only reads the
//! catalog here, it never drives a turn.
//!
//! The app-server wire is codex's PRIVATE protocol, not a reusable
//! JsonEventStream surface: a second JsonEventStream adapter must bring its
//! own wire module, never extend this one (issue #544).
//!
//! The app-server wire is JSON-RPC-shaped but deliberately NOT JSON-RPC 2.0:
//! it neither sends nor expects the `jsonrpc` field (codex's `rpc.rs`
//! documents this). A request is `{ id, method, params }`; a response is
//! `{ id, result }` or `{ id, error: { code, message, data? } }`, one NDJSON
//! line each.
//!
//! Two request rules, measured against codex-cli 0.147.0: the server serves
//! nothing before an `initialize` handshake (a bare `model/list` is refused
//! with `Not initialized`), and it rejects any request whose `params` field
//! is absent ("Invalid request: missing field `params`"). The probe's
//! round-trips are the handshake + the catalog query itself.
//!
//! Degraded-vs-failure (ADR-0096 D2): the process starting is itself a valid
//! diagnostic result. A `model/list` RPC error (old codex without the RPC /
//! not logged in) or an unparseable catalog degrades to
//! `ModelCatalogOutcome::Unavailable`, NOT a [`ProbeError`] -- only a spawn
//! failure, a timeout, the process dying mid-query, or a response envelope
//! that fails to parse fail outright.

use std::process::{ChildStdin, ChildStdout};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::runtime::acp::probe::{
    attach_stderr_tail, CatalogModel, ModelCatalogOutcome, ProbeError, StderrTail,
};

// ---------------------------------------------------------------------------
// Wire types (the app-server carries no `jsonrpc` field)
// ---------------------------------------------------------------------------

/// A request envelope (serialized without the `jsonrpc` marker). `params` is
/// REQUIRED on every request (the server rejects its absence -- an empty
/// object is the no-argument shape, never a missing field).
#[derive(serde::Serialize)]
struct AppServerRequest {
    id: u64,
    method: &'static str,
    params: Value,
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
/// [`super::probe::handshake_with`]). An `initialize` handshake precedes the
/// query (the server refuses everything before it); the client-info block
/// reuses the ACP channel's [`super::wire::Implementation::client()`]. Follows
/// `nextCursor` until the last page, folding each page into the catalog; a
/// wedged cursor loop is bounded by the wall-clock deadline (surfaces as
/// [`ProbeError::Timeout`], never a hang). Process management stays with the
/// caller, who must [`super::probe::ChildHandle::kill_and_wait`] on every
/// exit path.
pub fn query_catalog(
    stdin: ChildStdin,
    stdout: ChildStdout,
    stderr_tail: StderrTail,
    timeout: Duration,
) -> Result<ModelCatalogOutcome, ProbeError> {
    let mut io = AppServerIo::new(stdin, stdout);
    let deadline = Instant::now() + timeout;

    let init_params = serde_json::json!({
        "clientInfo": super::wire::Implementation::client(),
    });
    let resp = io
        .request_roundtrip("initialize", init_params, deadline)
        .map_err(|e| attach_stderr_tail(e, &stderr_tail))?;
    // The handshake result itself is not read (userAgent / codexHome are
    // display-only); only an error envelope degrades.
    if resp.result.is_none() {
        return Ok(degraded(error_detail(&resp), &stderr_tail));
    }

    let mut catalog = Catalog::default();
    let mut cursor: Option<String> = None;
    loop {
        let params = match &cursor {
            Some(c) => serde_json::json!({ "cursor": c }),
            None => serde_json::json!({}),
        };
        let resp = io
            .request_roundtrip("model/list", params, deadline)
            .map_err(|e| attach_stderr_tail(e, &stderr_tail))?;
        let page = match fold_page(resp, &stderr_tail) {
            Ok(page) => page,
            Err(unavailable) => return Ok(unavailable),
        };
        match catalog.fold_page(page) {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    Ok(ModelCatalogOutcome::Available {
        models: catalog.models,
    })
}

/// The accumulating catalog: folds pages deduplicating by model id, first
/// sight winning (issue #543 -- the frontend keys catalog entries by id, so a
/// cross-page repeat would silently collide; a server re-listing a model on a
/// later page must not shadow its first-seen entry).
#[derive(Default)]
struct Catalog {
    models: Vec<CatalogModel>,
    seen: std::collections::HashSet<String>,
}

impl Catalog {
    /// Fold one page's models in (dedup by id, first sight winning) and
    /// return the page's continuation cursor (`None` ends the traversal).
    fn fold_page(&mut self, page: ModelListResponse) -> Option<String> {
        for m in page.data {
            if self.seen.insert(m.id.clone()) {
                self.models.push(model_from_wire(m));
            } else {
                // The drop is invisible on every other surface (the catalog
                // stays green); log it so "why is model X stale" has an
                // answer (issue #543).
                log::debug!(target: "toptopduck::probe", "catalog duplicate id dropped (first sight wins): {}", m.id);
            }
        }
        page.next_cursor
    }
}

/// Extract the error detail from a response that carries no `result`: the
/// error message when present, an explicit fallback otherwise.
fn error_detail(resp: &AppServerResponse) -> String {
    resp.error
        .as_ref()
        .map(|e| e.message.as_str())
        .filter(|m| !m.is_empty())
        .unwrap_or("empty response")
        .to_string()
}

/// Fold one `model/list` response into its catalog page, degrading to
/// `Unavailable` on an RPC error / empty response / unparseable result
/// (ADR-0096 D2 -- the process is alive, the catalog just is not available).
/// The `Err` arm is the degraded SUCCESS value the caller short-circuits on,
/// never a hard failure. The degraded detail carries the CLI's stderr
/// diagnosis when it printed one (same-shape append as the failure path's
/// [`attach_stderr_tail`] -- the detail is the only diagnostic surface a
/// degraded outcome has, issue #543).
fn fold_page(
    resp: AppServerResponse,
    stderr_tail: &StderrTail,
) -> Result<ModelListResponse, ModelCatalogOutcome> {
    let Some(result) = resp.result else {
        return Err(degraded(error_detail(&resp), stderr_tail));
    };
    // A result that is not a catalog (protocol skew) degrades the same way --
    // never a false success.
    serde_json::from_value(result).map_err(|e| degraded(format!("catalog parse: {e}"), stderr_tail))
}

/// Build the degraded `Unavailable` outcome, appending the stderr tail to its
/// detail when non-empty (the same `; stderr tail: ` shape the failure path
/// attaches).
fn degraded(detail: String, stderr_tail: &StderrTail) -> ModelCatalogOutcome {
    ModelCatalogOutcome::Unavailable {
        detail: crate::runtime::acp::probe::with_stderr_tail(detail, stderr_tail),
    }
}

/// Project one wire model onto the public catalog entry, preserving the
/// declared order of the reasoning efforts (ADR-0096 D3).
fn model_from_wire(m: ModelWire) -> CatalogModel {
    CatalogModel {
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

/// The query's thin wrapper over the shared [`super::ndjson::NdjsonIo`]:
/// deadline-driven (the kernel's minimal counterpart of the ACP
/// [`super::probe::ProbeIo`]) and mapped onto [`ProbeError`] via
/// [`super::probe`]'s shared mapping (the `who` in the EOF detail names the
/// codex app-server). Owns the request-id counter the bare envelope needs
/// (no `jsonrpc` field, so the generic `Request` serializer is not used).
struct AppServerIo {
    inner: super::ndjson::NdjsonIo,
    next_id: u64,
}

impl AppServerIo {
    fn new(stdin: ChildStdin, stdout: ChildStdout) -> Self {
        Self {
            inner: super::ndjson::NdjsonIo::new(stdin, stdout),
            next_id: 1,
        }
    }

    /// Send a request and pump incoming lines until its response arrives or
    /// the deadline passes. Stray lines are dropped by the shared loop (see
    /// [`super::ndjson::NdjsonIo::request_roundtrip_deadline`]).
    fn request_roundtrip(
        &mut self,
        method: &'static str,
        params: Value,
        deadline: Instant,
    ) -> Result<AppServerResponse, ProbeError> {
        let id = self.next_id;
        self.next_id += 1;
        let req = AppServerRequest { id, method, params };
        let target = Value::from(id);
        self.inner
            .request_roundtrip_deadline(&req, &target, deadline)
            .map_err(|e| super::probe::map_roundtrip_error(e, "codex app-server"))
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
