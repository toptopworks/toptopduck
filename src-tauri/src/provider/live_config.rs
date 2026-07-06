//! Combined live provider-config source (ADR-0038): the API key comes from the
//! OS keychain ([`KeychainStore`]) and the non-secret endpoint config
//! (`{base_url, model}`) comes from the app-config file. Both are read fresh per
//! call -- stateless, like the keychain -- so an edit (a reconfigured key, a
//! switched endpoint) lands live on the next turn with no caching.
//!
//! This is the single [`ProviderConfigSource`] wired into the real provider as of
//! issue #53; it replaces the pre-#53 design where the keychain held BOTH the key
//! and a provider-config blob. The key still never enters app-config (enforced
//! structurally + a read-time secret scan in [`crate::app_config::io`]); the
//! endpoint config still never enters the keychain (the legacy blob is a one-time
//! migration source only).
//!
//! [`LiveProviderConfig`] is the Tauri-managed state: the IPC commands read/write
//! app-config + the key through it, and the provider holds a clone for per-turn
//! key + endpoint reads. The one-time migration from the legacy keychain blob is
//! baked into [`LiveProviderConfig::load`] (fires only when the app-config file
//! is absent AND a legacy blob is present, so it is idempotent across launches).

use std::path::{Path, PathBuf};

use crate::app_config::{self, AppConfig};
use crate::model::ProviderConfig;
use crate::provider::keychain::{KeychainStore, ProviderConfigSource};

/// The combined live source: key from the OS keychain + `{base_url, model}` and
/// every other preference from the app-config file. Clone is cheap (a stateless
/// [`KeychainStore`] + a [`PathBuf`]); the provider holds a clone and the Tauri
/// state holds another, both reading the same underlying stores.
#[derive(Clone)]
pub struct LiveProviderConfig {
    keychain: KeychainStore,
    path: PathBuf,
}

impl LiveProviderConfig {
    /// Bind a new live source to an app-config `path` (resolved by the caller via
    /// the Tauri `app_data_dir`). The path's parent directory must exist; the
    /// config file itself is created lazily on the first [`Self::store`].
    pub fn new(keychain: KeychainStore, path: PathBuf) -> Self {
        Self { keychain, path }
    }

    /// The configured app-config path (for tests / diagnostics).
    pub fn path(&self) -> &Path {
        &self.path
    }

    // --- Key (delegated to the OS keychain, ADR-0029) ------------------------

    /// Whether an API key is stored. Delegates to the keychain.
    pub fn has_key(&self) -> bool {
        self.keychain.has_key()
    }

    /// Store the API key (one-shot frontend -> Rust transfer, ADR-0029).
    pub fn set_key(&self, key: &str) -> Result<(), String> {
        self.keychain.set_key(key)
    }

    /// Remove the stored API key (idempotent).
    pub fn clear_key(&self) -> Result<(), String> {
        self.keychain.clear_key()
    }

    // --- App-config (preferences + endpoint, ADR-0038) -----------------------

    /// Load the app-config. On the FIRST launch after the ADR-0038 move (the
    /// config file is absent AND a legacy keychain blob is present), seed the
    /// provider section from that blob, best-effort clear it, persist, and return
    /// the seeded config. Otherwise: honest-degrade read (missing/corrupt ->
    /// defaults, ADR-0038). Idempotent: once the file exists, the migration never
    /// fires again, so repeated loads are plain reads.
    pub fn load(&self) -> AppConfig {
        if !self.path.exists() {
            if let Some(blob) = self.keychain.fetch_legacy_provider_blob() {
                return self.migrate_from_legacy_blob(blob);
            }
            // No file, no legacy blob -> defaults (file created lazily on first store).
            return AppConfig::defaults();
        }
        app_config::read_at(&self.path)
    }

    /// One-time migration: seed a fresh app-config's provider section from the
    /// legacy keychain blob, clear the blob, persist, and return the seeded config.
    /// A corrupt blob yields defaults (the legacy entry never bricks the app);
    /// a write failure is swallowed (the in-memory seeded config is still returned
    /// and the next load retries the migration since the file is still absent).
    fn migrate_from_legacy_blob(&self, blob: String) -> AppConfig {
        let mut cfg = AppConfig::defaults();
        if let Ok(legacy) = serde_json::from_str::<ProviderConfig>(&blob) {
            cfg.provider = legacy;
        }
        // Best-effort cleanup whether or not the blob parsed. Swallowed: the
        // migration already produced a valid in-memory config; a lingering non-
        // secret entry is harmless (it just triggers this branch again next load
        // if the write below failed).
        self.keychain.clear_legacy_provider_config();
        let _ = app_config::write_at(&self.path, &cfg);
        cfg
    }

    /// Normalize + atomically persist the app-config, returning the normalized
    /// value that was stored. The caller receives exactly what landed on disk.
    pub fn store(&self, mut cfg: AppConfig) -> Result<AppConfig, app_config::WriteError> {
        cfg.normalize();
        app_config::write_at(&self.path, &cfg)?;
        Ok(cfg)
    }

    /// Record a recently-opened `.duck` path (read-modify-write). Returns whether
    /// the recent-files list actually changed so the caller can skip work when it
    /// did not. A read or write failure is swallowed and reported as "no change"
    /// -- the recent-files list is a convenience, never a correctness surface.
    pub fn record_recent_file(&self, path: &str) -> bool {
        let mut cfg = self.load();
        if !cfg.record_recent_file(path) {
            return false;
        }
        // A store failure is swallowed: the list is advisory. The next open
        // re-reads whatever is on disk and retries.
        self.store(cfg).is_ok()
    }
}

impl ProviderConfigSource for LiveProviderConfig {
    fn api_key(&self) -> Option<String> {
        self.keychain.fetch_key()
    }
    fn base_url(&self) -> String {
        // Fresh disk read each call -- a reconfigured endpoint lands live on the
        // next turn, no caching (matches the keychain's stateless philosophy).
        self.load().provider.base_url
    }
    fn model(&self) -> String {
        self.load().provider.model
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_config::{EngineDefaults, Theme};
    use crate::model::{DEFAULT_PROVIDER_BASE_URL, DEFAULT_PROVIDER_MODEL};

    /// A LiveProviderConfig bound to a temp-dir config path (no real keychain
    /// dependency in tests; the keychain methods that touch the OS entry are not
    /// exercised here).
    fn live() -> (tempfile::TempDir, LiveProviderConfig) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("config.json");
        let live = LiveProviderConfig::new(KeychainStore::new(), path);
        (dir, live)
    }

    #[test]
    fn load_on_first_launch_returns_defaults_when_no_legacy_blob() {
        // No file, no legacy keychain blob -> defaults (the production keychain
        // has no provider-config entry in CI, so fetch_legacy_provider_blob is
        // None here).
        let (_dir, live) = live();
        assert_eq!(live.load(), AppConfig::defaults());
    }

    #[test]
    fn store_then_load_round_trips_and_normalizes() {
        // store normalizes (empty endpoint -> defaults) and persists; load reads
        // it back faithfully.
        let (_dir, live) = live();
        let mut cfg = AppConfig::defaults();
        cfg.theme = Theme::Dark;
        cfg.engine = EngineDefaults {
            memory_limit: "2048MB".into(),
            threads: 0, // invalid -> normalize clamps to 1
            row_cap: 1000,
            statement_timeout_ms: 5000,
        };
        cfg.provider.base_url = "   ".into(); // empty -> default
        let stored = live.store(cfg).expect("store");
        assert_eq!(stored.engine.threads, 1);
        assert_eq!(stored.provider.base_url, DEFAULT_PROVIDER_BASE_URL);
        assert_eq!(stored.theme, Theme::Dark);

        let back = live.load();
        assert_eq!(back, stored);
    }

    #[test]
    fn record_recent_file_persists_across_loads() {
        let (_dir, live) = live();
        assert!(live.record_recent_file("/tmp/a.duck"));
        assert!(live.record_recent_file("/tmp/b.duck"));
        let cfg = live.load();
        assert_eq!(
            cfg.recent_files,
            vec!["/tmp/b.duck".to_string(), "/tmp/a.duck".into()]
        );
    }

    #[test]
    fn record_recent_file_dedupes_on_reopen() {
        let (_dir, live) = live();
        live.record_recent_file("/tmp/a.duck");
        live.record_recent_file("/tmp/b.duck");
        live.record_recent_file("/tmp/a.duck"); // re-open moves a to front
        let cfg = live.load();
        assert_eq!(
            cfg.recent_files,
            vec!["/tmp/a.duck".to_string(), "/tmp/b.duck".into()]
        );
    }

    #[test]
    fn provider_source_reads_endpoint_from_app_config() {
        // The ProviderConfigSource impl reads base_url/model from app-config, not
        // the keychain -- the ADR-0038 split. Seeding app-config then reading via
        // the trait returns the seeded values.
        let (_dir, live) = live();
        let mut cfg = AppConfig::defaults();
        cfg.provider.base_url = "https://gateway.example.test".into();
        cfg.provider.model = "claude-opus-4-8".into();
        live.store(cfg).expect("store");

        assert_eq!(live.base_url(), "https://gateway.example.test");
        assert_eq!(live.model(), "claude-opus-4-8");
        // The key is not stored in this test keychain -> None (the trait's
        // api_key() delegates to the keychain, which has no entry in CI).
        assert!(live.api_key().is_none());
    }

    #[test]
    fn provider_source_returns_default_endpoint_when_unset() {
        // A fresh app-config (defaults) hands the provider the canonical endpoint.
        let (_dir, live) = live();
        assert_eq!(live.base_url(), DEFAULT_PROVIDER_BASE_URL);
        assert_eq!(live.model(), DEFAULT_PROVIDER_MODEL);
    }
}
