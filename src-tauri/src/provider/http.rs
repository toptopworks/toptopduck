//! Shared HTTP egress helpers for the provider adapters (issue #244).
//!
//! Two security invariants live here, applied to every outbound LLM call
//! (preflight + anthropic + openai) so the three paths cannot drift:
//!
//! 1. **base_url scheme is http/https** -- see [`validate_http_base_url`].
//!    Rejects `file:`, `data:`, and scheme-less strings at the boundary,
//!    before any request is built, so a hand-edited `file://` base_url never
//!    reaches ureq's request layer.
//!
//! 2. **Redirects are disabled** -- see [`egress_agent`]. ureq follows up to
//!    five 3xx redirects by default and strips only `authorization`/`cookie`
//!    per hop; the Anthropic `x-api-key` header survives and would be
//!    forwarded to whatever host a 3xx `Location` points at. The two gates are
//!    independent and additive -- one bypassed does not revive the leak.

/// A base_url that failed the [`validate_http_base_url`] check. Carries a
/// short reason so each call site (adapter vs preflight) maps it to its own
/// error vocabulary without re-deriving the diagnosis. The reason is read
/// only via [`Display`](std::fmt::Display); the inner string is private to
/// keep the diagnostic wording owned by this module.
///
/// `Display` is derived via `thiserror` (issue #277), matching the
/// `commands.rs` / `session_store.rs` style.
#[derive(Debug, thiserror::Error)]
#[error("invalid base_url: {0}")]
pub(crate) struct InvalidBaseUrl(String);

/// Validate that a provider base_url is an http/https URL (issue #244).
/// `url::Url::parse` rejects malformed URLs (including scheme-less strings,
/// which have no base to resolve against here); the explicit scheme check
/// then admits only `http`/`https`, ruling out `file:`, `data:`, and any
/// other scheme a hand-edited app-config might carry. This is a boundary
/// gate, not a parser -- call sites re-derive request URLs by string join.
pub(crate) fn validate_http_base_url(base_url: &str) -> Result<(), InvalidBaseUrl> {
    let parsed =
        url::Url::parse(base_url).map_err(|e| InvalidBaseUrl(format!("not a valid URL: {e}")))?;
    match parsed.scheme() {
        "http" | "https" => Ok(()),
        other => Err(InvalidBaseUrl(format!(
            "scheme `{other}` is not http/https"
        ))),
    }
}

/// Test-only construction counter for [`EGRESS_AGENT`] (issue #278): proves the
/// singleton is built at most once across the process, so every call site
/// (anthropic / openai / preflight) draws from one shared connection pool.
/// Read by `egress_agent_builds_only_once_across_calls`; compiled out of
/// release builds.
#[cfg(test)]
static EGRESS_AGENT_BUILDS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// The process-wide shared egress agent (issue #278).
///
/// Built once and reused for the process lifetime; [`egress_agent`] hands out
/// cheap clones that share the underlying `ConnectionPool` -- a `ureq::Agent` is
/// `Arc<AgentState>` internally, so cloning shares state (ureq 2.12.1). Every
/// call site previously built a fresh `AgentBuilder`, dropping the pool at the
/// end of each call so each LLM turn / preflight probe re-did the TCP+TLS
/// handshake; the shared pool restores keep-alive reuse across turns.
///
/// `redirects(0)` (issue #244) is the structural fix for the `x-api-key`
/// cross-host leak: ureq's per-hop header cleanup strips only
/// `authorization`/`cookie`, and the middleware hook wraps the whole redirect
/// loop once (not per-hop), so a middleware stripper cannot intervene between
/// hops either. It is baked in at construction and immutable on the shared
/// agent, so every clone preserves the leak guarantee -- a redirect is never
/// followed, so neither `x-api-key` nor `Authorization` can travel past the
/// first hop. Under `redirects(0)` a 3xx reply surfaces as the raw `Response`
/// (ureq keeps 3xx as `Ok`; only `>= 400` becomes `Error::Status`); adapters
/// map any non-2xx to their usual transient error.
///
/// `std::sync::OnceLock` is the std equivalent of `once_cell::sync::Lazy`
/// (stable since 1.70, within the crate MSRV of 1.77) and avoids adding a
/// dependency; the agent is constructed lazily on first use via `get_or_init`.
/// `ureq::Agent: Send + Sync` (its fields are `Arc` over thread-safe state, so
/// the auto traits hold), which makes the static `Sync` and safely reachable
/// from the `spawn_blocking` threads that drive `Provider::generate` and the
/// preflight probe.
static EGRESS_AGENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();

/// Return a clone of the shared egress agent (issue #278).
///
/// The clone shares the singleton's connection pool (see [`EGRESS_AGENT`]), so
/// repeated calls across turns reuse keep-alive connections instead of
/// re-handshaking. The signature returns an owned `ureq::Agent` rather than `&`
/// so call sites chain `.post(..).set(..).send_json(..)` unchanged -- cloning is
/// the ureq-blessed way to hand out a pool-sharing handle.
pub(crate) fn egress_agent() -> ureq::Agent {
    EGRESS_AGENT
        .get_or_init(|| {
            #[cfg(test)]
            EGRESS_AGENT_BUILDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            ureq::AgentBuilder::new().redirects(0).build()
        })
        .clone()
}

/// Classify a ureq send result into either a 2xx [`ureq::Response`] or a
/// [`ProviderError`](crate::provider::ProviderError), applying the ADR-0044
/// status mapping shared by every outbound LLM call:
///
/// - HTTP 401/403 -> [`NotWired`](crate::provider::ProviderError::NotWired)
///   (permanent for the turn: the stored key was rejected; not retried --
///   three identical auth failures would only burn time).
/// - Any other HTTP status, any transport error, and the 3xx that surfaces
///   as `Ok` under [`egress_agent`]'s `redirects(0)` ->
///   [`Unavailable`](crate::provider::ProviderError::Unavailable)
///   (transient/retryable). The upstream body rides the message (bounded by
///   [`reply::truncate`](crate::provider::reply::truncate)) so the user sees
///   WHY instead of a bare status code.
///
/// Used by the tool-calling adapters (issue #291). The single-shot adapters
/// retain their inline classification unchanged (zero behavior change to the
/// legacy path); ADR-0077 retires the single-SQL contract, after which the
/// single-shot path can route onto this helper.
pub(crate) fn classify_send_result(
    result: Result<ureq::Response, ureq::Error>,
) -> Result<ureq::Response, crate::provider::ProviderError> {
    use crate::provider::ProviderError;
    match result {
        // Under redirects(0) a 3xx surfaces as Ok (only >= 400 becomes
        // Error::Status). Without this guard the 3xx body would reach
        // into_json and surface as a misleading "response read failed"
        // parse fault; map any non-2xx to the same transient Unavailable so
        // the diagnosis names the status.
        Ok(r) if !(200..300).contains(&r.status()) => {
            let status = r.status();
            let body = r.into_string().unwrap_or_default();
            Err(ProviderError::Unavailable(format!(
                "LLM call failed (HTTP {status}): {}",
                crate::provider::reply::truncate(&body)
            )))
        }
        Ok(r) => Ok(r),
        Err(ureq::Error::Status(status, resp)) => {
            if status == 401 || status == 403 {
                Err(ProviderError::NotWired)
            } else {
                let body = resp.into_string().unwrap_or_default();
                Err(ProviderError::Unavailable(format!(
                    "LLM call failed (HTTP {status}): {}",
                    crate::provider::reply::truncate(&body)
                )))
            }
        }
        // Transport error (DNS / TCP / TLS / timeout): transient/retryable.
        Err(e) => Err(ProviderError::Unavailable(format!("LLM call failed: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_https_base_urls() {
        // AC #244: http and https schemes are admitted. http covers the
        // mockito test endpoints (and a local Ollama on http://localhost);
        // https covers every real LLM endpoint.
        assert!(validate_http_base_url("http://127.0.0.1:1234").is_ok());
        assert!(validate_http_base_url("https://api.anthropic.com").is_ok());
        assert!(validate_http_base_url("https://api.openai.com/v1/").is_ok());
    }

    #[test]
    fn rejects_file_scheme() {
        // AC #244: a file:// base_url is the canonical local-read /
        // exfiltration vector and must be rejected before any request is
        // built. The reason names both the offending scheme and the policy so
        // the diagnosis surfaces verbatim in the adapter error.
        match validate_http_base_url("file:///etc/passwd") {
            Err(err) => assert!(
                err.to_string().contains("file") && err.to_string().contains("http/https"),
                "reason names the bad scheme + the policy: {err}"
            ),
            other => panic!("file: must be rejected, got {other:?}"),
        }
    }

    #[test]
    fn rejects_schemeless_string() {
        // AC #244: a scheme-less string has no base to resolve against, so
        // Url::parse fails -- "no scheme" is rejected (not only a non-http
        // scheme). A hand-edited config missing the protocol must not silently
        // fall through.
        assert!(validate_http_base_url("api.anthropic.com").is_err());
        assert!(validate_http_base_url("/v1/messages").is_err());
        assert!(validate_http_base_url("").is_err());
    }

    #[test]
    fn rejects_data_scheme() {
        // A data: URL parses successfully but is not an http(s) endpoint; the
        // scheme check rejects it. Covers the "Url::parse succeeds but the
        // scheme is wrong" branch, distinct from the scheme-less case above.
        assert!(validate_http_base_url("data:text/plain,hello").is_err());
    }

    #[test]
    fn egress_agent_does_not_follow_cross_host_redirect() {
        // AC #244: a 3xx Location pointing at a SECOND host is NOT followed.
        // The first host receives the request (with whatever auth the adapter
        // attached); the second host receives nothing -- so x-api-key /
        // Authorization cannot leak across hosts. Built at the http-module
        // level (not per-adapter) because all three adapters share
        // [`egress_agent`]; per-adapter tests then pin that each adapter
        // wires it in.
        let mut first = mockito::Server::new();
        let mut second = mockito::Server::new();

        // First host responds 302 -> second host. If the agent followed it,
        // the second host mock would record a hit.
        let _first_mock = first
            .mock("POST", "/v1/messages")
            .with_status(302)
            .with_header("Location", &second.url())
            .create();
        let second_mock = second
            .mock("POST", "/v1/messages")
            .expect(0)
            .with_status(200)
            .with_body("{\"ok\":true}")
            .create();

        let agent = egress_agent();
        let target = format!("{}/v1/messages", first.url());
        let resp = agent
            .post(&target)
            .set("x-api-key", "sk-secret")
            .send_json(serde_json::json!({}));
        // redirects(0): a 3xx is returned as Ok (only >= 400 becomes Err). The
        // 302 status + this Ok prove the request reached the first host and
        // the agent did not follow the Location.
        let resp = resp.expect("3xx stays Ok under redirects(0)");
        assert_eq!(resp.status(), 302, "the 3xx surfaces raw, not followed");

        second_mock.assert(); // expect(0): the second host was NOT reached
    }

    #[test]
    fn egress_agent_builds_only_once_across_calls() {
        // AC #278: there is exactly one `ureq::Agent` for the whole process, so
        // every call site (anthropic / openai / preflight) draws from a single
        // shared connection pool. A `OnceLock` singleton is built on first use
        // and cloned thereafter -- the construction counter must not advance on
        // the 2nd+ call, regardless of whether another test already initialized
        // it (tests run in parallel, so `before` may already be non-zero). The
        // counter snapshots bracket the calls rather than asserting an absolute
        // value, so this stays correct under any initialization order.
        use std::sync::atomic::Ordering;
        let before = EGRESS_AGENT_BUILDS.load(Ordering::Relaxed);
        let _first = egress_agent();
        let after_first = EGRESS_AGENT_BUILDS.load(Ordering::Relaxed);
        let _second = egress_agent();
        let _third = egress_agent();
        let after_third = EGRESS_AGENT_BUILDS.load(Ordering::Relaxed);

        assert!(
            after_first - before <= 1,
            "first call builds the agent at most once (got {} builds)",
            after_first - before
        );
        assert_eq!(
            after_third, after_first,
            "subsequent calls never rebuild the agent"
        );
    }

    use crate::provider::ProviderError;

    /// Send a no-op POST via the shared egress agent and classify the result,
    /// so the ADR-0044 status mapping is pinned at [`classify_send_result`]
    /// itself, not only via the adapters (which exercise just the 401 + 503
    /// branches indirectly). Returns the small [`ProviderError`] (not the
    /// 272-byte `ureq::Error`) so the Err variant stays cheap.
    fn send_and_classify(url: &str) -> Result<ureq::Response, ProviderError> {
        let result = egress_agent().post(url).send_json(serde_json::json!({}));
        classify_send_result(result)
    }

    #[test]
    fn classify_2xx_passes_response_through() {
        // A 2xx is the only Ok branch that returns the response unchanged;
        // the caller then reads the JSON body. Pins the happy path so a
        // future guard broadening the non-2xx arm cannot swallow 200.
        let mut server = mockito::Server::new();
        server
            .mock("POST", "/v1/messages")
            .with_status(200)
            .with_body("{\"ok\":true}")
            .create();
        let resp = send_and_classify(&format!("{}/v1/messages", server.url()))
            .expect("2xx passes through");
        assert_eq!(resp.status(), 200);
    }

    #[test]
    fn classify_3xx_under_redirects_zero_is_unavailable_with_status() {
        // Under redirects(0) a 3xx surfaces as Ok (only >= 400 becomes Err);
        // the classify guard maps it to Unavailable naming the status, not a
        // misleading body-parse fault on the 3xx body.
        let mut server = mockito::Server::new();
        server
            .mock("POST", "/v1/messages")
            .with_status(302)
            .with_header("Location", "https://evil.test")
            .with_body("302 here")
            .create();
        match send_and_classify(&format!("{}/v1/messages", server.url())) {
            Err(ProviderError::Unavailable(msg)) => assert!(
                msg.contains("HTTP 302"),
                "3xx surfaces with its status, got: {msg}"
            ),
            other => panic!("expected Unavailable for 3xx, got {other:?}"),
        }
    }

    #[test]
    fn classify_403_is_not_wired() {
        // ADR-0044: 403 joins 401 in the auth-rejected set -> NotWired
        // (permanent, not retried). Distinct from the generic 4xx -> Available
        // path so a regression dropping 403 from the guard fails here.
        let mut server = mockito::Server::new();
        server
            .mock("POST", "/v1/messages")
            .with_status(403)
            .with_body(r#"{"error":{"message":"forbidden"}}"#)
            .create();
        assert!(matches!(
            send_and_classify(&format!("{}/v1/messages", server.url())),
            Err(ProviderError::NotWired)
        ));
    }

    #[test]
    fn classify_transport_error_is_unavailable() {
        // An unroutable host produces a transport error (connection refused),
        // mapped to Unavailable -- transient/retryable. Pins the catch-all
        // Err arm distinct from the auth/status arms.
        assert!(matches!(
            send_and_classify("http://127.0.0.1:1/v1/messages"),
            Err(ProviderError::Unavailable(_))
        ));
    }
}
