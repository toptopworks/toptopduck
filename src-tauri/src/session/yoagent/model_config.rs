//! Access-profile → upstream model config conversion (ADR-0107 Decision 4,
//! issue #668). The app's active profile (protocol + endpoint + model) maps
//! onto yoagent's `ModelConfig`; the API key rides as an EXPLICIT parameter on
//! the loop config -- never an environment variable, never out of the process
//! (ADR-0029 invariant 3, held bit-for-bit: yoagent's `Agent` wrapper reads
//! env keys by default, which is exactly why this layer calls the bare
//! `agent_loop()` with an explicit key instead).

use crate::model::Protocol;
use crate::provider::http::validate_http_base_url;
use crate::provider::ProviderError;
use yoagent::provider::ModelConfig;

/// The resolved upstream execution inputs: the model config (protocol +
/// endpoint + model id) plus the explicit API key that rides beside it on
/// [`yoagent::agent_loop`]'s config -- the two travel as a pair so no call
/// site can accidentally construct one without the other.
#[derive(Debug)]
pub(crate) struct ResolvedYoagentModel {
    pub(crate) config: ModelConfig,
    pub(crate) api_key: String,
}

/// Convert an access profile into the upstream model config + explicit key.
///
/// Base-url semantics are translated, not passed through: the app's adapters
/// post anthropic to `{base}/v1/messages` and openai-compatible to
/// `{base}/chat/completions`, while yoagent expects the versioned root and
/// appends only the terminal segment -- so the anthropic protocol gains the
/// `/v1` suffix here (the openai profile's base already carries its version
/// path, and passes through unchanged). The same `validate_http_base_url`
/// gate the adapters apply (issue #244) rejects non-http/https schemes before
/// any request is built, mapping onto `ProviderError::InvalidConfig` exactly
/// as the built-in adapters do (ADR-0044 classification).
pub(crate) fn resolve_yoagent_model(
    protocol: Protocol,
    base_url: &str,
    model: &str,
    api_key: Option<String>,
) -> Result<ResolvedYoagentModel, ProviderError> {
    let api_key = api_key.ok_or(ProviderError::NotWired)?;
    validate_http_base_url(base_url).map_err(|e| ProviderError::InvalidConfig(e.to_string()))?;
    let trimmed = base_url.trim_end_matches('/');
    let mut config = match protocol {
        Protocol::Anthropic => ModelConfig::anthropic(model, model),
        Protocol::Openai => ModelConfig::openai(model, model),
    };
    config.base_url = match protocol {
        // The app's anthropic base is the host root; the upstream expects the
        // versioned root (it appends `/messages` itself).
        Protocol::Anthropic => format!("{trimmed}/v1"),
        // The app's openai base already includes its version path.
        Protocol::Openai => trimmed.to_string(),
    };
    Ok(ResolvedYoagentModel { config, api_key })
}

/// Map the session posture's thought-level id onto the upstream thinking
/// level. Known ids map directly; anything else honest-degrades to `Off` --
/// the same posture the openai protocol's adapter takes for an unknown id
/// (the built-in anthropic adapter degrades to "no thinking enablement"
/// there too). `None` (no posture level) is `Off`.
pub(crate) fn thinking_level_for(level: Option<&str>) -> yoagent::ThinkingLevel {
    match level {
        Some("minimal") => yoagent::ThinkingLevel::Minimal,
        Some("low") => yoagent::ThinkingLevel::Low,
        Some("medium") => yoagent::ThinkingLevel::Medium,
        Some("high") => yoagent::ThinkingLevel::High,
        _ => yoagent::ThinkingLevel::Off,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yoagent::provider::ApiProtocol;

    /// The anthropic protocol's base gains the version segment, so the
    /// upstream request URL (`{base}/messages`) equals the built-in adapter's
    /// (`{base}/v1/messages`) bit-for-bit.
    #[test]
    fn anthropic_base_url_gains_the_version_segment() {
        let resolved = resolve_yoagent_model(
            Protocol::Anthropic,
            "https://api.anthropic.com",
            "claude-test",
            Some("sk-test".into()),
        )
        .expect("resolves");
        assert_eq!(resolved.config.base_url, "https://api.anthropic.com/v1");
        assert_eq!(resolved.config.api, ApiProtocol::AnthropicMessages);
        assert_eq!(resolved.config.id, "claude-test");
        assert_eq!(resolved.api_key, "sk-test");
    }

    /// The openai protocol's base already carries its version path and passes
    /// through unchanged (trailing slash trimmed), matching the built-in
    /// adapter's `{base}/chat/completions`.
    #[test]
    fn openai_base_url_passes_through_with_version_path() {
        let resolved = resolve_yoagent_model(
            Protocol::Openai,
            "https://api.openai.com/v1/",
            "gpt-test",
            Some("sk-test".into()),
        )
        .expect("resolves");
        assert_eq!(resolved.config.base_url, "https://api.openai.com/v1");
        assert_eq!(resolved.config.api, ApiProtocol::OpenAiCompletions);
    }

    /// ADR-0029: no key means the turn refuses as NotWired -- never an
    /// environment-variable fallback, never an empty key on the wire.
    #[test]
    fn a_missing_key_refuses_as_not_wired() {
        let err =
            resolve_yoagent_model(Protocol::Anthropic, "https://api.anthropic.com", "m", None)
                .unwrap_err();
        assert_eq!(err, ProviderError::NotWired);
    }

    /// The shared scheme gate: a `file:` base refuses as InvalidConfig with
    /// the same diagnosis vocabulary the built-in adapters surface (ADR-0044).
    #[test]
    fn a_non_http_scheme_refuses_as_invalid_config() {
        let err = resolve_yoagent_model(
            Protocol::Anthropic,
            "file:///etc/passwd",
            "m",
            Some("sk-test".into()),
        )
        .unwrap_err();
        assert!(matches!(err, ProviderError::InvalidConfig(_)));
        assert!(err.to_string().contains("scheme"));
    }

    /// Known posture ids map onto the upstream levels; unknown ids and `None`
    /// honest-degrade to Off (the openai adapter's posture for unknown ids).
    #[test]
    fn thought_level_ids_map_with_honest_degrade() {
        assert_eq!(thinking_level_for(None), yoagent::ThinkingLevel::Off);
        assert_eq!(
            thinking_level_for(Some("high")),
            yoagent::ThinkingLevel::High
        );
        assert_eq!(
            thinking_level_for(Some("medium")),
            yoagent::ThinkingLevel::Medium
        );
        assert_eq!(thinking_level_for(Some("low")), yoagent::ThinkingLevel::Low);
        assert_eq!(
            thinking_level_for(Some("custom-tier")),
            yoagent::ThinkingLevel::Off
        );
    }
}
