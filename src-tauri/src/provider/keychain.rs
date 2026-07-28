//! Key isolation (ADR-0029 invariant 3): the decrypted API key lives only in
//! the Rust core process. The frontend never holds it -- it sends the key once
//! via IPC to be stored, and thereafter learns only "is one set?" (a bool). The
//! provider fetches the key per turn from the OS keychain and attaches it to the
//! LLM HTTP call (which the Rust core, not the webview, places).
//!
//! As of ADR-0038 / issue #53, [`KeychainStore`] is **key-only**. The non-secret
//! provider config (`{base_url, model}`) moved to the app-config file -- the
//! keychain is no longer its home. A legacy `provider-config` keychain entry
//! from an older build is surfaced via [`KeychainStore::fetch_legacy_provider_blob`]
//! so [`crate::provider::LiveProviderConfig`] can seed app-config on first launch
//! (one-time migration), then cleared via [`KeychainStore::clear_legacy_provider_config`].
//! The key itself NEVER enters app-config (ADR-0038 secrets-never, enforced
//! structurally -- the app-config model has no key field -- plus a read-time
//! secret scan).
//!
//! [`KeychainStore`] is stateless -- each call opens the OS entry fresh, so the
//! provider and the IPC commands always see the live key without caching (a user
//! who clears the key sees the next turn refuse, not a stale copy).

use keyring::Entry;

use super::prompt::ResponseLocale;
use crate::model::{ProfileId, Protocol};

/// Read-only provider configuration + key access. The provider depends on this
/// abstraction so its unit tests inject fixed values ([`StaticConfig`]) instead
/// of touching the OS keychain; production wires
/// [`crate::provider::LiveProviderConfig`] (key from this keychain + baseURL/model
/// from app-config, ADR-0038).
pub trait ProviderConfigSource: Send {
    /// The decrypted API key, or `None` when none is stored (the provider then
    /// refuses the turn as not-wired -- ADR-0028 `NotWired`).
    fn api_key(&self) -> Option<String>;
    /// The Anthropic-protocol endpoint base URL (ADR-0019: configurable
    /// `baseURL`, default Anthropic direct).
    fn base_url(&self) -> String;
    /// The model id to request (ADR-0007: v1 default Sonnet-class, pinned).
    fn model(&self) -> String;
    /// The resolved response locale (ADR-0052, issue #78). Drives ONLY the
    /// locale directive appended to the system prompt -- never enters
    /// [`super::ProviderRequest`] and never crosses IPC from the frontend. The
    /// source resolves the "system" preference to a concrete locale itself
    /// (reading the OS locale), so the provider stays free of that concern.
    fn locale(&self) -> ResponseLocale;
    /// The active profile's wire protocol (ADR-0064, issue #152). Drives the
    /// per-turn adapter routing in [`crate::provider::LiveProvider`] -- read
    /// fresh each turn so a protocol switch on the active profile lands the
    /// next turn on the new adapter.
    fn protocol(&self) -> Protocol;
}

/// Service/account coordinates for the keychain entries. The API-key account is
/// PER-PROFILE (ADR-0064): `key-<profile_id>`, so each profile's key is isolated
/// in its own OS entry. The pre-#150 single-slot `anthropic-api-key` entry is
/// NOT migrated and NOT cleaned up (ADR-0064: orphan is harmless; dev machines
/// re-set their key under the new account). The provider-config account is a
/// LEGACY migration source only (ADR-0038 moved its contents to app-config); it
/// is read once on first launch and best-effort cleared.
const SERVICE: &str = "toptopduck";
const KEY_ACCOUNT_PREFIX: &str = "key-";
const CONFIG_ACCOUNT: &str = "provider-config";

/// The keychain account for a profile's API key (ADR-0064): `key-<profile_id>`.
fn key_account(profile_id: &ProfileId) -> String {
    format!("{KEY_ACCOUNT_PREFIX}{profile_id}")
}

/// Production keychain-backed store (ADR-0029 invariant 3). Key-only as of
/// ADR-0038: the non-secret provider config moved to app-config. Stateless and
/// cheap to clone (no fields); managed as Tauri state (inside
/// [`crate::provider::LiveProviderConfig`]) for the IPC commands, and the real
/// provider fetches the key per turn via the [`ProviderConfigSource`] impl on
/// [`crate::provider::LiveProviderConfig`].
#[derive(Clone, Default)]
pub struct KeychainStore;

impl KeychainStore {
    pub fn new() -> Self {
        Self
    }

    /// Whether an API key is stored for the given profile (ADR-0064 per-profile
    /// slot `key-<profile_id>`). The IPC `has_api_key` command routes here with
    /// the active profile's id; it returns a boolean, never the key (ADR-0029).
    /// A keychain read failure honest-degrades to `false` ("cannot confirm a
    /// key is stored") -- a bool cannot carry the error, and a false negative
    /// only re-prompts the user, whose set/clear then propagates the real
    /// keychain error (issue #243). The failure surfaces when the user next
    /// clicks "Test connection" -- the preflight re-reads via
    /// [`Self::fetch_key_for`] and classifies the fault as
    /// `KeychainUnavailable` (this bool surface does not auto-route it).
    pub fn has_key_for(&self, profile_id: &ProfileId) -> bool {
        matches!(self.fetch_key_for(profile_id), Ok(Some(_)))
    }

    /// Store the API key for the given profile under `key-<profile_id>`
    /// (ADR-0029 frontend-to-Rust one-shot; ADR-0064 per-profile slot).
    /// Thereafter the frontend never receives it back.
    pub fn set_key_for(&self, profile_id: &ProfileId, key: &str) -> Result<(), String> {
        let entry = Entry::new(SERVICE, &key_account(profile_id)).map_err(keychain_err)?;
        entry.set_password(key).map_err(keychain_err)?;
        Ok(())
    }

    /// Remove the stored key for the given profile. Idempotent: a missing entry
    /// is success. Any other keychain error is surfaced rather than swallowed --
    /// the OS keychain is the trust root for the key (ADR-0029), so a failed
    /// delete must not silently read as "key removed" while the key still sits
    /// in the keyring.
    pub fn clear_key_for(&self, profile_id: &ProfileId) -> Result<(), String> {
        let entry = Entry::new(SERVICE, &key_account(profile_id)).map_err(keychain_err)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            // Idempotent: clearing when nothing is stored is a no-op success.
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain_err(e)),
        }
    }

    /// The stored API key for the given profile: `Ok(None)` when nothing is
    /// stored, `Err` when the OS keychain read failed (locked, service down,
    /// permission revoked, corrupt entry). Mirrors [`Self::clear_key_for`]'s
    /// trust-root handling (ADR-0029): the OS keychain is the trust root for
    /// the key, so a read failure is surfaced rather than swallowed into
    /// "nothing stored" -- a failed read must not diagnose as a missing / bad
    /// key (issue #243). The provider reads this per turn (stateless: each call
    /// opens the OS entry fresh) for the active profile.
    pub fn fetch_key_for(&self, profile_id: &ProfileId) -> Result<Option<String>, String> {
        let entry = Entry::new(SERVICE, &key_account(profile_id)).map_err(keychain_err)?;
        match entry.get_password() {
            Ok(key) => Ok(Some(key)),
            // No entry is not a failure: "nothing stored" is a legitimate
            // state the callers classify as no-key (never a keychain fault).
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain_err(e)),
        }
    }

    /// Read the LEGACY provider-config blob (`{base_url, model}` JSON) that older
    /// builds stored in the keychain, or `None` when none is stored. ADR-0038
    /// moved this to app-config; this accessor exists ONLY for the one-time
    /// first-launch migration in [`crate::provider::LiveProviderConfig`]. A
    /// corrupt / unparseable blob yields `None` (the migration then falls back to
    /// app-config defaults) -- a corrupt legacy entry never bricks the app.
    pub fn fetch_legacy_provider_blob(&self) -> Option<String> {
        let entry = Entry::new(SERVICE, CONFIG_ACCOUNT).ok()?;
        entry.get_password().ok()
    }

    /// Best-effort delete of the legacy provider-config entry. Called after the
    /// migration seeds app-config so the stale non-secret blob does not linger.
    /// Idempotent and never fails the caller: a missing entry or a keychain error
    /// is swallowed (the migration already succeeded; cleanup is best-effort).
    pub fn clear_legacy_provider_config(&self) {
        let Ok(entry) = Entry::new(SERVICE, CONFIG_ACCOUNT) else {
            return;
        };
        let _ = entry.delete_credential();
    }
}

/// Map a keyring error to an English technical detail. Rides
/// [`StoreCommandError::KeychainFailure`](crate::commands::StoreCommandError)
/// (issue #130) into the frontend's technical-details fold; the user-facing
/// wording lives in the catalog, not here. No key is leaked (ADR-0029).
fn keychain_err(e: keyring::Error) -> String {
    format!("keychain access failed: {e}")
}

/// Test double for [`ProviderConfigSource`]: fixed key + base URL + model +
/// locale + protocol, no OS access. Lets the real provider's HTTP/auth/parse
/// path run against a mockito server without any keychain (the orchestrator
/// integration test uses it too). Not used in production, where
/// [`crate::provider::LiveProviderConfig`] is wired.
pub struct StaticConfig {
    pub key: Option<String>,
    pub base_url: String,
    pub model: String,
    pub locale: ResponseLocale,
    /// The wire protocol the double reports (issue #152). Anthropic-adapter /
    /// pre-#152 mockito tests set [`Protocol::Anthropic`]; openai-adapter and
    /// routing tests set [`Protocol::Openai`].
    pub protocol: Protocol,
}

impl ProviderConfigSource for StaticConfig {
    fn api_key(&self) -> Option<String> {
        self.key.clone()
    }
    fn base_url(&self) -> String {
        self.base_url.clone()
    }
    fn model(&self) -> String {
        self.model.clone()
    }
    fn locale(&self) -> ResponseLocale {
        self.locale
    }
    fn protocol(&self) -> Protocol {
        self.protocol
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DEFAULT_PROVIDER_BASE_URL;

    #[test]
    fn key_account_is_profile_prefixed() {
        // ADR-0064: the per-profile keychain account is `key-<profile_id>`, so
        // each profile's key is isolated in its own OS entry. The pre-#150
        // single-slot `anthropic-api-key` account is NOT produced here.
        assert_eq!(key_account(&ProfileId("default".into())), "key-default");
        assert_eq!(key_account(&ProfileId("abc-123".into())), "key-abc-123");
    }

    #[test]
    fn static_config_returns_fixed_values() {
        let cfg = StaticConfig {
            key: Some("sk-test".into()),
            base_url: "https://example.test".into(),
            model: "claude-test".into(),
            locale: ResponseLocale::EnUS,
            protocol: Protocol::Anthropic,
        };
        assert_eq!(cfg.api_key().as_deref(), Some("sk-test"));
        assert_eq!(cfg.base_url(), "https://example.test");
        assert_eq!(cfg.model(), "claude-test");
        assert_eq!(cfg.locale(), ResponseLocale::EnUS);
        assert_eq!(cfg.protocol(), Protocol::Anthropic);
    }

    #[test]
    fn static_config_with_no_key_reports_none() {
        // The provider maps None -> NotWired; pin that the double carries it.
        let cfg = StaticConfig {
            key: None,
            base_url: DEFAULT_PROVIDER_BASE_URL.into(),
            model: "m".into(),
            locale: ResponseLocale::EnUS,
            protocol: Protocol::Anthropic,
        };
        assert!(cfg.api_key().is_none());
    }
}
