//! Shared HTTP egress helpers for the provider adapters (issue #244).
//!
//! Two security invariants live here, applied to every outbound LLM call
//! (preflight + anthropic + openai) so the three paths cannot drift:
//!
//! 1. **base_url scheme is http/https** -- see [`parse_http_base_url`]. Rejects
//!    `file:`, `data:`, and scheme-less strings at the boundary, before any
//!    request is built. A malicious or hand-edited `file://` base_url must
//!    never reach ureq's request layer.
//!
//! 2. **Redirects are disabled** -- see [`egress_agent`]. ureq 2.12.1 follows
//!    up to five 3xx redirects by default and, on each hop, strips only
//!    `authorization` and `cookie` (`unit.rs:221-225`). The Anthropic auth
//!    header `x-api-key` is NOT in that list, so a cross-host redirect (a
//!    `Location` pointing at an attacker-controlled host) would forward the
//!    real Anthropic key off-host. ureq's middleware hook wraps the whole
//!    redirect loop once (`request.rs:150-167`), not per-hop, so a middleware
//!    stripper cannot intervene between hops either. Disabling redirect-
//!    following entirely is the structural fix: no redirect is followed, so no
//!    credential can reach a second host. A 3xx reply surfaces as the raw
//!    `Response` (status 3xx, which ureq keeps as `Ok` for 3xx -- only
//!    `>= 400` becomes `Error::Status`, `request.rs:169`); adapters map the
//!    non-2xx to their usual transient error. LLM endpoints never redirect,
//!    so no legitimate traffic is lost (ADR-0029 invariant 1: this is the
//!    only network egress surface).

/// A base_url that failed the [`parse_http_base_url`] check. Carries a short
/// reason so each call site (adapter vs preflight) maps it to its own error
/// vocabulary without re-deriving the diagnosis.
#[derive(Debug)]
pub(crate) struct InvalidBaseUrl(pub String);

impl std::fmt::Display for InvalidBaseUrl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid base_url: {}", self.0)
    }
}

impl std::error::Error for InvalidBaseUrl {}

/// Validate and parse a provider base_url (issue #244). `url::Url::parse`
/// rejects malformed URLs (including scheme-less strings, which have no base
/// to resolve against here); the explicit scheme check then admits only
/// `http`/`https`, ruling out `file:`, `data:`, and any other scheme a
/// hand-edited app-config might carry. Returns the parsed [`url::Url`] so a
/// future caller can avoid a second parse (current call sites re-derive
/// request URLs by string join, unchanged -- this gate is purely a boundary
/// check).
pub(crate) fn parse_http_base_url(base_url: &str) -> Result<url::Url, InvalidBaseUrl> {
    let parsed =
        url::Url::parse(base_url).map_err(|e| InvalidBaseUrl(format!("not a valid URL: {e}")))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        other => Err(InvalidBaseUrl(format!(
            "scheme `{other}` is not http/https"
        ))),
    }
}

/// Build the shared egress agent with redirect-following disabled (issue #244).
/// See the module docs for why disabling is the structural fix for the
/// `x-api-key` cross-host leak. Otherwise ureq's defaults apply (rustls TLS,
/// 30s connect timeout, `RedirectAuthHeaders::Never` -- moot once redirects
/// are off, but retained for defense in depth).
pub(crate) fn egress_agent() -> ureq::Agent {
    ureq::AgentBuilder::new().redirects(0).build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_https_base_urls() {
        // AC #244: http and https schemes are admitted. http covers the
        // mockito test endpoints (and a local Ollama on http://localhost);
        // https covers every real LLM endpoint. A trailing slash and a path
        // segment are preserved verbatim -- the adapter joins the protocol
        // path onto whatever base it is given.
        assert!(parse_http_base_url("http://127.0.0.1:1234").is_ok());
        assert!(parse_http_base_url("https://api.anthropic.com").is_ok());
        assert!(parse_http_base_url("https://api.openai.com/v1/").is_ok());
    }

    #[test]
    fn rejects_file_scheme() {
        // AC #244: a file:// base_url is the canonical local-read /
        // exfiltration vector and must be rejected before any request is
        // built. The reason names both the offending scheme and the policy so
        // the diagnosis surfaces verbatim in the adapter error.
        match parse_http_base_url("file:///etc/passwd") {
            Err(InvalidBaseUrl(msg)) => assert!(
                msg.contains("file") && msg.contains("http/https"),
                "reason names the bad scheme + the policy: {msg}"
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
        assert!(parse_http_base_url("api.anthropic.com").is_err());
        assert!(parse_http_base_url("/v1/messages").is_err());
        assert!(parse_http_base_url("").is_err());
    }

    #[test]
    fn rejects_data_scheme() {
        // A data: URL parses successfully but is not an http(s) endpoint; the
        // scheme check rejects it. Covers the "Url::parse succeeds but the
        // scheme is wrong" branch, distinct from the scheme-less case above.
        assert!(parse_http_base_url("data:text/plain,hello").is_err());
    }

    #[test]
    fn egress_agent_does_not_follow_cross_host_redirect() {
        // AC #244: a 3xx Location pointing at a SECOND host is NOT followed.
        // The first host receives the request (with whatever auth the adapter
        // attached); the second host receives nothing -- so x-api-key /
        // Authorization cannot leak across hosts. This is the structural core
        // of the fix: redirects(0) means the credential never travels past
        // the first hop.
        //
        // Built at the http-module level (not per-adapter) because all three
        // adapters share [`egress_agent`]; per-adapter tests then pin that
        // each adapter wires it in.
        let mut first = mockito::Server::new();
        let mut second = mockito::Server::new();

        // First host responds 302 -> second host. If the agent followed it,
        // the second host mock would record a hit.
        let first_mock = first
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
        // redirects(0): a 3xx is returned as Ok (only >= 400 becomes Err).
        let resp = resp.expect("3xx stays Ok under redirects(0)");
        assert_eq!(resp.status(), 302, "the 3xx surfaces raw, not followed");

        first_mock.assert(); // request hit the first host
        second_mock.assert(); // expect(0): the second host was NOT reached
    }
}
