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
#[derive(Debug)]
pub(crate) struct InvalidBaseUrl(String);

impl std::fmt::Display for InvalidBaseUrl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid base_url: {}", self.0)
    }
}

impl std::error::Error for InvalidBaseUrl {}

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

/// Build the shared egress agent with redirect-following disabled (issue #244).
///
/// Disabling is the structural fix for the `x-api-key` cross-host leak:
/// ureq's per-hop header cleanup strips only `authorization`/`cookie`, and
/// the middleware hook wraps the whole redirect loop once (not per-hop), so a
/// middleware stripper cannot intervene between hops either. `redirects(0)`
/// means no redirect is followed, so neither `x-api-key` nor `Authorization`
/// can travel past the first hop.
///
/// Under `redirects(0)` a 3xx reply surfaces as the raw `Response` (ureq keeps
/// 3xx as `Ok`; only `>= 400` becomes `Error::Status`); adapters map any
/// non-2xx to their usual transient error.
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
}
