//! Shared HTTP egress helpers for the provider adapters (issue #244).
//!
//! Two security invariants live here, applied to every outbound LLM call
//! (preflight and the yoagent model-config resolution) so the paths cannot drift:
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
/// singleton is built at most once across the process, so every call site (the
/// preflight probes) draws from one shared connection pool.
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
/// `std::sync::LazyLock` is the std equivalent of `once_cell::sync::Lazy`
/// and avoids adding a dependency; the agent is constructed lazily on first
/// use. `ureq::Agent: Send + Sync` (its fields are `Arc` over thread-safe
/// state, so the auto traits hold), which makes the static `Sync` and safely
/// reachable from the `spawn_blocking` threads that drive `Provider::generate`
/// and the preflight probe.
static EGRESS_AGENT: std::sync::LazyLock<ureq::Agent> = std::sync::LazyLock::new(|| {
    #[cfg(test)]
    EGRESS_AGENT_BUILDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    ureq::AgentBuilder::new().redirects(0).build()
});

/// Return a clone of the shared egress agent (issue #278).
///
/// The clone shares the singleton's connection pool (see [`EGRESS_AGENT`]), so
/// repeated calls across turns reuse keep-alive connections instead of
/// re-handshaking. The signature returns an owned `ureq::Agent` rather than `&`
/// so call sites chain `.post(..).set(..).send_json(..)` unchanged -- cloning is
/// the ureq-blessed way to hand out a pool-sharing handle.
pub(crate) fn egress_agent() -> ureq::Agent {
    EGRESS_AGENT.clone()
}

/// Truncate a string for an error message (avoid flooding the user / log with a
/// long malformed model reply or upstream HTTP body). Floors to a UTF-8 char
/// boundary: a naive `&s[..LIMIT]` panics when the cut lands mid-character, and
/// model replies / gateway error bodies (and the errors built from them) are
/// routinely CJK -- so this path, of all paths, must not panic on multi-byte
/// text. (`floor_char_boundary` needs 1.91, so the floor is manual.) Shared
/// across the preflight + HTTP-error-body paths so both stay panic-free from
/// one source.
pub(crate) fn truncate(s: &str) -> String {
    const LIMIT: usize = 200;
    if s.len() <= LIMIT {
        return s.to_string();
    }
    let mut end = LIMIT;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
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
        // shared connection pool. A `LazyLock` singleton is built on first use
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

    #[test]
    fn truncate_floors_to_char_boundary_for_cjk_replies() {
        // 120 CJK chars = 360 bytes; byte 200 (the LIMIT) lands mid-character.
        // A naive `&s[..200]` would panic on the char boundary; truncate floors.
        let reply = "中".repeat(120);
        let out = truncate(&reply);
        assert!(
            out.ends_with('…'),
            "truncated output should end with ellipsis"
        );
        // The head must hold only whole '中' chars -- the floor dropped no halves.
        let head: String = out.chars().filter(|&c| c != '…').collect();
        assert!(head.chars().all(|c| c == '中'));
        assert!(head.chars().count() < 120);

        // Short input passes through verbatim (no ellipsis added).
        assert_eq!(truncate("短回复"), "短回复");
        assert_eq!(truncate(""), "");
    }
}
