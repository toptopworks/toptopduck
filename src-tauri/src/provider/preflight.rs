//! Connection preflight (ADR-0070): a "Test connection" probe fired from the
//! Settings Profiles edit form. The Rust core reads the profile's stored key
//! from the OS keychain (ADR-0029 -- the key never crosses IPC; the caller
//! passes only the profile id) and probes the endpoint via `GET /models`
//! (primary path), degrading to a minimal messages ping (fallback) when the
//! endpoint does not implement `/models` or returns a non-auth HTTP error.
//!
//! The result is classified into four states along the ADR-0044 axis
//! ([`ProfileTestOutcome`]): success (carrying the listed models), key rejected
//! (no key / HTTP 401/403), endpoint unreachable (transport), or incompatible
//! (the endpoint responded but neither `/models` nor a minimal turn yielded a
//! usable result). The model list feeds the model dropdown; it is NOT
//! persisted (ADR-0038 -- app-config stores preferences, not probe snapshots).
//!
//! The endpoint (protocol + base_url + model) is the caller's current edit
//! value, passed in explicitly -- so a user who edits base_url and re-tests
//! does not have to save first (ADR-0070 Why 3: "change base_url/model and test
//! repeatedly without re-entering the key"). The key alone is read from the
//! keychain by profile id.
//!
//! Why a dedicated HTTP path instead of reusing `LiveProvider::generate`:
//! `generate` parses the ADR-0009 SQL contract and treats a non-contract reply
//! as `Unavailable`, which would let a weak model that answers the ping with
//! plain prose masquerade as "incompatible". The preflight only cares whether
//! the endpoint is reachable + the key is valid + the chat/messages shape is
//! served -- it must not couple to the SQL contract, so it owns its own minimal
//! HTTP exchange. The POST paths (`/v1/messages`, `/chat/completions`), the
//! per-protocol auth headers (`x-api-key` + `anthropic-version` vs `Bearer`),
//! and the `base_url` join mirror the anthropic and openai adapters verbatim;
//! the `/models` GET path is preflight-only (neither adapter lists models -- it
//! is the ADR-0070 "list models main path" probe added by this module).

use std::time::Duration;

use serde::Deserialize;

use crate::model::{ProfileTestOutcome, Protocol};
use crate::provider::reply::truncate;

/// Anthropic Messages API protocol version header (ADR-0019 native protocol).
/// Mirrors `anthropic::ANTHROPIC_VERSION` verbatim -- that const is private to
/// keep the adapter self-contained, and the preflight needs the same value to
/// authenticate the `/v1/models` + `/v1/messages` probes; a version bump must
/// update both (kept in sync by this comment).
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

/// Run a connection preflight against the given key + endpoint (ADR-0070).
///
/// `key` is the profile's stored key read by the caller from the OS keychain
/// (`None` when nothing is stored -> [`ProfileTestOutcome::KeyRejected`]); it
/// never crosses IPC. `protocol` / `base_url` / `model` are the caller's
/// current edit values (the frontend's edit form), so the probe tests what the
/// user is looking at without forcing a save first.
pub fn probe(
    key: Option<&str>,
    protocol: Protocol,
    base_url: &str,
    model: &str,
) -> ProfileTestOutcome {
    let key = match key {
        Some(k) => k,
        None => return ProfileTestOutcome::KeyRejected,
    };
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
    let request = match protocol {
        Protocol::Anthropic => ureq::get(&url)
            .timeout(REQUEST_TIMEOUT)
            .set("x-api-key", key)
            .set("anthropic-version", ANTHROPIC_VERSION),
        Protocol::Openai => ureq::get(&url)
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
    let request = match protocol {
        Protocol::Anthropic => ureq::post(&url)
            .timeout(REQUEST_TIMEOUT)
            .set("x-api-key", key)
            .set("anthropic-version", ANTHROPIC_VERSION),
        Protocol::Openai => ureq::post(&url)
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
}
