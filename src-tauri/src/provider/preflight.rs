//! Connection preflight (ADR-0070): a "Test connection" probe fired from the
//! Settings Profiles edit form. The Rust core reads the profile's stored key
//! from the OS keychain (ADR-0029 -- the stored key never crosses IPC back to
//! the frontend; the caller passes only the profile id) and probes the
//! endpoint via `GET /models` (primary path), degrading to a minimal messages
//! ping (fallback) when the endpoint does not implement `/models` or returns
//! a non-auth HTTP error.
//!
//! Key channel (issue #735, ADR-0070 calibration): EDIT mode has the key in
//! the keychain, so the probe reads it there (the original store-then-test
//! flow, unchanged). ADD mode buffers the typed key in the frontend draft
//! (issue #733) -- it has not reached the keychain yet -- so the caller may
//! pass that key as a one-shot explicit parameter (see
//! [`resolve_probe_key`]). That transfer is frontend -> Rust, one request,
//! never persisted and never echoed back: the same direction `set_profile_key`
//! already uses, so no ADR-0029 invariant (not in app-config, not leaked back
//! from Rust, no plaintext at rest) is widened.
//!
//! The result is classified into six states along the ADR-0044 axis
//! ([`ProfileTestOutcome`]): success (carrying the listed models), key rejected
//! (no key / HTTP 401/403), keychain unavailable (the OS keychain read itself
//! failed -- the probe never ran, issue #243), endpoint unreachable
//! (transport), invalid endpoint (a non-http/https scheme rejected before any
//! probe fires, issue #279), or incompatible (the endpoint responded but
//! neither `/models` nor a minimal turn yielded a usable result). The model
//! list feeds the model dropdown; it is NOT persisted (ADR-0038 -- app-config
//! stores preferences, not probe snapshots).
//!
//! The endpoint (protocol + base_url + model) is the caller's current edit
//! value, passed in explicitly -- so a user who edits base_url and re-tests
//! does not have to save first (ADR-0070 Why 3: "change base_url/model and test
//! repeatedly without re-entering the key"). The key alone is read from the
//! keychain by profile id.
//!
//! Why a dedicated HTTP path instead of reusing `LiveProvider::generate`:
//! A SQL-contract parse (the way the retired single-shot `generate` path did)
//! would treat a plain-prose ping answer as `Unavailable`, letting a weak model
//! masquerade as "incompatible". The preflight only cares whether
//! the endpoint is reachable + the key is valid + the chat/messages shape is
//! served -- it must not couple to the SQL contract, so it owns its own minimal
//! HTTP exchange. The POST paths (`/v1/messages`, `/chat/completions`), the
//! per-protocol auth headers (`x-api-key` + `anthropic-version` vs `Bearer`),
//! and the `base_url` join mirror the turn's upstream calls verbatim;
//! the `/models` GET path is probe-only (the upstream loop has no model-list
//! API -- it is the ADR-0070 "list models main path" probe added by this
//! module).

use std::time::Duration;

use serde::Deserialize;

use crate::model::{ProfileTestOutcome, Protocol};
use crate::provider::http::truncate;

/// Anthropic Messages API protocol version header (ADR-0019 native protocol).
/// The preflight probes carry the same header value the upstream provider
/// construction uses, so a probe authenticates exactly like a turn would; a
/// version bump must update both (kept in sync by this comment).
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Wall-clock ceiling on one preflight HTTP call. Tighter than the turn
/// adapter's 120s ceiling (ADR-0021) -- a preflight is a quick reachability
/// probe, not a full turn, and the user is blocked on the button. 30s is
/// generous for a `/models` GET or a 1-token ping across high-latency links.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The one-token prompt the ping fallback sends. The preflight does not read
/// the reply content (only the HTTP status), so the shortest non-empty user
/// message is enough to satisfy both protocols' "at least one user turn" rule.
const PING_PROMPT: &str = ".";

/// The reply cap on the ping fallback. One token is the floor both protocols
/// accept; the preflight never reads the reply text, so a truncated 1-token
/// response is fine -- it only needs an HTTP 200 to confirm the endpoint + key
/// serve the chat/messages shape.
const PING_MAX_TOKENS: u32 = 1;

/// Resolve which key a probe uses (issue #735, ADR-0070 calibration).
/// `explicit` is the caller's one-shot key (the add-mode form's buffered
/// draft key, which has not reached the keychain yet): when it trims to a
/// non-empty value it WINS and the keychain is never consulted -- so a locked
/// or faulted keychain cannot block an add-mode probe, and the verdict
/// predicts the created profile's real behavior because the frontend writes
/// the same trimmed value on create. When it is absent or blank the probe
/// falls back to the keychain read verbatim (edit mode passes no explicit
/// key, preserving store-then-test unchanged).
pub(crate) fn resolve_probe_key(
    explicit: Option<&str>,
    keychain_read: Result<Option<String>, String>,
) -> Result<Option<String>, String> {
    match explicit.map(str::trim).filter(|k| !k.is_empty()) {
        Some(k) => Ok(Some(k.to_string())),
        None => keychain_read,
    }
}

/// Run a connection preflight for a profile: classify the keychain read, then
/// probe the endpoint (ADR-0070). `key_read` is the caller's resolved key
/// source ([`resolve_probe_key`] output: the keychain read, or the explicit
/// one-shot key when the caller supplied one -- the stored key never crosses
/// IPC back to the frontend, ADR-0029 invariant 3). A failed read
/// short-circuits to [`ProfileTestOutcome::KeychainUnavailable`] without any
/// HTTP (the trust root itself is unavailable, so no endpoint verdict applies
/// -- issue #243); a successful read delegates to [`probe`], which splits
/// "nothing stored" (`Ok(None)` -> `KeyRejected`) from the endpoint verdict.
pub fn run(
    key_read: Result<Option<String>, String>,
    protocol: Protocol,
    base_url: &str,
    model: &str,
) -> ProfileTestOutcome {
    match key_read {
        Err(detail) => ProfileTestOutcome::KeychainUnavailable { detail },
        Ok(key) => probe(key.as_deref(), protocol, base_url, model),
    }
}

/// Run a connection preflight against the given key + endpoint (ADR-0070).
///
/// `key` is the profile's stored key read by the caller from the OS keychain
/// (`None` when nothing is stored -> [`ProfileTestOutcome::KeyRejected`]); it
/// never crosses IPC. `protocol` / `base_url` / `model` are the caller's
/// current edit values (the frontend's edit form), so the probe tests what the
/// user is looking at without forcing a save first.
pub(crate) fn probe(
    key: Option<&str>,
    protocol: Protocol,
    base_url: &str,
    model: &str,
) -> ProfileTestOutcome {
    let key = match key {
        Some(k) => k,
        None => return ProfileTestOutcome::KeyRejected,
    };
    // AC #244 / #279: reject a non-http/https base_url (file:, data:,
    // scheme-less) before any probe fires. Mirrors the turn's upstream
    // boundary check. Classified as InvalidEndpoint -- the endpoint is not a
    // reachable http(s) target by construction (a CONFIGURATION error), distinct
    // from EndpointUnreachable (a transport fault on a VALID url). The detail
    // rides the shared validate_http_base_url Display verbatim, matching the
    // turn's TurnFailure::InvalidConfig mapping so one root cause
    // yields one diagnosis at either surface (see provider::http).
    if let Err(e) = super::http::validate_http_base_url(base_url) {
        return ProfileTestOutcome::InvalidEndpoint {
            detail: e.to_string(),
        };
    }
    match list_models(protocol, base_url, key) {
        ModelsOutcome::Listed(models) => ProfileTestOutcome::Ok { models },
        ModelsOutcome::KeyRejected => ProfileTestOutcome::KeyRejected,
        ModelsOutcome::Unreachable => ProfileTestOutcome::EndpointUnreachable,
        // 200-but-not-a-model-list, or a non-auth HTTP error: the endpoint may
        // still serve turns -- degrade to a minimal ping before declaring
        // incompatibility (ADR-0070 ping fallback).
        ModelsOutcome::NeedsFallback => match ping(protocol, base_url, model, key) {
            PingOutcome::Ok => ProfileTestOutcome::Ok { models: Vec::new() },
            PingOutcome::KeyRejected => ProfileTestOutcome::KeyRejected,
            PingOutcome::Unreachable => ProfileTestOutcome::EndpointUnreachable,
            PingOutcome::Incompatible(detail) => ProfileTestOutcome::Incompatible { detail },
        },
    }
}

/// The `/models` GET classification. `Listed` carries the model ids (possibly
/// empty -- an endpoint that legitimately lists zero models still counts as a
/// success). `KeyRejected` and `Unreachable` short-circuit (no ping -- the same
/// key/transport verdict applies to a turn). `NeedsFallback` (200 non-list, or
/// a non-auth HTTP status such as 404/5xx) degrades to a ping before the final
/// verdict.
enum ModelsOutcome {
    Listed(Vec<String>),
    KeyRejected,
    Unreachable,
    NeedsFallback,
}

/// Issue `GET {base_url}/<models_path>` and classify the result.
fn list_models(protocol: Protocol, base_url: &str, key: &str) -> ModelsOutcome {
    let url = join_url(base_url, models_path(protocol));
    // AC #244: shared egress agent disables redirect-following, so x-api-key
    // (anthropic) and Authorization (openai) cannot reach a second host via a
    // 3xx Location -- uniform with the turn path.
    let agent = super::http::egress_agent();
    let request = match protocol {
        Protocol::Anthropic => agent
            .get(&url)
            .timeout(REQUEST_TIMEOUT)
            .set("x-api-key", key)
            .set("anthropic-version", ANTHROPIC_VERSION),
        Protocol::Openai => agent
            .get(&url)
            .timeout(REQUEST_TIMEOUT)
            .set("Authorization", &format!("Bearer {key}")),
    };
    match request.call() {
        Ok(response) => match response.into_json::<ModelsResponse>() {
            Ok(list) => ModelsOutcome::Listed(list.into_ids()),
            // 200 but not a `{data:[{id}]}` shape -- the endpoint answered but
            // does not implement the models contract; a turn may still work.
            Err(_) => ModelsOutcome::NeedsFallback,
        },
        Err(ureq::Error::Status(status, _)) => {
            if is_auth_rejected(status) {
                ModelsOutcome::KeyRejected
            } else {
                // 404 (path not implemented), 5xx (overloaded), or another
                // non-auth 4xx -- the endpoint responded, so let the ping
                // decide whether a turn actually works.
                ModelsOutcome::NeedsFallback
            }
        }
        // Transport (DNS / TCP / TLS / timeout) -- the endpoint is unreachable.
        Err(_) => ModelsOutcome::Unreachable,
    }
}

/// The minimal-turn ping classification. `Ok` means an HTTP 2xx -- the
/// endpoint + key serve the chat/messages shape (the reply content is not
/// read). `KeyRejected` / `Unreachable` mirror the models path. Anything else
/// (non-auth HTTP error) is `Incompatible` carrying the upstream body for the
/// details fold.
#[derive(Debug, PartialEq, Eq)]
enum PingOutcome {
    Ok,
    KeyRejected,
    Unreachable,
    Incompatible(String),
}

/// Issue a minimal `POST {base_url}/<chat_path>` and classify the HTTP outcome.
fn ping(protocol: Protocol, base_url: &str, model: &str, key: &str) -> PingOutcome {
    let url = join_url(base_url, chat_path(protocol));
    // AC #244: shared egress agent disables redirect-following (mirrors
    // list_models and the turn path).
    let agent = super::http::egress_agent();
    let request = match protocol {
        Protocol::Anthropic => agent
            .post(&url)
            .timeout(REQUEST_TIMEOUT)
            .set("x-api-key", key)
            .set("anthropic-version", ANTHROPIC_VERSION),
        Protocol::Openai => agent
            .post(&url)
            .timeout(REQUEST_TIMEOUT)
            .set("Authorization", &format!("Bearer {key}")),
    };
    match request.send_json(ping_body(protocol, model)) {
        Ok(_) => PingOutcome::Ok,
        Err(ureq::Error::Status(status, response)) => {
            if is_auth_rejected(status) {
                PingOutcome::KeyRejected
            } else {
                let body = response.into_string().unwrap_or_default();
                PingOutcome::Incompatible(format!("HTTP {status}: {}", truncate(&body)))
            }
        }
        Err(_) => PingOutcome::Unreachable,
    }
}

/// Whether an HTTP status codes an auth rejection (ADR-0044 -> NotWired). 401
/// (bad/missing key) and 403 (forbidden scope) are permanent for the profile;
/// every other status falls through to the transient/incompatible bucket.
fn is_auth_rejected(status: u16) -> bool {
    status == 401 || status == 403
}

/// The models-list path per protocol (preflight-only -- neither adapter lists
/// models; this is the ADR-0070 "list models main path" probe): anthropic
/// appends `/v1/models` (base_url has no version segment); openai appends
/// `/models` (base_url carries `/v1` per OpenAI SDK convention).
fn models_path(protocol: Protocol) -> &'static str {
    match protocol {
        Protocol::Anthropic => "v1/models",
        Protocol::Openai => "models",
    }
}

/// The chat/messages path per protocol (mirrors the adapter conventions):
/// anthropic `/v1/messages`, openai `/chat/completions`.
fn chat_path(protocol: Protocol) -> &'static str {
    match protocol {
        Protocol::Anthropic => "v1/messages",
        Protocol::Openai => "chat/completions",
    }
}

/// Join a base_url with a path segment, tolerating a trailing slash on the
/// base (mirrors the anthropic/openai adapter `trim_end_matches('/')` join).
fn join_url(base_url: &str, suffix: &str) -> String {
    format!("{base}/{suffix}", base = base_url.trim_end_matches('/'))
}

/// The minimal ping body per protocol. Both send one user turn capped at one
/// token; the preflight reads only the HTTP status, never the reply content.
fn ping_body(protocol: Protocol, model: &str) -> serde_json::Value {
    let messages = serde_json::json!([{ "role": "user", "content": PING_PROMPT }]);
    match protocol {
        Protocol::Anthropic => serde_json::json!({
            "model": model,
            "max_tokens": PING_MAX_TOKENS,
            "messages": messages,
        }),
        // OpenAI Chat Completions accepts the same `{model, max_tokens, messages}`
        // shape; the system prompt is optional and omitted for the minimal ping.
        Protocol::Openai => serde_json::json!({
            "model": model,
            "max_tokens": PING_MAX_TOKENS,
            "messages": messages,
        }),
    }
}

/// Minimal `/models` response shape -- the `data` array of `{id}` entries that
/// both the Anthropic and OpenAI wire protocols return. Extra fields (created,
/// owned_by) are ignored by serde. A 200 body that does not deserialize into
/// this shape triggers the ping fallback (the endpoint answered but does not
/// implement the models contract).
#[derive(Deserialize)]
struct ModelsResponse {
    #[serde(default)]
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}

impl ModelsResponse {
    /// Extract the model ids in listed order.
    fn into_ids(self) -> Vec<String> {
        self.data.into_iter().map(|m| m.id).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Wrap a model-list body in the `{data:[{id}]}` envelope both protocols
    /// share.
    fn models_body(ids: &[&str]) -> String {
        let data: Vec<_> = ids
            .iter()
            .map(|id| serde_json::json!({ "id": id }))
            .collect();
        serde_json::json!({ "data": data }).to_string()
    }

    /// The anthropic chat-completion body echoed back by the ping mock (unused
    /// content -- the ping only checks the HTTP status).
    fn anthropic_reply() -> String {
        serde_json::json!({
            "content": [{"type":"text","text":"ok"}],
        })
        .to_string()
    }

    /// The openai chat-completion body echoed back by the ping mock.
    fn openai_reply() -> String {
        serde_json::json!({
            "choices": [{"message": {"role":"assistant","content":"ok"}}],
        })
        .to_string()
    }

    #[test]
    fn resolve_probe_key_explicit_key_wins_over_keychain_without_reading_it() {
        // Issue #735 (ADR-0070 calibration): an add-mode probe carries the
        // buffered draft key, which trims to what the frontend will write on
        // create. The explicit key WINS: even a faulted keychain read is
        // never consulted (a locked keychain must not block an add-mode
        // probe -- the keychain is not needed when the key is in hand).
        let resolved =
            resolve_probe_key(Some(" sk-test-123 "), Err("keychain access failed".into()));
        assert_eq!(resolved, Ok(Some("sk-test-123".into())));
    }

    #[test]
    fn resolve_probe_key_blank_or_absent_falls_back_to_the_keychain_read() {
        // Absence and blank (whitespace-only) explicit keys are the same
        // state -- "the caller has no key to offer yet" -- and fall back to
        // the keychain read verbatim, edit mode's unchanged store-then-test
        // path. The fault propagates untouched (KeychainUnavailable stays
        // classifiable upstream).
        for explicit in [None, Some(""), Some("   ")] {
            let resolved = resolve_probe_key(explicit, Err("keychain access failed".into()));
            assert_eq!(resolved, Err("keychain access failed".into()));
        }
        let resolved = resolve_probe_key(None, Ok(Some("stored".into())));
        assert_eq!(resolved, Ok(Some("stored".into())));
    }

    #[test]
    fn keychain_read_failure_classifies_as_keychain_unavailable_without_probing() {
        // AC (issue #243): a failed keychain read (locked / service down /
        // corrupt entry) is NOT a key verdict. `run` short-circuits to
        // KeychainUnavailable carrying the technical detail, and no HTTP probe
        // fires -- the base_url is unroutable, so had the probe run it would
        // have yielded EndpointUnreachable, not this. Previously the failure
        // rode `.ok()?` into None and misclassified as KeyRejected.
        let outcome = run(
            Err("keychain access failed: The user canceled".into()),
            Protocol::Anthropic,
            "http://127.0.0.1:1",
            "m",
        );
        assert_eq!(
            outcome,
            ProfileTestOutcome::KeychainUnavailable {
                detail: "keychain access failed: The user canceled".into(),
            }
        );
    }

    #[test]
    fn run_with_no_key_stored_still_classifies_as_key_rejected() {
        // The issue #243 split keeps the "nothing stored" verdict intact:
        // Ok(None) is a legitimate no-entry state (not a read failure) and
        // delegates to probe's no-key branch -> KeyRejected, no HTTP fired.
        let outcome = run(Ok(None), Protocol::Anthropic, "http://127.0.0.1:1", "m");
        assert_eq!(outcome, ProfileTestOutcome::KeyRejected);
    }

    #[test]
    fn anthropic_list_models_success_returns_models_and_hits_v1_models_with_x_api_key() {
        // AC: list models success -> Ok { models }; anthropic path /v1/models
        // with x-api-key auth.
        let mut server = mockito::Server::new();
        let mock = server
            .mock("GET", "/v1/models")
            .match_header("x-api-key", "sk-test")
            .match_header("anthropic-version", "2023-06-01")
            .with_status(200)
            .with_body(models_body(&["claude-sonnet-4-6", "claude-haiku-4-5"]))
            .create();
        let outcome = probe(
            Some("sk-test"),
            Protocol::Anthropic,
            &server.url(),
            "claude-sonnet-4-6",
        );
        assert_eq!(
            outcome,
            ProfileTestOutcome::Ok {
                models: vec![
                    "claude-sonnet-4-6".to_string(),
                    "claude-haiku-4-5".to_string()
                ]
            }
        );
        mock.assert();
    }

    #[test]
    fn openai_list_models_success_returns_models_and_hits_models_with_bearer() {
        // AC: the openai protocol lists models at {base}/models with Bearer.
        let mut server = mockito::Server::new();
        let mock = server
            .mock("GET", "/models")
            .match_header("authorization", "Bearer sk-test")
            .with_status(200)
            .with_body(models_body(&["gpt-4o", "gpt-4o-mini"]))
            .create();
        let outcome = probe(Some("sk-test"), Protocol::Openai, &server.url(), "gpt-4o");
        assert_eq!(
            outcome,
            ProfileTestOutcome::Ok {
                models: vec!["gpt-4o".to_string(), "gpt-4o-mini".to_string()]
            }
        );
        mock.assert();
    }

    #[test]
    fn empty_models_list_is_still_success() {
        // An endpoint that legitimately lists zero models (e.g. Ollama with no
        // models pulled) still answered the contract -> Ok { models: [] }; the
        // dropdown then falls back to a hand-typed input.
        let mut server = mockito::Server::new();
        server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_body(models_body(&[]))
            .create();
        let outcome = probe(Some("sk-test"), Protocol::Anthropic, &server.url(), "m");
        assert_eq!(outcome, ProfileTestOutcome::Ok { models: vec![] });
    }

    #[test]
    fn no_key_stored_is_key_rejected() {
        // ADR-0029 / ADR-0044: no key -> KeyRejected (no HTTP call placed).
        // Pointed at a bogus URL that would actively refuse: if the path tried
        // the network it would surface EndpointUnreachable, not KeyRejected.
        let outcome = probe(None, Protocol::Anthropic, "http://127.0.0.1:1", "m");
        assert_eq!(outcome, ProfileTestOutcome::KeyRejected);
    }

    #[test]
    fn list_models_401_is_key_rejected() {
        // AC: HTTP 401 -> KeyRejected (no ping -- the same key verdict applies
        // to a turn, ADR-0044).
        let mut server = mockito::Server::new();
        server
            .mock("GET", "/v1/models")
            .with_status(401)
            .with_body(r#"{"error":{"message":"invalid key"}}"#)
            .create();
        let outcome = probe(Some("sk-bad"), Protocol::Anthropic, &server.url(), "m");
        assert_eq!(outcome, ProfileTestOutcome::KeyRejected);
    }

    #[test]
    fn list_models_403_is_key_rejected() {
        // 403 mirrors 401 (ADR-0044): forbidden is permanent for the profile.
        let mut server = mockito::Server::new();
        server
            .mock("GET", "/models")
            .with_status(403)
            .with_body(r#"{"error":{"message":"forbidden"}}"#)
            .create();
        let outcome = probe(Some("sk-test"), Protocol::Openai, &server.url(), "m");
        assert_eq!(outcome, ProfileTestOutcome::KeyRejected);
    }

    #[test]
    fn list_models_transport_error_is_endpoint_unreachable() {
        // AC: DNS/TCP/TLS failure -> EndpointUnreachable. A bogus port refuses
        // the connection -> ureq transport error -> EndpointUnreachable, with
        // no ping attempted (the endpoint is not reachable at all).
        let outcome = probe(
            Some("sk-test"),
            Protocol::Anthropic,
            "http://127.0.0.1:1",
            "m",
        );
        assert_eq!(outcome, ProfileTestOutcome::EndpointUnreachable);
    }

    #[test]
    fn list_models_200_non_json_degrades_to_ping_then_ok() {
        // AC: ping fallback. The endpoint answered 200 but not with a model
        // list (a gateway HTML page); the ping then succeeds -> Ok { models: [] }
        // (the endpoint runs turns, just does not implement /models).
        let mut server = mockito::Server::new();
        server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_body("<html>not a models list</html>")
            .create();
        let ping = server
            .mock("POST", "/v1/messages")
            .match_header("x-api-key", "sk-test")
            .match_header("anthropic-version", "2023-06-01")
            .with_status(200)
            .with_body(anthropic_reply())
            .create();
        let outcome = probe(
            Some("sk-test"),
            Protocol::Anthropic,
            &server.url(),
            "claude-sonnet-4-6",
        );
        assert_eq!(outcome, ProfileTestOutcome::Ok { models: vec![] });
        ping.assert();
    }

    #[test]
    fn list_models_404_degrades_to_ping_then_ok() {
        // A 404 on /models (the path is not implemented) still lets the ping
        // confirm the endpoint serves turns -> Ok { models: [] }.
        let mut server = mockito::Server::new();
        server
            .mock("GET", "/models")
            .with_status(404)
            .with_body(r#"{"error":"not found"}"#)
            .create();
        let ping = server
            .mock("POST", "/chat/completions")
            .match_header("authorization", "Bearer sk-test")
            .with_status(200)
            .with_body(openai_reply())
            .create();
        let outcome = probe(Some("sk-test"), Protocol::Openai, &server.url(), "gpt-4o");
        assert_eq!(outcome, ProfileTestOutcome::Ok { models: vec![] });
        // Pin the ping auth (mirrors the /models GET test rigor): an OpenAI
        // endpoint must receive Bearer on the fallback path, not the anthropic
        // x-api-key header.
        ping.assert();
    }

    #[test]
    fn ping_fallback_401_is_key_rejected() {
        // list models 200 non-list -> ping -> ping 401: the key was not checked
        // at /models but the turn rejects it -> KeyRejected (the honest verdict
        // for the profile).
        let mut server = mockito::Server::new();
        server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_body("<html/>")
            .create();
        server
            .mock("POST", "/v1/messages")
            .with_status(401)
            .with_body(r#"{"error":"invalid key"}"#)
            .create();
        let outcome = probe(Some("sk-bad"), Protocol::Anthropic, &server.url(), "m");
        assert_eq!(outcome, ProfileTestOutcome::KeyRejected);
    }

    #[test]
    fn list_models_5xx_then_ping_5xx_is_incompatible() {
        // AC: incompatible. /models 500 then ping 500: the endpoint responded
        // but neither path yields a usable result -> Incompatible with the
        // upstream body surfaced for the details fold.
        let mut server = mockito::Server::new();
        server
            .mock("GET", "/models")
            .with_status(503)
            .with_body(r#"{"error":"overloaded"}"#)
            .create();
        server
            .mock("POST", "/chat/completions")
            .with_status(502)
            .with_body(r#"{"error":"bad gateway"}"#)
            .create();
        let outcome = probe(Some("sk-test"), Protocol::Openai, &server.url(), "gpt-4o");
        match outcome {
            ProfileTestOutcome::Incompatible { detail } => {
                assert!(detail.contains("502"), "ping status surfaced: {detail}");
                assert!(detail.contains("bad gateway"), "body surfaced: {detail}");
            }
            other => panic!("expected Incompatible, got {other:?}"),
        }
    }

    #[test]
    fn ping_fallback_non_auth_4xx_is_incompatible() {
        // ping 400 (model_not_found / bad request) is non-auth -> Incompatible,
        // not KeyRejected. Pins that a 4xx outside 401/403 does not silently
        // read as a key problem.
        let mut server = mockito::Server::new();
        server
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_body("not json")
            .create();
        server
            .mock("POST", "/v1/messages")
            .with_status(400)
            .with_body(r#"{"error":{"message":"model not found"}}"#)
            .create();
        let outcome = probe(
            Some("sk-test"),
            Protocol::Anthropic,
            &server.url(),
            "no-such-model",
        );
        match outcome {
            ProfileTestOutcome::Incompatible { detail } => {
                assert!(detail.contains("400"), "status surfaced: {detail}");
                assert!(
                    detail.contains("model not found"),
                    "body surfaced: {detail}"
                );
            }
            other => panic!("expected Incompatible, got {other:?}"),
        }
    }

    #[test]
    fn ping_transport_error_is_endpoint_unreachable() {
        // Cover ping()'s transport branch directly: a refused port -> ureq
        // transport error -> PingOutcome::Unreachable. Tested at the ping()
        // level rather than via probe() because probe's list-models step would
        // short-circuit on the SAME transport failure first (returning
        // EndpointUnreachable before ping runs) -- a probe-level call cannot
        // isolate ping's transport branch. Pins that a transport failure
        // during the fallback ping classifies as EndpointUnreachable, not
        // Incompatible (the endpoint is not reachable for the turn).
        let outcome = ping(Protocol::Anthropic, "http://127.0.0.1:1", "m", "sk-test");
        assert_eq!(outcome, PingOutcome::Unreachable);
    }

    #[test]
    fn join_url_trims_trailing_slash_and_appends_segment() {
        // Mirrors the adapter join: a base_url ending in '/' must not produce
        // '//' and the user's version segment is preserved verbatim.
        assert_eq!(
            join_url("https://api.openai.com/v1/", "models"),
            "https://api.openai.com/v1/models"
        );
        assert_eq!(
            join_url("https://api.anthropic.com", "v1/models"),
            "https://api.anthropic.com/v1/models"
        );
    }

    #[test]
    fn base_url_non_http_scheme_is_invalid_endpoint_before_probe() {
        // AC #244 / #279 (mirrors the adapters): a file:// base_url is rejected
        // at the run/probe boundary -- no HTTP probe fires. Classified as
        // InvalidEndpoint (a configuration error), NOT EndpointUnreachable --
        // the endpoint is not a reachable http(s) target by construction, so
        // directing the user at DNS/network/TLS would misdiagnose. The detail
        // rides validate_http_base_url's Display verbatim, naming the offending
        // scheme + the http/https policy (the same string the turn adapters
        // surface as TurnFailure::InvalidConfig). Ok(Some(key)) so the verdict
        // is not short-circuited as KeyRejected; the scheme check fires after
        // the key check.
        let outcome = run(
            Ok(Some("sk-test".into())),
            Protocol::Anthropic,
            "file:///etc/passwd",
            "m",
        );
        match outcome {
            ProfileTestOutcome::InvalidEndpoint { detail } => {
                assert!(
                    detail.contains("file") && detail.contains("http/https"),
                    "detail names the bad scheme + the policy: {detail}"
                );
            }
            other => panic!("expected InvalidEndpoint, got {other:?}"),
        }
    }

    #[test]
    fn base_url_data_scheme_and_schemeless_are_invalid_endpoint_before_probe() {
        // AC #279: the two other bad-scheme shapes the shared gate rejects --
        // data: (parses but wrong scheme) and a scheme-less string (no scheme,
        // Url::parse fails) -- also classify as InvalidEndpoint, not
        // EndpointUnreachable. Pins the full bad-scheme surface named in the
        // issue so a regression on any one of the three shapes is caught.
        for bad in ["data:text/plain,hello", "api.anthropic.com"] {
            let outcome = run(Ok(Some("sk-test".into())), Protocol::Anthropic, bad, "m");
            assert!(
                matches!(outcome, ProfileTestOutcome::InvalidEndpoint { .. }),
                "bad scheme {bad:?} -> InvalidEndpoint, got {outcome:?}"
            );
        }
    }

    #[test]
    fn no_key_with_bad_scheme_is_key_rejected_before_invalid_endpoint() {
        // AC: the key-existence check (-> KeyRejected) runs BEFORE the scheme
        // gate (-> InvalidEndpoint) in probe -- a profile with no stored key
        // AND a bad-scheme base_url is diagnosed "set a key", not "fix the
        // protocol". Pins the ordering invariant the bad-scheme tests above
        // (which all pass a key) do not exercise on their own; a future
        // refactor flipping the order would otherwise silently reclassify
        // this case with no test failure.
        let outcome = run(Ok(None), Protocol::Anthropic, "file:///etc/passwd", "m");
        assert_eq!(outcome, ProfileTestOutcome::KeyRejected);
    }

    #[test]
    fn list_models_does_not_forward_x_api_key_across_host_redirect() {
        // AC #244 (three-path uniform handling): the preflight's /models GET
        // path wires the same shared egress agent, so a 3xx redirect is NOT
        // followed and x-api-key cannot reach a second host. ureq's default
        // agent would follow the 302 (GET stays GET) and land x-api-key on
        // the target; the shared agent's redirects(0) keeps the credential on
        // the first hop. The second host's x-api-key-matching mock must
        // record zero hits.
        let mut first = mockito::Server::new();
        let mut second = mockito::Server::new();
        first
            .mock("GET", "/v1/models")
            .with_status(302)
            .with_header("Location", &format!("{}/v1/models", second.url()))
            .create();
        let second_leak = second
            .mock("GET", "/v1/models")
            .match_header("x-api-key", "sk-secret")
            .expect(0)
            .with_status(200)
            .with_body(models_body(&["claude-leak"]))
            .create();
        // The probe outcome is not asserted here -- under redirects(0) the
        // 302 surfaces raw, list_models falls through to NeedsFallback, and
        // the ping hits the first host (unmocked -> 501 -> Incompatible). The
        // assertion is the absence of a cross-host x-api-key leak.
        let _ = probe(Some("sk-secret"), Protocol::Anthropic, &first.url(), "m");
        second_leak.assert();
    }

    #[test]
    fn ping_fallback_does_not_forward_x_api_key_across_host_redirect() {
        // AC #244 (three-path uniform handling): the preflight's ping POST
        // fallback wires the same shared egress agent, so a 3xx redirect on the
        // chat/messages endpoint is NOT followed and x-api-key cannot reach a
        // second host. Mirrors the /models GET test but forces the ping
        // fallback first (/v1/models answers 200 non-list -> NeedsFallback ->
        // ping POST /v1/messages returns 302). The second host's
        // x-api-key-matching mock must record zero hits.
        let mut first = mockito::Server::new();
        let mut second = mockito::Server::new();
        first
            .mock("GET", "/v1/models")
            .with_status(200)
            .with_body("<html>not a models list</html>")
            .create();
        first
            .mock("POST", "/v1/messages")
            .with_status(302)
            .with_header("Location", &format!("{}/v1/messages", second.url()))
            .create();
        let second_leak = second
            .mock("POST", "/v1/messages")
            .match_header("x-api-key", "sk-secret")
            .expect(0)
            .with_status(200)
            .create();
        let _ = probe(Some("sk-secret"), Protocol::Anthropic, &first.url(), "m");
        second_leak.assert();
    }
}
