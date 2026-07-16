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
}

/// Service/account coordinates for the two keychain entries. The provider-config
/// account is now a LEGACY migration source only (ADR-0038 moved its contents to
/// app-config); it is read once on first launch and best-effort cleared.
const SERVICE: &str = "toptopduck";
const KEY_ACCOUNT: &str = "anthropic-api-key";
const CONFIG_ACCOUNT: &str = "provider-config";

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

    /// Whether an API key is stored. The IPC `has_api_key` command returns this
    /// directly -- a boolean, never the key (ADR-0029).
    pub fn has_key(&self) -> bool {
        self.fetch_key().is_some()
    }

    /// Store the API key the frontend sent once (ADR-0029: frontend-to-Rust
    /// one-shot; thereafter the frontend never receives it back).
    pub fn set_key(&self, key: &str) -> Result<(), String> {
        let entry = Entry::new(SERVICE, KEY_ACCOUNT).map_err(keychain_err)?;
        entry.set_password(key).map_err(keychain_err)?;
        Ok(())
    }

    /// Remove the stored key. Idempotent: a missing entry is success. Any other
    /// keychain error is surfaced rather than swallowed -- the OS keychain is the
    /// trust root for the key (ADR-0029), so a failed delete must not silently
    /// read as "key removed" while the key still sits in the keyring.
    pub fn clear_key(&self) -> Result<(), String> {
        let entry = Entry::new(SERVICE, KEY_ACCOUNT).map_err(keychain_err)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            // Idempotent: clearing when nothing is stored is a no-op success.
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain_err(e)),
        }
    }

    /// The stored API key, or `None` when nothing is stored. The provider reads
    /// this per turn (stateless: each call opens the OS entry fresh).
    pub fn fetch_key(&self) -> Option<String> {
        let entry = Entry::new(SERVICE, KEY_ACCOUNT).ok()?;
        entry.get_password().ok()
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
/// locale, no OS access. Lets the real provider's HTTP/auth/parse path run
/// against a mockito server without any keychain (the orchestrator integration
/// test uses it too). Not used in production, where
/// [`crate::provider::LiveProviderConfig`] is wired.
pub struct StaticConfig {
    pub key: Option<String>,
    pub base_url: String,
    pub model: String,
    pub locale: ResponseLocale,
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DEFAULT_PROVIDER_BASE_URL;

    #[test]
    fn static_config_returns_fixed_values() {
        let cfg = StaticConfig {
            key: Some("sk-test".into()),
            base_url: "https://example.test".into(),
            model: "claude-test".into(),
            locale: ResponseLocale::EnUS,
        };
        assert_eq!(cfg.api_key().as_deref(), Some("sk-test"));
        assert_eq!(cfg.base_url(), "https://example.test");
        assert_eq!(cfg.model(), "claude-test");
        assert_eq!(cfg.locale(), ResponseLocale::EnUS);
    }

    #[test]
    fn static_config_with_no_key_reports_none() {
        // The provider maps None -> NotWired; pin that the double carries it.
        let cfg = StaticConfig {
            key: None,
            base_url: DEFAULT_PROVIDER_BASE_URL.into(),
            model: "m".into(),
            locale: ResponseLocale::EnUS,
        };
        assert!(cfg.api_key().is_none());
    }
}
