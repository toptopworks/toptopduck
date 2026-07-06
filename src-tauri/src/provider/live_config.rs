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
use std::sync::{Arc, Mutex};

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
    /// Serializes the in-process writers (`store` + `record_recent_file`). Both
    /// do read-modify-write on the config file; without coordination two writers
    /// interleave and lose an entire update (`T1 load -> T2 load -> T1 write ->
    /// T2 write` drops T1). Mirrors the `.duck` single-writer (issue #50).
    /// Pure reads (`load`) do NOT take this lock -- they honest-degrade and
    /// tolerate reading a value that is about to be overwritten.
    write_lock: Arc<Mutex<()>>,
}

impl LiveProviderConfig {
    /// Bind a new live source to an app-config `path` (resolved by the caller via
    /// the Tauri `app_data_dir`). The path's parent directory must exist; the
    /// config file itself is created lazily on the first [`Self::store`].
    pub fn new(keychain: KeychainStore, path: PathBuf) -> Self {
        Self {
            keychain,
            path,
            write_lock: Arc::new(Mutex::new(())),
        }
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
    /// provider section from that blob, persist, then best-effort clear it, and
    /// return the seeded config. Otherwise: honest-degrade read (missing/corrupt
    /// -> defaults, ADR-0038). Idempotent: once the file exists, the migration
    /// never fires again, so repeated loads are plain reads.
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
    /// legacy keychain blob, persist, clear the blob, and return the seeded
    /// config. A corrupt blob yields defaults (the legacy entry never bricks the
    /// app); a write failure is logged and the blob is RETAINED so the next load
    /// can retry -- the prior clear-then-write order lost the user's endpoint
    /// pref permanently if the write failed (blob gone, file never created).
    /// Runs inside `load()` (a pure-read path), so it does NOT take
    /// [`Self::write_lock`]; the atomic write_at cannot corrupt the file, and a
    /// race with a concurrent `store` only risks a lost update on the migration
    /// value, which the next load re-reads from disk.
    fn migrate_from_legacy_blob(&self, blob: String) -> AppConfig {
        let mut cfg = AppConfig::defaults();
        if let Ok(legacy) = serde_json::from_str::<ProviderConfig>(&blob) {
            cfg.provider = legacy;
        }
        cfg.normalize();
        // Persist FIRST, clear the legacy blob AFTER. Writing first keeps the
        // blob as a retry source until the migration is durably on disk.
        if let Err(e) = app_config::write_at(&self.path, &cfg) {
            log::warn!(
                "legacy provider-config migration write failed; blob retained for retry: {e}"
            );
            return cfg;
        }
        // Best-effort cleanup now that the file is durably written. A clear
        // failure is harmless -- the file exists so this branch never fires
        // again; a lingering non-secret entry is just a wasted keychain slot.
        self.keychain.clear_legacy_provider_config();
        cfg
    }

    /// Normalize + atomically persist the app-config, returning the normalized
    /// value that was stored. The caller receives exactly what landed on disk.
    /// Acquires [`Self::write_lock`] so concurrent writers (`store` and
    /// `record_recent_file`) serialize -- app-config has no version/CAS, so
    /// last-writer-wins needs the lock to avoid lost updates (issue #53).
    pub fn store(&self, cfg: AppConfig) -> Result<AppConfig, app_config::WriteError> {
        let _guard = self
            .write_lock
            .lock()
            .expect("app-config write_lock poisoned");
        self.store_inner(cfg)
    }

    /// Normalize + persist WITHOUT taking [`Self::write_lock`] -- for callers
    /// (`record_recent_file`) that already hold the lock as part of a load-
    /// modify-write transaction. `std::sync::Mutex` is NOT reentrant, so `store`
    /// cannot recurse into this while a guard is held. (`migrate_from_legacy_blob`
    /// inlines its own normalize + write_at rather than calling this, because it
    /// must return the in-memory cfg even when the write fails, and store_inner
    /// consumes cfg by value.)
    fn store_inner(&self, mut cfg: AppConfig) -> Result<AppConfig, app_config::WriteError> {
        cfg.normalize();
        app_config::write_at(&self.path, &cfg)?;
        Ok(cfg)
    }

    /// Record a recently-opened `.duck` path (read-modify-write). Returns whether
    /// the recent-files list actually changed so the caller can skip work when it
    /// did not. A read or write failure is swallowed and reported as "no change"
    /// -- the recent-files list is a convenience, never a correctness surface.
    /// Holds [`Self::write_lock`] across the whole load-modify-write so a
    /// concurrent `store` cannot interleave and lose either side's update.
    pub fn record_recent_file(&self, path: &str) -> bool {
        let Ok(_guard) = self.write_lock.lock() else {
            return false;
        };
        let mut cfg = self.load();
        if !cfg.record_recent_file(path) {
            return false;
        }
        // store_inner (not store): the guard is already held, and std::sync::Mutex
        // is not reentrant. A failure is swallowed -- the list is advisory; the
        // next open re-reads whatever is on disk and retries.
        self.store_inner(cfg).is_ok()
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
    fn record_recent_file_concurrent_writers_do_not_lose_updates_or_deadlock() {
        // H1 regression: store + record_recent_file both take write_lock (shared
        // across clones via the inner Arc<Mutex>). Multiple concurrent recorders
        // must each land their path (no lost-update) and the test must complete
        // (no deadlock). Without the lock, two interleaved read-modify-write
        // transactions would drop whichever wrote first.
        use std::thread;

        let (_dir, live) = live();
        let paths: Vec<String> = (0..8)
            .map(|i| format!("/tmp/concurrent-{i}.duck"))
            .collect();
        let handles: Vec<_> = paths
            .iter()
            .map(|p| {
                let live = live.clone();
                let p = p.clone();
                thread::spawn(move || live.record_recent_file(&p))
            })
            .collect();
        for h in handles {
            assert!(h.join().expect("worker thread panicked"));
        }
        // Every path landed -- no lost update. Order depends on the scheduler,
        // so check set membership, not order.
        let cfg = live.load();
        for p in &paths {
            assert!(
                cfg.recent_files.contains(p),
                "concurrent record lost path {p}"
            );
        }
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
