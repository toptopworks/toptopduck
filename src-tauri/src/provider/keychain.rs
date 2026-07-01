//! Key isolation (ADR-0029 invariant 3): the decrypted API key lives only in
//! the Rust core process. The frontend never holds it -- it sends the key once
//! via IPC to be stored, and thereafter learns only "is one set?" (a bool). The
//! provider fetches the key per turn from the OS keychain and attaches it to
//! the LLM HTTP call (which the Rust core, not the webview, places).
//!
//! Two keychain entries back the v1 config:
//! - the secret API key (service `toptopduck`, account `anthropic-api-key`);
//! - a non-secret config JSON blob `{base_url, model}` (account
//!   `provider-config`). ADR-0038 defers a full app-config file; for v1 both
//!   ride the keychain as persistent Rust-side storage. The key never enters
//!   the config blob, and [`ProviderConfigView`] never returns the key.
//!
//! [`KeychainStore`] is stateless -- each call opens the OS entry fresh, so the
//! provider and the IPC commands always see live key/config without caching
//! (a user who clears the key sees the next turn refuse, not a stale copy).

use keyring::Entry;

use crate::model::ProviderConfig;

/// Read-only provider configuration + key access. The provider depends on this
/// abstraction so its unit tests inject fixed values ([`StaticConfig`]) instead
/// of touching the OS keychain; production wires [`KeychainStore`].
pub trait ProviderConfigSource: Send {
    /// The decrypted API key, or `None` when none is stored (the provider then
    /// refuses the turn as not-wired -- ADR-0028 `NotWired`).
    fn api_key(&self) -> Option<String>;
    /// The Anthropic-protocol endpoint base URL (ADR-0019: configurable
    /// `baseURL`, default Anthropic direct).
    fn base_url(&self) -> String;
    /// The model id to request (ADR-0007: v1 default Sonnet-class, pinned).
    fn model(&self) -> String;
}

/// Service/account coordinates for the two keychain entries.
const SERVICE: &str = "toptopduck";
const KEY_ACCOUNT: &str = "anthropic-api-key";
const CONFIG_ACCOUNT: &str = "provider-config";

/// Production keychain-backed store (ADR-0029 invariant 3). Stateless and cheap
/// to clone (no fields); managed as Tauri state for the IPC commands and held
/// by the real provider for per-turn key/config reads.
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

    /// The stored non-secret config, or the v1 defaults when nothing is stored
    /// yet / the blob is unreadable (a corrupt blob never bricks the app).
    pub fn get_config(&self) -> ProviderConfig {
        let Some(blob) = self.fetch_config_blob() else {
            return ProviderConfig::defaults();
        };
        serde_json::from_str(&blob).unwrap_or_else(|_| ProviderConfig::defaults())
    }

    /// Store the non-secret config (base URL + model). The key never enters
    /// this blob (ADR-0029: key confined to its own entry).
    pub fn set_config(&self, cfg: &ProviderConfig) -> Result<(), String> {
        let blob = serde_json::to_string(cfg).map_err(|e| e.to_string())?;
        let entry = Entry::new(SERVICE, CONFIG_ACCOUNT).map_err(keychain_err)?;
        entry.set_password(&blob).map_err(keychain_err)?;
        Ok(())
    }

    fn fetch_key(&self) -> Option<String> {
        let entry = Entry::new(SERVICE, KEY_ACCOUNT).ok()?;
        entry.get_password().ok()
    }

    fn fetch_config_blob(&self) -> Option<String> {
        let entry = Entry::new(SERVICE, CONFIG_ACCOUNT).ok()?;
        entry.get_password().ok()
    }
}

impl ProviderConfigSource for KeychainStore {
    fn api_key(&self) -> Option<String> {
        self.fetch_key()
    }
    fn base_url(&self) -> String {
        // get_config already fell back to defaults when no/empty stored value,
        // so the effective base URL is the stored-or-default field verbatim.
        self.get_config().base_url
    }
    fn model(&self) -> String {
        self.get_config().model
    }
}

/// Map a keyring error to a user-facing string. The OS keychain is the trust
/// root for the key, so an access failure is surfaced plainly (no key leaked in
/// the message).
fn keychain_err(e: keyring::Error) -> String {
    format!("系统钥匙串访问失败：{e}")
}

/// Test double for [`ProviderConfigSource`]: fixed key + base URL + model, no OS
/// access. Lets the real provider's HTTP/auth/parse path run against a mockito
/// server without any keychain (the orchestrator integration test uses it too).
/// Not used in production, where [`KeychainStore`] is wired.
pub struct StaticConfig {
    pub key: Option<String>,
    pub base_url: String,
    pub model: String,
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
        };
        assert_eq!(cfg.api_key().as_deref(), Some("sk-test"));
        assert_eq!(cfg.base_url(), "https://example.test");
        assert_eq!(cfg.model(), "claude-test");
    }

    #[test]
    fn static_config_with_no_key_reports_none() {
        // The provider maps None -> NotWired; pin that the double carries it.
        let cfg = StaticConfig {
            key: None,
            base_url: DEFAULT_PROVIDER_BASE_URL.into(),
            model: "m".into(),
        };
        assert!(cfg.api_key().is_none());
    }
}
