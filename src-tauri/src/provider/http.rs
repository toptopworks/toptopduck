//! Shared HTTP helpers for the provider adapters (issue #244).
//!
//! One security invariant lives here, applied to every outbound LLM call
//! (preflight and the loop runtime's model-config resolution) so the paths
//! cannot drift: **base_url scheme is http/https** -- see
//! [`validate_http_base_url`]. Rejects `file:`, `data:`, and scheme-less
//! strings at the boundary, before any request is built, so a hand-edited
//! `file://` base_url never reaches the HTTP layer.
//!
//! The no-redirect guarantee this module used to carry moved with the egress
//! stack (ADR-0139): it is pinned on the clients themselves -- the async
//! reqwest client injected into rig (ADR-0116 Decision 6) and the preflight
//! probes' shared blocking client (`Policy::none`) -- so `x-api-key` /
//! `Authorization` cannot travel past the first hop of a 3xx.

/// A base_url that failed the [`validate_http_base_url`] check. Carries a
/// short reason so each call site (adapter vs preflight) maps it to its own
/// error vocabulary without re-deriving the diagnosis. The reason is read
/// only via [`Display`](std::fmt::Display); the inner string is private to
/// keep the diagnostic wording owned by this module.
///
/// `Display` is derived via `thiserror` (issue #277), matching the
/// `commands.rs` / `session/store.rs` style.
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
