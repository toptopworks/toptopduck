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
/// single entry). `Err` carries the turn's terminal
/// outcome for a facts resolution that refused before any round-trip -- a
/// keyless profile (`NotWired`) or a non-http base (`InvalidConfig`) -- with
/// the same vocabulary the adapters surfaced; the
/// caller lands it as a zero-round-trip `LoopOutcome`.
pub(crate) fn turn_loop_for(provider: Arc<dyn Provider>) -> Result<LoopRuntime, Termination> {
    match provider.turn_model_facts() {
        Some(facts) => live_runtime(facts),
        None => Ok(LoopRuntime::bridged(provider)),
    }
}

/// Construct the real upstream client + model handle from live facts.
/// Profile freshness survives the shared egress client: key and base ride
/// this per-turn construction into the provider builder itself, so a
/// mid-session profile switch reroutes the very next turn (the
/// protocol-flip pin rides the wire-level integration tests) while the
/// connection pool beneath it stays shared (#926).
fn live_runtime(facts: TurnModelFacts) -> Result<LoopRuntime, Termination> {
    // Key first, then scheme, so
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
    Ok(LoopRuntime::live(handle, facts.protocol))
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

/// Test-only construction counter for the shared egress client (issue
/// #926): proves the client is built at most once across the process, so
/// every live turn draws from one shared connection pool. Read by
/// `egress_client_builds_only_once_across_calls`; compiled out of release
/// builds (the probe face's `EGRESS_AGENT` counter is the precedent).
#[cfg(test)]
static EGRESS_CLIENT_BUILDS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// The process-shared egress client injected into every live rig provider
/// (ADR-0116 Decision 6, shared since issue #926): redirects disabled at
/// the client, so a cross-host 3xx becomes an honest status the completion
/// layer surfaces as a transient -- structurally incapable of following a
/// redirect with the credential on board. TLS rides the crate's
/// rustls-only feature graph (see the Cargo.toml reqwest declaration).
///
/// Built once per process and shared across turns and sessions: the client
/// carries no per-profile state (key and base ride each turn's provider
/// builder), so sharing it costs no profile freshness while restoring
/// keep-alive reuse for BYOK multi-turn sessions -- the per-turn rebuild
/// dropped the connection pool and TLS sessions with every round. Clones
/// share the pool (`reqwest::Client` is `Arc` internally); the probe
/// face's `EGRESS_AGENT` singleton is the precedent. Only a successful
/// build is cached: a construction failure refuses its turn as an honest
/// transient and stays uncached, so the next turn retries the build --
/// the per-turn retry posture survives the sharing.
static EGRESS_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

/// Hand out the shared egress client (issue #926): a clone per call, one
/// build per process -- see [`EGRESS_CLIENT`].
fn egress_client() -> Result<reqwest::Client, reqwest::Error> {
    if let Some(client) = EGRESS_CLIENT.get() {
        return Ok(client.clone());
    }
    #[cfg(test)]
    EGRESS_CLIENT_BUILDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    // First-wins under a race (two turns' first calls racing the init):
    // both built, one pool wins, the loser's drops unused -- once, harmless.
    let _ = EGRESS_CLIENT.set(client.clone());
    Ok(client)
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

    /// The egress client is process-shared (issue #926): every live turn
    /// draws from one client, so the connection pool and TLS sessions
    /// survive across turns -- a BYOK multi-turn session reuses keep-alive
    /// connections instead of re-handshaking every round. The counter
    /// snapshots bracket the calls and the build count must not advance on
    /// the 2nd+ call, regardless of whether another test already
    /// initialized the client (tests run in parallel, so `before` may
    /// already be non-zero) -- the probe face's `EGRESS_AGENT` pin is the
    /// precedent this mirrors.
    #[test]
    fn egress_client_builds_only_once_across_calls() {
        let before = EGRESS_CLIENT_BUILDS.load(std::sync::atomic::Ordering::Relaxed);
        let _first = egress_client().expect("the shared client builds");
        let after_first = EGRESS_CLIENT_BUILDS.load(std::sync::atomic::Ordering::Relaxed);
        let _second = egress_client().expect("the shared client builds");
        let _third = egress_client().expect("the shared client builds");
        let after_third = EGRESS_CLIENT_BUILDS.load(std::sync::atomic::Ordering::Relaxed);

        assert!(
            after_first - before <= 1,
            "the first call builds the client at most once (got {} builds)",
            after_first - before
        );
        assert_eq!(
            after_third, after_first,
            "subsequent calls never rebuild the client"
        );
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
