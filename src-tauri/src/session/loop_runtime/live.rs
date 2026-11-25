//! The live construction path (ADR-0116, issue #918 -- the swap slice): the
//! wiring seam's single entry. Live facts (a profile-backed provider) construct the
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
//! adapters held (ADR-0044 classification,
//! ADR-0029 key handling): a keyless profile refuses as `NotWired`, a
//! non-http base as `InvalidConfig`. rig's anthropic base-url
//! normalization (it strips a trailing `/v1` / `/messages` / `/v1/messages`
//! and re-appends `/v1/messages` itself) therefore runs only on a base the
//! scheme gate already admitted -- normalization cannot bypass the gate,
//! and a user-configured base that already carries `/v1` is idempotent
//! under it.
//!
//! HTTP client injection (ADR-0116 Decision 6): the app constructs the
//! reqwest client with redirects pinned off (`Policy::none`), so a
//! cross-host 3xx surfaces as an honest transient instead of following the
//! `Location` with the credential still on board. The injection point's
//! generic contract (rig's `http_client` accepts any type implementing its
//! `HttpClientExt`; `reqwest::Client` implements it in-tree) is verified
//! here by construction -- this is the only injection site. Since #1653
//! the injected client is the per-turn transport-liveness wrapper
//! ([`super::transport::LivenessClient`]) over that shared egress client:
//! streaming body chunks re-arm the turn's no-progress clock, so an
//! upstream queue/processing heartbeat (SSE comment lines the parser
//! swallows) keeps a live stream alive under ADR-0115's calibrated
//! bytes-are-liveness predicate.

use std::sync::Arc;

use rig_agent::agent::ModelHandle;
use rig_core::client::CompletionClient;
use rig_core::completion::CompletionModel as _;
use rig_core::providers::{anthropic, openai};

use crate::cancel::CancelToken;
use crate::model::Protocol;
use crate::provider::http::validate_http_base_url;
use crate::provider::output_cap;
use crate::provider::{Provider, TurnModelFacts};
use crate::session::loop_contract::Termination;

use super::transport::LivenessClient;
use super::LoopRuntime;

/// Build the per-turn runner from an app provider object (the wiring seam's
/// single entry). `Err` carries the turn's terminal
/// outcome for a facts resolution that refused before any round-trip -- a
/// keyless profile (`NotWired`), a non-http base (`InvalidConfig`), or a
/// model-less profile with no posture selection (`NoModel`, ADR-0154) --
/// with the same vocabulary the adapters surfaced; the caller lands it as
/// a zero-round-trip `LoopOutcome`.
///
/// `facts` is the provider's per-turn construction facts, resolved ONCE by
/// the caller: the built-in turn's posture gate reads the endpoint off the
/// same facts the loop constructs from, so a second read here could compare
/// against a different endpoint than the one that serves the turn. The
/// `None` arm bridges a facts-less provider as-is (the scripted test fake).
///
/// `posture_model` is the session-level model selection (#1639,
/// ADR-0153), already scoped to this endpoint by the caller (ADR-0154):
/// `Some` overrides the facts' pinned profile model for the turn -- the
/// posture pair's model half rides the same per-turn construction as a
/// profile switch, so a selection lands the next turn. The bridged face
/// ignores it (a facts-less provider takes no model).
pub(crate) fn turn_loop_for(
    provider: Arc<dyn Provider>,
    facts: Option<TurnModelFacts>,
    posture_model: Option<&str>,
    cancel: Option<&Arc<CancelToken>>,
) -> Result<LoopRuntime, Termination> {
    match facts {
        Some(mut facts) => {
            if let Some(model) = posture_model {
                facts.model = Some(model.to_string());
            }
            live_runtime(facts, cancel)
        }
        None => Ok(LoopRuntime::bridged(provider)),
    }
}

/// Construct the real upstream client + model handle from live facts (the
/// shared construction behind both live faces: the session loop's runner
/// and the extraction one-shot). Profile freshness survives the shared
/// egress client: key and base ride this per-turn construction into the
/// provider builder itself, so a mid-session profile switch reroutes the
/// very next turn (the protocol-flip pin rides the wire-level integration
/// tests) while the connection pool beneath it stays shared (#926).
fn handle_from_facts(
    facts: &TurnModelFacts,
    cancel: Option<&Arc<CancelToken>>,
) -> Result<ModelHandle, Termination> {
    // Key first, then scheme, so
    // a misconfigured profile surfaces the same first refusal it always
    // did (a keyless https base reports NotWired, not InvalidConfig).
    let api_key = facts.api_key.clone().ok_or(Termination::NotWired)?;
    validate_http_base_url(&facts.base_url)
        .map_err(|e| Termination::InvalidConfig(e.to_string()))?;
    // Then the model (ADR-0154): an unpinned profile with no session
    // selection has nothing to request, and no id is invented for it. The
    // refusal lands here -- before any client is built -- so a model-less
    // facts can never reach the wire.
    let model = facts.model.clone().ok_or(Termination::NoModel)?;
    let base = facts.base_url.trim_end_matches('/');
    // The transport-liveness wrapper (#1653) over the shared egress client:
    // pool sharing is unchanged, and streaming chunks re-arm the turn's
    // no-progress clock. `cancel` is the loop's token on the turn path; the
    // extraction one-shot passes `None`, which makes the wrapper a pure
    // pass-through.
    let http = LivenessClient::new(
        egress_client().map_err(termination_for_build_failure)?,
        cancel.cloned(),
    );
    Ok(match facts.protocol {
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
                .completion_model(&model),
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
                .completion_model(&model),
        ),
    })
}

/// Construct the session loop's per-turn runner from live facts. The
/// stamped output cap (issue #1001) and the serving model name
/// (ADR-0130 Decision 4's occupancy-denominator key, #1290) reads the
/// SAME facts that built
/// the handle above, so both are keyed on the exact model serving the
/// turn -- a profile switch lands handle + cap + denominator together,
/// never apart. The turn start here is also the model catalog's lazy
/// refresh trigger (#1638, ADR-0152): the ONE consumption point that
/// implies a provider profile exists -- zero-profile and CLI-only setups
/// never reach it, and the CLI channels' occupancy stamps are pure chain
/// reads that never trigger, so those setups egress nothing.
fn live_runtime(
    facts: TurnModelFacts,
    cancel: Option<&Arc<CancelToken>>,
) -> Result<LoopRuntime, Termination> {
    // Gates first: a refused turn (no key / bad base / no model) must not
    // trigger the catalog's lazy refresh below -- a refusal egresses nothing.
    let handle = handle_from_facts(&facts, cancel)?;
    crate::provider::model_catalog::ensure_fresh();
    // The gates above refused a model-less facts, so this is the model the
    // handle was just built for -- re-read rather than unwrap.
    let model = facts.model.clone().ok_or(Termination::NoModel)?;
    Ok(LoopRuntime::live(
        handle,
        facts.protocol,
        output_cap::output_token_cap(&model),
        model,
    ))
}

/// The extraction engine's single model call (issue #1530): one
/// NON-streaming round-trip over live facts -- the same dispatch
/// [`turn_loop_for`] applies, so a production extraction constructs the
/// REAL upstream clients (never the completion face only the scripted
/// fake answers). Blocking by design: the extraction lane owns a
/// dedicated thread, so this parks THAT thread for the call's duration,
/// never a tokio worker. `Err` carries the completion face's
/// [`ProviderError`] vocabulary.
pub(crate) fn one_shot_tool_turn(
    facts: TurnModelFacts,
    request: &crate::provider::tool_calling::ToolTurnRequest,
) -> Result<crate::provider::tool_calling::ToolTurnOutcome, crate::provider::ProviderError> {
    use crate::provider::ProviderError;
    // No loop token on the extraction lane (#1653): the one-shot rides the
    // same construction, and its wrapper leg is a pure pass-through.
    let handle = handle_from_facts(&facts, None).map_err(|term| match term {
        Termination::NotWired => ProviderError::NotWired,
        Termination::InvalidConfig(detail) => ProviderError::InvalidConfig(detail),
        other => ProviderError::Unavailable(format!("{other:?}")),
    })?;
    // The loop's split, one message deep: the LAST message is the prompt,
    // everything before it the history (the extraction request carries
    // exactly one user message; no tools are advertised).
    let mut history = super::model::to_rig_history(&request.messages);
    let Some(prompt) = history.pop() else {
        return Err(ProviderError::Unavailable(
            "empty extraction request: no prompt message".to_string(),
        ));
    };
    let completion = handle
        .completion_request(prompt)
        .preamble(request.system.clone())
        .messages(history)
        .max_tokens(u64::from(request.max_tokens))
        .build();
    let response = tauri::async_runtime::block_on(handle.completion(completion))
        .map_err(|err| ProviderError::Unavailable(err.to_string()))?;
    // Terminal text only -- the request advertises no tools, so the
    // round's text items ARE the reply (any non-text content drops).
    let mut text = String::new();
    for item in response.choice {
        if let rig_core::message::AssistantContent::Text(chunk) = item {
            text.push_str(&chunk.text);
        }
    }
    Ok(crate::provider::tool_calling::ToolTurnOutcome::from(
        crate::provider::tool_calling::ToolTurnReply::Text(text),
    ))
}

/// The bridged face's app-private key carrying the posture's thought level
/// through rig's additional-params channel (the live faces render the level
/// into real wire parameters instead, so the key never touches a real
/// endpoint). [`super::model`]'s request translation reads it back.
pub(crate) const BRIDGED_THOUGHT_LEVEL_KEY: &str = "app_thought_level";

/// Render the posture's thought level onto the request's additional
/// params (ADR-0103 / #918): the anthropic face carries the adaptive
/// thinking shape -- a thinking type of adaptive plus an output-config
/// effort -- and the openai
/// face carries the reasoning effort;
/// the bridged face carries the app-private key instead. An absent level
/// (thinking off) contributes nothing, and an unknown posture id
/// contributes nothing either -- Off on every face.
pub(crate) fn thought_level_params(
    protocol: Option<Protocol>,
    level: Option<&str>,
) -> serde_json::Map<String, serde_json::Value> {
    // Unknown ids degrade to Off, not to a guessed tier: the app does not
    // second-guess a level it cannot interpret.
    let Some(level) = level.filter(|l| crate::provider::is_wire_effort(l)) else {
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

/// Hand out the shared egress client for one live turn (issue #926): the
/// process-wide async singleton -- redirects pinned off, proxy snapshot
/// frozen at the first successful build -- lives in
/// [`crate::egress::async_client`] (ADR-0139's shared construction seam),
/// shared with the preflight probes' blocking twin and the MCP remote
/// transports. Only a successful build is cached: a construction failure
/// refuses its turn as an honest transient and stays uncached, so the next
/// turn retries the build -- the per-turn retry posture survives the
/// sharing.
fn egress_client() -> Result<reqwest::Client, reqwest::Error> {
    crate::egress::async_client()
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
        let runtime = turn_loop_for(provider, None, None, None)
            .expect("the facts-less fork bridges, never refuses");
        // Issue #1001: the bridged face carries no model-keyed cap -- no
        // facts, no stamp; the request keeps its assembled cap. #1290: no
        // name either -- its occupancy readings stay hollow.
        assert_eq!(runtime.output_cap, None);
        assert_eq!(runtime.model_name, None);
    }

    /// #1290: the live factory carries the serving model's NAME beside the
    /// handle and the cap -- the occupancy denominator stamp keys on the
    /// exact model that served the turn, the same never-drifts posture the
    /// cap pin above holds.
    #[test]
    fn live_factory_carries_the_model_name_for_the_occupancy_stamp() {
        let runtime = live_runtime(
            TurnModelFacts {
                protocol: Protocol::Anthropic,
                base_url: "https://api.anthropic.com".into(),
                model: Some("glm-4.6".into()),
                api_key: Some("sk-test".into()),
            },
            None,
        )
        .expect("a fully-present profile builds the live runtime");
        assert_eq!(runtime.model_name.as_deref(), Some("glm-4.6"));
    }

    /// Issue #1001's wiring half, pinned: the live factory stamps the
    /// catalog's answer for the facts' model -- the same facts that built
    /// the handle -- so a catalog-hit model's live runtime carries its
    /// documented ceiling and a miss carries the global cap. The seam pin
    /// in the module suite cannot see this (it drives the stamp through
    /// the test seam); without this pin, any wrong value at the factory's
    /// call ships undetected (offline -- the construction builds the
    /// shared client but sends nothing).
    #[test]
    fn live_factory_stamps_the_catalog_cap_for_the_facts_model() {
        let runtime = live_runtime(
            TurnModelFacts {
                protocol: Protocol::Anthropic,
                base_url: "https://api.anthropic.com".into(),
                model: Some("claude-3-haiku-20240307".into()),
                api_key: Some("sk-test".into()),
            },
            None,
        )
        .expect("a fully-present profile builds the live runtime");
        assert_eq!(
            runtime.output_cap,
            Some(4_096),
            "a catalog-hit model carries its documented ceiling"
        );
        let runtime = live_runtime(
            TurnModelFacts {
                protocol: Protocol::Anthropic,
                base_url: "https://api.anthropic.com".into(),
                model: Some("claude-sonnet-4-6".into()),
                api_key: Some("sk-test".into()),
            },
            None,
        )
        .expect("a fully-present profile builds the live runtime");
        assert_eq!(
            runtime.output_cap,
            Some(crate::provider::output_cap::OUTPUT_TOKEN_CAP),
            "a catalog miss carries the global cap"
        );
    }

    /// ADR-0029: a present-but-keyless profile refuses as NotWired before
    /// any client is built (zero round-trips, the configure-key signal).
    #[test]
    fn a_keyless_profile_refuses_as_not_wired() {
        let err = live_runtime(
            TurnModelFacts {
                protocol: Protocol::Anthropic,
                base_url: "https://api.anthropic.com".into(),
                model: Some("claude-test".into()),
                api_key: None,
            },
            None,
        )
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
        let err = live_runtime(
            TurnModelFacts {
                protocol: Protocol::Anthropic,
                base_url: "file:///etc/passwd".into(),
                model: Some("m".into()),
                api_key: Some("sk-test".into()),
            },
            None,
        )
        .err()
        .expect("the non-http base refuses");
        match err {
            Termination::InvalidConfig(detail) => {
                assert!(detail.contains("scheme"), "diagnosis: {detail}");
            }
            other => panic!("expected InvalidConfig, got {other:?}"),
        }
    }

    /// ADR-0154 priority: a keyless unpinned profile still refuses as
    /// NotWired -- the key gate runs first, so the model refusal never masks
    /// the configure-key signal.
    #[test]
    fn a_keyless_unpinned_profile_refuses_as_not_wired() {
        let err = live_runtime(
            TurnModelFacts {
                protocol: Protocol::Anthropic,
                base_url: "https://api.anthropic.com".into(),
                model: None,
                api_key: None,
            },
            None,
        )
        .err()
        .expect("the keyless profile refuses");
        assert!(matches!(err, Termination::NotWired), "got {err:?}");
    }

    /// The model gate (ADR-0154): a keyed profile with no pinned model and
    /// no posture selection refuses as NoModel before any client is built --
    /// zero round-trips, the pick-a-model signal. The scheme gate still runs
    /// ahead of it: a bad base reports InvalidConfig with or without a model.
    #[test]
    fn an_unpinned_profile_refuses_as_no_model() {
        let err = live_runtime(
            TurnModelFacts {
                protocol: Protocol::Anthropic,
                base_url: "https://api.anthropic.com".into(),
                model: None,
                api_key: Some("sk-test".into()),
            },
            None,
        )
        .err()
        .expect("the model-less profile refuses");
        assert!(matches!(err, Termination::NoModel), "got {err:?}");
        let err = live_runtime(
            TurnModelFacts {
                protocol: Protocol::Anthropic,
                base_url: "file:///etc/passwd".into(),
                model: None,
                api_key: Some("sk-test".into()),
            },
            None,
        )
        .err()
        .expect("the non-http base refuses");
        assert!(matches!(err, Termination::InvalidConfig(_)), "got {err:?}");
    }

    /// ADR-0154: the posture model completes an unpinned profile's facts --
    /// the session selection IS the request model, so no pinned default is
    /// needed for a selected turn.
    #[test]
    fn turn_loop_for_takes_the_posture_model_over_an_unpinned_profile() {
        let provider: Arc<dyn Provider> = Arc::new(crate::provider::UnwiredProvider);
        let runtime = turn_loop_for(
            provider,
            Some(TurnModelFacts {
                protocol: Protocol::Anthropic,
                base_url: "https://api.anthropic.com".into(),
                model: None,
                api_key: Some("sk-test".into()),
            }),
            Some("glm-4.6"),
            None,
        )
        .expect("the posture model completes the facts");
        assert_eq!(runtime.model_name.as_deref(), Some("glm-4.6"));
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
