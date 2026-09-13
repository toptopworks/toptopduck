//! The live construction path (ADR-0116, issue #918 -- the swap slice): the
//! wiring seam's single entry, the rig-backed twin of the yoagent layer's
//! `turn_loop_for`. Live facts (a profile-backed provider) construct the
//! REAL upstream model through rig's anthropic / openai clients -- sealed
//! here, so the wiring point names no upstream type beyond what the
//! integration layer's doc contract already allows (upstream types and
//! upstream names never escape `loop_runtime/`). Anything else (the
//! scripted test fake, `UnwiredProvider`) bridges onto the completion face
//! via `LoopRuntime::bridged`, so the offline test corpus keeps driving
//! turn execution through the SAME loop the production path runs (one
//! runtime, no second execution path).
//!
//! Configuration gates run BEFORE any client is built, in the order the
//! adapters and the yoagent resolution both held (ADR-0044 classification,
//! ADR-0029 key handling): a keyless profile refuses as `NotWired`, a
//! non-http base as `InvalidConfig`. rig's anthropic base-url
//! normalization (it strips a trailing `/v1` / `/messages` / `/v1/messages`
//! and re-appends `/v1/messages` itself) therefore runs only on a base the
//! scheme gate already admitted -- normalization cannot bypass the gate,
//! and a user-configured base that already carries `/v1` is idempotent
//! under it (where the yoagent resolution would have doubled the segment).
//!
//! HTTP client injection (ADR-0116 Decision 6): the app constructs the
//! reqwest client with redirects pinned off (`Policy::none`), so a
//! cross-host 3xx surfaces as an honest transient instead of following the
//! `Location` with the credential still on board. The injection point's
//! generic contract (rig's `http_client` accepts any type implementing its
//! `HttpClientExt`; `reqwest::Client` implements it in-tree) is verified
//! here by construction -- this is the only injection site.

use std::sync::Arc;

use rig_agent::agent::ModelHandle;
use rig_core::client::CompletionClient;
use rig_core::providers::{anthropic, openai};

use crate::model::Protocol;
use crate::provider::http::validate_http_base_url;
use crate::provider::{Provider, TurnModelFacts};
use crate::session::loop_contract::Termination;

use super::LoopRuntime;

/// Build the per-turn runner from an app provider object (the wiring seam's
/// single entry, the rig-backed twin). `Err` carries the turn's terminal
/// outcome for a facts resolution that refused before any round-trip -- a
/// keyless profile (`NotWired`) or a non-http base (`InvalidConfig`) -- with
/// the same vocabulary the adapters and the yoagent seam surfaced; the
/// caller lands it as a zero-round-trip `LoopOutcome`.
pub(crate) fn turn_loop_for(provider: Arc<dyn Provider>) -> Result<LoopRuntime, Termination> {
    match provider.turn_model_facts() {
        Some(facts) => live_runtime(facts),
        None => Ok(LoopRuntime::bridged(provider)),
    }
}

/// Construct the real upstream client + model handle from live facts. The
/// per-turn construction keeps the profile freshness the yoagent seam held
/// (a mid-session profile switch reroutes the very next turn -- the
/// protocol-flip pin rides the wire-level integration tests).
fn live_runtime(facts: TurnModelFacts) -> Result<LoopRuntime, Termination> {
    // Key first, then scheme -- the order the yoagent resolution held, so
    // a misconfigured profile surfaces the same first refusal it always
    // did (a keyless https base reports NotWired, not InvalidConfig).
    let api_key = facts.api_key.ok_or(Termination::NotWired)?;
    validate_http_base_url(&facts.base_url)
        .map_err(|e| Termination::InvalidConfig(e.to_string()))?;
    let base = facts.base_url.trim_end_matches('/');
    let http = egress_client().map_err(termination_for_build_failure)?;
    let handle = match facts.protocol {
        // The app's anthropic base is the host root; rig's normalization
        // keeps it there and appends `/v1/messages` itself, so the request
        // URL equals the built-in adapter's bit-for-bit.
        Protocol::Anthropic => ModelHandle::new(
            anthropic::Client::builder()
                .api_key(api_key)
                .base_url(base)
                .http_client(http)
                .build()
                .map_err(termination_for_build_failure)?
                .completion_model(&facts.model),
        ),
        // The app's openai face is chat-completions BYOK (custom
        // compatible endpoints), NOT the Responses API rig's default
        // `openai::Client` rides -- so the construction picks the
        // `CompletionsClient` flavor, which joins `/chat/completions`
        // onto the already-versioned base as-is.
        Protocol::Openai => ModelHandle::new(
            openai::CompletionsClient::builder()
                .api_key(api_key)
                .base_url(base)
                .http_client(http)
                .build()
                .map_err(termination_for_build_failure)?
                .completion_model(&facts.model),
        ),
    };
    Ok(LoopRuntime::new(handle).with_protocol(facts.protocol))
}

/// The bridged face's app-private key carrying the posture's thought level
/// through rig's additional-params channel (the live faces render the level
/// into real wire parameters instead, so the key never touches a real
/// endpoint). [`super::model`]'s request translation reads it back.
pub(crate) const BRIDGED_THOUGHT_LEVEL_KEY: &str = "app_thought_level";

/// Render the posture's thought level onto the request's additional
/// params (ADR-0103 / #918): the anthropic face carries the adaptive
/// thinking shape the retired yoagent seam actually wrote -- its compat
/// default turned adaptive thinking on, so the wire carried a thinking
/// type of adaptive plus an output-config effort, and the legacy budget
/// numbers lived only in a branch the app never enabled -- and the openai
/// face carries the reasoning effort, the same values that seam wrote;
/// the bridged face carries the app-private key instead. An absent level
/// (thinking off) contributes nothing, and an unknown posture id
/// contributes nothing either -- the same Off the retired seam's mapping
/// held for ids it did not recognize, on every face.
pub(crate) fn thought_level_params(
    protocol: Option<Protocol>,
    level: Option<&str>,
) -> serde_json::Map<String, serde_json::Value> {
    // Unknown ids degrade to Off, not to a guessed tier: the app does not
    // second-guess a level it cannot interpret.
    let Some(level) = level.filter(|l| matches!(*l, "minimal" | "low" | "medium" | "high")) else {
        return serde_json::Map::new();
    };
    let params = match protocol {
        Some(Protocol::Anthropic) => serde_json::json!({
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": effort_tier(level)},
        }),
        Some(Protocol::Openai) => serde_json::json!({
            "reasoning_effort": effort_tier(level),
        }),
        // The bridged face: the completion-model bridge reads the key back
        // so the app provider's request keeps its `thought_level` stamp.
        None => serde_json::json!({ BRIDGED_THOUGHT_LEVEL_KEY: level }),
    };
    params.as_object().cloned().unwrap_or_default()
}

/// The effort tier per known posture id -- the retired seam's mapping on
/// both live faces (minimal shares low's tier: neither wire carries a
/// tier below it).
fn effort_tier(level: &str) -> &'static str {
    match level {
        "medium" => "medium",
        "high" => "high",
        _ => "low",
    }
}

/// The app-constructed egress client injected into every live rig provider
/// (ADR-0116 Decision 6): redirects disabled at the client, so a
/// cross-host 3xx becomes an honest status the completion layer surfaces
/// as a transient -- structurally incapable of following a redirect with
/// the credential on board. A construction failure refuses the turn as an
/// honest transient rather than falling back to reqwest's default client,
/// whose redirect-following would silently undo the decision. TLS rides
/// the crate's rustls-only feature graph (see the Cargo.toml reqwest
/// declaration).
fn egress_client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
}

/// A client build failure is a construction-side fault, not a profile
/// refusal -- the gates above already validated everything user-owned, so
/// this lands as an honest transient with the cause attached.
fn termination_for_build_failure<E: std::fmt::Display>(err: E) -> Termination {
    Termination::Transient(format!("upstream client construction failed: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Protocol;

    /// A facts-less provider resolves onto the bridged runtime (the offline
    /// corpus's track), never the live construction -- the seam's fork is
    /// the provider's own facts signal, and `UnwiredProvider` carries none.
    #[test]
    fn a_facts_less_provider_bridges() {
        let provider: Arc<dyn Provider> = Arc::new(crate::provider::UnwiredProvider);
        // Ok = the bridged branch; the live branch is the only Err source
        // and it refuses on facts this provider does not present.
        turn_loop_for(provider).expect("the facts-less fork bridges, never refuses");
    }

    /// ADR-0029: a present-but-keyless profile refuses as NotWired before
    /// any client is built (zero round-trips, the configure-key signal).
    #[test]
    fn a_keyless_profile_refuses_as_not_wired() {
        let err = live_runtime(TurnModelFacts {
            protocol: Protocol::Anthropic,
            base_url: "https://api.anthropic.com".into(),
            model: "claude-test".into(),
            api_key: None,
        })
        .err()
        .expect("the keyless profile refuses");
        assert!(matches!(err, Termination::NotWired), "got {err:?}");
    }

    /// The shared scheme gate: a `file:` base refuses as InvalidConfig with
    /// the diagnosis vocabulary the adapters surface (ADR-0044) -- and the
    /// refusal happens BEFORE rig's base-url normalization could ever see
    /// the string, so normalization cannot pierce the gate.
    #[test]
    fn a_non_http_scheme_refuses_as_invalid_config() {
        let err = live_runtime(TurnModelFacts {
            protocol: Protocol::Anthropic,
            base_url: "file:///etc/passwd".into(),
            model: "m".into(),
            api_key: Some("sk-test".into()),
        })
        .err()
        .expect("the non-http base refuses");
        match err {
            Termination::InvalidConfig(detail) => {
                assert!(detail.contains("scheme"), "diagnosis: {detail}");
            }
            other => panic!("expected InvalidConfig, got {other:?}"),
        }
    }
}
#[cfg(test)]
mod thought_level_tests {
    use super::*;
    use crate::model::Protocol;

    /// The live anthropic rendering: the adaptive shape the retired seam
    /// wrote (a thinking type of adaptive plus an output-config effort;
    /// minimal shares low's tier).
    #[test]
    fn anthropic_renders_the_adaptive_effort() {
        let params = thought_level_params(Some(Protocol::Anthropic), Some("high"));
        assert_eq!(
            params.get("thinking").unwrap(),
            &serde_json::json!({"type": "adaptive"})
        );
        assert_eq!(
            params.get("output_config").unwrap(),
            &serde_json::json!({"effort": "high"})
        );
        assert_eq!(
            thought_level_params(Some(Protocol::Anthropic), Some("low"))
                .get("output_config")
                .unwrap(),
            &serde_json::json!({"effort": "low"})
        );
    }

    /// The live openai rendering: reasoning_effort, the retired seam's
    /// mapping (minimal shares low's tier).
    #[test]
    fn openai_renders_reasoning_effort() {
        let params = thought_level_params(Some(Protocol::Openai), Some("high"));
        assert_eq!(params.get("reasoning_effort").unwrap(), "high");
        assert_eq!(
            thought_level_params(Some(Protocol::Openai), Some("minimal"))
                .get("reasoning_effort")
                .unwrap(),
            "low"
        );
    }

    /// Off (no level) and unknown posture ids contribute nothing on any
    /// face -- the same Off the retired seam's mapping held for
    /// unrecognized ids -- and the bridged face carries the app-private
    /// key, never a real wire parameter.
    #[test]
    fn off_and_unknown_ids_contribute_nothing_and_the_bridge_carries_the_private_key() {
        assert!(
            thought_level_params(Some(Protocol::Anthropic), None).is_empty(),
            "thinking off: no parameter on the wire"
        );
        assert!(
            thought_level_params(None, None).is_empty(),
            "thinking off: nothing for the bridge either"
        );
        assert!(
            thought_level_params(Some(Protocol::Anthropic), Some("max")).is_empty(),
            "an unknown id degrades to Off, not a guessed tier"
        );
        assert!(
            thought_level_params(None, Some("old-level")).is_empty(),
            "an unknown id stamps nothing on the bridge either"
        );
        let bridged = thought_level_params(None, Some("high"));
        assert_eq!(
            bridged.get(BRIDGED_THOUGHT_LEVEL_KEY).unwrap(),
            "high",
            "the bridged face rides the app-private key alone"
        );
        assert_eq!(bridged.len(), 1, "no wire parameter leaks on the bridge");
    }
}
