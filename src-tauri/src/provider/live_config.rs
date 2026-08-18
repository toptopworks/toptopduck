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

use crate::app_config::{self, AppConfig, DefaultRuntime, LocalePreference};
use crate::mcp::config::{McpServerConfig, McpServerId};
use crate::model::{ProfileId, Protocol};
use crate::provider::keychain::{KeychainStore, ProviderConfigSource};
use crate::provider::prompt::{resolve_locale_from_tag, ResponseLocale};

/// The combined live source: key from the OS keychain + `{base_url, model}` and
/// every other preference from the app-config file. Clone is cheap (a stateless
/// [`KeychainStore`] + a [`PathBuf`]); the provider holds a clone and the Tauri
/// state holds another, both reading the same underlying stores.
#[derive(Clone)]
pub struct LiveProviderConfig {
    keychain: KeychainStore,
    path: PathBuf,
    /// Serializes the in-process writers (`store` + MCP upsert/remove + sessions-dir).
    /// All do read-modify-write on the config file; without coordination two writers
    /// interleave and lose an entire update (`T1 load -> T2 load -> T1 write ->
    /// T2 write` drops T1). Mirrors the `.duck` single-writer (issue #50).
    /// Pure reads (`load`) do NOT take this lock -- they honest-degrade and
    /// tolerate reading a value that is about to be overwritten.
    write_lock: Arc<Mutex<()>>,
}

/// Why an ACTIVE-profile key write (`set_key` / `clear_key`) failed. The two
/// causes map onto different [`crate::commands::StoreCommandError`] variants
/// at the IPC boundary: the zero-profile refusal is a config-state rejection
/// (the OS keychain was never touched -- NOT a keychain fault), while the
/// keychain fault propagates the OS-level detail (ADR-0029).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ActiveKeyError {
    /// No active profile (ADR-0098 zero-profile state or null pointer): there
    /// is no keychain slot to write. A user-correctable refusal, not a fault.
    #[error("no active provider profile to write the key for")]
    NoActiveProfile,
    /// The OS keychain operation itself failed; carries the English technical
    /// detail (locked / service down / permission revoked / corrupt entry).
    #[error("{0}")]
    Keychain(String),
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

    /// Reads the ACTIVE profile's keychain slot (`key-<active_profile_id>`,
    /// ADR-0064 per-profile slot) and propagates the outcome. `Ok(bool)` is the
    /// authoritative has-key state; `Err(detail)` means the OS keychain read
    /// itself failed (locked / service down / permission revoked / corrupt
    /// entry), logged at [`KeychainStore::has_key_for`]. The
    /// `get_provider_config` / `set_provider_config` views feed this straight
    /// into [`crate::model::ProviderConfig::view`], which maps a fault onto the
    /// view's `keychain_fault` so the header indicator renders "keychain
    /// unavailable" instead of misreading the fault as "no key configured"
    /// (issue #275). With no active profile (ADR-0098 zero-profile state) there
    /// is no slot to read: `Ok(false)` -- the honest no-key state, not a fault.
    pub fn has_key(&self) -> Result<bool, String> {
        match self.load().provider.active_profile.as_ref() {
            Some(id) => self.keychain.has_key_for(id),
            None => Ok(false),
        }
    }

    /// Store the API key for the ACTIVE profile (one-shot frontend -> Rust
    /// transfer, ADR-0029; ADR-0064 per-profile slot). With no active profile
    /// (ADR-0098) there is no slot to write: an explicit typed refusal rather
    /// than a silent success that would misread as "stored".
    pub fn set_key(&self, key: &str) -> Result<(), ActiveKeyError> {
        match self.load().provider.active_profile.as_ref() {
            Some(id) => self
                .keychain
                .set_key_for(id, key)
                .map_err(ActiveKeyError::Keychain),
            None => Err(ActiveKeyError::NoActiveProfile),
        }
    }

    /// Remove the stored API key for the ACTIVE profile (idempotent). With no
    /// active profile (ADR-0098) the operation has no referent: an explicit
    /// typed refusal (the caller cannot have meant any specific slot).
    pub fn clear_key(&self) -> Result<(), ActiveKeyError> {
        match self.load().provider.active_profile.as_ref() {
            Some(id) => self
                .keychain
                .clear_key_for(id)
                .map_err(ActiveKeyError::Keychain),
            None => Err(ActiveKeyError::NoActiveProfile),
        }
    }

    // --- Per-profile key (issue #153, ADR-0064) ------------------------------
    //
    // The Profiles management UI edits keys for ANY profile, not just the active
    // one. These delegate to the per-profile keychain slots (`key-<id>`) that the
    // active-path methods above resolve through the active id. Each returns the
    // NEW has_key for the targeted profile (issue #153 AC: set/clear returns a
    // bool) so the frontend updates its overlay without a re-fetch. The profile
    // id is opaque (ADR-0064) -- a string that does not match a stored profile
    // still addresses a valid keychain slot (e.g. a freshly-minted id before its
    // profile is saved, or an orphan after a delete -- ADR-0064 sanctions both).

    /// Key-status overlay for every profile currently in app-config (issue
    /// #153). The Profiles UI seeds its per-profile `has_key` view from this;
    /// profile RECORDS stay single-sourced from app-config. A profile minted
    /// client-side but not yet saved is absent here (the UI defaults it to
    /// `has_key=false` until `set_profile_key` returns `true`).
    pub fn list_profile_key_status(&self) -> Vec<crate::model::ProfileKeyStatus> {
        self.load()
            .provider
            .profiles
            .iter()
            .map(|p| match self.keychain.has_key_for(&p.id) {
                Ok(has_key) => crate::model::ProfileKeyStatus {
                    profile_id: p.id.as_str().to_string(),
                    has_key,
                    keychain_fault: None,
                },
                Err(detail) => crate::model::ProfileKeyStatus {
                    profile_id: p.id.as_str().to_string(),
                    has_key: false,
                    keychain_fault: Some(detail),
                },
            })
            .collect()
    }

    /// Store the key for the named profile (one-shot frontend -> Rust transfer,
    /// ADR-0029; per-profile slot `key-<id>`, ADR-0064). Returns the new has_key
    /// (true on success) so the frontend updates its overlay without a re-fetch.
    pub fn set_profile_key(&self, profile_id: &ProfileId, key: &str) -> Result<bool, String> {
        self.keychain.set_key_for(profile_id, key)?;
        // The write succeeded, so the key IS stored -- a read fault on the
        // post-write status check must not propagate as a write failure (the
        // frontend would misread a successful set as rejected). Honest-degrade
        // to true; the fault is logged at has_key_for, and the next list/read
        // re-reads the live state.
        Ok(self.keychain.has_key_for(profile_id).unwrap_or(true))
    }

    /// Remove the key for the named profile (idempotent). Returns the new
    /// has_key (false on success). A missing entry is success -- clear is a
    /// no-op when nothing was stored; a real keychain error propagates so the
    /// frontend can tell the user the key did not come out (ADR-0029 trust root).
    pub fn clear_profile_key(&self, profile_id: &ProfileId) -> Result<bool, String> {
        self.keychain.clear_key_for(profile_id)?;
        // The delete succeeded (idempotent on a missing entry), so the key is
        // gone -- a read fault on the post-clear status check must not propagate
        // as a delete failure. Honest-degrade to false; the fault is logged at
        // has_key_for.
        Ok(self.keychain.has_key_for(profile_id).unwrap_or(false))
    }

    /// The stored key for the named profile: `Ok(None)` when nothing is
    /// stored, `Err` when the keychain read failed (issue #243: the failure is
    /// propagated, not swallowed -- see [`KeychainStore::fetch_key_for`]).
    /// Rust-internal accessor for the connection preflight (ADR-0070): the
    /// `test_profile` IPC reads the key here (by profile id, never crossing IPC
    /// -- ADR-0029 invariant 3) and hands the read result to
    /// `provider::preflight::run`, which classifies a failure as
    /// `KeychainUnavailable` and otherwise probes the endpoint with the key
    /// attached to the LLM HTTP call placed from the Rust core. Mirrors the
    /// active-profile read on `ProviderConfigSource::api_key` but targets ANY
    /// profile id (the edit form tests the profile being edited, not
    /// necessarily the active one).
    pub fn key_for_profile(&self, profile_id: &ProfileId) -> Result<Option<String>, String> {
        self.keychain.fetch_key_for(profile_id)
    }

    // --- MCP servers (issue #301, ADR-0076) ----------------------------------
    //
    // User-configured external MCP servers live in app-config (`mcp_servers`);
    // their SECRET env values live in the OS keychain under `mcp-<id>-<env_key>`
    // (mcp::secrets). These wrappers give the IPC commands a single entry point:
    // upsert/remove touch app-config (write-locked via `store`), set/clear
    // secret touch the keychain (stateless). remove does NOT clean up keychain
    // entries -- the frontend orchestrates clear-then-remove; orphaned entries
    // keyed by the removed server's (uuid) id are inert.

    /// Upsert one MCP server into app-config: mint a uuid v4 id when the
    /// incoming id is empty (a new server from the frontend), fill
    /// `display_name` from the id when empty, replace an existing entry with the
    /// same id or append. Returns the finalized config (with the stable id) so
    /// the IPC hands it back to the frontend.
    pub fn upsert_mcp_server(
        &self,
        server: McpServerConfig,
    ) -> Result<McpServerConfig, app_config::WriteError> {
        // Hold write_lock across the full load -> mutate -> store so a concurrent
        // upsert / remove cannot interleave and drop this server (a lost update
        // would orphan its keychain anchor). store_inner -- not store -- because
        // the guard is already held and std::sync::Mutex is non-reentrant.
        let _guard = self
            .write_lock
            .lock()
            .expect("app-config write_lock poisoned");
        let mut cfg = self.load();
        let stored = cfg.mcp_servers.upsert(server);
        self.store_inner(cfg)?;
        Ok(stored)
    }

    /// Remove the MCP server with the given id from app-config (idempotent: a
    /// missing id is a no-op). Does NOT clear the server's keychain secrets --
    /// the frontend orchestrates clear-then-remove; orphaned entries keyed by
    /// the removed server's (uuid) id are inert.
    pub fn remove_mcp_server(&self, id: &McpServerId) -> Result<(), app_config::WriteError> {
        // Hold write_lock across the full load -> mutate -> store (same contract
        // as upsert_mcp_server); store_inner, not store --
        // std::sync::Mutex is non-reentrant.
        let _guard = self
            .write_lock
            .lock()
            .expect("app-config write_lock poisoned");
        let mut cfg = self.load();
        cfg.mcp_servers.remove(id);
        self.store_inner(cfg)?;
        Ok(())
    }

    /// Store one MCP server secret in the OS keychain under
    /// `mcp-<id>-<env_key>` (issue #301, ADR-0029 one-shot frontend -> Rust
    /// transfer). The value never crosses IPC back out.
    pub fn set_mcp_secret(
        &self,
        id: &McpServerId,
        env_key: &str,
        value: &str,
    ) -> Result<(), String> {
        crate::mcp::secrets::set_mcp_secret(&self.keychain, id, env_key, value)
    }

    /// Remove one MCP server secret (idempotent). The trust-root rule applies
    /// (ADR-0029): a real keychain error surfaces rather than reading as
    /// "removed".
    pub fn clear_mcp_secret(&self, id: &McpServerId, env_key: &str) -> Result<(), String> {
        crate::mcp::secrets::clear_mcp_secret(&self.keychain, id, env_key)
    }

    /// Read-only snapshot of the configured MCP servers (issue #301 slice
    /// C-gw). The gateway reads this per external turn to connect each
    /// configured server; the clone is cheap (a Vec of small config structs).
    pub fn mcp_servers(&self) -> Vec<McpServerConfig> {
        self.load().mcp_servers.servers.clone()
    }

    /// Borrow the OS keychain (ADR-0029). The gateway reads each server's
    /// secret env values at spawn via [`mcp::secrets::get_mcp_secret`]; the
    /// values never cross IPC back out.
    pub fn keychain(&self) -> &KeychainStore {
        &self.keychain
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

    /// One-time migration: seed a fresh app-config's default profile endpoint
    /// from the legacy keychain blob, persist, clear the blob, and return the
    /// seeded config. The blob is the pre-#53 single-endpoint shape
    /// `{base_url, model}`; this slice's provider schema is multi-profile
    /// (ADR-0064), so the blob's endpoint is spliced into the default profile
    /// rather than assigned wholesale. A corrupt / ill-shaped blob yields
    /// defaults (the legacy entry never bricks the app); a write failure is
    /// logged and the blob is RETAINED so the next load can retry -- the prior
    /// clear-then-write order lost the user's endpoint pref permanently if the
    /// write failed (blob gone, file never created). Runs inside `load()` (a
    /// pure-read path), so it does NOT take [`Self::write_lock`]; the atomic
    /// write_at cannot corrupt the file, and a race with a concurrent `store`
    /// only risks a lost update on the migration value, which the next load
    /// re-reads from disk.
    fn migrate_from_legacy_blob(&self, blob: String) -> AppConfig {
        let mut cfg = AppConfig::defaults();
        // The legacy blob is the pre-#53 `{base_url, model}` shape. Splice
        // both into the default profile's endpoint when they parse; anything
        // else leaves the defaults in place (ADR-0038 honest-degrade -- the
        // pure splice helper is unit-tested per shape branch).
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&blob) {
            splice_legacy_endpoint(&mut cfg, &value);
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
    /// Acquires [`Self::write_lock`] so concurrent writers (`store`, MCP
    /// upsert/remove, `set_sessions_dir`) serialize -- app-config has no
    /// version/CAS, so last-writer-wins needs the lock to avoid lost updates
    /// (issue #53).
    pub fn store(&self, cfg: AppConfig) -> Result<AppConfig, app_config::WriteError> {
        let _guard = self
            .write_lock
            .lock()
            .expect("app-config write_lock poisoned");
        self.store_inner(cfg)
    }

    /// Normalize + persist WITHOUT taking [`Self::write_lock`] -- for callers
    /// (MCP upsert/remove, `set_sessions_dir`) that already hold the lock as part
    /// of a load-modify-write transaction. `std::sync::Mutex` is NOT reentrant,
    /// so `store` cannot recurse into this while a guard is held.
    /// (`migrate_from_legacy_blob` inlines its own normalize + write_at rather
    /// than calling this, because it must return the in-memory cfg even when the
    /// write fails, and store_inner consumes cfg by value.)
    fn store_inner(&self, mut cfg: AppConfig) -> Result<AppConfig, app_config::WriteError> {
        cfg.normalize();
        app_config::write_at(&self.path, &cfg)?;
        Ok(cfg)
    }

    /// Set the managed sessions directory override (issue #452, ADR-0089
    /// Decision 2). Read-modify-write under [`Self::write_lock`] (same pattern
    /// as MCP upsert/remove). The caller validates the path before calling;
    /// this method persists the value verbatim + returns the normalized config
    /// that landed on disk.
    pub fn set_sessions_dir(
        &self,
        path: Option<String>,
    ) -> Result<AppConfig, app_config::WriteError> {
        let _guard = self
            .write_lock
            .lock()
            .expect("app-config write_lock poisoned");
        let mut cfg = self.load();
        cfg.sessions_dir = path;
        self.store_inner(cfg)
    }

    /// Set the default runtime new sessions + resumes start on (ADR-0098
    /// Decision 2, issue #569). Read-modify-write under [`Self::write_lock`]
    /// (same pattern as sessions-dir). The value persists VERBATIM -- no
    /// detected-state write-time validation (ADR-0098 Decision 3): an adapter
    /// that is not currently detected must keep the preference so an
    /// environment restore re-enables the external start with no
    /// re-configuration. Referential validation (the id names a v1 adapter)
    /// is the command boundary's job, not the store's.
    pub fn set_default_runtime(
        &self,
        runtime: DefaultRuntime,
    ) -> Result<AppConfig, app_config::WriteError> {
        let _guard = self
            .write_lock
            .lock()
            .expect("app-config write_lock poisoned");
        let mut cfg = self.load();
        cfg.default_runtime = runtime;
        self.store_inner(cfg)
    }
}

/// Splice the legacy pre-#53 `{base_url, model}` blob into the config
/// (ADR-0038 one-time migration). The ADR-0098 defaults ship zero profiles, so
/// a well-formed blob materializes the default profile (fixed id => the same
/// `key-default` slot the pre-#53 era used) carrying the stored endpoint.
/// Honest-degrade: a malformed / partial / wrong-typed blob leaves the
/// zero-profile defaults in place -- the migration never fails, it just
/// carries less forward. Pure (no IO) so each shape branch is unit-testable
/// without a keychain.
fn splice_legacy_endpoint(cfg: &mut AppConfig, blob: &serde_json::Value) {
    let base_url = blob.get("base_url").and_then(|v| v.as_str());
    let model = blob.get("model").and_then(|v| v.as_str());
    if let (Some(base_url), Some(model)) = (base_url, model) {
        let mut profile = crate::model::ProviderProfile::default_anthropic();
        profile.base_url = base_url.to_string();
        profile.model = model.to_string();
        cfg.provider.active_profile = Some(profile.id.clone());
        cfg.provider.profiles.push(profile);
    }
}

impl ProviderConfigSource for LiveProviderConfig {
    fn api_key(&self) -> Option<String> {
        // Per-turn read of the ACTIVE profile's keychain slot (ADR-0064). Fresh
        // disk read for the active id each call so a switched profile lands its
        // key on the next turn, no caching (matches the keychain's stateless
        // philosophy). A keychain read failure honest-degrades to None -> the
        // turn refuses as NotWired (ADR-0028/0044 permanent): without a
        // readable key the turn cannot go out anyway, and the trait's Option
        // contract cannot carry the error. The failure surfaces when the user
        // next clicks "Test connection" -- test_profile re-reads and classifies
        // it as KeychainUnavailable (issue #243), keeping the Err this per-turn
        // path must drop. Issue #275: log the fault before dropping it so the
        // per-turn honest-degrade leaves a trail (mirrors the has_key_for log);
        // the signature stays Option<String> (per-turn cannot carry the error,
        // and test_profile is the diagnostic entry point).
        let cfg = self.load();
        // Zero-profile state (legal, ADR-0098) or a nulled dangling pointer: no
        // slot to read, so no key (`?` returns None) -- the turn refuses as
        // NotWired, the honest built-in-not-configured outcome.
        let active_id = cfg.provider.active_profile.as_ref()?;
        match self.keychain.fetch_key_for(active_id) {
            Ok(opt) => opt,
            Err(e) => {
                log::warn!(
                    "keychain per-turn read failed for active {}: {e}",
                    active_id
                );
                None
            }
        }
    }
    fn base_url(&self) -> String {
        // Fresh disk read each call -- a reconfigured endpoint on the active
        // profile lands live on the next turn, no caching. effective_base_url
        // falls back to the canonical default when there is no active profile
        // (the legal zero-profile state, or a dangling pointer that normalize
        // nulls on the next store), so a live read never hands the provider an
        // empty endpoint. The IPC view does NOT share this fallback -- it
        // exposes null endpoints instead (ADR-0098).
        self.load().provider.effective_base_url().to_string()
    }
    fn model(&self) -> String {
        self.load().provider.effective_model().to_string()
    }
    fn locale(&self) -> ResponseLocale {
        // ADR-0052: resolve the persisted preference (ADR-0038) here in Rust --
        // never enters ProviderRequest, never pushed by the frontend. An explicit
        // ZhCN/EnUS override maps directly; "system" reads the OS locale fresh
        // per turn (a user who switches their OS language sees the next turn
        // follow it without an app restart). Fresh read each call matches the
        // keychain/endpoint philosophy: no caching.
        match self.load().locale {
            LocalePreference::System => {
                let tag = sys_locale::get_locale().unwrap_or_default();
                resolve_locale_from_tag(&tag)
            }
            LocalePreference::ZhCN => ResponseLocale::ZhCN,
            LocalePreference::EnUS => ResponseLocale::EnUS,
        }
    }
    fn protocol(&self) -> Protocol {
        // ADR-0064 (issue #152): the active profile's wire protocol drives the
        // per-turn adapter routing. Fresh disk read each call so a protocol
        // switch (a different profile set active, or the active profile's
        // protocol edited) lands the next turn on the new adapter, no caching
        // -- matches the keychain/endpoint/locale philosophy.
        self.load().provider.effective_protocol()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_config::{EngineDefaults, LocalePreference, Theme};
    use crate::mcp::config::{McpServerConfig, McpServerId, McpTransport};
    use crate::model::{
        ProfileId, Protocol, ProviderProfile, DEFAULT_PROVIDER_BASE_URL, DEFAULT_PROVIDER_MODEL,
    };
    use std::collections::BTreeMap;

    /// A LiveProviderConfig bound to a temp-dir config path (no real keychain
    /// dependency in tests; the keychain methods that touch the OS entry are not
    /// exercised here).
    fn live() -> (tempfile::TempDir, LiveProviderConfig) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("config.json");
        let live = LiveProviderConfig::new(KeychainStore::new(), path);
        (dir, live)
    }

    /// An app-config with one active anthropic profile -- the pre-0098 stored
    /// shape. The ADR-0098 defaults ship zero profiles, so endpoint/protocol
    /// read tests seed one explicitly.
    fn one_profile_cfg() -> AppConfig {
        let mut cfg = AppConfig::defaults();
        let profile = crate::model::ProviderProfile::default_anthropic();
        cfg.provider.active_profile = Some(profile.id.clone());
        cfg.provider.profiles.push(profile);
        cfg
    }

    #[test]
    fn load_on_first_launch_returns_defaults_when_no_legacy_blob() {
        // No file, no legacy keychain blob -> defaults (the production keychain
        // has no provider-config entry in CI, so fetch_legacy_provider_blob is
        // None here). ADR-0098: the defaults are the zero-profile shape.
        let (_dir, live) = live();
        let cfg = live.load();
        assert_eq!(cfg, AppConfig::defaults());
        assert!(cfg.provider.profiles.is_empty());
        assert_eq!(cfg.provider.active_profile, None);
    }

    #[test]
    fn store_persists_the_zero_profile_state_across_a_reload() {
        // ADR-0098: deleting every profile persists -- the store path must not
        // resurrect a skeleton (the pre-0098 normalize re-seeded), and a
        // reload reads the same zero-profile state back.
        let (_dir, live) = live();
        let mut cfg = AppConfig::defaults();
        cfg.provider.profiles.clear();
        cfg.provider.active_profile = None;
        let stored = live.store(cfg).expect("store");
        assert!(stored.provider.profiles.is_empty());
        assert_eq!(stored.provider.active_profile, None);
        let back = live.load();
        assert!(back.provider.profiles.is_empty());
        assert_eq!(back.provider.active_profile, None);
    }

    #[test]
    fn splice_legacy_endpoint_copies_both_fields_when_well_formed() {
        // The pre-#53 legacy blob shape is `{base_url, model}`. Both fields
        // splice into the materialized default profile when present and
        // stringy (ADR-0098 zero-profile defaults leave no slot to splice
        // into, so the migration materializes one -- fixed id, so the stored
        // key lands on the same `key-default` slot as the pre-#53 era).
        let mut cfg = AppConfig::defaults();
        let blob = serde_json::json!({
            "base_url": "https://gateway.example.test",
            "model": "claude-fable-5"
        });
        splice_legacy_endpoint(&mut cfg, &blob);
        let active = cfg.provider.active().expect("active profile");
        assert_eq!(active.base_url, "https://gateway.example.test");
        assert_eq!(active.model, "claude-fable-5");
        assert_eq!(cfg.provider.profiles.len(), 1);
    }

    #[test]
    fn splice_legacy_endpoint_leaves_defaults_when_one_field_missing() {
        // ADR-0038 honest-degrade: a partial blob (only base_url) carries
        // nothing forward -- the zero-profile defaults stand so a half-shape
        // legacy entry never seeds a mismatched endpoint/model pair.
        let mut cfg = AppConfig::defaults();
        let blob = serde_json::json!({ "base_url": "https://gateway.example.test" });
        splice_legacy_endpoint(&mut cfg, &blob);
        assert!(cfg.provider.profiles.is_empty());
        assert_eq!(cfg.provider.active_profile, None);
    }

    #[test]
    fn splice_legacy_endpoint_leaves_defaults_when_fields_are_wrong_type() {
        // Non-string fields (a number where base_url is expected, a bool where
        // model is expected) do not splice -- as_str() is None for both, so the
        // zero-profile defaults stand rather than seeding a nonsense endpoint.
        let mut cfg = AppConfig::defaults();
        let blob = serde_json::json!({ "base_url": 42, "model": true });
        splice_legacy_endpoint(&mut cfg, &blob);
        assert!(cfg.provider.profiles.is_empty());
        assert_eq!(cfg.provider.active_profile, None);
    }

    #[test]
    fn splice_legacy_endpoint_leaves_defaults_when_blob_is_not_an_object() {
        // A non-object JSON value (array / string / null) has no base_url/model
        // keys, so the splice is a no-op and the zero-profile defaults stand.
        // (A malformed JSON string never reaches this function --
        // migrate_from_legacy_blob gates on serde_json::from_str succeeding
        // first.)
        let mut cfg = AppConfig::defaults();
        let blob = serde_json::json!(["not", "an", "object"]);
        splice_legacy_endpoint(&mut cfg, &blob);
        assert!(cfg.provider.profiles.is_empty());
        assert_eq!(cfg.provider.active_profile, None);
    }

    #[test]
    fn store_then_load_round_trips_and_normalizes() {
        // store normalizes (empty endpoint -> defaults) and persists; load reads
        // it back faithfully.
        let (_dir, live) = live();
        let mut cfg = one_profile_cfg();
        cfg.theme = Theme::Dark;
        cfg.engine = EngineDefaults {
            memory_limit: "2048MB".into(),
            threads: 0, // invalid -> normalize clamps to 1
            row_cap: 1000,
            statement_timeout_ms: 5000,
        };
        cfg.provider
            .active_mut()
            .expect("seeded config has an active profile")
            .base_url = "   ".into(); // empty -> default
        let stored = live.store(cfg).expect("store");
        assert_eq!(stored.engine.threads, 1);
        assert_eq!(
            stored.provider.active().expect("active profile").base_url,
            DEFAULT_PROVIDER_BASE_URL
        );
        assert_eq!(stored.theme, Theme::Dark);

        let back = live.load();
        assert_eq!(back, stored);
    }

    #[test]
    fn provider_source_reads_endpoint_from_app_config() {
        // The ProviderConfigSource impl reads base_url/model from the ACTIVE
        // profile in app-config, not the keychain -- the ADR-0038/0064 split.
        // Seeding the active profile then reading via the trait returns the
        // seeded values.
        let (_dir, live) = live();
        let mut cfg = one_profile_cfg();
        {
            let active = cfg
                .provider
                .active_mut()
                .expect("seeded config has an active profile");
            active.base_url = "https://gateway.example.test".into();
            active.model = "claude-opus-4-8".into();
        }
        live.store(cfg).expect("store");

        assert_eq!(live.base_url(), "https://gateway.example.test");
        assert_eq!(live.model(), "claude-opus-4-8");
        // The key is not stored in this test keychain -> None (the trait's
        // api_key() delegates to the keychain, which has no entry in CI).
        assert!(live.api_key().is_none());
    }

    #[test]
    fn provider_source_falls_back_to_default_endpoint_when_active_missing() {
        // A hand-edited config whose active_profile points nowhere must fall
        // back to the canonical endpoint defaults on a LIVE read (before
        // normalize nulls it on the next store), never panic or emit "". The
        // api_key() lookup uses the dangling id -> no slot -> None (safe).
        let (_dir, live) = live();
        let mut cfg = one_profile_cfg();
        cfg.provider.active_profile = Some(crate::model::ProfileId("no-such-profile".into()));
        // Write WITHOUT normalize so the dangling active id survives on disk
        // (a hand-edit scenario, not the store path which nulls it).
        app_config::write_at(live.path(), &cfg).expect("write");

        assert_eq!(live.base_url(), DEFAULT_PROVIDER_BASE_URL);
        assert_eq!(live.model(), DEFAULT_PROVIDER_MODEL);
        assert!(live.api_key().is_none());
    }

    #[test]
    fn provider_source_reads_canonical_endpoint_in_the_zero_profile_state() {
        // ADR-0098: a zero-profile app-config (the fresh defaults) still hands
        // the provider read path the canonical endpoint -- the reads stay
        // total, never "" -- but no key exists, so any turn refuses as
        // NotWired (the honest built-in-not-configured outcome; the submit
        // gate redirects to Settings before a turn can even start).
        let (_dir, live) = live();
        assert_eq!(live.base_url(), DEFAULT_PROVIDER_BASE_URL);
        assert_eq!(live.model(), DEFAULT_PROVIDER_MODEL);
        assert!(live.api_key().is_none());
        assert_eq!(live.protocol(), Protocol::Anthropic);
        // The has_key view short-circuits: no active profile -> no slot to
        // read -> the authoritative no-key state, not a keychain fault.
        assert_eq!(live.has_key(), Ok(false));
    }

    #[test]
    fn provider_source_resolves_explicit_locale_overrides() {
        // ADR-0052: an explicit ZhCN/EnUS preference maps directly to the
        // ResponseLocale the provider feeds the prompt directive. "system" is
        // covered implicitly (it reads the OS locale, environment-dependent);
        // the zh*/en*/fallback MAPPING is pinned in prompt::resolve_locale_from_tag.
        let (_dir, live) = live();
        let mut cfg = AppConfig::defaults();
        cfg.locale = LocalePreference::ZhCN;
        live.store(cfg).expect("store");
        assert_eq!(live.locale(), ResponseLocale::ZhCN);

        let mut cfg = AppConfig::defaults();
        cfg.locale = LocalePreference::EnUS;
        live.store(cfg).expect("store");
        assert_eq!(live.locale(), ResponseLocale::EnUS);
    }

    #[test]
    fn provider_source_default_locale_never_panics() {
        // A fresh app-config (locale = System) must resolve without panicking
        // even when the OS locale is absent (sys_locale returns None -> empty
        // tag -> EnUS fallback). The exact result depends on the host, so only
        // assert it lands in the two-variant set, not a specific value.
        let (_dir, live) = live();
        let resolved = live.locale();
        assert!(matches!(
            resolved,
            ResponseLocale::ZhCN | ResponseLocale::EnUS
        ));
    }

    #[test]
    fn provider_source_reads_protocol_from_active_profile() {
        // ADR-0064 (issue #152): the ProviderConfigSource::protocol read drives
        // the live router's per-turn adapter dispatch. Seed an Openai protocol
        // on the active profile, store, then read via the trait -- the trait
        // must surface what the active profile carries, never a cached/default
        // value (the production config source is the only protocol source the
        // router reads, so its correctness is load-bearing).
        let (_dir, live) = live();
        let mut cfg = one_profile_cfg();
        {
            let active = cfg
                .provider
                .active_mut()
                .expect("seeded config has an active profile");
            active.protocol = Protocol::Openai;
        }
        live.store(cfg).expect("store");
        assert_eq!(live.protocol(), Protocol::Openai);
    }

    #[test]
    fn provider_source_falls_back_to_anthropic_when_active_missing() {
        // A hand-edited config whose active_profile points nowhere must fall
        // back to the Anthropic protocol default on a LIVE read (before
        // normalize nulls it on the next store), never panic -- mirrors the
        // endpoint fallback contract. A wrong-protocol turn is hard to
        // diagnose from the bare NotWired/Unavailable it produces downstream,
        // so the fallback is deterministic Anthropic.
        let (_dir, live) = live();
        let mut cfg = one_profile_cfg();
        cfg.provider.active_profile = Some(crate::model::ProfileId("no-such-profile".into()));
        // Write WITHOUT normalize so the dangling active id survives on disk
        // (a hand-edit scenario, not the store path which nulls it).
        app_config::write_at(live.path(), &cfg).expect("write");
        assert_eq!(live.protocol(), Protocol::Anthropic);
    }

    #[test]
    fn provider_source_protocol_reflects_profile_switch() {
        // Core ADR-0064 AC: switching the active profile lands the new protocol
        // on the next trait read -- no LiveProvider reboot, no cached protocol.
        // The live source reads disk per call, so flipping active_profile
        // between two profiles (Anthropic + Openai) surfaces each one's
        // protocol in turn. Two cache regressions are pinned: (a) a once_cell
        // populated on the first protocol() call would freeze at the first
        // read; (b) a snapshot taken at LiveProviderConfig::new would freeze
        // at construction -- rebinding the source between flips (and re-reading
        // it after the second flip) proves neither can sneak in green.
        let (_dir, live) = live();
        let path = live.path().to_path_buf();
        let mut cfg = AppConfig::defaults();
        let anthropic_id = ProfileId("__test_anthropic_profile".into());
        let openai_id = ProfileId("__test_openai_profile".into());
        cfg.provider.profiles = vec![
            ProviderProfile {
                id: anthropic_id.clone(),
                display_name: "Anthropic".into(),
                protocol: Protocol::Anthropic,
                base_url: "https://api.anthropic.example.test".into(),
                model: "claude-sonnet-4-6".into(),
            },
            ProviderProfile {
                id: openai_id.clone(),
                display_name: "OpenAI".into(),
                protocol: Protocol::Openai,
                base_url: "https://api.openai.example.test".into(),
                model: "gpt-4o".into(),
            },
        ];
        cfg.provider.active_profile = Some(anthropic_id.clone());
        live.store(cfg).expect("store");
        // Starts on the anthropic profile.
        assert_eq!(live.protocol(), Protocol::Anthropic);

        // Flip active to the Openai profile (the IPC set_active path).
        let mut cfg = live.load();
        cfg.provider.active_profile = Some(openai_id);
        live.store(cfg).expect("store");
        assert_eq!(live.protocol(), Protocol::Openai);

        // Rebind the source to the same path -- a constructor-time snapshot
        // cache would freeze Openai here, but the live read must follow the
        // next flip below too.
        let rebound = LiveProviderConfig::new(KeychainStore::new(), path);
        assert_eq!(rebound.protocol(), Protocol::Openai);

        // Flip back to the anthropic profile -- both the original and the
        // rebound source follow each switch.
        let mut cfg = live.load();
        cfg.provider.active_profile = Some(anthropic_id);
        live.store(cfg).expect("store");
        assert_eq!(live.protocol(), Protocol::Anthropic);
        assert_eq!(rebound.protocol(), Protocol::Anthropic);
    }

    #[test]
    fn list_profile_key_status_returns_one_entry_per_profile_with_bool() {
        // Issue #153: the overlay returns one entry per profile in app-config,
        // keyed by id, with has_key from the per-profile keychain slot. Synthetic
        // ids that no real keychain entry uses -> has_key is deterministically
        // false (the keychain read is a non-mutating Entry lookup, the same path
        // the existing api_key() tests exercise). profile_id is the opaque id
        // verbatim; the UI never assumes structure.
        let (_dir, live) = live();
        let mut cfg = AppConfig::defaults();
        cfg.provider.profiles = vec![
            ProviderProfile {
                id: ProfileId("__test_list_a".into()),
                display_name: "A".into(),
                protocol: Protocol::Anthropic,
                base_url: DEFAULT_PROVIDER_BASE_URL.into(),
                model: DEFAULT_PROVIDER_MODEL.into(),
            },
            ProviderProfile {
                id: ProfileId("__test_list_b".into()),
                display_name: "B".into(),
                protocol: Protocol::Openai,
                base_url: "https://api.deepseek.example.test".into(),
                model: "deepseek-chat".into(),
            },
        ];
        live.store(cfg).expect("store");
        let status = live.list_profile_key_status();
        assert_eq!(status.len(), 2);
        assert_eq!(status[0].profile_id, "__test_list_a");
        assert_eq!(status[1].profile_id, "__test_list_b");
        // No keychain entry exists for these synthetic ids -> has_key false.
        // Issue #275: the read itself succeeded (CI keychain has no entry but
        // the read does not fail), so keychain_fault is None -- the frontend
        // renders "no key", not "keychain unavailable". The fault branch cannot
        // be reproduced in CI (OS keychain locking needs host manipulation) and
        // is covered by the wire-shape pin in tests/ipc_contract.rs + the
        // Result-returning has_key_for contract.
        assert!(!status[0].has_key);
        assert!(!status[1].has_key);
        assert!(status[0].keychain_fault.is_none());
        assert!(status[1].keychain_fault.is_none());
    }

    #[test]
    fn has_key_propagates_the_active_profile_read_outcome() {
        // Issue #275: has_key() propagates the keychain read outcome for the
        // active profile. In CI the read succeeds (no entry, but not a fault),
        // so the result is Ok(false) -- the authoritative no-key state. The
        // fault branch (Err) cannot be reproduced in CI (OS keychain locking
        // needs host manipulation); it rides the wire-shape pin in
        // tests/ipc_contract.rs (ProviderConfigView.keychain_fault) + the
        // Result-returning has_key_for contract.
        let (_dir, live) = live();
        let cfg = one_profile_cfg();
        live.store(cfg).expect("store");
        assert_eq!(live.has_key(), Ok(false));
    }

    #[test]
    fn has_key_short_circuits_to_false_in_the_zero_profile_state() {
        // ADR-0098: with no active profile there is no keychain slot to read.
        // Ok(false) is the honest no-key state (not a fault), and no keychain
        // entry is consulted -- the zero-profile config never surfaces a
        // spurious keychain_fault on the view.
        let (_dir, live) = live();
        live.store(AppConfig::defaults()).expect("store");
        assert_eq!(live.has_key(), Ok(false));
        // set_key / clear_key have no referent: an explicit TYPED refusal
        // (ActiveKeyError::NoActiveProfile -- a config-state rejection the
        // command boundary maps to StoreCommandError::NoActiveProfile, NOT
        // KeychainFailure), never a silent success that would misread as
        // "stored" / "removed".
        assert_eq!(
            live.set_key("sk-test"),
            Err(ActiveKeyError::NoActiveProfile)
        );
        assert_eq!(live.clear_key(), Err(ActiveKeyError::NoActiveProfile));
    }

    // --- default runtime (issue #569, ADR-0098 Decision 2) ------------------

    #[test]
    fn set_default_runtime_persists_verbatim_across_a_reload() {
        // The IPC round-trip: set external -> the returned config carries it ->
        // a reload reads it back verbatim. gemini-cli is NOT installed on CI,
        // which is the point: the store path has no detected-state validation
        // (ADR-0098 Decision 3) -- an undetected adapter's preference persists
        // so an environment restore re-enables it with no re-configuration.
        let (_dir, live) = live();
        let stored = live
            .set_default_runtime(DefaultRuntime::External("gemini-cli".into()))
            .expect("set_default_runtime");
        assert_eq!(
            stored.default_runtime,
            DefaultRuntime::External("gemini-cli".into())
        );
        assert_eq!(
            live.load().default_runtime,
            DefaultRuntime::External("gemini-cli".into())
        );
        // Setting BuiltIn resets the start to the built-in loop.
        let reset = live
            .set_default_runtime(DefaultRuntime::BuiltIn)
            .expect("set_default_runtime built-in");
        assert_eq!(reset.default_runtime, DefaultRuntime::BuiltIn);
        assert_eq!(live.load().default_runtime, DefaultRuntime::BuiltIn);
    }

    // --- MCP server CRUD (issue #301 slice B) -------------------------------

    #[test]
    fn upsert_mcp_server_mints_id_and_persists_across_loads() {
        // The wrapper does load -> registry.upsert (mint id + fill
        // display_name) -> store. A reload sees the finalized server, proving
        // the write_lock-protected round-trip lands the new server on disk.
        let (_dir, live) = live();
        let incoming = McpServerConfig {
            id: McpServerId(String::new()),
            display_name: String::new(),
            transport: McpTransport::stdio("/bin/github-mcp", Vec::new()),
            env: BTreeMap::new(),
            keychain_env_keys: Vec::new(),
            timeout_ms: None,
        };
        let stored = live.upsert_mcp_server(incoming).expect("upsert");
        assert_ne!(stored.id.as_str(), "");
        assert_eq!(stored.display_name, stored.id.as_str());
        let reloaded = live.load();
        assert_eq!(reloaded.mcp_servers.servers.len(), 1);
        assert_eq!(reloaded.mcp_servers.servers[0].id, stored.id);
    }

    #[test]
    fn upsert_mcp_server_replaces_existing_by_id() {
        // Re-upserting with the same id replaces (not appends) + persists.
        let (_dir, live) = live();
        let first = McpServerConfig {
            id: McpServerId("stable-id".into()),
            display_name: "Old".into(),
            transport: McpTransport::stdio("/bin/old", Vec::new()),
            env: BTreeMap::new(),
            keychain_env_keys: Vec::new(),
            timeout_ms: None,
        };
        live.upsert_mcp_server(first).expect("first upsert");
        let updated = McpServerConfig {
            id: McpServerId("stable-id".into()),
            display_name: "New".into(),
            transport: McpTransport::stdio("/bin/new", vec!["--flag".into()]),
            env: BTreeMap::new(),
            keychain_env_keys: Vec::new(),
            timeout_ms: None,
        };
        live.upsert_mcp_server(updated).expect("second upsert");
        let reloaded = live.load();
        assert_eq!(reloaded.mcp_servers.servers.len(), 1, "replace not append");
        assert_eq!(reloaded.mcp_servers.servers[0].display_name, "New");
    }

    #[test]
    fn remove_mcp_server_drops_from_persisted_config() {
        // remove -> store -> reload sees the server gone. Idempotent on a
        // missing id (no error, no change).
        let (_dir, live) = live();
        let stored = live
            .upsert_mcp_server(McpServerConfig {
                id: McpServerId(String::new()),
                display_name: "GH".into(),
                transport: McpTransport::stdio("/bin/srv", Vec::new()),
                env: BTreeMap::new(),
                keychain_env_keys: Vec::new(),
                timeout_ms: None,
            })
            .expect("upsert");
        live.remove_mcp_server(&stored.id).expect("remove");
        let reloaded = live.load();
        assert!(reloaded.mcp_servers.servers.is_empty());
        // Idempotent: removing the same id again is a no-op success.
        live.remove_mcp_server(&stored.id).expect("remove again");
    }

    #[test]
    fn upsert_mcp_server_concurrent_writers_do_not_lose_servers() {
        // I1 regression: upsert_mcp_server holds write_lock across the full
        // load -> mutate -> store (same contract as store). Multiple
        // concurrent upserts must each land their server (no lost-update) and the
        // test must complete (no deadlock). Without the full-window lock two
        // interleaved read-modify-write transactions would drop whichever wrote
        // first, orphaning its keychain anchor.
        use std::thread;

        let (_dir, live) = live();
        let labels: Vec<String> = (0..8).map(|i| format!("srv-{i}")).collect();
        let handles: Vec<_> = labels
            .iter()
            .map(|label| {
                let live = live.clone();
                let server = McpServerConfig {
                    id: McpServerId(String::new()),
                    display_name: label.clone(),
                    transport: McpTransport::stdio("/bin/srv", Vec::new()),
                    env: BTreeMap::new(),
                    keychain_env_keys: Vec::new(),
                    timeout_ms: None,
                };
                thread::spawn(move || live.upsert_mcp_server(server).expect("upsert").id)
            })
            .collect();
        let ids: Vec<McpServerId> = handles
            .into_iter()
            .map(|h| h.join().expect("worker thread panicked"))
            .collect();
        // Every minted id landed -- no lost update (order is scheduler-dependent,
        // so check membership, not order).
        let cfg = live.load();
        assert_eq!(
            cfg.mcp_servers.servers.len(),
            labels.len(),
            "concurrent upserts lost a server"
        );
        for id in &ids {
            assert!(
                cfg.mcp_servers.servers.iter().any(|s| &s.id == id),
                "concurrent upsert lost server {id}"
            );
        }
    }
}
