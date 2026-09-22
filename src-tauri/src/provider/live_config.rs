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

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::app_config::{self, AppConfig, DefaultRuntime, LocalePreference, ModelPosture};
use crate::cli_tools::config::{CliToolConfig, CliToolSource};
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
    /// Serializes the in-process writers (`store` + MCP upsert + sessions-dir).
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

/// Why a CLI-tool registry write failed (issue #671): an invalid entry
/// (validation detail, user-correctable) or an app-config write fault.
/// Separate variants because the command layer maps them to different
/// [`crate::commands::StoreCommandError`] members.
#[derive(Debug, thiserror::Error)]
pub enum CliToolWriteError {
    #[error("invalid CLI tool registration: {0}")]
    Invalid(String),
    #[error("{0}")]
    Write(#[from] app_config::WriteError),
}

/// One skills-registry scan, two projections (issue #933 review DRY): the
/// registered-name set every agents command partitions marks against, and
/// the name-to-body map the delegation assembly injects from. Both
/// consumers ride the same listing, so they cannot disagree on which
/// skills count as registered.
fn scan_registered_skills(
    skills_root: &Path,
) -> (BTreeSet<String>, std::collections::BTreeMap<String, String>) {
    let skills = crate::skills::registry::list_skills(skills_root).skills;
    let mut names = BTreeSet::new();
    let mut bodies = std::collections::BTreeMap::new();
    for skill in skills {
        names.insert(skill.name.clone());
        bodies.insert(skill.name, skill.body);
    }
    (names, bodies)
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

    /// The bare `active_profile` pointer behind the key paths: one load +
    /// field extract, no resolution against the profile list (that is
    /// [`crate::model::ProviderConfig::active`]'s job). `None` iff the
    /// pointer is null: the legal zero-profile state (ADR-0098), or a
    /// dangling pointer a store's normalize has already nulled. A
    /// not-yet-nulled dangling pointer comes back as-is and addresses an
    /// orphan slot (`key-<id>`; ADR-0064 sanctions orphans) until the next
    /// store's normalize nulls it. Each caller translates `None` (no slot to
    /// address) per its own contract: honest no-key / typed refusal / no key.
    fn active_profile_id(&self) -> Option<ProfileId> {
        self.load().provider.active_profile
    }

    /// Reads the ACTIVE profile's keychain slot (`key-<active_profile_id>`,
    /// ADR-0064 per-profile slot) and propagates the outcome. `Ok(bool)` is the
    /// authoritative has-key state; `Err(detail)` means the OS keychain read
    /// itself failed (locked / service down / permission revoked / corrupt
    /// entry), logged at [`KeychainStore::has_key_for`]. The
    /// `get_provider_config` / `set_provider_config` views feed this straight
    /// into [`crate::model::ProviderConfig::view`], which maps a fault onto the
    /// view's `keychain_fault` so the header indicator renders "keychain
    /// unavailable" instead of misreading the fault as "no key configured"
    /// (issue #275). With no active profile ([`Self::active_profile_id`]) there is no
    /// slot to read: `Ok(false)` -- the honest no-key state, not a fault.
    pub fn has_key(&self) -> Result<bool, String> {
        match self.active_profile_id() {
            Some(id) => self.keychain.has_key_for(&id),
            None => Ok(false),
        }
    }

    /// Store the API key for the ACTIVE profile (one-shot frontend -> Rust
    /// transfer, ADR-0029; ADR-0064 per-profile slot). With no active profile
    /// ([`Self::active_profile_id`]) there is no slot to write: an explicit typed
    /// refusal rather than a silent success that would misread as "stored".
    pub fn set_key(&self, key: &str) -> Result<(), ActiveKeyError> {
        let id = self
            .active_profile_id()
            .ok_or(ActiveKeyError::NoActiveProfile)?;
        self.keychain
            .set_key_for(&id, key)
            .map_err(ActiveKeyError::Keychain)
    }

    /// Remove the stored API key for the ACTIVE profile (idempotent). With no
    /// active profile ([`Self::active_profile_id`]) the operation has no referent: an
    /// explicit typed refusal (the caller cannot have meant any specific slot).
    pub fn clear_key(&self) -> Result<(), ActiveKeyError> {
        let id = self
            .active_profile_id()
            .ok_or(ActiveKeyError::NoActiveProfile)?;
        self.keychain
            .clear_key_for(&id)
            .map_err(ActiveKeyError::Keychain)
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
    // upsert touches app-config (write-locked via `store`), set/clear secret
    // touch the keychain (stateless). Deletion is NOT a dedicated IPC -- the
    // frontend writes the filtered full config, then clears the removed
    // server's keychain entries best-effort; an orphaned entry keyed by a
    // removed server's (uuid) id is inert (nothing reads it).

    /// Upsert one MCP server into app-config: mint a uuid v4 id when the
    /// incoming id is empty (a new server from the frontend), fill
    /// `display_name` from the id when empty, replace an existing entry with the
    /// same id or append. Returns the finalized config (with the stable id) so
    /// the IPC hands it back to the frontend.
    pub fn upsert_mcp_server(
        &self,
        server: McpServerConfig,
    ) -> Result<McpServerConfig, app_config::WriteError> {
        // Header-face guard at the deepest write boundary (issue #901): every
        // path that persists a server (the IPC upsert command, any future
        // internal writer) refuses an invalid header face here -- a save the
        // read-time scan would later nuke the whole file over must never
        // succeed in the first place. Before the write lock: fail fast, no
        // file touched.
        crate::mcp::config::validate_mcp_server_headers(&server)
            .map_err(app_config::WriteError::Validation)?;
        // Hold write_lock across the full load -> mutate -> store so a concurrent
        // upsert cannot interleave and drop this server (a lost update
        // would orphan its keychain anchor). store_inner -- not store -- because
        // the guard is already held and std::sync::Mutex is non-reentrant.
        let _guard = self
            .write_lock
            .lock()
            .expect("app-config write_lock poisoned");
        let mut cfg = self.load_for_write()?;
        let stored = cfg.mcp_servers.upsert(server);
        self.store_inner(cfg)?;
        Ok(stored)
    }

    /// Upsert one CLI tool registration (issue #671, ADR-0108 Decision 2 +
    /// ADR-0109 Decision 9): validate, then read-modify-write under the same
    /// write_lock as every registry write. Returns the updated FULL config
    /// (the ADR-0109 Decision 9 frontend-sync contract -- unlike
    /// `upsert_mcp_server`, which predates it and returns the entry).
    pub fn upsert_cli_tool(&self, mut tool: CliToolConfig) -> Result<AppConfig, CliToolWriteError> {
        let _guard = self
            .write_lock
            .lock()
            .expect("app-config write_lock poisoned");
        let mut cfg = self.load_for_write().map_err(CliToolWriteError::Write)?;
        // The backend is the baseline authority on BOTH sides (issue #676,
        // ADR-0109 Decision 2): a builtin entry's posture is recomputed
        // under the write lock from the tracked-field diff, and a user
        // entry never carries one -- whatever a hand-rolled IPC call
        // submitted, the marker is meaningless off the baseline.
        if tool.source == CliToolSource::Builtin {
            let posture = crate::cli_tools::builtin::baseline_after_edit(
                cfg.cli_tools.get(&tool.name),
                &tool,
            );
            tool.baseline = Some(posture);
        } else {
            tool.baseline = None;
        }
        cfg.cli_tools
            .upsert(tool)
            .map_err(CliToolWriteError::Invalid)?;
        self.store_inner(cfg).map_err(CliToolWriteError::Write)
    }

    /// Remove one CLI tool registration by name (idempotent: removing a name
    /// that is not registered still returns the config). Returns the updated
    /// full config (ADR-0109 Decision 9). A BUILTIN entry is refused
    /// (ADR-0109 Decision 2, issue #676): deletion would need suppression
    /// tracking to stop the next scan from resurrecting the entry --
    /// disabling is the single shutdown axis. The refusal is by the ENTRY's
    /// source, not the name: a user entry owning a builtin name (the
    /// conflict posture) stays removable -- disposing of it is how the
    /// builtin entry gets to register.
    pub fn remove_cli_tool(&self, name: &str) -> Result<AppConfig, CliToolWriteError> {
        let _guard = self
            .write_lock
            .lock()
            .expect("app-config write_lock poisoned");
        let mut cfg = self.load_for_write().map_err(CliToolWriteError::Write)?;
        if cfg
            .cli_tools
            .get(name)
            .is_some_and(|t| t.source == CliToolSource::Builtin)
        {
            return Err(CliToolWriteError::Invalid(format!(
                "`{name}` is a built-in CLI tool; disable it instead of deleting"
            )));
        }
        cfg.cli_tools.remove(name);
        self.store_inner(cfg).map_err(CliToolWriteError::Write)
    }

    /// Restore one builtin entry's definition body to the shipped baseline
    /// (ADR-0109 Decision 2, issue #676): the four tracked fields are
    /// rewritten and the entry returns to `Following` (future upgrades
    /// follow the baseline again); the machine-local `executable` and the
    /// `enabled` intent axis are untouched. Returns the updated full config
    /// (ADR-0109 Decision 9).
    pub fn restore_builtin_cli_tool(&self, name: &str) -> Result<AppConfig, CliToolWriteError> {
        let _guard = self
            .write_lock
            .lock()
            .expect("app-config write_lock poisoned");
        let mut cfg = self.load_for_write().map_err(CliToolWriteError::Write)?;
        let Some(def) = crate::cli_tools::builtin::find_definition(name) else {
            return Err(CliToolWriteError::Invalid(format!(
                "`{name}` is not a built-in CLI tool"
            )));
        };
        let Some(tool) = cfg.cli_tools.tools.iter_mut().find(|t| t.name == name) else {
            return Err(CliToolWriteError::Invalid(format!(
                "`{name}` is not registered"
            )));
        };
        if tool.source != CliToolSource::Builtin {
            return Err(CliToolWriteError::Invalid(format!(
                "`{name}` is not a built-in CLI tool registration"
            )));
        }
        def.apply_baseline(tool);
        self.store_inner(cfg).map_err(CliToolWriteError::Write)
    }

    /// The builtin-entry scan: detect the shipped definitions' executables
    /// and auto-register the hits in one read-modify-write (issue #675,
    /// ADR-0109 Decisions 1/3/9). Detection runs inside the write lock so
    /// the snapshot and the written registry cannot interleave with a
    /// concurrent user write. `path_env` injects the PATH value for tests;
    /// `None` reads the process environment. Returns the updated full
    /// config plus the detection snapshot (the rescan IPC hands both to
    /// the frontend, which syncs without a re-fetch).
    pub fn scan_and_register(
        &self,
        path_env: Option<std::ffi::OsString>,
        skills_root: &std::path::Path,
    ) -> Result<crate::cli_tools::builtin::BuiltinScanResult, CliToolWriteError> {
        let _guard = self
            .write_lock
            .lock()
            .expect("app-config write_lock poisoned");
        let mut cfg = self.load_for_write().map_err(CliToolWriteError::Write)?;
        let resolve = |name: &str| match &path_env {
            Some(env) => crate::cli_tools::builtin::which_in(name, env),
            None => crate::cli_tools::builtin::which(name),
        };
        let (scan, to_register) = crate::cli_tools::builtin::scan(&cfg.cli_tools, resolve);
        // Baseline reconciliation rides the same write (issue #676,
        // ADR-0109 Decision 2): a FOLLOWING entry drifted from the shipped
        // definition upgrades silently; EDITED entries are preserved. The
        // two plans are disjoint by construction -- the scan only plans
        // names with no entry, the reconciler only touches existing ones.
        let upgraded = crate::cli_tools::builtin::reconcile_baselines(&mut cfg.cli_tools);
        let nothing_registered = to_register.is_empty();
        for tool in to_register {
            cfg.cli_tools
                .upsert(tool)
                .map_err(CliToolWriteError::Invalid)?;
        }
        // Builtin-skill alignment rides the same window (issue #677;
        // ADR-0121 Decision 3): the reserved `.system/` subtree is brought
        // to fingerprint agreement with the embedded tree, per anchored
        // manifest entry -- the freshly-registered entries are already in
        // `cfg.cli_tools`, so a first detection materializes its companion
        // skill in this same window. Alignment writes NOTHING to app-config
        // (the baseline side table is retired), so the persist decision is
        // the CLI's alone.
        let skills = crate::skills::builtin::align(skills_root, &cfg.cli_tools);
        let config = if nothing_registered && upgraded.is_empty() {
            // Nothing to persist: every shipped CLI definition is dormant
            // or already registered, and the baseline reconciliation found
            // no drift. Skip the rewrite so startup and pane mounts do not
            // churn the config file (normalize + atomic write).
            cfg
        } else {
            self.store_inner(cfg).map_err(CliToolWriteError::Write)?
        };
        for name in upgraded {
            log::info!(
                target: "toptopduck::cli_tools",
                "builtin CLI entry `{name}` upgraded to the shipped definition (unedited)"
            );
        }
        Ok(crate::cli_tools::builtin::BuiltinScanResult {
            config,
            scan,
            skill_materialize_failures: skills.materialize_failures,
        })
    }

    /// The registered-skills name set the agent preamble marks partition
    /// against (issue #932): the spec-valid listing off the same scan the
    /// Skills pane reads. One derivation shared by every agents command, so
    /// the two panes cannot disagree on which skills count as registered.
    fn registered_skill_names(skills_root: &Path) -> BTreeSet<String> {
        scan_registered_skills(skills_root).0
    }

    /// List the agent-definitions registry (issue #932): the directory scan
    /// over the agents root, merged with the machine-level enablement set,
    /// the builtin materialization mark, and the backtick skill-mark
    /// partition. Read-only -- cannot refuse.
    pub fn list_agents(
        &self,
        agents_root: &Path,
        skills_root: &Path,
    ) -> crate::agents::AgentListing {
        let cfg = self.load();
        let mark = crate::agents::BuiltinAgentMark::from_config(&cfg);
        let skill_names = Self::registered_skill_names(skills_root);
        crate::agents::registry::list_agents(agents_root, &mark, &cfg.enabled_agents, &skill_names)
    }

    /// The turn's delegation snapshot (issue #933, ADR-0117): the enabled
    /// agent definitions assembled into [`DelegationSpec`]s with their
    /// bound skill bodies resolved against the skills registry. Read-side
    /// degradation is honest and non-blocking: a registry that cannot be
    /// read yields an empty family (the turn simply carries no delegation
    /// tool), with every degraded row logged -- the settings pane surfaces
    /// the same faults, the turn path never surfaces them anywhere else.
    pub fn delegation_specs(
        &self,
        agents_root: &Path,
        skills_root: &Path,
    ) -> Vec<crate::agents::DelegationSpec> {
        // #944 review Advisory B: a default install (no definition ever
        // created) must not pay the skills-registry scan -- a directory
        // walk plus a full parse per registered skill -- under the held
        // session lock. A bare read_dir is the whole cost of knowing the
        // family is empty: no `.md` file in the registry implies no
        // definition however wide the registry's own admission rule ever
        // grows (a wider rule can only add files, and this check missing
        // them degrades to the full scan, never to a wrong family).
        let has_definitions = std::fs::read_dir(agents_root)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .any(|e| e.path().extension().is_some_and(|ext| ext == "md"))
            })
            .unwrap_or(false);
        if !has_definitions {
            return Vec::new();
        }
        let cfg = self.load();
        let (skill_names, bodies) = scan_registered_skills(skills_root);
        let mark = crate::agents::BuiltinAgentMark::from_config(&cfg);
        let listing = crate::agents::registry::list_agents(
            agents_root,
            &mark,
            &cfg.enabled_agents,
            &skill_names,
        );
        if let Some(root_error) = &listing.root_error {
            log::warn!(
                target: "agents",
                "delegation assembly: agents registry read fault: {root_error}"
            );
        }
        for skipped in &listing.ignored {
            log::warn!(
                target: "agents",
                "delegation assembly: skipped definition `{}`: {}",
                skipped.file,
                skipped.reason
            );
        }
        for warning in &listing.warnings {
            log::warn!(target: "agents", "delegation assembly: {warning:?}");
        }
        let mut specs = Vec::new();
        for entry in listing.agents.iter().filter(|entry| entry.enabled) {
            let (spec, skipped) = crate::agents::DelegationSpec::from_entry(entry, &bodies);
            // The single degradation record (issue #945): `from_entry`
            // reports the dangling skips back as values (logged here,
            // beside the registry's own faults above); its one side
            // effect is the shared body cap's truncation warn, firing
            // inside `cap_body` itself (issue #1025).
            for name in skipped {
                log::warn!(
                    target: "agents",
                    "delegation assembly: bound skill `{name}` is no longer registered; \
                     skipping its injection (ADR-0117 Decision 2)"
                );
            }
            specs.push(spec);
        }
        specs
    }

    /// Mint + enable as one composite (issue #932): the file mint lands
    /// ENABLED -- the explicit create is explicit intent (the blankCliTool
    /// precedent). The enablement write degrades with a log: the row renders
    /// with its switch off and the user can flip it. The read-back partitions
    /// the preamble marks against the real registered-skills set. Returns the
    /// entry for the written definition (read back, or derived from the
    /// written payload on a transient read-back failure).
    pub fn create_agent(
        &self,
        agents_root: &Path,
        skills_root: &Path,
        name: &str,
        description: &str,
        preamble: &str,
    ) -> Result<crate::agents::AgentEntry, crate::agents::AgentError> {
        let cfg = self.load();
        let entry = crate::agents::registry::create_agent(
            agents_root,
            name,
            description,
            preamble,
            &cfg.enabled_agents,
            &Self::registered_skill_names(skills_root),
        )?;
        if let Err(e) = self.set_agent_enabled(name, true) {
            log::warn!(
                "created agent definition `{name}` but failed to enable it (flip the \
                 switch in the Agents pane): {e}"
            );
            return Ok(entry);
        }
        Ok(crate::agents::AgentEntry {
            enabled: true,
            ..entry
        })
    }

    /// Rewrite + carry as one composite (issue #932): `name` addresses the
    /// current file; `update.name` is the identity to write -- a different
    /// value renames the file and carries the enablement entry with it
    /// (without the carry an enabled definition would silently read disabled
    /// under its new name, and the old entry would linger inert). The carry
    /// degrades with a warn; the returned entry's enablement reflects the
    /// post-carry set. Returns the entry for the written definition (read
    /// back, or derived from the written payload on a transient read-back
    /// failure).
    pub fn update_agent(
        &self,
        agents_root: &Path,
        skills_root: &Path,
        name: &str,
        update: crate::agents::AgentUpdate,
    ) -> Result<crate::agents::AgentEntry, crate::agents::AgentError> {
        let cfg = self.load();
        let mark = crate::agents::BuiltinAgentMark::from_config(&cfg);
        let skill_names = Self::registered_skill_names(skills_root);
        let mut updated = crate::agents::registry::update_agent(
            agents_root,
            &mark,
            name,
            update,
            &cfg.enabled_agents,
            &skill_names,
        )?;
        if updated.name != name {
            match self.rename_agent_enabled(name, &updated.name) {
                Ok(carried) => {
                    updated.enabled = carried.enabled_agents.contains(&updated.name);
                }
                Err(e) => {
                    log::warn!(
                        "renamed agent definition `{name}` -> `{}` but failed to carry its \
                         enablement entry (flip the switch in the Agents pane): {e}",
                        updated.name
                    );
                }
            }
        }
        Ok(updated)
    }

    /// Delete + stale-entry drop as one composite (issue #932): the file
    /// removal IS the operation; the enablement drop keeps the set honest,
    /// but a leftover entry is inert by construction (the reader intersects
    /// with the registry scan), so a cleanup failure degrades with a warn
    /// and the returned config reflects whatever the set holds (the create
    /// posture -- the delete must not report failure for an operation that
    /// landed). Returns the updated FULL app-config (the ADR-0109 Decision 9
    /// sync contract).
    pub fn delete_agent(
        &self,
        agents_root: &Path,
        name: &str,
    ) -> Result<AppConfig, crate::agents::AgentError> {
        let mark = crate::agents::BuiltinAgentMark::from_config(&self.load());
        crate::agents::registry::delete_agent(agents_root, &mark, name)?;
        match self.set_agent_enabled(name, false) {
            Ok(cfg) => Ok(cfg),
            Err(e) => {
                log::warn!(
                    "deleted agent definition `{name}` but failed to drop its enablement \
                     entry (the stale name is inert): {e}"
                );
                Ok(self.load())
            }
        }
    }

    /// The builtin agent-definitions startup window (issue #932, ADR-0117
    /// Decision 3): materialize / adopt / clean the shipped set against the
    /// registry under the write lock, persisting only when the mark moved.
    /// The window also binds default enablement to the mark difference
    /// (issue #948): every name it newly records -- first materialization,
    /// the adopt self-heal, a shipped-set evolution addition -- enters the
    /// enablement set, so a fresh install lands the builtin set enabled
    /// (Decision 3's fallback). A previously recorded name never differs,
    /// which keeps an explicit disable from reviving -- even when a deleted
    /// file re-materializes under the record -- and migrates nothing on
    /// existing installs. Failures are the caller's to log-and-degrade (the
    /// next startup retries).
    pub fn materialize_builtin_agents(
        &self,
        agents_root: &std::path::Path,
    ) -> Result<(), app_config::WriteError> {
        let _guard = self
            .write_lock
            .lock()
            .expect("app-config write_lock poisoned");
        let mut cfg = self.load_for_write()?;
        let mark_before = cfg.materialized_builtin_agents.clone();
        if crate::agents::builtin::reconcile(agents_root, &mut cfg.materialized_builtin_agents) {
            // A non-empty difference implies the reconcile reported dirty,
            // so an enablement write never persists without the mark write
            // landing beside it (mark-only dirt -- a dropped stale record,
            // a file rewritten under its record -- persists with no
            // enablement change).
            for name in cfg.materialized_builtin_agents.difference(&mark_before) {
                cfg.enabled_agents.insert(name.clone());
            }
            self.store_inner(cfg)?;
        }
        Ok(())
    }

    /// Set one agent definition's machine-level enablement (issue #932,
    /// ADR-0117 Decision 2): the app-config name set is the single axis --
    /// enabled = listed into the built-in runtime's every-turn tool face
    /// (#933), disabled = hidden. Read-modify-write under the same write
    /// lock as every registry write. Returns the updated FULL config (the
    /// ADR-0109 Decision 9 frontend-sync contract).
    pub fn set_agent_enabled(
        &self,
        name: &str,
        enabled: bool,
    ) -> Result<AppConfig, app_config::WriteError> {
        let _guard = self
            .write_lock
            .lock()
            .expect("app-config write_lock poisoned");
        let mut cfg = self.load_for_write()?;
        let trimmed = name.trim().to_string();
        if enabled {
            if trimmed.is_empty() {
                return Err(app_config::WriteError::Validation(
                    "an agent-definition name must not be blank".into(),
                ));
            }
            cfg.enabled_agents.insert(trimmed);
        } else {
            cfg.enabled_agents.remove(&trimmed);
        }
        self.store_inner(cfg)
    }

    /// Flip one skill's enablement on the config-level axis (issue #961,
    /// ADR-0118 Decision 2). Disabled = dormant (out of the new-session
    /// seed, grayed in the settings pane; the directory stays); enabled =
    /// the default-on posture. Read-modify-write under the same write lock
    /// as every config write. Returns the updated FULL config (the
    /// ADR-0109 Decision 9 frontend-sync contract).
    pub fn set_skill_enabled(
        &self,
        name: &str,
        enabled: bool,
    ) -> Result<AppConfig, app_config::WriteError> {
        let _guard = self
            .write_lock
            .lock()
            .expect("app-config write_lock poisoned");
        let mut cfg = self.load_for_write()?;
        let trimmed = name.trim().to_string();
        if enabled {
            cfg.disabled_skills.remove(&trimmed);
        } else {
            if trimmed.is_empty() {
                return Err(app_config::WriteError::Validation(
                    "a skill name must not be blank".into(),
                ));
            }
            cfg.disabled_skills.insert(trimmed);
        }
        self.store_inner(cfg)
    }

    /// Carry one skill's disablement across a rename (issue #961): a
    /// disabled name that renames keeps its dormant state (the entry moves
    /// `from` -> `to`); an enabled rename is a no-op -- the disable-polarity
    /// mirror of [`Self::rename_agent_enabled`].
    pub fn rename_skill_disabled(
        &self,
        from: &str,
        to: &str,
    ) -> Result<AppConfig, app_config::WriteError> {
        let _guard = self
            .write_lock
            .lock()
            .expect("app-config write_lock poisoned");
        let mut cfg = self.load_for_write()?;
        if cfg.disabled_skills.remove(from) {
            cfg.disabled_skills.insert(to.to_string());
        }
        self.store_inner(cfg)
    }

    /// Mint + lands-enabled as one composite (issue #961, ADR-0118 Decision
    /// 2): enablement is the default polarity, and the mint also clears any
    /// STALE same-name disabled entry an earlier delete may have left --
    /// without the clear, a dangling disabled name would silently shadow the
    /// rebirth, violating "newly created skills are enabled with zero
    /// bookkeeping". The clear degrades with a warn (the mint landed); the
    /// returned entry's enablement reflects the set as it stands.
    pub fn create_skill(
        &self,
        skills_root: &std::path::Path,
        name: &str,
        description: &str,
        body: &str,
    ) -> Result<crate::skills::SkillEntry, crate::skills::SkillError> {
        let entry = crate::skills::registry::create_skill(skills_root, name, description, body)?;
        self.land_enabled(entry)
    }

    /// The whole-string create entry (ADR-0122 Decision 1): the model-face
    /// channel's composite -- the same registry mint + stale-disabled-entry
    /// clear the form channel gets, so both creation surfaces land a
    /// rebirth enabled by one contract.
    pub fn create_skill_from_markdown(
        &self,
        skills_root: &std::path::Path,
        markdown: &str,
    ) -> Result<crate::skills::SkillEntry, crate::skills::SkillError> {
        let entry = crate::skills::registry::create_skill_from_markdown(skills_root, markdown)?;
        self.land_enabled(entry)
    }

    /// The post-mint enablement composite both create entries share: the
    /// mint also clears any STALE same-name disabled entry an earlier
    /// delete may have left -- without the clear, a dangling disabled name
    /// would silently shadow the rebirth, violating "newly created skills
    /// are enabled with zero bookkeeping" (issue #961, ADR-0118 Decision
    /// 2). The clear degrades with a warn (the mint landed); the returned
    /// entry's enablement reflects the set as it stands.
    fn land_enabled(
        &self,
        entry: crate::skills::SkillEntry,
    ) -> Result<crate::skills::SkillEntry, crate::skills::SkillError> {
        match self.set_skill_enabled(&entry.name, true) {
            Ok(_) => Ok(entry),
            Err(e) => {
                let name = &entry.name;
                log::warn!(
                    "created skill `{name}` but failed to clear a stale disabled entry \
                     (flip the switch in the Skills pane): {e}"
                );
                let cfg = self.load();
                Ok(crate::skills::SkillEntry {
                    enabled: !cfg.disabled_skills.contains(name),
                    ..entry
                })
            }
        }
    }

    /// Rewrite + disablement carry as one composite (issue #961): a rename
    /// moves a disabled entry to the new name (without the carry the disable
    /// veto would silently evaporate under the new name, and the old entry
    /// would linger dangling); an enabled rename is a no-op. The carry
    /// degrades with a warn; the returned entry's enablement reflects the
    /// post-carry set.
    pub fn update_skill(
        &self,
        skills_root: &std::path::Path,
        name: &str,
        update: crate::skills::SkillUpdate,
    ) -> Result<crate::skills::SkillEntry, crate::skills::SkillError> {
        let mut updated = crate::skills::registry::update_skill(skills_root, name, update)?;
        if updated.name != name {
            match self.rename_skill_disabled(name, &updated.name) {
                Ok(cfg) => {
                    updated.enabled = !cfg.disabled_skills.contains(&updated.name);
                }
                Err(e) => {
                    log::warn!(
                        "renamed skill `{name}` -> `{}` but failed to carry its disabled \
                         entry (flip the switch in the Skills pane): {e}",
                        updated.name
                    );
                    let cfg = self.load();
                    updated.enabled = !cfg.disabled_skills.contains(&updated.name);
                }
            }
        }
        Ok(updated)
    }

    /// Delete + stale-entry drop as one composite (issue #961): the
    /// directory removal IS the operation; the disabled-entry drop keeps the
    /// set honest for a future same-name rebirth (a dangling disabled name
    /// would otherwise shadow it), but a leftover entry is inert until that
    /// rebirth, so a cleanup failure degrades with a warn and the delete
    /// never reports failure for an operation that landed.
    pub fn delete_skill(
        &self,
        skills_root: &std::path::Path,
        name: &str,
    ) -> Result<(), crate::skills::SkillError> {
        crate::skills::registry::delete_skill(skills_root, name)?;
        if let Err(e) = self.set_skill_enabled(name, true) {
            log::warn!(
                "deleted skill `{name}` but failed to drop its disabled entry (the stale \
                 name is inert until a same-name rebirth): {e}"
            );
        }
        Ok(())
    }

    /// Carry one agent definition's enablement across a rename (issue #932):
    /// an enabled definition that renames keeps its enabled state (the entry
    /// moves `from` -> `to` in the name set); a disabled rename is a no-op --
    /// no stale `from` entry is created. Read-modify-write under the same
    /// write lock as every registry write.
    pub fn rename_agent_enabled(
        &self,
        from: &str,
        to: &str,
    ) -> Result<AppConfig, app_config::WriteError> {
        let _guard = self
            .write_lock
            .lock()
            .expect("app-config write_lock poisoned");
        let mut cfg = self.load_for_write()?;
        if cfg.enabled_agents.remove(from) {
            cfg.enabled_agents.insert(to.to_string());
        }
        self.store_inner(cfg)
    }

    /// Read-only snapshot of the configured CLI registry: every entry,
    /// enabled or not (the settings list renders the disabled rows too).
    pub fn cli_tools(&self) -> Vec<CliToolConfig> {
        self.load().cli_tools.tools.clone()
    }

    /// The effective CLI tool set (ADR-0106 single axis): the entries whose
    /// config-level `enabled` flag is on. Disabled means dormant -- no
    /// tool-table entry, no spawn. `ask` feeds exactly this slice.
    ///
    /// This is also the read-side honest-degrade point for the name
    /// invariants: the tool table and the dispatch arm both consume this
    /// slice, and a hand-edited file -- the threat model the secret-name
    /// scan and the write-path `normalize` dedupe already defend against --
    /// can carry a reserved or duplicate name past the upsert boundary.
    /// Such an entry is dropped here (keep-first on duplicates, the
    /// `McpServerRegistry::normalize` precedent, logged not silent) so the
    /// provider request never sees a duplicate tool name and no builtin is
    /// shadowed.
    pub fn enabled_cli_tools(&self) -> Vec<CliToolConfig> {
        let mut seen = std::collections::HashSet::new();
        self.cli_tools()
            .into_iter()
            .filter(|tool| tool.enabled)
            .filter(|tool| {
                // The validate-side legal-shape rule's read twin (issue
                // #675): one predicate, `has_legal_shape`, serves both
                // sides. A hand-edited file claiming builtin provenance
                // still cannot shadow a DuckDB tool / mcp__ handle / meta
                // tool, smuggle a foreign name, or carry no baseline. The
                // drop log names the actual failure mode.
                if crate::cli_tools::config::has_legal_shape(tool) {
                    true
                } else if tool.source == CliToolSource::Builtin {
                    log::warn!(
                        "cli tool `{}` in the config file claims builtin \
                         provenance on a foreign name or carries no baseline; \
                         it is excluded from the tool surface (remove the \
                         entry or restore its baseline)",
                        tool.name
                    );
                    false
                } else {
                    log::warn!(
                        "cli tool `{}` in the config file uses a reserved \
                         name; it is excluded from the tool surface (rename \
                         or remove it)",
                        tool.name
                    );
                    false
                }
            })
            .filter(|tool| {
                if !seen.insert(tool.name.clone()) {
                    log::warn!(
                        "duplicate cli tool name `{}` in the config file; \
                         keeping the first occurrence only",
                        tool.name
                    );
                    false
                } else {
                    true
                }
            })
            .collect()
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

    /// Store one MCP server request-header secret in the OS keychain under
    /// `mcp-<id>-header-<name>` (issue #901, the header-face counterpart of
    /// [`Self::set_mcp_secret`]).
    pub fn set_mcp_header_secret(
        &self,
        id: &McpServerId,
        header_name: &str,
        value: &str,
    ) -> Result<(), String> {
        crate::mcp::secrets::set_mcp_header_secret(&self.keychain, id, header_name, value)
    }

    /// Remove one MCP server request-header secret (idempotent; issue #901).
    pub fn clear_mcp_header_secret(
        &self,
        id: &McpServerId,
        header_name: &str,
    ) -> Result<(), String> {
        crate::mcp::secrets::clear_mcp_header_secret(&self.keychain, id, header_name)
    }

    /// Read-only snapshot of the configured registry (issue #301 slice
    /// C-gw): every server, enabled or not (the settings list renders the
    /// disabled rows too). The turn's effective set is the filtered
    /// [`Self::enabled_mcp_servers`]; the clone is cheap (a Vec of small
    /// config structs).
    pub fn mcp_servers(&self) -> Vec<McpServerConfig> {
        self.load().mcp_servers.servers.clone()
    }

    /// ADR-0106: the effective MCP set -- the configured servers whose
    /// config-level `enabled` flag is on. Single-axis by decision: no
    /// per-session or skill-declared contribution exists, and disabled means
    /// dormant (no connect, no child spawn, no keychain secret read, no
    /// catalog entry). `ask` feeds exactly this slice to the turn's
    /// aggregator, so a disabled server never reaches `connect_all`.
    pub fn enabled_mcp_servers(&self) -> Vec<McpServerConfig> {
        self.mcp_servers()
            .into_iter()
            .filter(|srv| srv.enabled)
            .collect()
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
            return self.load_missing();
        }
        app_config::read_at(&self.path)
    }

    /// The value for an absent config file: the one-time legacy keychain blob
    /// migration when a blob is present, otherwise the built-in defaults (the
    /// file is created lazily on first store). A missing file is the correct
    /// starting value, not a degraded state -- shared by [`load`] and the
    /// read-modify-write entries below.
    fn load_missing(&self) -> AppConfig {
        if let Some(blob) = self.keychain.fetch_legacy_provider_blob() {
            return self.migrate_from_legacy_blob(blob);
        }
        AppConfig::defaults()
    }

    /// The read source for the read-modify-write entries (issue #602). Unlike
    /// [`load`], a read failure on an EXISTING file surfaces as `Err` instead
    /// of degrading to defaults: a degraded read handed to `store_inner` would
    /// atomically persist "defaults + this one write", resetting every other
    /// pref on disk while the write reports success. Only a missing file goes
    /// to the defaults (same branch as `load`, legacy migration included).
    fn load_for_write(&self) -> Result<AppConfig, app_config::WriteError> {
        match app_config::parse_at(&self.path) {
            Ok(cfg) => Ok(cfg),
            Err(app_config::AppConfigReadError::Missing) => Ok(self.load_missing()),
            Err(reason) => Err(app_config::WriteError::Read(format!(
                "{reason}: {}",
                self.path.display()
            ))),
        }
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
    /// write failed (blob gone, file never created). Runs from the two
    /// missing-file branches -- `load()` (a pure-read path) and
    /// `load_for_write()`'s Missing arm (already holding [`Self::write_lock`])
    /// -- so it does NOT take the lock itself: `write_at` is lock-free and
    /// `store_inner` is not re-entered. The atomic write_at cannot corrupt the
    /// file, and on the read path a race with a concurrent `store` only risks
    /// a lost update on the migration value, which the next load re-reads
    /// from disk.
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
    /// upsert, `set_sessions_dir`) serialize -- app-config has no
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
    /// (MCP upsert, `set_sessions_dir`) that already hold the lock as part
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

    /// Set the whole provider section (the multi-profile `{profiles,
    /// active_profile}` shape, ADR-0064/0098) in one read-modify-write under
    /// [`Self::write_lock`] -- same pattern as the other section setters, so
    /// the locked writers serialize with this one instead of racing the bare
    /// load + `store` the command layer used before. Strict read source
    /// (issue #602): a read failure on an existing file refuses the write
    /// instead of degrading to "defaults + this section", and the provider
    /// section lands verbatim after `normalize` with every sibling section
    /// intact. Returns the normalized config that landed on disk.
    pub fn set_provider_section(
        &self,
        config: crate::model::ProviderConfig,
    ) -> Result<AppConfig, app_config::WriteError> {
        let _guard = self
            .write_lock
            .lock()
            .expect("app-config write_lock poisoned");
        let mut cfg = self.load_for_write()?;
        cfg.provider = config;
        self.store_inner(cfg)
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
        let mut cfg = self.load_for_write()?;
        cfg.sessions_dir = path;
        self.store_inner(cfg)
    }

    /// Set the default runtime new sessions start on (ADR-0098 Decision 2,
    /// issue #569; since ADR-0102 a resume continues the session's own last
    /// runtime instead -- the default stays the fallback for a pre-#589
    /// recipe whose header carries no `last_runtime`). Read-modify-write
    /// under [`Self::write_lock`]
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
        let mut cfg = self.load_for_write()?;
        cfg.default_runtime = runtime;
        self.store_inner(cfg)
    }

    /// Set one adapter's backfill posture entry (ADR-0100 Decision 3, issue
    /// #581). Read-modify-write under [`Self::write_lock`] (same pattern as
    /// default-runtime): the posture lands on ONE map entry, every sibling
    /// field survives. The default posture (`None`/`None`) IS the explicit
    /// cleared form -- the entry stays in the map rather than being removed,
    /// per the ADR's "clear empties the entry" wording. Like
    /// `set_default_runtime`, no referential validation: a dangling adapter id
    /// persists verbatim (Decision 4) and the command boundary owns the
    /// id-names-a-v1-adapter check.
    pub fn set_last_model_posture(
        &self,
        adapter_id: &str,
        posture: ModelPosture,
    ) -> Result<AppConfig, app_config::WriteError> {
        let _guard = self
            .write_lock
            .lock()
            .expect("app-config write_lock poisoned");
        let mut cfg = self.load_for_write()?;
        cfg.last_model_postures
            .insert(adapter_id.to_string(), posture);
        self.store_inner(cfg)
    }

    /// Read one adapter's backfill posture (ADR-0100, issue #581).
    /// Lock-light: an honest-degrade [`Self::load`] read, no write lock -- the
    /// same contract as every other read here. No entry = the empty posture
    /// (unselected startup), so the read never distinguishes "cleared" from
    /// "never chosen": both start the next session unselected.
    pub fn last_model_posture(&self, adapter_id: &str) -> ModelPosture {
        self.load()
            .last_model_postures
            .get(adapter_id)
            .cloned()
            .unwrap_or_default()
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
        // No active profile ([`Self::active_profile_id`]): no slot to read, so no key
        // (`?` returns None) -- the turn refuses as NotWired, the honest
        // built-in-not-configured outcome.
        let active_id = self.active_profile_id()?;
        match self.keychain.fetch_key_for(&active_id) {
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
    use crate::cli_tools::config::CliBaselineState;
    use crate::mcp::config::{McpServerConfig, McpServerId, McpTransport};
    use crate::model::{
        ProfileId, Protocol, ProviderProfile, DEFAULT_PROVIDER_BASE_URL, DEFAULT_PROVIDER_MODEL,
    };
    use std::collections::BTreeMap;

    /// A LiveProviderConfig bound to a temp-dir config path. The keychain
    /// WRITE path never runs here, but note that `load()` on a MISSING config
    /// does query the OS keychain for the legacy provider blob
    /// (`fetch_legacy_provider_blob`) -- without a legacy entry (CI) that
    /// read degrades to the documented default; on a machine still carrying
    /// one it would migrate and clear the real entry (review C, issue #707).
    fn live() -> (tempfile::TempDir, LiveProviderConfig) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("config.json");
        let live = LiveProviderConfig::new(KeychainStore::new(), path);
        (dir, live)
    }

    /// A minimal valid CLI registration for the RMW tests (issue #671).
    fn cli_tool(name: &str) -> CliToolConfig {
        CliToolConfig {
            name: name.to_string(),
            description: "convert documents".to_string(),
            executable: "pandoc".to_string(),
            argv_template: vec!["{input}".to_string()],
            params: vec![crate::cli_tools::config::CliToolParam {
                name: "input".to_string(),
                description: "source file".to_string(),
                delivery: crate::cli_tools::config::CliParamDelivery::Argv,
                varargs: false,
            }],
            env: BTreeMap::new(),
            enabled: true,
            source: crate::cli_tools::config::CliToolSource::User,
            baseline: None,
        }
    }

    #[test]
    fn upsert_cli_tool_validates_persists_and_returns_the_full_config() {
        let (_dir, live) = live();
        let cfg = live.upsert_cli_tool(cli_tool("my-pandoc")).expect("upsert");
        assert_eq!(
            cfg.cli_tools.tools.len(),
            1,
            "returned config carries the entry"
        );
        assert_eq!(cfg.cli_tools.tools[0].name, "my-pandoc");
        // The write landed on disk: a fresh snapshot reads it back.
        assert_eq!(live.cli_tools().len(), 1);

        // An invalid entry never touches the registry (ADR-0108 Decision 2).
        let mut reserved = cli_tool("explore");
        reserved.name = "explore".to_string();
        assert!(matches!(
            live.upsert_cli_tool(reserved),
            Err(CliToolWriteError::Invalid(_))
        ));
        // The builtin CLI names are equally reserved at the upsert boundary
        // (ADR-0109 Decision 7): a user `pandoc` would race the
        // conflict-deference mechanism for the builtin entry's own name.
        assert!(matches!(
            live.upsert_cli_tool(cli_tool("pandoc")),
            Err(CliToolWriteError::Invalid(_))
        ));
        assert_eq!(live.cli_tools().len(), 1);
    }

    #[test]
    fn enabled_cli_tools_drops_a_builtin_claim_on_a_foreign_reserved_name() {
        // A hand-edited file claiming `source: "builtin"` for a reserved
        // name (here the DuckDB tool `explore`) must still drop from the
        // tool surface: provenance does not license shadowing (issue #675
        // review finding -- the read twin of the validate-side rule).
        let (dir, live) = live();
        let mut cfg = AppConfig::defaults();
        let mut claim = cli_tool("my-pandoc");
        claim.name = "explore".to_string();
        claim.source = crate::cli_tools::config::CliToolSource::Builtin;
        claim.baseline = Some(crate::cli_tools::config::CliBaselineState::Following);
        // The legitimate builtin shape passes for contrast.
        let mut own = cli_tool("my-pandoc");
        own.name = "pandoc".to_string();
        own.source = crate::cli_tools::config::CliToolSource::Builtin;
        own.baseline = Some(crate::cli_tools::config::CliBaselineState::Following);
        cfg.cli_tools.tools = vec![claim, own];
        std::fs::write(
            dir.path().join("config.json"),
            serde_json::to_string(&cfg).unwrap(),
        )
        .unwrap();
        let names: Vec<String> = live
            .enabled_cli_tools()
            .into_iter()
            .map(|t| t.name)
            .collect();
        assert_eq!(names, vec!["pandoc".to_string()]);
    }

    #[test]
    fn enabled_cli_tools_filters_the_single_enable_axis() {
        let (_dir, live) = live();
        let mut disabled = cli_tool("my-pandoc");
        disabled.enabled = false;
        live.upsert_cli_tool(cli_tool("officecli"))
            .expect("upsert 1");
        live.upsert_cli_tool(disabled).expect("upsert 2");
        let enabled = live.enabled_cli_tools();
        let names: Vec<&str> = enabled.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["officecli"],
            "disabled means dormant (ADR-0106)"
        );
    }

    #[test]
    fn enabled_cli_tools_excludes_reserved_and_duplicate_names_from_a_drifted_file() {
        // A hand-edited file bypasses upsert's validate(): a reserved name
        // would shadow a builtin in the dispatch order and duplicate names
        // would put two tools of one name into the provider request (which
        // providers reject outright). The read-side filter keeps the
        // agent-facing slice well-formed regardless of what the file says.
        let (dir, live) = live();
        let mut cfg = AppConfig::defaults();
        let mut reserved = cli_tool("my-pandoc");
        reserved.name = "explore".to_string();
        let mut builtin_named = cli_tool("my-pandoc");
        builtin_named.name = "python".to_string();
        let mut dup = cli_tool("my-pandoc");
        dup.executable = "other-bin".to_string();
        cfg.cli_tools.tools = vec![cli_tool("my-pandoc"), reserved, builtin_named, dup];
        let path = dir.path().join("config.json");
        std::fs::write(&path, serde_json::to_string(&cfg).unwrap()).unwrap();
        let enabled = live.enabled_cli_tools();
        let names: Vec<&str> = enabled.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["my-pandoc"],
            "the reserved name is dropped and the duplicate keeps the first occurrence"
        );
        assert_eq!(
            enabled[0].executable, "pandoc",
            "keep-FIRST on duplicates (normalize's precedent)"
        );
    }

    #[test]
    fn remove_cli_tool_persists_and_is_idempotent() {
        let (_dir, live) = live();
        live.upsert_cli_tool(cli_tool("my-pandoc")).expect("upsert");
        let cfg = live.remove_cli_tool("my-pandoc").expect("remove");
        assert!(cfg.cli_tools.tools.is_empty());
        assert!(live.cli_tools().is_empty());
        // Removing an unregistered name still succeeds (idempotent).
        assert!(live.remove_cli_tool("my-pandoc").is_ok());
    }

    /// A controlled PATH for the builtin-scan tests: a temp dir holding the
    /// named executables (with the platform suffix `which_in` matches), so
    /// detection runs against real files without touching the process env.
    fn controlled_path(names: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in names {
            let file = if cfg!(windows) {
                format!("{name}.exe")
            } else {
                (*name).to_string()
            };
            std::fs::write(dir.path().join(file), b"bin").expect("write exe");
        }
        dir
    }

    #[test]
    fn scan_and_register_registers_hits_and_returns_the_snapshot() {
        // A detected definition with no registry entry auto-registers in the
        // same read-modify-write: the returned config carries the builtin
        // entry, the write landed on disk, and the snapshot reports
        // detected (issue #675 AC).
        let (_dir, live) = live();
        let skills = tempfile::tempdir().expect("skills root");
        let path_dir = controlled_path(&["pandoc"]);
        let path_env = std::env::join_paths([path_dir.path()]).expect("join");
        let result = live
            .scan_and_register(Some(path_env), skills.path())
            .expect("scan");
        let registered = result
            .config
            .cli_tools
            .tools
            .iter()
            .find(|t| t.name == "pandoc")
            .expect("registered in returned config");
        assert_eq!(registered.source, CliToolSource::Builtin);
        assert_eq!(registered.baseline, Some(CliBaselineState::Following));
        assert!(registered.enabled);
        // The write persisted (not just the returned view).
        assert_eq!(live.cli_tools().len(), 1);
        // The rest of the shipped set stays dormant: nothing registered.
        assert_eq!(live.cli_tools()[0].name, "pandoc");
        let entry = result
            .scan
            .iter()
            .find(|e| e.name() == "pandoc")
            .expect("row");
        assert!(
            matches!(
                entry,
                crate::cli_tools::builtin::BuiltinScanEntry::Detected { .. }
            ),
            "the fresh hit reports detected"
        );
        assert!(result
            .scan
            .iter()
            .filter(|e| e.name() != "pandoc")
            .all(|e| matches!(
                e,
                crate::cli_tools::builtin::BuiltinScanEntry::Dormant { .. }
            )));
    }

    #[test]
    fn scan_and_register_surfaces_skill_materialize_failures() {
        // A blocked skills root (issue #1016, whole-tree lane since
        // ADR-0121): the reserved-subtree path for vega-chart is occupied
        // by a plain file, so alignment fails while the CLI scan itself is
        // untouched -- the failure rides the same payload as the detection
        // snapshot, for the Skills panel's warning lane.
        let (_dir, live) = live();
        let skills = tempfile::tempdir().expect("skills root");
        std::fs::create_dir(skills.path().join(".system")).expect("reserved subtree");
        std::fs::write(skills.path().join(".system/vega-chart"), b"not a directory")
            .expect("blocker");
        let path_dir = controlled_path(&[]);
        let path_env = std::env::join_paths([path_dir.path()]).expect("join");
        let result = live
            .scan_and_register(Some(path_env.clone()), skills.path())
            .expect("scan");
        assert_eq!(
            result.skill_materialize_failures,
            vec!["vega-chart".to_string()]
        );
        // The degraded posture: nothing written for the failed skill...
        assert!(!skills.path().join(".system/vega-chart/SKILL.md").exists());
        // ...and the next window over a cleared path heals the lane (the
        // warning must not outlive the failure it reported).
        std::fs::remove_file(skills.path().join(".system/vega-chart")).expect("unblock");
        let healed = live
            .scan_and_register(Some(path_env), skills.path())
            .expect("rescan");
        assert!(healed.skill_materialize_failures.is_empty());
        assert!(skills.path().join(".system/vega-chart/SKILL.md").exists());
    }

    #[test]
    fn scan_and_register_defers_to_a_user_entry_and_never_rearms() {
        // Conflict deference: the user's entry stays untouched and unmutated
        // while the executable resolves; a rescan after the user removes
        // their entry registers the builtin one (the next-scan catch-up).
        // A user-disabled builtin entry is never re-enabled by a rescan.
        let (_dir, live) = live();
        let skills = tempfile::tempdir().expect("skills root");
        live.upsert_cli_tool(cli_tool("my-pandoc"))
            .expect("user entry");
        let mut user_pandoc = cli_tool("my-pandoc");
        user_pandoc.name = "pandoc".to_string();
        // Bypass upsert (the name is reserved for user entries): write the
        // hand-edit shape directly, the conflict path reads the registry,
        // not the upsert boundary.
        let mut cfg = AppConfig::defaults();
        cfg.cli_tools.tools = vec![user_pandoc];
        std::fs::write(live.path(), serde_json::to_string(&cfg).unwrap()).unwrap();

        let path_dir = controlled_path(&["pandoc"]);
        let path_env = std::env::join_paths([path_dir.path()]).expect("join");
        let result = live
            .scan_and_register(Some(path_env), skills.path())
            .expect("scan 1");
        let entry = result
            .scan
            .iter()
            .find(|e| e.name() == "pandoc")
            .expect("row");
        assert!(matches!(
            entry,
            crate::cli_tools::builtin::BuiltinScanEntry::Conflict { .. }
        ));
        // The user entry survived byte-for-byte in name + executable.
        let tools = live.cli_tools();
        let user = tools
            .iter()
            .find(|t| t.name == "pandoc")
            .expect("user entry");
        assert_eq!(user.source, CliToolSource::User);

        // Disposition: the user removes their entry; the next scan
        // registers the builtin one.
        live.remove_cli_tool("pandoc").expect("remove");
        let path_env = std::env::join_paths([path_dir.path()]).expect("join");
        live.scan_and_register(Some(path_env.clone()), skills.path())
            .expect("scan 2");
        let tools = live.cli_tools();
        let builtin = tools
            .iter()
            .find(|t| t.name == "pandoc")
            .expect("builtin registered after disposition");
        assert_eq!(builtin.source, CliToolSource::Builtin);

        // A user-disabled builtin entry keeps its state across rescans.
        let mut disabled = builtin.clone();
        disabled.enabled = false;
        live.upsert_cli_tool(disabled).expect("disable");
        let result = live
            .scan_and_register(Some(path_env), skills.path())
            .expect("scan 3");
        assert!(
            !result
                .config
                .cli_tools
                .tools
                .iter()
                .find(|t| t.name == "pandoc")
                .expect("still registered")
                .enabled,
            "a rescan never re-arms a disabled builtin entry"
        );
    }

    #[test]
    fn scan_and_register_concurrent_with_user_writes_never_interleaves() {
        // Issue #683: scan_and_register holds write_lock across the whole
        // detect -> register -> persist window, so a concurrent user write
        // can never interleave mid-scan (a lost registration or a lost user
        // entry). Mixed workers -- 4 scans over a controlled PATH hitting
        // pandoc, 8 user upserts with distinct names -- must all complete
        // (no deadlock) and all land (no lost update), the upsert
        // concurrency test's contract applied to the scan entry point.
        use std::thread;

        let (_dir, live) = live();
        let skills = tempfile::tempdir().expect("skills root");
        let path_dir = controlled_path(&["pandoc"]);
        let path_env = std::env::join_paths([path_dir.path()]).expect("join");
        let mut handles = Vec::new();
        for _ in 0..4 {
            let live = live.clone();
            let env = path_env.clone();
            let skills_root = skills.path().to_path_buf();
            handles.push(thread::spawn(move || {
                live.scan_and_register(Some(env), &skills_root)
                    .expect("scan and register");
            }));
        }
        for i in 0..8 {
            let live = live.clone();
            handles.push(thread::spawn(move || {
                live.upsert_cli_tool(cli_tool(&format!("user-{i}")))
                    .expect("user upsert");
            }));
        }
        for handle in handles {
            handle.join().expect("worker thread panicked");
        }
        let tools = live.cli_tools();
        assert_eq!(
            tools.iter().filter(|t| t.name == "pandoc").count(),
            1,
            "the builtin hit registered exactly once (unique-name invariant)"
        );
        for i in 0..8 {
            assert!(
                tools.iter().any(|t| t.name == format!("user-{i}")),
                "the concurrent scan lost user entry user-{i}"
            );
        }
        assert_eq!(tools.len(), 9, "exactly the 1 builtin + 8 user entries");
    }

    #[test]
    fn startup_register_registers_hits_through_the_passed_path() {
        // The startup window's trigger (ADR-0109 Decision 3, one of its
        // two): the `path_env` seam keeps the register semantics pinnable
        // against a controlled PATH instead of this machine's installs.
        let (_dir, live) = live();
        let path_dir = controlled_path(&["pandoc"]);
        let path_env = std::env::join_paths([path_dir.path()]).expect("join");
        let skills = tempfile::tempdir().expect("skills root");
        crate::cli_tools::builtin::startup_register(&live, Some(path_env), skills.path())
            .expect("startup");
        let tools = live.cli_tools();
        let builtin = tools
            .iter()
            .find(|t| t.name == "pandoc")
            .expect("registered at startup");
        assert_eq!(builtin.source, CliToolSource::Builtin);
        assert!(builtin.enabled);
    }

    #[test]
    fn startup_register_on_a_full_miss_registers_no_cli_but_materializes_the_knowledge_skill() {
        // No CLI hits -> no CLI registration (the dormant posture, CLI
        // side). The knowledge-only skill is NOT a miss: it aligns in the
        // same window into the reserved subtree (ADR-0120 Decision 7) --
        // and since alignment writes no config, a no-CLI-hit install stays
        // config-silent too (the ADR-0121 posture: no side table).
        let (dir, live) = live();
        let empty_dir = tempfile::tempdir().expect("tempdir");
        let path_env = std::env::join_paths([empty_dir.path()]).expect("join");
        let skills = tempfile::tempdir().expect("skills root");
        crate::cli_tools::builtin::startup_register(&live, Some(path_env), skills.path())
            .expect("startup");
        assert!(live.cli_tools().is_empty());
        assert!(skills.path().join(".system/vega-chart/SKILL.md").exists());
        assert!(
            !dir.path().join("config.json").exists(),
            "nothing to persist: alignment is config-silent"
        );
    }

    #[test]
    fn startup_register_defers_to_a_user_entry_and_succeeds() {
        // The conflict path is log-and-continue at startup: the call returns
        // Ok, the user entry survives untouched, and nothing registers
        // alongside it.
        let (_dir, live) = live();
        let mut user_pandoc = cli_tool("my-pandoc");
        user_pandoc.name = "pandoc".to_string();
        let mut cfg = AppConfig::defaults();
        cfg.cli_tools.tools = vec![user_pandoc];
        std::fs::write(live.path(), serde_json::to_string(&cfg).unwrap()).unwrap();
        let path_dir = controlled_path(&["pandoc"]);
        let path_env = std::env::join_paths([path_dir.path()]).expect("join");
        let skills = tempfile::tempdir().expect("skills root");
        crate::cli_tools::builtin::startup_register(&live, Some(path_env), skills.path())
            .expect("startup");
        let tools = live.cli_tools();
        assert_eq!(
            tools.len(),
            1,
            "no builtin registration alongside the user entry"
        );
        assert_eq!(tools[0].source, CliToolSource::User);
    }

    // --- baseline tracking (issue #676) --------------------------------------

    #[test]
    fn scan_and_register_upgrades_a_drifted_following_entry_and_preserves_an_edited_one() {
        // Baseline reconciliation: a FOLLOWING entry whose tracked fields
        // drifted from the shipped definition -- the app version moved the
        // baseline -- upgrades silently, keeping its machine-local
        // executable and enable state; an EDITED entry is preserved
        // verbatim, the app never overwrites a user edit.
        let (_dir, live) = live();
        let skills = tempfile::tempdir().expect("skills root");
        let mut cfg = AppConfig::defaults();
        let mut drifted = cli_tool("pandoc");
        drifted.name = "pandoc".to_string();
        drifted.source = CliToolSource::Builtin;
        drifted.baseline = Some(CliBaselineState::Following);
        drifted.description = "an older shipped description".to_string();
        drifted.executable = "custom-resolution".to_string();
        drifted.enabled = false;
        let mut edited = cli_tool("python");
        edited.source = CliToolSource::Builtin;
        edited.baseline = Some(CliBaselineState::Edited);
        edited.description = "user's own description".to_string();
        cfg.cli_tools.tools = vec![drifted, edited];
        std::fs::write(live.path(), serde_json::to_string(&cfg).unwrap()).unwrap();
        // An empty PATH: nothing registers (both entries exist), but the
        // reconciliation still has work to do.
        let empty_dir = tempfile::tempdir().expect("tempdir");
        let path_env = std::env::join_paths([empty_dir.path()]).expect("join");
        live.scan_and_register(Some(path_env), skills.path())
            .expect("scan");

        let tools = live.cli_tools();
        let pandoc = tools.iter().find(|t| t.name == "pandoc").expect("entry");
        let def = crate::cli_tools::builtin::find_definition("pandoc").expect("definition");
        assert!(
            def.baseline_matches(pandoc),
            "upgraded back onto the baseline"
        );
        assert_eq!(
            pandoc.executable, "custom-resolution",
            "machine-local, kept"
        );
        assert!(!pandoc.enabled, "the intent axis is kept");
        assert_eq!(pandoc.baseline, Some(CliBaselineState::Following));
        let python = tools.iter().find(|t| t.name == "python").expect("entry");
        assert_eq!(
            python.description, "user's own description",
            "never overwritten"
        );
        assert_eq!(python.baseline, Some(CliBaselineState::Edited));
    }

    #[test]
    fn scan_and_register_skips_the_write_when_nothing_upgrades_or_registers() {
        // No registration AND no upgrade: the second scan leaves the file
        // byte-identical (the store skip -- pane mounts must not churn the
        // config file).
        let (_dir, live) = live();
        let skills = tempfile::tempdir().expect("skills root");
        let path_dir = controlled_path(&["pandoc"]);
        let path_env = std::env::join_paths([path_dir.path()]).expect("join");
        live.scan_and_register(Some(path_env.clone()), skills.path())
            .expect("scan 1");
        let after_first = std::fs::read_to_string(live.path()).expect("file");
        // The registered entry matches the shipped baseline: nothing to do.
        live.scan_and_register(Some(path_env), skills.path())
            .expect("scan 2");
        let after_second = std::fs::read_to_string(live.path()).expect("file");
        assert_eq!(
            after_first, after_second,
            "nothing to register or upgrade: the file must not be rewritten"
        );
    }

    #[test]
    fn upsert_cli_tool_computes_the_builtin_baseline_from_the_tracked_diff() {
        // The edit signal (issue #676): only a tracked-field change flips a
        // builtin entry to EDITED -- the enable toggle and the executable
        // relocation keep the posture, and EDITED is one-way (editing back
        // to the shipped values stays EDITED; the explicit restore is the
        // way back). User entries stay baseline-free.
        let (_dir, live) = live();
        let skills = tempfile::tempdir().expect("skills root");
        let path_dir = controlled_path(&["pandoc"]);
        let path_env = std::env::join_paths([path_dir.path()]).expect("join");
        live.scan_and_register(Some(path_env), skills.path())
            .expect("scan");
        let registered = live.cli_tools().remove(0);

        // The enable toggle (the row switch path: same body, one field).
        let mut toggled = registered.clone();
        toggled.enabled = false;
        live.upsert_cli_tool(toggled).expect("toggle");
        assert_eq!(
            live.cli_tools()[0].baseline,
            Some(CliBaselineState::Following)
        );

        // An executable relocation is machine-local, not an edit.
        let mut relocated = live.cli_tools().remove(0);
        relocated.executable = "/custom/pandoc".to_string();
        live.upsert_cli_tool(relocated).expect("relocate");
        assert_eq!(
            live.cli_tools()[0].baseline,
            Some(CliBaselineState::Following)
        );

        // A tracked-field edit flips to EDITED...
        let mut edited = live.cli_tools().remove(0);
        edited.description = "custom".to_string();
        live.upsert_cli_tool(edited).expect("edit");
        assert_eq!(live.cli_tools()[0].baseline, Some(CliBaselineState::Edited));

        // ...and stays EDITED even when a later save changes nothing (an
        // unchanged body is not an edit-back; the one-way rule and the
        // explicit restore are pinned at the unit layer).
        let unchanged = live.cli_tools().remove(0);
        live.upsert_cli_tool(unchanged).expect("no-op save");
        assert_eq!(live.cli_tools()[0].baseline, Some(CliBaselineState::Edited));

        // User entries stay baseline-free regardless of edits.
        live.upsert_cli_tool(cli_tool("my-pandoc"))
            .expect("user entry");
        let user = live
            .cli_tools()
            .into_iter()
            .find(|t| t.name == "my-pandoc")
            .expect("user");
        assert_eq!(user.baseline, None);
    }

    #[test]
    fn upsert_cli_tool_strips_a_submitted_baseline_off_user_entries() {
        // The read-side twin of the posture authority: a hand-rolled IPC
        // submission cannot persist a baseline onto a user entry -- the
        // marker is meaningless off the baseline.
        let (_dir, live) = live();
        let mut forged = cli_tool("my-pandoc");
        forged.baseline = Some(CliBaselineState::Edited);
        live.upsert_cli_tool(forged).expect("upsert");
        assert_eq!(live.cli_tools()[0].baseline, None);
    }

    #[test]
    fn remove_cli_tool_refuses_a_builtin_entry_but_not_a_name_owning_user_entry() {
        // Undeletable by the ENTRY's source (ADR-0109 Decision 2): the
        // builtin registration survives removal; a user entry owning the
        // builtin name (the conflict posture) stays removable -- disposing
        // of it is how the builtin entry gets to register.
        let (_dir, live) = live();
        let skills = tempfile::tempdir().expect("skills root");
        let path_dir = controlled_path(&["pandoc"]);
        let path_env = std::env::join_paths([path_dir.path()]).expect("join");
        live.scan_and_register(Some(path_env), skills.path())
            .expect("scan");
        assert!(matches!(
            live.remove_cli_tool("pandoc"),
            Err(CliToolWriteError::Invalid(_))
        ));
        assert_eq!(live.cli_tools().len(), 1, "the builtin entry survives");

        let mut cfg = AppConfig::defaults();
        cfg.cli_tools.tools = vec![cli_tool("pandoc")];
        std::fs::write(live.path(), serde_json::to_string(&cfg).unwrap()).unwrap();
        live.remove_cli_tool("pandoc")
            .expect("user entry removable");
    }

    #[test]
    fn restore_builtin_cli_tool_rewrites_the_tracked_fields_only() {
        // The explicit restore (ADR-0109 Decision 2): the four tracked
        // fields return to the shipped definition, the posture returns to
        // FOLLOWING, and the machine-local executable + enable state are
        // untouched -- after which the entry upgrades with the baseline
        // again.
        let (_dir, live) = live();
        let skills = tempfile::tempdir().expect("skills root");
        let path_dir = controlled_path(&["pandoc"]);
        let path_env = std::env::join_paths([path_dir.path()]).expect("join");
        live.scan_and_register(Some(path_env.clone()), skills.path())
            .expect("scan");
        let mut edited = live.cli_tools().remove(0);
        edited.description = "custom".to_string();
        edited.executable = "/custom/pandoc".to_string();
        edited.enabled = false;
        live.upsert_cli_tool(edited).expect("edit");

        let cfg = live.restore_builtin_cli_tool("pandoc").expect("restore");
        let tool = cfg
            .cli_tools
            .tools
            .iter()
            .find(|t| t.name == "pandoc")
            .expect("entry");
        let def = crate::cli_tools::builtin::find_definition("pandoc").expect("definition");
        assert!(def.baseline_matches(tool), "back on the baseline");
        assert_eq!(tool.baseline, Some(CliBaselineState::Following));
        assert_eq!(
            tool.executable, "/custom/pandoc",
            "machine-local, untouched"
        );
        assert!(!tool.enabled, "the intent axis is untouched");
        // Persisted, not just the returned view.
        assert_eq!(
            live.cli_tools()[0].baseline,
            Some(CliBaselineState::Following)
        );

        // Re-following: a FOLLOWING entry that drifts again upgrades on the
        // next scan (the restore put the entry back on the baseline).
        let mut cfg2 = AppConfig::defaults();
        let mut drifted = live.cli_tools().remove(0);
        drifted.description = "drifted again".to_string();
        cfg2.cli_tools.tools = vec![drifted];
        std::fs::write(live.path(), serde_json::to_string(&cfg2).unwrap()).unwrap();
        live.scan_and_register(Some(path_env), skills.path())
            .expect("rescan");
        assert!(def.baseline_matches(&live.cli_tools()[0]));
    }

    #[test]
    fn scan_and_register_materializes_the_companion_skill_in_the_same_window() {
        // The wiring pin (issue #677): a first detection registers the CLI
        // entry AND aligns the companion skill's reserved subtree in the
        // same window -- the file lands under `.system/`, byte-identical
        // to the embedded asset, with the alignment marker beside it.
        let (_dir, live) = live();
        let skills = tempfile::tempdir().expect("skills root");
        let path_dir = controlled_path(&["pandoc"]);
        let path_env = std::env::join_paths([path_dir.path()]).expect("join");
        live.scan_and_register(Some(path_env), skills.path())
            .expect("scan");
        let md = skills.path().join(".system/pandoc/SKILL.md");
        assert!(md.exists(), "the companion skill file materialized");
        let embedded = std::fs::read(md).expect("read");
        let asset = include_bytes!("../skills/assets/builtin/pandoc/SKILL.md");
        assert_eq!(embedded, asset, "byte-identical to the embedded asset");
        assert!(skills.path().join(".system/pandoc/.fingerprint").exists());
        // The un-anchored companions stay out of the subtree; the
        // knowledge-only skill rides the app version and lands too.
        assert!(!skills.path().join(".system/python").exists());
        assert!(skills.path().join(".system/vega-chart/SKILL.md").exists());
    }

    #[test]
    fn restore_builtin_cli_tool_refuses_non_builtin_targets() {
        // A registered user entry, an unregistered builtin name, and a user
        // entry OWNING a builtin name (the conflict posture) are all refusals
        // (structured, through the same Invalid lane as every other
        // registration-shape rejection). The third guard is what keeps
        // apply_baseline off a user entry, so its body survives verbatim.
        let (_dir, live) = live();
        live.upsert_cli_tool(cli_tool("my-pandoc")).expect("upsert");
        assert!(matches!(
            live.restore_builtin_cli_tool("my-pandoc"),
            Err(CliToolWriteError::Invalid(_))
        ));
        assert!(matches!(
            live.restore_builtin_cli_tool("pandoc"),
            Err(CliToolWriteError::Invalid(_))
        ));
        let mut cfg = AppConfig::defaults();
        cfg.cli_tools.tools = vec![cli_tool("pandoc")];
        std::fs::write(live.path(), serde_json::to_string(&cfg).unwrap()).unwrap();
        assert!(matches!(
            live.restore_builtin_cli_tool("pandoc"),
            Err(CliToolWriteError::Invalid(_))
        ));
        let tool = live
            .cli_tools()
            .into_iter()
            .find(|t| t.name == "pandoc")
            .expect("entry");
        assert_eq!(tool.source, CliToolSource::User);
        assert_eq!(tool.description, "convert documents");
        assert_eq!(tool.baseline, None);
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
        // reload reads the same zero-profile state back. defaults() IS the
        // zero-profile shape, so no setup teardown is needed.
        let (_dir, live) = live();
        let cfg = AppConfig::defaults();
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

    // --- agent enablement (issue #932, ADR-0117) -----------------------------

    #[test]
    fn create_agent_lands_enabled_and_partitions_marks_against_real_skills() {
        // The create composite at its seam: a fresh mint lands ENABLED, and
        // the read-back partitions the preamble marks against the real
        // registered-skills set -- a mark naming a registered skill is a
        // binding hit, not a dangle.
        let (_dir, live) = live();
        let agents = tempfile::tempdir().expect("agents root");
        let skills = tempfile::tempdir().expect("skills root");
        let sql_dir = skills.path().join("sql");
        std::fs::create_dir_all(&sql_dir).expect("skill dir");
        std::fs::write(
            sql_dir.join("SKILL.md"),
            "---\nname: sql\ndescription: Runs SQL.\n---\nYou run SQL.\n",
        )
        .expect("SKILL.md");

        let entry = live
            .create_agent(
                agents.path(),
                skills.path(),
                "data-cleaner",
                "Cleans datasets.",
                "Use `sql` and `ghost-skill` when helpful.\n",
            )
            .expect("create");

        assert!(entry.enabled, "a fresh mint lands enabled");
        assert_eq!(entry.skill_refs, vec!["sql".to_string()]);
        assert_eq!(entry.dangling_skill_refs, vec!["ghost-skill".to_string()]);
        let cfg = live.load();
        assert!(cfg.enabled_agents.contains("data-cleaner"));
        assert!(agents.path().join("data-cleaner.md").exists());
    }

    #[test]
    fn update_agent_renames_and_carries_enablement() {
        // The update composite at its seam: a rename carries the enablement
        // entry, and the returned entry's enablement reflects the post-carry
        // set (the pre-rename snapshot does not know the new name).
        let (_dir, live) = live();
        let agents = tempfile::tempdir().expect("agents root");
        let skills = tempfile::tempdir().expect("skills root");
        live.create_agent(agents.path(), skills.path(), "old-name", "d", "p\n")
            .expect("seed");

        let updated = live
            .update_agent(
                agents.path(),
                skills.path(),
                "old-name",
                crate::agents::AgentUpdate {
                    name: "new-name".into(),
                    description: "d".into(),
                    preamble: "p\n".into(),
                },
            )
            .expect("rename");

        assert_eq!(updated.name, "new-name");
        assert!(
            updated.enabled,
            "the carried entry shows under the new name"
        );
        let cfg = live.load();
        assert!(!cfg.enabled_agents.contains("old-name"));
        assert!(cfg.enabled_agents.contains("new-name"));
        assert!(agents.path().join("new-name.md").exists());
    }

    #[test]
    fn set_skill_enabled_round_trips_and_keeps_siblings() {
        // The skill enablement axis (issue #961): the DISABLED-name polarity
        // -- disabling lands the name in the set, enabling removes it; a
        // sibling entry and an unrelated pref survive the read-modify-write,
        // and a fresh load reads the set back off disk.
        let (_dir, live) = live();
        live.set_skill_enabled("pdf-tools", false)
            .expect("disable pdf-tools");
        let stored = live
            .set_skill_enabled("sql-coach", false)
            .expect("disable sql-coach");
        assert!(stored.disabled_skills.contains("pdf-tools"));
        assert!(stored.disabled_skills.contains("sql-coach"));
        // Re-enabling one entry leaves the sibling alone.
        let stored = live
            .set_skill_enabled("pdf-tools", true)
            .expect("enable pdf-tools");
        assert!(!stored.disabled_skills.contains("pdf-tools"));
        assert!(stored.disabled_skills.contains("sql-coach"));
        assert_eq!(
            live.load().disabled_skills,
            ["sql-coach".to_string()].into_iter().collect()
        );
    }

    #[test]
    fn set_skill_enabled_refuses_a_blank_disable() {
        // A blank name can only ever be a malformed write (no skill is named
        // ""), so the disable is refused at the validation boundary instead
        // of landing an entry normalize would then silently drop.
        let (_dir, live) = live();
        let err = live.set_skill_enabled("   ", false).expect_err("refused");
        assert!(
            matches!(err, app_config::WriteError::Validation(_)),
            "validation refusal, got {err:?}"
        );
    }

    /// Write one spec-valid SKILL.md directory for the composite tests.
    fn put_skill(root: &std::path::Path, name: &str) {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: Does things.\n---\nBody.\n"),
        )
        .expect("SKILL.md");
    }

    fn skill_update(name: &str) -> crate::skills::SkillUpdate {
        crate::skills::SkillUpdate {
            name: name.to_string(),
            description: "Does things.".to_string(),
            license: None,
            compatibility: None,
            body: "Body.\n".to_string(),
        }
    }

    #[test]
    fn create_skill_clears_a_stale_disabled_entry_so_a_rebirth_lands_enabled() {
        // The create composite (issue #961, ADR-0118 Decision 2): a disabled
        // skill deleted earlier left its name in the set (dangling); the
        // same-name rebirth lands ENABLED -- the mint clears the stale
        // entry instead of letting it shadow the new skill.
        let (_dir, live) = live();
        let root = tempfile::tempdir().expect("skills root");
        live.set_skill_enabled("pdf-tools", false).expect("disable");
        let entry = live
            .create_skill(root.path(), "pdf-tools", "Does things.", "Body.\n")
            .expect("create");
        assert!(entry.enabled, "the rebirth lands enabled");
        assert!(!live.load().disabled_skills.contains("pdf-tools"));
    }

    /// The whole-string create entry (ADR-0122 Decision 1) rides the SAME
    /// composite: a same-name rebirth lands enabled, and the bytes on disk
    /// are the input verbatim.
    #[test]
    fn create_skill_from_markdown_lands_enabled_and_verbatim() {
        let (_dir, live) = live();
        let root = tempfile::tempdir().expect("skills root");
        live.set_skill_enabled("pdf-tools", false).expect("disable");
        let markdown = "---\nname: pdf-tools\ndescription: Does things.\nlicense: MIT\n\
             ---\nBody.\n";
        let entry = live
            .create_skill_from_markdown(root.path(), markdown)
            .expect("create");
        assert_eq!(entry.name, "pdf-tools");
        assert!(entry.enabled, "the rebirth lands enabled");
        assert!(!live.load().disabled_skills.contains("pdf-tools"));
        let on_disk =
            std::fs::read_to_string(root.path().join("pdf-tools/SKILL.md")).expect("read back");
        assert_eq!(on_disk, markdown, "the bytes land verbatim");
    }

    #[test]
    fn update_skill_carries_a_disablement_across_a_rename() {
        // The carry (issue #961): a disabled skill that renames keeps its
        // dormant state under the new name (the entry moves `from` -> `to`);
        // an enabled rename adds no entry (the no-op half).
        let (_dir, live) = live();
        let root = tempfile::tempdir().expect("skills root");
        put_skill(root.path(), "pdf-tools");
        live.set_skill_enabled("pdf-tools", false).expect("disable");
        let renamed = live
            .update_skill(root.path(), "pdf-tools", skill_update("pdf-suite"))
            .expect("rename");
        assert!(!renamed.enabled, "the disablement carries");
        let cfg = live.load();
        assert!(!cfg.disabled_skills.contains("pdf-tools"));
        assert!(cfg.disabled_skills.contains("pdf-suite"));
        // The enabled half: renaming an ENABLED skill (a fresh one -- the
        // carried entry above still owns pdf-suite) adds no entry.
        put_skill(root.path(), "sql-coach");
        let renamed = live
            .update_skill(root.path(), "sql-coach", skill_update("sql-guide"))
            .expect("rename enabled");
        assert!(renamed.enabled);
        let cfg = live.load();
        assert!(!cfg.disabled_skills.contains("sql-guide"));
        assert_eq!(cfg.disabled_skills.len(), 1, "only the carried entry");
    }

    #[test]
    fn delete_skill_drops_the_disabled_entry() {
        // The stale-entry drop (issue #961): the delete keeps the set
        // honest for a future same-name rebirth -- without the drop, the
        // rebirth would land disabled (the dangling shadow).
        let (_dir, live) = live();
        let root = tempfile::tempdir().expect("skills root");
        put_skill(root.path(), "pdf-tools");
        live.set_skill_enabled("pdf-tools", false).expect("disable");
        live.delete_skill(root.path(), "pdf-tools").expect("delete");
        assert!(!live.load().disabled_skills.contains("pdf-tools"));
    }

    #[test]
    fn set_agent_enabled_round_trips_and_keeps_siblings() {
        // The write lands on the name set; a sibling entry and an unrelated
        // pref (default_runtime) survive the read-modify-write, and a fresh
        // load reads the set back off disk (the persisted-set round trip).
        let (_dir, live) = live();
        live.set_agent_enabled("data-cleaner", true)
            .expect("seed data-cleaner");
        let stored = live
            .set_agent_enabled("sql-explorer", true)
            .expect("set sql-explorer");
        assert!(stored.enabled_agents.contains("data-cleaner"));
        assert!(stored.enabled_agents.contains("sql-explorer"));
        // Disabling one entry leaves the sibling alone.
        let stored = live
            .set_agent_enabled("data-cleaner", false)
            .expect("disable data-cleaner");
        assert!(!stored.enabled_agents.contains("data-cleaner"));
        assert!(stored.enabled_agents.contains("sql-explorer"));
        assert_eq!(
            live.load().enabled_agents,
            ["sql-explorer".to_string()].into_iter().collect()
        );
    }

    #[test]
    fn rename_agent_enabled_carries_the_entry_and_creates_no_stale_one() {
        let (_dir, live) = live();
        live.set_agent_enabled("old-name", true).expect("seed");
        let stored = live
            .rename_agent_enabled("old-name", "new-name")
            .expect("rename");
        assert!(!stored.enabled_agents.contains("old-name"));
        assert!(stored.enabled_agents.contains("new-name"));
        // A disabled rename is a no-op: no stale `from` entry appears.
        let stored = live
            .rename_agent_enabled("ghost", "other")
            .expect("rename a disabled name");
        assert!(!stored.enabled_agents.contains("other"));
        assert!(!stored.enabled_agents.contains("ghost"));
    }

    /// The window's default-enable binding (issue #948): a fresh install
    /// materializes the shipped set and the newly recorded names land in
    /// the enablement set -- ADR-0117 Decision 3's fallback (zero custom
    /// entries still give the main turn the delegation face).
    #[test]
    fn materialize_builtin_agents_lands_newly_recorded_names_enabled() {
        let (_dir, live) = live();
        let agents = tempfile::tempdir().expect("agents root");
        live.materialize_builtin_agents(agents.path())
            .expect("startup window");
        assert!(agents.path().join("general-purpose.md").exists());
        assert!(live.load().enabled_agents.contains("general-purpose"));
    }

    /// An explicit disable cannot revive: the toggle touches only the
    /// enablement set (never the mark), so the next window's difference is
    /// empty -- and stays empty when a deleted file re-materializes under
    /// the recorded mark.
    #[test]
    fn materialize_builtin_agents_does_not_revive_an_explicit_disable() {
        let (_dir, live) = live();
        let agents = tempfile::tempdir().expect("agents root");
        live.materialize_builtin_agents(agents.path())
            .expect("startup window");
        live.set_agent_enabled("general-purpose", false)
            .expect("disable the builtin");

        live.materialize_builtin_agents(agents.path())
            .expect("second window");
        assert!(!live.load().enabled_agents.contains("general-purpose"));

        // The disabled-name delete-and-rematerialize path: the file rewrites
        // under the existing record, so the difference stays empty.
        std::fs::remove_file(agents.path().join("general-purpose.md"))
            .expect("remove the definition");
        live.materialize_builtin_agents(agents.path())
            .expect("third window");
        assert!(agents.path().join("general-purpose.md").exists());
        assert!(!live.load().enabled_agents.contains("general-purpose"));
    }

    /// The symmetric delete-and-rematerialize edge for an enabled name: the
    /// file rewrites under the recorded mark (difference empty) and the
    /// enablement entry rides the config through untouched.
    #[test]
    fn materialize_builtin_agents_keeps_an_enabled_name_through_rematerialize() {
        let (_dir, live) = live();
        let agents = tempfile::tempdir().expect("agents root");
        live.materialize_builtin_agents(agents.path())
            .expect("startup window");
        std::fs::remove_file(agents.path().join("general-purpose.md"))
            .expect("remove the definition");
        live.materialize_builtin_agents(agents.path())
            .expect("second window");
        assert!(agents.path().join("general-purpose.md").exists());
        assert!(live.load().enabled_agents.contains("general-purpose"));
    }

    /// The adopt self-heal enables too: shipped content on disk with the
    /// mark missing (an interrupted persist -- the store lost both the mark
    /// and its enablement) is adopted into both sets when the window runs.
    #[test]
    fn materialize_builtin_agents_enables_an_adopted_shipped_file() {
        let (_dir, live) = live();
        let agents = tempfile::tempdir().expect("agents root");
        live.materialize_builtin_agents(agents.path())
            .expect("startup window");
        // Rewind to the interrupted-persist shape: the shipped file stays,
        // the mark and its enablement entry are gone.
        {
            let _guard = live
                .write_lock
                .lock()
                .expect("app-config write_lock poisoned");
            let mut cfg = live.load_for_write().expect("load");
            cfg.materialized_builtin_agents.clear();
            cfg.enabled_agents.clear();
            live.store_inner(cfg).expect("rewind the record");
        }
        live.materialize_builtin_agents(agents.path())
            .expect("second window");
        let cfg = live.load();
        assert!(cfg.materialized_builtin_agents.contains("general-purpose"));
        assert!(cfg.enabled_agents.contains("general-purpose"));
    }

    // --- last model posture (issue #581, ADR-0100) --------------------------

    #[test]
    fn set_last_model_posture_round_trips_and_keeps_siblings() {
        // The write lands on ONE map entry; a sibling adapter's entry and an
        // unrelated pref (default_runtime) survive the read-modify-write.
        // gemini-cli is NOT installed on CI, which is the point: the store
        // path has no detection validation (ADR-0100 Decision 4 keeps
        // dangling entries).
        let (_dir, live) = live();
        live.set_default_runtime(DefaultRuntime::External("gemini-cli".into()))
            .expect("seed default_runtime");
        live.set_last_model_posture(
            "codex",
            ModelPosture {
                model: Some("gpt-5.3-codex".into()),
                thought_level: None,
            },
        )
        .expect("set codex posture");
        let stored = live
            .set_last_model_posture(
                "gemini-cli",
                ModelPosture {
                    model: Some("gemini-2.5-pro".into()),
                    thought_level: Some("high".into()),
                },
            )
            .expect("set gemini-cli posture");
        assert_eq!(
            stored.last_model_postures.get("gemini-cli"),
            Some(&ModelPosture {
                model: Some("gemini-2.5-pro".into()),
                thought_level: Some("high".into()),
            }),
            "the returned config carries the entry just written"
        );
        let back = live.load();
        assert_eq!(
            back.last_model_postures.len(),
            2,
            "the sibling entry survives"
        );
        assert_eq!(
            back.last_model_postures
                .get("codex")
                .map(|p| p.model.clone()),
            Some(Some("gpt-5.3-codex".into())),
            "the sibling entry round-trips untouched"
        );
        assert_eq!(
            back.default_runtime,
            DefaultRuntime::External("gemini-cli".into()),
            "an unrelated pref survives the read-modify-write"
        );
    }

    #[test]
    fn setting_the_default_posture_persists_the_cleared_entry() {
        // Clear = the empty posture entry, NOT a removed key (ADR-0100
        // Decision 3): the map keeps the adapter's row with both fields None,
        // so a later read returns "unselected" without a missing-key branch.
        let (_dir, live) = live();
        live.set_last_model_posture(
            "gemini-cli",
            ModelPosture {
                model: Some("gemini-2.5-pro".into()),
                thought_level: Some("high".into()),
            },
        )
        .expect("seed posture");
        live.set_last_model_posture("gemini-cli", ModelPosture::default())
            .expect("clear posture");
        assert_eq!(
            live.load().last_model_postures.get("gemini-cli"),
            Some(&ModelPosture::default()),
            "the cleared entry stays in the map"
        );
        assert_eq!(
            live.last_model_posture("gemini-cli"),
            ModelPosture::default(),
            "a cleared entry reads back unselected"
        );
    }

    #[test]
    fn last_model_posture_absent_entry_reads_as_the_default() {
        // No entry (never chosen) reads as the empty posture -- identical to
        // the cleared form, both mean an unselected startup.
        let (_dir, live) = live();
        assert_eq!(
            live.last_model_posture("gemini-cli"),
            ModelPosture::default()
        );
    }

    // --- MCP header-face write boundary (issue #901) ---------------------------

    #[test]
    fn upsert_refuses_an_invalid_header_face_leaving_the_file_untouched() {
        // The deepest write boundary (issue #901): an MCP server whose header
        // face is invalid (a control-char value, or a secret-named configured
        // header that the read-time scan would nuke the whole file over at
        // the next launch) is refused BEFORE any file write -- pinning the
        // call site inside `upsert_mcp_server`, not just the validator.
        let (_dir, live) = live();
        let make = |headers: BTreeMap<String, String>| McpServerConfig {
            id: McpServerId("remote".into()),
            display_name: "Remote".into(),
            transport: McpTransport::Http {
                url: "https://example.test/mcp".into(),
                headers,
            },
            env: BTreeMap::new(),
            keychain_env_keys: Vec::new(),
            keychain_header_keys: Vec::new(),
            timeout_ms: None,
            enabled: true,
        };
        let mut cr_value = BTreeMap::new();
        cr_value.insert("X-Ok-Name".to_string(), "a\rb".to_string());
        let mut secret_named = BTreeMap::new();
        secret_named.insert("Authorization".to_string(), "Bearer literal".to_string());
        for server in [make(cr_value), make(secret_named)] {
            let err = live
                .upsert_mcp_server(server)
                .expect_err("an invalid header face must be refused");
            assert!(
                matches!(err, app_config::WriteError::Validation(_)),
                "the refusal is a named validation, got: {err}"
            );
        }
        // Fail-fast: the validation runs before the write, so a first launch
        // (no file yet) never materializes one.
        assert!(
            !live.path().exists(),
            "a refused upsert must not create the config file"
        );
    }

    // --- RMW read strictness (issue #602) -------------------------------------

    #[test]
    fn rmw_entries_err_and_leave_a_corrupt_config_untouched() {
        // A read failure on the read half of a read-modify-write must surface
        // as Err and leave the file bytes untouched. The ADR-0038
        // honest-degrade read is a STARTUP contract: handed to a rewrite it
        // would have store_inner atomically persist "defaults + this one
        // write", resetting every other pref while the write returns Ok. All
        // six RMW entries share the read source, so all six are pinned
        // against the same corrupt seed.
        let (_dir, live) = live();
        let corrupt = b"{ this is not json";
        std::fs::write(live.path(), corrupt).expect("seed corrupt file");
        let server = McpServerConfig {
            id: McpServerId(String::new()),
            display_name: String::new(),
            transport: McpTransport::stdio("/bin/srv", Vec::new()),
            env: BTreeMap::new(),
            keychain_env_keys: Vec::new(),
            keychain_header_keys: Vec::new(),
            timeout_ms: None,
            enabled: true,
        };

        live.upsert_mcp_server(server)
            .expect_err("upsert refuses a corrupt read");
        assert_eq!(
            std::fs::read(live.path()).expect("file still there"),
            corrupt,
            "no defaults-plus-one-write rewrite"
        );

        live.set_sessions_dir(Some("/elsewhere".into()))
            .expect_err("set_sessions_dir refuses a corrupt read");
        assert_eq!(
            std::fs::read(live.path()).expect("file still there"),
            corrupt
        );

        live.set_default_runtime(DefaultRuntime::BuiltIn)
            .expect_err("set_default_runtime refuses a corrupt read");
        assert_eq!(
            std::fs::read(live.path()).expect("file still there"),
            corrupt
        );

        live.set_last_model_posture("codex", ModelPosture::default())
            .expect_err("set_last_model_posture refuses a corrupt read");
        assert_eq!(
            std::fs::read(live.path()).expect("file still there"),
            corrupt
        );

        live.set_provider_section(crate::model::ProviderConfig::default())
            .expect_err("provider-section save refuses a corrupt read");
        assert_eq!(
            std::fs::read(live.path()).expect("file still there"),
            corrupt
        );
    }

    #[test]
    fn rmw_read_failure_refuses_every_non_missing_variant() {
        // The corrupt-seed test pins the Parse variant through all six
        // entries; this pins the REST of the catch-all arm on one entry.
        // LowerVersion is the tempting one: mapping a stale v1 file to
        // Ok(defaults) ("a stale file resets on the next write") would be a
        // plausible misreading of ADR-0064's read-side degrade and would
        // resurrect exactly the silent reset issue #602 closes -- with every
        // other test still green. The Io seed (config path is a directory)
        // fails deterministically on both platforms.
        let (_dir, live) = live();
        let v = crate::app_config::APP_CONFIG_FORMAT_VERSION;
        let seeds: Vec<Vec<u8>> = vec![
            format!("{{\"format_version\":{}}}", v + 1).into_bytes(),
            b"{\"format_version\":1}".to_vec(),
            format!("{{\"format_version\":{v},\"api_key\":\"sk\"}}").into_bytes(),
        ];
        for seed in seeds {
            std::fs::write(live.path(), &seed).expect("seed file");
            live.set_default_runtime(DefaultRuntime::BuiltIn)
                .expect_err("non-Missing read variant refuses the write");
            assert_eq!(std::fs::read(live.path()).expect("file still there"), seed);
        }

        // Io: the config path is a directory, so the read cannot even start.
        std::fs::remove_file(live.path()).expect("clear the last seed file");
        std::fs::create_dir(live.path()).expect("seed directory");
        live.set_default_runtime(DefaultRuntime::BuiltIn)
            .expect_err("io read failure refuses the write");
        assert!(live.path().is_dir(), "the directory seed is untouched");
    }

    #[test]
    fn rmw_read_failure_error_names_the_path_and_reason() {
        // The Err must be diagnosable at the best-effort warn site
        // (record_last_model_posture) and in the IPC ConfigWriteFailure
        // string: the Display carries both the read failure reason and the
        // config path, so one log line attributes the refused write.
        let (_dir, live) = live();
        std::fs::write(live.path(), b"{ nope").expect("seed corrupt file");
        let msg = live
            .set_default_runtime(DefaultRuntime::BuiltIn)
            .expect_err("read failure surfaces")
            .to_string();
        assert!(msg.contains("config.json"), "names the file: {msg}");
        assert!(msg.contains("parse"), "names the reason: {msg}");
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
            keychain_header_keys: Vec::new(),
            timeout_ms: None,
            enabled: true,
        };
        let stored = live.upsert_mcp_server(incoming).expect("upsert");
        assert_ne!(stored.id.as_str(), "");
        assert_eq!(stored.display_name, stored.id.as_str());
        let reloaded = live.load();
        assert_eq!(reloaded.mcp_servers.servers.len(), 1);
        assert_eq!(reloaded.mcp_servers.servers[0].id, stored.id);
    }

    #[test]
    fn enabled_mcp_servers_is_the_config_level_axis_alone() {
        // ADR-0106: the effective set is the config-level `enabled` flag --
        // no per-session or skill-declared contribution exists. A disabled
        // server is absent from the slice `ask` feeds the aggregator, so it
        // never connects (no spawn, no keychain read); the registry itself
        // still lists it (the settings row renders it, toggled off).
        let (_dir, live) = live();
        let make = |id: &str, enabled: bool| McpServerConfig {
            id: McpServerId(id.into()),
            display_name: id.into(),
            transport: McpTransport::stdio("/bin/srv", Vec::new()),
            env: BTreeMap::new(),
            keychain_env_keys: Vec::new(),
            keychain_header_keys: Vec::new(),
            timeout_ms: None,
            enabled,
        };
        live.upsert_mcp_server(make("on-a", true))
            .expect("upsert on-a");
        live.upsert_mcp_server(make("off-b", false))
            .expect("upsert off-b");
        live.upsert_mcp_server(make("on-c", true))
            .expect("upsert on-c");

        let registry = live.mcp_servers();
        assert_eq!(
            registry.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec!["on-a", "off-b", "on-c"],
            "the registry lists every configured server, enabled or not"
        );

        let effective = live.enabled_mcp_servers();
        assert_eq!(
            effective.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec!["on-a", "on-c"],
            "only config-enabled servers reach the turn's aggregator"
        );
    }

    #[test]
    fn disabled_server_never_attempted_at_turn_assembly() {
        // #656 AC3: a disabled server is dormant at turn assembly -- no child
        // spawn, no keychain secret read. Composed over the real ask chain
        // (`enabled_mcp_servers` -> `connect_all`): both servers carry a
        // command that does not exist, so ANY connect attempt surfaces as a
        // `connected: false` ConnectResult row. The enabled one supplies the
        // contrast (attempted -> row, failed); the disabled one's ABSENCE
        // from the results proves the attempt -- and the keychain read that
        // precedes spawn injection -- never happened.
        let (_dir, live) = live();
        let make = |id: &str, enabled: bool| McpServerConfig {
            id: McpServerId(id.into()),
            display_name: id.into(),
            transport: McpTransport::stdio("/bin/toptopduck-definitely-not-a-command", Vec::new()),
            env: BTreeMap::new(),
            keychain_env_keys: if enabled {
                Vec::new()
            } else {
                vec!["API_KEY".into()]
            },
            keychain_header_keys: Vec::new(),
            timeout_ms: None,
            enabled,
        };
        live.upsert_mcp_server(make("on-a", true))
            .expect("upsert on-a");
        live.upsert_mcp_server(make("off-b", false))
            .expect("upsert off-b");

        let mut agg = crate::mcp::aggregator::McpAggregator::empty();
        let results = agg.connect_all(&live.enabled_mcp_servers(), live.keychain());
        assert_eq!(
            results.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["on-a"],
            "only the enabled server was attempted (off-b never spawned)"
        );
        assert!(!results[0].connected, "the bogus command fails when tried");
    }

    #[test]
    fn connect_all_skips_disabled_entries_even_when_passed_unfiltered() {
        // ADR-0106: the dormancy line holds at the chokepoint too. The
        // semantic axis is `enabled_mcp_servers` (see the tests above), but
        // `connect_all` itself guards: a caller handing over an unfiltered
        // registry snapshot -- the shape a future consumer like #657's
        // meta-tool surface could produce -- still gets disabled servers
        // skipped (no spawn, no keychain read). Same bogus-command contrast:
        // the enabled server surfaces as a failed row; the disabled one is
        // absent.
        let (_dir, live) = live();
        let make = |id: &str, enabled: bool| McpServerConfig {
            id: McpServerId(id.into()),
            display_name: id.into(),
            transport: McpTransport::stdio("/bin/toptopduck-definitely-not-a-command", Vec::new()),
            env: BTreeMap::new(),
            keychain_env_keys: if enabled {
                Vec::new()
            } else {
                vec!["API_KEY".into()]
            },
            keychain_header_keys: Vec::new(),
            timeout_ms: None,
            enabled,
        };
        live.upsert_mcp_server(make("on-a", true))
            .expect("upsert on-a");
        live.upsert_mcp_server(make("off-b", false))
            .expect("upsert off-b");

        let mut agg = crate::mcp::aggregator::McpAggregator::empty();
        // Deliberately UNFILTERED: the full registry snapshot, not
        // `enabled_mcp_servers()` -- the guard is what stands between it and
        // the spawn/keychain effects.
        let results = agg.connect_all(&live.mcp_servers(), live.keychain());
        assert_eq!(
            results.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["on-a"],
            "the guard skips the disabled entry even in an unfiltered slice"
        );
        assert!(!results[0].connected, "the bogus command fails when tried");
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
            keychain_header_keys: Vec::new(),
            timeout_ms: None,
            enabled: true,
        };
        live.upsert_mcp_server(first).expect("first upsert");
        let updated = McpServerConfig {
            id: McpServerId("stable-id".into()),
            display_name: "New".into(),
            transport: McpTransport::stdio("/bin/new", vec!["--flag".into()]),
            env: BTreeMap::new(),
            keychain_env_keys: Vec::new(),
            keychain_header_keys: Vec::new(),
            timeout_ms: None,
            enabled: true,
        };
        live.upsert_mcp_server(updated).expect("second upsert");
        let reloaded = live.load();
        assert_eq!(reloaded.mcp_servers.servers.len(), 1, "replace not append");
        assert_eq!(reloaded.mcp_servers.servers[0].display_name, "New");
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
                    keychain_header_keys: Vec::new(),
                    timeout_ms: None,
                    enabled: true,
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

    /// The turn's delegation assembly (issue #933): enabled entries project
    /// to specs with their bound skill bodies resolved off the skills
    /// registry; a disabled entry never lists; an entry whose bound skill
    /// vanished degrades to unbound (the no-breakage clause). Pin against
    /// the real config path (create-lands-enabled + the enablement toggle),
    /// mirroring the wiring pin's non-empty direction posture.
    #[test]
    fn delegation_specs_list_enabled_entries_with_resolved_skill_injections() {
        let (_dir, live) = live();
        let agents = tempfile::tempdir().expect("agents root");
        let skills = tempfile::tempdir().expect("skills root");

        // One registered skill the definition binds.
        let skill_dir = skills.path().join("sql");
        std::fs::create_dir_all(&skill_dir).expect("skill dir");
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: sql\ndescription: SQL coach.\n---\nPrefer CTEs.\n",
        )
        .expect("skill file");

        // An enabled entry (create lands enabled) binding the skill by a
        // backtick mark, plus a dangling mark naming no registered skill.
        live.create_agent(
            agents.path(),
            skills.path(),
            "analyst",
            "Open-ended analysis.",
            "You analyze. Use `sql` and `ghost-skill` when helpful.\n",
        )
        .expect("create analyst");
        // A second entry, disabled via the single machine-level axis.
        live.create_agent(
            agents.path(),
            skills.path(),
            "idle-helper",
            "Never enabled.",
            "You wait.\n",
        )
        .expect("create idle-helper");
        live.set_agent_enabled("idle-helper", false)
            .expect("disable idle-helper");

        let specs = live.delegation_specs(agents.path(), skills.path());
        assert_eq!(specs.len(), 1, "only the enabled entry lists");
        assert_eq!(specs[0].name, "analyst");
        assert_eq!(specs[0].description, "Open-ended analysis.");
        assert_eq!(
            specs[0].preamble,
            "You analyze. Use `sql` and `ghost-skill` when helpful.\n"
        );
        // The binding resolved to the registered skill's body alone -- the
        // dangling mark contributes nothing and refuses nothing.
        assert_eq!(
            specs[0].skill_injections,
            vec![crate::agents::SkillInjection {
                name: "sql".to_string(),
                body: "Prefer CTEs.\n".to_string(),
            }]
        );
    }

    /// AC #1 wiring (issue #1025): an over-cap registered skill bound by a
    /// definition truncates through the real scan + assembly chain -- the
    /// spec's injection, and the preamble the sub-agent runs on, carry the
    /// delegation marker instead of the whole body.
    #[test]
    fn delegation_specs_caps_an_over_cap_bound_skill_body() {
        use crate::skills::prompt::SKILL_BODY_MAX_BYTES;
        let (_dir, live) = live();
        let agents = tempfile::tempdir().expect("agents root");
        let skills = tempfile::tempdir().expect("skills root");
        let skill_dir = skills.path().join("huge");
        std::fs::create_dir_all(&skill_dir).expect("skill dir");
        let body = format!("{}\n", "x".repeat(SKILL_BODY_MAX_BYTES + 4096));
        std::fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\nname: huge\ndescription: Big skill.\n---\n{body}"),
        )
        .expect("skill file");
        live.create_agent(
            agents.path(),
            skills.path(),
            "analyst",
            "Open-ended analysis.",
            "You analyze. Use `huge` when helpful.\n",
        )
        .expect("create analyst");
        let specs = live.delegation_specs(agents.path(), skills.path());
        assert_eq!(specs.len(), 1);
        let injection = &specs[0].skill_injections[0];
        assert_eq!(injection.name, "huge");
        assert!(
            injection.body.contains("[Truncated:"),
            "the over-cap body arrives capped through the real chain"
        );
        assert!(
            injection.body.len() < SKILL_BODY_MAX_BYTES + 512,
            "the capped body stays near the cap"
        );
        assert!(
            crate::agents::delegation::subagent_preamble(&specs[0]).contains("[Truncated:"),
            "the sub-agent's preamble rides the capped injection"
        );
    }

    /// A never-created agents registry is the legitimate empty state: the
    /// assembly lists nothing and never refuses the turn.
    #[test]
    fn delegation_specs_over_an_absent_registry_lists_empty() {
        let (_dir, live) = live();
        let agents = tempfile::tempdir().expect("agents root");
        let skills = tempfile::tempdir().expect("skills root");
        assert!(live
            .delegation_specs(agents.path(), skills.path())
            .is_empty());
    }
}
