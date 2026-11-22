//! LLM provider config (issue #29/#150/#568, ADR-0007/0019/0029/0064/0098).
//! Multi-profile provider config (ADR-0064): a list of named access profiles
//! (protocol + endpoint + model) plus the id of the active one. The profile
//! set may be EMPTY and the active pointer may be `None` -- zero profiles is a
//! legal persistent state (ADR-0098, the CLI-only user shape); first install
//! ships empty and normalize never re-seeds a skeleton. The active profile,
//! when one exists, drives the live provider; its id is the keychain account
//! suffix (`key-<id>`). The API key is NOT here (ADR-0029/0038: key only in
//! the OS keychain, never in app-config).

use serde::{Deserialize, Serialize};

/// v1 default endpoint (ADR-0019: Anthropic native protocol + configurable
/// `baseURL`; default is Anthropic direct).
pub const DEFAULT_PROVIDER_BASE_URL: &str = "https://api.anthropic.com";

/// The reserved prefix of the built-in runtime's entry in
/// `last_model_postures` (ADR-0154): the map's other keys are external
/// adapter ids (`gemini-cli`, `user:…`), so the built-in entry -- keyed by
/// the endpoint its posture was selected against -- lives under a prefix no
/// adapter table or registry can ever mint. The built-in posture pair's
/// scope carries the same string, so the two compare verbatim.
pub const BUILTIN_POSTURE_KEY_PREFIX: &str = "builtin:";

/// The wire protocol a profile speaks (ADR-0064). Two variants: anthropic
/// (Anthropic Messages native, `x-api-key` auth) and openai (OpenAI Chat
/// Completions, Bearer auth; covers OpenAI direct / DeepSeek / GLM / Qwen /
/// Ollama compatible endpoints). Crosses IPC as the bare lowercase variant
/// name (mirrors the ChartKind convention).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    #[default]
    Anthropic,
    /// OpenAI Chat Completions wire protocol (ADR-0064). The upstream client
    /// is a pure HTTP translation layer: Chat Completions request shape,
    /// Bearer auth, reads `choices[0].message.content`. Covers
    /// OpenAI direct / DeepSeek / GLM / Qwen / Ollama compatible endpoints --
    /// the user points `base_url` at the endpoint (incl. its version path
    /// segment, e.g. `/v1`); the upstream client appends `/chat/completions`.
    Openai,
}

impl Protocol {
    /// The wire name (the serde spelling), the first half of the built-in
    /// endpoint identity ([`builtin_endpoint_identity`]).
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Protocol::Anthropic => "anthropic",
            Protocol::Openai => "openai",
        }
    }
}

/// The built-in runtime's endpoint identity (ADR-0154): the wire protocol
/// plus the base URL, spelling-normalized (surrounding whitespace and
/// trailing slashes ignored -- the turn wire trims the same way, so two
/// spellings of one endpoint share an identity). Model ids are endpoint
/// facts, so this is the scope a built-in posture pair belongs to. THE one
/// derivation: the backfill map's built-in key, the scope the backend stamps
/// on a built-in pair, and the gate comparing that scope at turn time all
/// read this function -- a second derivation would be a second opinion on
/// "same endpoint".
pub fn builtin_endpoint_identity(protocol: Protocol, base_url: &str) -> String {
    format!(
        "{BUILTIN_POSTURE_KEY_PREFIX}{}|{}",
        protocol.as_str(),
        base_url.trim().trim_end_matches('/')
    )
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

/// The id of the built-in default profile (ADR-0064; the pre-ADR-0098
/// first-launch skeleton). FIXED so repeated first-launches and degrades
/// converge on the same keychain account (`key-default`) rather than minting a
/// fresh id each time -- a user who sets a key once keeps it across a degrade.
/// No longer seeded into a fresh config (ADR-0098 zero-profile defaults); it
/// still names the profile the legacy keychain-blob migration materializes
/// (issue #53) and the account a pre-ADR-0098 stored profile references.
/// User-created profiles mint their own ids.
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
    /// The pinned default model id to request, or `None` = no pinned default
    /// (ADR-0154, calibrating ADR-0007's version-pinned default). A gateway
    /// serves a list of models and no id can be pinned for it in advance, so
    /// empty is a legal stored state: the turn then runs on the session's
    /// selected posture, or refuses honestly when nothing is selected. An
    /// absent key and an explicit null both read as `None`; a stored string
    /// reads as pinned.
    pub model: Option<String>,
}

impl ProviderProfile {
    /// The built-in default anthropic profile (ADR-0064). The pre-ADR-0098
    /// first-launch skeleton / honest-degrade target; no longer seeded into a
    /// fresh config (zero profiles is the legal default state), but still
    /// materialized by the legacy keychain-blob migration
    /// ([`crate::provider::live_config`], issue #53) so a carried-forward
    /// endpoint lands on the stable `key-default` slot. Unpinned: the
    /// migration splices the stored model in, and nothing else constructs
    /// this shape.
    pub fn default_anthropic() -> Self {
        Self {
            id: ProfileId(DEFAULT_PROFILE_ID.to_string()),
            display_name: DEFAULT_PROFILE_DISPLAY_NAME.to_string(),
            protocol: Protocol::Anthropic,
            base_url: DEFAULT_PROVIDER_BASE_URL.to_string(),
            model: None,
        }
    }

    /// The pinned model as a turn requests it: trimmed, and `None` for a
    /// blank value -- a hand-edited whitespace-only id is the unpinned state
    /// too (ADR-0154), on the READ path as well as the store path (normalize
    /// only runs on write). The one definition of "pinned"; consumers never
    /// inspect the raw field.
    pub fn pinned_model(&self) -> Option<&str> {
        self.model
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
    }
}

/// Serde default for a profile's [`ProviderProfile::base_url`] (used at
/// deserialize time for older blobs and by [`ProviderProfile::default_anthropic`]).
fn default_provider_base_url() -> String {
    DEFAULT_PROVIDER_BASE_URL.to_string()
}

/// Non-secret multi-profile provider config (ADR-0064): a list of named access
/// profiles plus the id of the active one. Never carries the API key
/// (ADR-0029/0038 -- the key lives only in the OS keychain under `key-<id>`).
/// This is BOTH the app-config storage shape ([`crate::app_config::AppConfig`].provider)
/// AND the `set_provider_config` IPC input -- one shape, no DRY split between a
/// "storage" and a "wire" variant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderConfig {
    /// The named access profiles (ADR-0064). May be empty: zero profiles is a
    /// legal persistent state (ADR-0098 -- the CLI-only user shape); normalize
    /// no longer re-seeds a skeleton into an empty list.
    #[serde(default)]
    pub profiles: Vec<ProviderProfile>,
    /// The id of the active profile (ADR-0064: global single active), or
    /// `None` when no profile is active. `None` is the honest zero-profile
    /// state (ADR-0098) and also the repair target for a dangling pointer
    /// (normalize nulls it rather than falling back to the first profile). A
    /// profile's protocol + endpoint + model drive the live provider, and its
    /// id drives the keychain account the key is read from.
    #[serde(default)]
    pub active_profile: Option<ProfileId>,
}

impl ProviderConfig {
    /// The built-in defaults (ADR-0098): zero profiles, no active pointer --
    /// the CLI-only user shape is the first-launch state, not an anomaly to
    /// repair. "New profile" form prefill (anthropic + direct endpoint) lives
    /// in the interaction layer, never the persisted defaults.
    pub fn defaults() -> Self {
        Self {
            profiles: Vec::new(),
            active_profile: None,
        }
    }

    /// The active profile, or `None` when `active_profile` is `None` (the
    /// legal zero-profile state, ADR-0098) or points at no profile (a
    /// dangling pointer [`crate::app_config::AppConfig::normalize`] nulls).
    /// Live readers fall back to the canonical defaults when this returns
    /// `None` so a hand-edited gap never hands the provider an empty endpoint.
    pub fn active(&self) -> Option<&ProviderProfile> {
        self.active_profile
            .as_ref()
            .and_then(|id| self.profiles.iter().find(|p| p.id == *id))
    }

    /// Mutable access to the active profile, or `None` when `active_profile`
    /// is `None` or matches no profile. Callers that need a profile must seed
    /// one first (the defaults ship zero profiles, ADR-0098).
    pub fn active_mut(&mut self) -> Option<&mut ProviderProfile> {
        self.active_profile
            .as_ref()
            .and_then(|id| self.profiles.iter_mut().find(|p| p.id == *id))
    }

    /// The active profile's base URL, or the canonical default when there is
    /// no active profile (zero profiles -- legal, ADR-0098 -- or a dangling
    /// pointer normalize nulls). The live provider read path keeps this total
    /// so a hand-edited gap never hands the provider an empty endpoint; the
    /// turn then refuses as NotWired on the missing key. The IPC view does NOT
    /// share this fallback (it exposes the empty state honestly, ADR-0098).
    pub fn effective_base_url(&self) -> &str {
        self.active()
            .map(|p| p.base_url.as_str())
            .unwrap_or_else(|| {
                log::warn!(
                    "no active profile (empty set or dangling pointer); falling \
                     back to default base_url for this read"
                );
                DEFAULT_PROVIDER_BASE_URL
            })
    }

    /// The active profile's pinned model, or `None` when the active profile
    /// pins none or there is no active profile (ADR-0154). Unlike the
    /// endpoint reads above there is no total fallback to borrow: with no
    /// pinned model the turn runs on the session's posture selection, and
    /// refuses honestly as `NoModel` when that is empty too. The missing-key
    /// refusal (NotWired) still covers the no-active-profile arm first.
    pub fn effective_model(&self) -> Option<&str> {
        self.active().and_then(ProviderProfile::pinned_model)
    }

    /// The active profile's wire protocol, or [`Protocol::Anthropic`] when
    /// there is no active profile (see [`Self::effective_base_url`]). Drives
    /// the live provider's per-turn adapter routing (issue #152, ADR-0064):
    /// `LiveProvider` reads this each turn so a protocol switch on the active
    /// profile lands the next turn on the new adapter, no caching.
    pub fn effective_protocol(&self) -> Protocol {
        self.active().map(|p| p.protocol).unwrap_or_else(|| {
            // No active profile (zero profiles -- legal, ADR-0098 -- or a
            // dangling pointer normalize nulls): log the fallback so the
            // state is observable. The turn refuses as NotWired on the
            // missing key before any request goes out; this keeps the
            // trait read total, and a wrong-protocol turn is hard to
            // diagnose from the bare NotWired/Unavailable it produces
            // downstream.
            log::warn!(
                "no active profile (empty set or dangling pointer); falling \
                     back to Anthropic protocol for this turn"
            );
            Protocol::Anthropic
        })
    }

    /// The IPC-shaped view of the active profile's endpoint + key status
    /// (ADR-0029: only a boolean + read-fault detail cross, never the key).
    /// Issue #275: the keychain read outcome rides in as a `Result` so a read
    /// fault surfaces on `keychain_fault` (with `has_key` a placeholder false)
    /// instead of being honest-degraded behind a bare `false`. One shape for
    /// both `get_provider_config` and `set_provider_config`. ADR-0098: with no
    /// active profile the endpoint fields are `None` -- the honest empty
    /// state, NOT the canonical defaults masquerading as a configured value
    /// (the live read path's total fallback serves the pre-gate turn path
    /// only, and is deliberately not shared here).
    pub fn view(&self, key_read: Result<bool, String>) -> ProviderConfigView {
        let (has_key, keychain_fault) = match key_read {
            Ok(has_key) => (has_key, None),
            Err(detail) => (false, Some(detail)),
        };
        // One resolution for both fields: they derive from the SAME profile,
        // and a single bind makes that shared provenance explicit (instead of
        // two independent lookups the reader must reconcile).
        let active = self.active();
        ProviderConfigView {
            base_url: active.map(|p| p.base_url.clone()),
            model: active.and_then(|p| p.model.clone()),
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

/// The get_provider_config view (ADR-0029): the active profile's base URL +
/// model plus its key status -- `has_key` (a boolean, never the key itself)
/// and a keychain read-fault detail. The frontend's header key indicator
/// learns whether to prompt for a key without ever receiving it, and
/// distinguishes a read fault from a legitimate no-key state (issue #275).
/// One shape for both `get_provider_config` and `set_provider_config`.
/// ADR-0098: `base_url` / `model` are `None` when there is no active profile
/// -- the honest empty state (no endpoint to read), not the canonical
/// defaults pretending a value exists. `model` is also `None` when the
/// active profile pins no default model (ADR-0154): an unpinned profile is
/// a legal state, not a missing value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderConfigView {
    /// The active profile's base URL, or `None` when no profile is active
    /// (ADR-0098 zero-profile state).
    pub base_url: Option<String>,
    /// The active profile's pinned model id, or `None` when there is no
    /// active profile or the active profile pins none (ADR-0154).
    pub model: Option<String>,
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
        // lands that profile's protocol on the next read. Seed two profiles
        // with different protocols and flip active_profile between the two; the
        // read tracks each flip, never a cached value. The live source
        // (LiveProviderConfig::protocol) delegates here, so this is the
        // load-bearing leaf of the per-turn read path.
        let mut cfg = ProviderConfig::defaults();
        let anthropic_id = ProfileId("__test_anthropic_profile".into());
        let openai_id = ProfileId("__test_openai_profile".into());
        cfg.profiles = vec![
            ProviderProfile {
                id: anthropic_id.clone(),
                display_name: "Anthropic".into(),
                protocol: Protocol::Anthropic,
                base_url: "https://api.anthropic.example.test".into(),
                model: Some("claude-sonnet-4-6".into()),
            },
            ProviderProfile {
                id: openai_id.clone(),
                display_name: "OpenAI".into(),
                protocol: Protocol::Openai,
                base_url: "https://api.openai.example.test".into(),
                model: Some("gpt-4o".into()),
            },
        ];
        cfg.active_profile = Some(anthropic_id.clone());
        assert_eq!(cfg.effective_protocol(), Protocol::Anthropic);

        // Flip active_profile to the Openai profile -- effective_protocol follows.
        cfg.active_profile = Some(openai_id);
        assert_eq!(cfg.effective_protocol(), Protocol::Openai);

        // Flip back -- the read tracks each pointer switch, never a cached value.
        cfg.active_profile = Some(anthropic_id);
        assert_eq!(cfg.effective_protocol(), Protocol::Anthropic);
    }

    #[test]
    fn effective_protocol_falls_back_to_anthropic_when_active_missing() {
        // A config with no resolvable active profile (a dangling pointer here;
        // the zero-profile state is pinned separately below) falls back to the
        // Anthropic protocol default on a live read, never panics -- mirrors
        // effective_base_url / effective_model. normalize nulls the pointer on
        // the next store; this pins the pre-normalize live-read behavior so a
        // hand-edited gap never dispatches a turn on a wrong/no protocol.
        let mut cfg = ProviderConfig::defaults();
        cfg.active_profile = Some(ProfileId("no-such-profile".into()));
        assert_eq!(cfg.effective_protocol(), Protocol::Anthropic);
    }

    #[test]
    fn defaults_ship_zero_profiles_with_no_active_pointer() {
        // ADR-0098: the built-in defaults are the CLI-only user shape -- an
        // empty profile set with no active pointer. First install must NOT
        // seed a skeleton profile (the pre-0098 behavior masked "not
        // configured" behind a keyless skeleton).
        let cfg = ProviderConfig::defaults();
        assert!(cfg.profiles.is_empty());
        assert_eq!(cfg.active_profile, None);
        assert_eq!(cfg.active(), None);
    }

    #[test]
    fn active_resolves_none_when_pointer_is_none_even_with_profiles_present() {
        // `None` pointer + non-empty profile set is representable: no profile
        // is active. active()/active_mut() resolve None rather than falling
        // back to the first profile (the pre-0098 repair would have).
        let mut cfg = ProviderConfig::defaults();
        cfg.profiles.push(ProviderProfile::default_anthropic());
        cfg.active_profile = None;
        assert!(cfg.active().is_none());
        assert!(cfg.active_mut().is_none());
    }

    #[test]
    fn view_exposes_the_empty_state_when_no_active_profile() {
        // ADR-0098: with no active profile the view carries null endpoint
        // fields -- the honest "nothing configured" signal. The canonical
        // defaults must NOT masquerade as a configured value (the live read
        // path's total fallback is deliberately not shared with the view).
        let cfg = ProviderConfig::defaults();
        let view = cfg.view(Ok(false));
        assert_eq!(view.base_url, None);
        assert_eq!(view.model, None);
        assert!(!view.has_key);
        assert!(view.keychain_fault.is_none());

        // A dangling pointer (pre-normalize hand-edit) exposes the same empty
        // state -- there is still no endpoint to read.
        let mut dangling = ProviderConfig::defaults();
        dangling.active_profile = Some(ProfileId("no-such-profile".into()));
        let view = dangling.view(Ok(false));
        assert_eq!(view.base_url, None);
        assert_eq!(view.model, None);
    }

    #[test]
    fn legacy_config_with_the_retired_context_limit_key_opens() {
        // #1290: the retired denominator field leaves stored configs
        // carrying the key; serde ignores unknown fields, so the profile
        // opens verbatim minus the retired field -- zero migration, no
        // version gate.
        let json = r#"{"id":"p1","display_name":"P","protocol":"anthropic","base_url":"https://api.anthropic.com","model":"m","context_limit":200000}"#;
        let profile: ProviderProfile = serde_json::from_str(json).expect("legacy opens");
        assert_eq!(profile.model.as_deref(), Some("m"));
    }

    #[test]
    fn view_surfaces_the_active_profile_endpoint_verbatim() {
        // With an active profile the view carries its endpoint fields verbatim
        // plus the key read outcome (ADR-0029: a boolean + read-fault detail
        // cross, never the key).
        let mut cfg = ProviderConfig::defaults();
        let profile = ProviderProfile {
            id: ProfileId("__test_view_profile".into()),
            display_name: "Gateway".into(),
            protocol: Protocol::Anthropic,
            base_url: "https://gateway.example.test".into(),
            model: Some("claude-opus-4-8".into()),
        };
        cfg.active_profile = Some(profile.id.clone());
        cfg.profiles.push(profile);
        let view = cfg.view(Ok(true));
        assert_eq!(
            view.base_url.as_deref(),
            Some("https://gateway.example.test")
        );
        assert_eq!(view.model.as_deref(), Some("claude-opus-4-8"));
        assert!(view.has_key);
        assert!(view.keychain_fault.is_none());
    }

    #[test]
    fn active_profile_round_trips_a_null_pointer_and_a_stored_id() {
        // Wire/storage shape (ADR-0098): a null pointer stays null through a
        // serde round trip (the zero-profile state persists as written), and a
        // stored id string parses back into Some -- a pre-0098 file carrying a
        // skeleton profile + its pointer keeps both verbatim, no cleaning.
        let zero = ProviderConfig::defaults();
        let json = serde_json::to_string(&zero).expect("serialize");
        assert!(
            json.contains(r#""active_profile":null"#),
            "zero-profile state serializes an explicit null: {json}"
        );
        let back: ProviderConfig = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, zero);

        let mut seeded = ProviderConfig::defaults();
        seeded.profiles.push(ProviderProfile::default_anthropic());
        seeded.active_profile = Some(ProfileId(DEFAULT_PROFILE_ID.into()));
        let json = serde_json::to_string(&seeded).expect("serialize");
        let back: ProviderConfig = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, seeded);
        assert!(
            back.active().is_some(),
            "stored id resolves post round trip"
        );
    }

    #[test]
    fn profile_model_is_nullable_across_serde() {
        // ADR-0154: the pinned model is optional. An explicit null and an
        // absent key both read as None -- no serde default invents an id --
        // and a stored string reads as pinned. None serializes as an
        // explicit null: the wire face the `string | null` mirror reads (a
        // skipped key would hand the frontend undefined).
        let profile = ProviderProfile::default_anthropic();
        assert_eq!(profile.model, None, "the seeded skeleton pins no model");
        let json = serde_json::to_string(&profile).expect("serialize");
        assert!(json.contains(r#""model":null"#), "{json}");
        let back: ProviderProfile = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, profile);
        let absent: ProviderProfile =
            serde_json::from_str(r#"{"id":"p1","base_url":"https://x.test"}"#)
                .expect("a profile without the model key opens");
        assert_eq!(absent.model, None, "an absent key is the unpinned state");
        let pinned: ProviderProfile =
            serde_json::from_str(r#"{"id":"p1","base_url":"https://x.test","model":"m"}"#)
                .expect("a pinned profile opens");
        assert_eq!(pinned.model.as_deref(), Some("m"));
    }

    #[test]
    fn effective_model_reads_the_active_profiles_pin_or_none() {
        // ADR-0154: the model read has no total fallback to borrow -- an
        // unpinned active profile and a dangling pointer both read None, and
        // the turn's own gates (NotWired first, then NoModel) take over.
        let mut cfg = ProviderConfig::defaults();
        cfg.profiles.push(ProviderProfile::default_anthropic());
        cfg.active_profile = Some(ProfileId(DEFAULT_PROFILE_ID.into()));
        assert_eq!(
            cfg.effective_model(),
            None,
            "an unpinned active profile reads None"
        );
        cfg.profiles[0].model = Some("claude-opus-4-8".into());
        assert_eq!(cfg.effective_model(), Some("claude-opus-4-8"));
        // The read path does not normalize (only the store does), so a
        // hand-edited blank id must still read as unpinned -- never as a
        // model a turn could put on the wire.
        cfg.profiles[0].model = Some("   ".into());
        assert_eq!(cfg.effective_model(), None, "a blank id reads as unpinned");
        cfg.active_profile = Some(ProfileId("no-such-profile".into()));
        assert_eq!(cfg.effective_model(), None, "a dangling pointer reads None");
    }

    #[test]
    fn builtin_endpoint_identity_joins_protocol_and_normalized_base() {
        // ADR-0154: the identity is protocol + base URL with the turn wire's
        // own spelling normalization -- two spellings of one endpoint share
        // an identity, and the reserved prefix keeps the key out of the
        // adapter-id namespace of `last_model_postures`.
        assert_eq!(Protocol::Anthropic.as_str(), "anthropic");
        assert_eq!(Protocol::Openai.as_str(), "openai");
        assert_eq!(
            builtin_endpoint_identity(Protocol::Anthropic, "https://gateway.example.test/v1/"),
            "builtin:anthropic|https://gateway.example.test/v1"
        );
        assert_eq!(
            builtin_endpoint_identity(Protocol::Anthropic, "  https://gateway.example.test/v1  "),
            builtin_endpoint_identity(Protocol::Anthropic, "https://gateway.example.test/v1"),
            "surrounding whitespace and trailing slashes are not identity"
        );
        assert_ne!(
            builtin_endpoint_identity(Protocol::Openai, "https://gateway.example.test/v1"),
            builtin_endpoint_identity(Protocol::Anthropic, "https://gateway.example.test/v1"),
            "the protocol is half the identity"
        );
        assert!(
            BUILTIN_POSTURE_KEY_PREFIX.ends_with(':'),
            "the prefix must stay outside the adapter-id shapes (bare ids, `user:` ids)"
        );
    }
}
