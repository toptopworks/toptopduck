//! LLM provider config (issue #29/#150, ADR-0007/0019/0029/0064). Multi-profile
//! provider config (ADR-0064): a list of named access profiles (protocol +
//! endpoint + model) plus the id of the active one. The active profile drives
//! the live provider; its id is the keychain account suffix (`key-<id>`). The
//! API key is NOT here (ADR-0029/0038: key only in the OS keychain, never in
//! app-config).

use serde::{Deserialize, Serialize};

/// v1 default endpoint (ADR-0019: Anthropic native protocol + configurable
/// `baseURL`; default is Anthropic direct).
pub const DEFAULT_PROVIDER_BASE_URL: &str = "https://api.anthropic.com";

/// v1 default model (ADR-0007: Sonnet-class, version-pinned). SQL + structured
/// JSON output at top tier with controllable cost; the user can switch to a
/// stronger (Fable/Opus) or cheaper (Haiku) model via the config.
pub const DEFAULT_PROVIDER_MODEL: &str = "claude-sonnet-4-6";

/// The wire protocol a profile speaks (ADR-0064). Two variants: anthropic
/// (Anthropic Messages native, `x-api-key` auth) and openai (OpenAI Chat
/// Completions, Bearer auth; covers OpenAI direct / DeepSeek / GLM / Qwen /
/// Ollama compatible endpoints). Crosses IPC as the bare lowercase variant
/// name (mirrors the ChartKind convention).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    #[default]
    Anthropic,
    /// OpenAI Chat Completions wire protocol (ADR-0064). A pure HTTP
    /// translation layer: Chat Completions request shape, Bearer auth, reads
    /// `choices[0].message.content`, reuses the shared `parse_reply`. Covers
    /// OpenAI direct / DeepSeek / GLM / Qwen / Ollama compatible endpoints --
    /// the user points `base_url` at the endpoint (incl. its version path
    /// segment, e.g. `/v1`); the adapter appends `/chat/completions`.
    Openai,
}

/// Stable identity of a provider profile (ADR-0064, mirroring the ADR-0037
/// reference_name half of the stable-vs-display split). Created once when the
/// profile is minted and never mutated thereafter -- [`ProviderProfile::display_name`]
/// is the renamable half. Opaque: carried verbatim across IPC and used as the
/// keychain account suffix (`key-<id>`). Callers must not assume any structure.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProfileId(pub String);

impl ProfileId {
    /// The id as a string slice (for keychain account formatting, lookups, etc.).
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ProfileId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl AsRef<str> for ProfileId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl Default for ProfileId {
    fn default() -> Self {
        // Falls back to the default profile's id so a config missing the
        // active_profile field (serde default) points at the built-in default
        // profile rather than an empty / dangling id.
        Self(DEFAULT_PROFILE_ID.to_string())
    }
}

/// The id of the built-in default profile (ADR-0064/0038 honest-degrade +
/// first-launch skeleton). FIXED so repeated first-launches and degrades
/// converge on the same keychain account (`key-default`) rather than minting a
/// fresh id each time -- a user who sets a key once keeps it across a degrade.
/// User-created profiles (a follow-up slice) will mint their own ids.
pub const DEFAULT_PROFILE_ID: &str = "default";

/// Display name of the built-in default profile.
const DEFAULT_PROFILE_DISPLAY_NAME: &str = "Anthropic";

/// One named access profile (ADR-0064): protocol + endpoint + model. The key
/// lives separately in the OS keychain under `key-<id>` (ADR-0029/0038). `id`
/// is stable (created once); `display_name` is renamable (ADR-0037 split).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderProfile {
    /// Stable identity (ADR-0037 reference half); also the keychain account
    /// suffix (`key-<id>`).
    pub id: ProfileId,
    /// Renamable display label (ADR-0037 display half). Sans key, sans protocol
    /// semantics -- purely what the UI shows.
    #[serde(default)]
    pub display_name: String,
    /// Wire protocol (ADR-0064); defaults to Anthropic.
    #[serde(default)]
    pub protocol: Protocol,
    /// Anthropic Messages API base URL (ADR-0019: configurable `baseURL`,
    /// default Anthropic direct). A user's own Anthropic-compatible gateway goes
    /// here. `#[serde(default)]` keeps older stored blobs deserializing.
    #[serde(default = "default_provider_base_url")]
    pub base_url: String,
    /// Model id to request (ADR-0007: default Sonnet-class, pinned).
    #[serde(default = "default_provider_model")]
    pub model: String,
}

impl ProviderProfile {
    /// The built-in default anthropic profile (ADR-0064 skeleton): the
    /// honest-degrade target and the single profile this slice ships.
    pub fn default_anthropic() -> Self {
        Self {
            id: ProfileId(DEFAULT_PROFILE_ID.to_string()),
            display_name: DEFAULT_PROFILE_DISPLAY_NAME.to_string(),
            protocol: Protocol::Anthropic,
            base_url: DEFAULT_PROVIDER_BASE_URL.to_string(),
            model: DEFAULT_PROVIDER_MODEL.to_string(),
        }
    }
}

/// Serde default for a profile's [`ProviderProfile::base_url`] (used at
/// deserialize time for older blobs and by [`ProviderProfile::default_anthropic`]).
fn default_provider_base_url() -> String {
    DEFAULT_PROVIDER_BASE_URL.to_string()
}

/// Serde default for a profile's [`ProviderProfile::model`].
fn default_provider_model() -> String {
    DEFAULT_PROVIDER_MODEL.to_string()
}

/// Non-secret multi-profile provider config (ADR-0064): a list of named access
/// profiles plus the id of the active one. Never carries the API key
/// (ADR-0029/0038 -- the key lives only in the OS keychain under `key-<id>`).
/// This is BOTH the app-config storage shape ([`crate::app_config::AppConfig`].provider)
/// AND the `set_provider_config` IPC input -- one shape, no DRY split between a
/// "storage" and a "wire" variant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderConfig {
    /// The named access profiles (ADR-0064). At least one in any valid config;
    /// [`ProviderConfig::defaults`] seeds the single default anthropic profile.
    #[serde(default)]
    pub profiles: Vec<ProviderProfile>,
    /// The id of the active profile (ADR-0064: global single active). Its
    /// protocol + endpoint + model drive the live provider, and its id drives
    /// the keychain account the key is read from.
    #[serde(default)]
    pub active_profile: ProfileId,
}

impl ProviderConfig {
    /// The built-in defaults (ADR-0064): one anthropic profile, active.
    pub fn defaults() -> Self {
        let profile = ProviderProfile::default_anthropic();
        Self {
            active_profile: profile.id.clone(),
            profiles: vec![profile],
        }
    }

    /// The active profile, or `None` when no profile matches `active_profile`
    /// (a malformed config that [`crate::app_config::AppConfig::normalize`]
    /// repairs). Live readers fall back to the canonical defaults when this
    /// returns `None` so a hand-edited gap never hands the provider an empty
    /// endpoint.
    pub fn active(&self) -> Option<&ProviderProfile> {
        self.profiles.iter().find(|p| p.id == self.active_profile)
    }

    /// Mutable access to the active profile, or `None` when no profile matches
    /// `active_profile`. [`crate::app_config::AppConfig::normalize`] establishes
    /// the invariant (non-empty + active points at a real profile) before
    /// callers that `expect` a profile run.
    pub fn active_mut(&mut self) -> Option<&mut ProviderProfile> {
        self.profiles
            .iter_mut()
            .find(|p| p.id == self.active_profile)
    }

    /// The active profile's base URL, or the canonical default when no profile
    /// matches `active_profile` (a malformed config normalize repairs). Shared
    /// by the live provider read path and the IPC view so a dangling active
    /// always yields the same endpoint the provider itself uses, never "".
    pub fn effective_base_url(&self) -> &str {
        self.active()
            .map(|p| p.base_url.as_str())
            .unwrap_or_else(|| {
                log::warn!(
                    "active_profile does not match any profile; falling back to \
                     default base_url for this read"
                );
                DEFAULT_PROVIDER_BASE_URL
            })
    }

    /// The active profile's model, or the canonical default (see
    /// [`Self::effective_base_url`]).
    pub fn effective_model(&self) -> &str {
        self.active().map(|p| p.model.as_str()).unwrap_or_else(|| {
            log::warn!(
                "active_profile does not match any profile; falling back to \
                     default model for this read"
            );
            DEFAULT_PROVIDER_MODEL
        })
    }

    /// The active profile's wire protocol, or [`Protocol::Anthropic`] when no
    /// profile matches `active_profile` (a malformed config normalize repairs).
    /// Drives the live provider's per-turn adapter routing (issue #152,
    /// ADR-0064): `LiveProvider` reads this each turn so a protocol switch on
    /// the active profile lands the next turn on the new adapter, no caching.
    pub fn effective_protocol(&self) -> Protocol {
        match self.active() {
            Some(profile) => profile.protocol,
            None => {
                // A malformed config whose active_profile points nowhere: log
                // the silent fallback so the misconfiguration is observable.
                // normalize repairs it on the next store; a hand-edit gap
                // otherwise lands the turn on the Anthropic default with no
                // trace, and a wrong-protocol turn is hard to diagnose from
                // the bare NotWired/Unavailable it produces downstream.
                log::warn!(
                    "active_profile does not match any profile; falling back to \
                     Anthropic protocol for this turn"
                );
                Protocol::Anthropic
            }
        }
    }

    /// The IPC-shaped view of the active profile's endpoint + key status
    /// (ADR-0029: only a boolean + read-fault detail cross, never the key).
    /// Issue #275: the keychain read outcome rides in as a `Result` so a read
    /// fault surfaces on `keychain_fault` (with `has_key` a placeholder false)
    /// instead of being honest-degraded behind a bare `false`. One shape for
    /// both `get_provider_config` and `set_provider_config` so the
    /// active-missing fallback policy is single-sourced, not duplicated per
    /// call site.
    pub fn view(&self, key_read: Result<bool, String>) -> ProviderConfigView {
        let (has_key, keychain_fault) = match key_read {
            Ok(has_key) => (has_key, None),
            Err(detail) => (false, Some(detail)),
        };
        ProviderConfigView {
            base_url: self.effective_base_url().to_string(),
            model: self.effective_model().to_string(),
            has_key,
            keychain_fault,
        }
    }
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self::defaults()
    }
}

/// The get_provider_config view (ADR-0029): the effective base URL + model the
/// provider uses, plus the active profile's key status -- `has_key` (a boolean,
/// never the key itself) and a keychain read-fault detail. The frontend's header
/// key indicator learns whether to prompt for a key without ever receiving it,
/// and distinguishes a read fault from a legitimate no-key state (issue #275).
/// One shape for both `get_provider_config` and `set_provider_config` so the
/// active-missing fallback policy is single-sourced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderConfigView {
    pub base_url: String,
    pub model: String,
    /// Whether an API key is stored in the OS keychain. A boolean only (ADR-0029
    /// invariant 3: the key never crosses to the frontend). When
    /// [`Self::keychain_fault`] is `Some`, the read failed and this is a
    /// placeholder `false` (the status is unknown, not empty).
    pub has_key: bool,
    /// A keychain READ failure detail (issue #275): `None` when the read
    /// succeeded (has_key authoritative); `Some(detail)` when the OS keychain
    /// read failed (locked / service down / permission revoked / corrupt entry).
    /// Technical English only (ADR-0029 -- never the key). See
    /// [`ProfileKeyStatus::keychain_fault`].
    pub keychain_fault: Option<String>,
}

/// Per-profile key-status overlay (issue #153, ADR-0064/0029). The Profiles
/// management UI lists every profile with whether its keychain slot
/// (`key-<profile_id>`) holds a key -- a boolean only, never the key itself
/// (ADR-0029 invariant 3). The profile RECORDS come from app-config (the single
/// source of truth for the list); this view only carries the key status the
/// app-config deliberately does not store. `list_provider_profiles` returns one
/// entry per profile currently in app-config.
///
/// Issue #275 adds `keychain_fault`: a non-echoing read-failure detail distinct
/// from "no key stored". When the OS keychain read itself fails (locked /
/// service down / permission revoked / corrupt entry), `has_key` is `false`
/// (a placeholder -- the read could not confirm either way) and `keychain_fault`
/// carries the technical English detail for the frontend's details fold, so the
/// status surface renders "keychain unavailable" instead of misreading as "no
/// key configured" (the pre-#275 bool honest-degrade hid the fault). Mirrors
/// [`ProfileTestOutcome::KeychainUnavailable`] (issue #243); ADR-0029
/// invariant 3 holds (never the key itself).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileKeyStatus {
    /// The stable profile id (also the keychain account suffix `key-<id>`).
    pub profile_id: String,
    /// Whether a key is stored for this profile. A boolean only (ADR-0029).
    /// When [`Self::keychain_fault`] is `Some`, the read failed and this is a
    /// placeholder `false` (the status is unknown, not empty).
    pub has_key: bool,
    /// A keychain READ failure detail (issue #275): `None` when the read
    /// succeeded (has_key is authoritative); `Some(detail)` when the OS
    /// keychain read failed. Technical English (no key leaked, ADR-0029) for
    /// the frontend's details fold, matching
    /// [`StoreCommandError::KeychainFailure`](crate::commands::StoreCommandError).
    pub keychain_fault: Option<String>,
}

/// One connection-preflight outcome (ADR-0070). Returned by the `test_profile`
/// IPC when the user clicks "Test connection" in the Profiles edit form, after
/// the Rust core reads the profile's stored key from the OS keychain and probes
/// the endpoint. Six states along the ADR-0044 axis:
///
/// - [`ProfileTestOutcome::Ok`]: the probe succeeded; `models` carries the
///   model ids listed by `GET /models` (fed to the model dropdown). Empty when
///   the endpoint answered a minimal turn (ping fallback) but does not implement
///   `/models` -- the dropdown then falls back to a hand-typed input.
/// - [`ProfileTestOutcome::KeyRejected`]: no key is stored for the profile, or
///   the endpoint rejected it (HTTP 401/403). Permanent for the profile -- the
///   user must configure a valid key (ADR-0044 NotWired).
/// - [`ProfileTestOutcome::KeychainUnavailable`]: the OS keychain read itself
///   failed (locked, service down, permission revoked, corrupt entry) -- the
///   probe never ran (issue #243). The trust root is unavailable (ADR-0029),
///   distinct from KeyRejected: the fix is repairing the OS keychain, not the
///   key.
/// - [`ProfileTestOutcome::EndpointUnreachable`]: a transport failure (DNS /
///   TCP / TLS / timeout) -- the endpoint could not be reached at all.
/// - [`ProfileTestOutcome::InvalidEndpoint`]: the endpoint URL is permanently
///   invalid (issue #279) -- a non-http/https scheme (`file:`, `data:`, or
///   scheme-less) rejected at the boundary before any probe fires. Distinct
///   from `EndpointUnreachable` (a transport fault on a VALID url): this is a
///   configuration error, not a network failure, so the fix is correcting the
///   protocol, not debugging DNS/TLS.
/// - [`ProfileTestOutcome::Incompatible`]: the endpoint responded (HTTP non-auth
///   status, or a 200 body that is not a model list) AND a minimal turn ping
///   also failed for a non-key, non-transport reason -- the endpoint is alive
///   but does not serve a usable chat/messages contract.
///
/// Adjacently-tagged (`#[serde(tag = "kind", content = "data")]`) like the other
/// IPC enums; the `detail` on `Incompatible` / `KeychainUnavailable` is a
/// technical English string for the frontend's details fold -- intentionally
/// NOT localized (it stays out of the ADR-0052 translation catalog; the
/// user-facing label is the locale id). Mirrored by `src/types/provider.ts` --
/// the wire shape is pinned by `tests/ipc_contract.rs`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum ProfileTestOutcome {
    /// The probe succeeded. `models` feeds the model dropdown (ADR-0070); empty
    /// when only the ping fallback succeeded (the endpoint runs turns but does
    /// not implement `/models`).
    Ok { models: Vec<String> },
    /// No key stored, or the endpoint rejected it (HTTP 401/403).
    KeyRejected,
    /// The OS keychain read failed (locked, service down, permission revoked,
    /// corrupt entry) -- the probe never ran (issue #243). Distinct from
    /// `KeyRejected`: the trust root itself is unavailable (ADR-0029), so the
    /// fix is repairing the OS keychain, not the key. `detail` is a technical
    /// English string for the details fold, mirroring `Incompatible`.
    KeychainUnavailable { detail: String },
    /// Transport failure (DNS / TCP / TLS / timeout) -- endpoint unreachable.
    EndpointUnreachable,
    /// The endpoint URL is permanently invalid (issue #279): a non-http/https
    /// scheme (`file:`, `data:`, or scheme-less) rejected at the boundary before
    /// any probe fires. Distinct from `EndpointUnreachable` (a transport fault
    /// on a VALID url) -- this is a configuration error, not a network failure,
    /// so the fix is correcting the protocol, not debugging DNS/TLS. `detail`
    /// is the technical English reason from the shared `validate_http_base_url`
    /// gate (e.g. "invalid base_url: scheme `file` is not http/https") -- the
    /// SAME string the turn adapters ride on [`TurnFailure::InvalidConfig`], so
    /// one root cause yields one diagnosis whether it surfaces at preflight or
    /// at turn time. Surfaced for the details fold, like `Incompatible`.
    InvalidEndpoint { detail: String },
    /// The endpoint responded but is not compatible (non-auth HTTP error whose
    /// body or a failed ping shows it cannot serve the chat/messages contract).
    /// `detail` is a technical English string for the details fold.
    Incompatible { detail: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_protocol_returns_active_protocol() {
        // ADR-0064 (issue #152): effective_protocol follows the active_profile
        // POINTER, not a fixed field -- switching active to a different profile
        // lands that profile's protocol on the next read. Seed a second profile
        // with the Openai protocol and flip active_profile between the two; the
        // read tracks each flip, never a cached value. The live source
        // (LiveProviderConfig::protocol) delegates here, so this is the
        // load-bearing leaf of the per-turn read path.
        let mut cfg = ProviderConfig::defaults();
        let anthropic_id = cfg.active_profile.clone();
        let openai_id = ProfileId("__test_openai_profile".into());
        cfg.profiles.push(ProviderProfile {
            id: openai_id.clone(),
            display_name: "OpenAI".into(),
            protocol: Protocol::Openai,
            base_url: "https://api.openai.example.test".into(),
            model: "gpt-4o".into(),
        });
        // Default active profile is the Anthropic one.
        assert_eq!(cfg.effective_protocol(), Protocol::Anthropic);

        // Flip active_profile to the Openai profile -- effective_protocol follows.
        cfg.active_profile = openai_id;
        assert_eq!(cfg.effective_protocol(), Protocol::Openai);

        // Flip back -- the read tracks each pointer switch, never a cached value.
        cfg.active_profile = anthropic_id;
        assert_eq!(cfg.effective_protocol(), Protocol::Anthropic);
    }

    #[test]
    fn effective_protocol_falls_back_to_anthropic_when_active_missing() {
        // A malformed config whose active_profile points nowhere falls back to
        // the Anthropic protocol default, never panics -- mirrors
        // effective_base_url / effective_model. normalize repairs it on the
        // next store; this pins the pre-normalize live-read behavior so a
        // hand-edited gap never dispatches a turn on a wrong/no protocol.
        let mut cfg = ProviderConfig::defaults();
        cfg.active_profile = ProfileId("no-such-profile".into());
        assert_eq!(cfg.effective_protocol(), Protocol::Anthropic);
    }
}
