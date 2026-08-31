//! App-level config model (ADR-0038): the durable shape of the SECOND at-rest
//! artifact, alongside the user-owned `.duck`. This holds ONLY preferences,
//! defaults, and data-free state (path pointers, numeric ceilings, booleans)
//! -- never a key, never user-data values, never dataset contents.
//!
//! The secrets-never invariant (ADR-0029/0036/0038) is enforced structurally:
//! there is no key field anywhere in this model, so the write path physically
//! cannot persist one. The read path additionally scans the raw JSON for any
//! secret-named field and honest-degrades to defaults if one is present (see
//! [`crate::app_config::io`]), so a hand-edited file cannot smuggle a key past
//! the type system into a plaintext-on-disk state.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::cli_tools::config::CliToolRegistry;
use crate::guardrail::{DEFAULT_MAX_RESULT_ROWS, MAX_THREADS, MEMORY_LIMIT};
use crate::mcp::config::McpServerRegistry;
use crate::model::{ProviderConfig, DEFAULT_PROVIDER_BASE_URL, DEFAULT_PROVIDER_MODEL};
use crate::skills::BuiltinSkillBaseline;
use crate::window::WINDOW_TURNS;

/// App-config schema version (ADR-0038 -- separate domain from the `.duck`
/// `format_version`: app-config is machine-local and migrates with the app, not
/// across users). v2 (issue #150, ADR-0064) marks the provider schema shape
/// change to the multi-profile `ProviderConfig { profiles, active_profile }`.
/// A leftover v1 file honest-degrades to built-in defaults via the read path's
/// `LowerVersion` branch -- the app is unreleased, so ADR-0064 declines a
/// v1->v2 migrator and treats a stale v1 file as a reset to defaults
/// (ADR-0038). Any other version also honest-degrades to built-in defaults.
///
/// Removing a field is forward-compatible without a version bump: `AppConfig`
/// has no `#[serde(deny_unknown_fields)]`, so serde silently drops unknown keys
/// -- a pre-#268 file still carrying a `window` field parses cleanly with the
/// key ignored. Issue #268 retired `WindowGeometry` + `AppConfig.window` and
/// moved geometry persistence to `tauri_plugin_window_state`; the stale `window`
/// key in an old file is harmless, so no bump accompanies the removal.
///
/// ADR-0098 (issue #568) makes `provider.active_profile` nullable without a
/// bump, same reasoning: a v2 file written before the change carries a string
/// id that parses into `Some`, and the null form has no pre-change reader in
/// the wild (the app is unreleased -- the ADR-0064 no-migrator stance).
pub const APP_CONFIG_FORMAT_VERSION: u32 = 2;

/// V1 default far-window cap M (ADR-0028). Mirrors the M=100 invariant; not a
/// named constant elsewhere, so pinned here with the ADR pointer.
const DEFAULT_FAR_WINDOW: u32 = 100;

/// UI response-locale preference (ADR-0052, issue #78). Three-state, mirroring
/// [`Theme`]: `System` defers to the OS locale at apply time, `ZhCN` / `EnUS`
/// are explicit overrides. Crosses IPC as the BCP-47-shaped string the Intl
/// side also keys on (`system` / `zh-CN` / `en-US`). The variant rename is
/// explicit (not `rename_all`) because kebab-case would lowercase the region
/// subtag (`zh-cn`), drifting from the Intl convention the frontend relies on.
/// The default is `System` (follow the OS locale, the local-first zero-config
/// default).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum LocalePreference {
    #[default]
    #[serde(rename = "system")]
    System,
    #[serde(rename = "zh-CN")]
    ZhCN,
    #[serde(rename = "en-US")]
    EnUS,
}

/// UI theme preference (ADR-0050). `System` defers to the OS setting at apply
/// time. Crosses IPC as the bare lowercase variant name. The default is `System`
/// (derived via the `#[default]` attribute on the variant).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

/// The runtime new sessions + resumes start on (ADR-0098 Decision 2, issue
/// #569). A machine-level preference like the active provider profile
/// (ADR-0038 preferences-only model), NOT a last-used hint: switching the
/// runtime mid-session never writes back. `BuiltIn` is the fresh-install
/// default; `External` carries the adapter id STRING -- the config outlives
/// any one build's adapter table, so the id (not the `AdapterSpec`) is what
/// persists. Adjacently tagged (`kind`/`data`, snake_case), mirroring
/// `commands::SessionRuntimeChoice`'s wire shape so one frontend type shape
/// serves both surfaces. Startup RESOLUTION (in `commands`) degrades an
/// undetected `External` to built-in per-startup WITHOUT rewriting this
/// field (ADR-0098 Decision 3: environment restored -> auto re-effective).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum DefaultRuntime {
    #[default]
    BuiltIn,
    External(String),
}

/// One adapter's last-selected model + thought-level posture (ADR-0100, issue
/// #581): the startup posture a NEW session on that adapter starts with --
/// selected + injected at creation, not a display-only hint. `None` on a field
/// = the last set cleared it; both `None` (or no entry at all) = the
/// "default (recommended)" unselected start. Stored keyed by adapter id in
/// [`AppConfig::last_model_postures`] -- the model id is adapter-namespaced,
/// so entries never migrate across CLIs. Ids are NOT validated against the
/// live catalog at rest: a dangling entry (adapter undetected, model gone
/// from the catalog) is KEPT and re-enables automatically once the
/// environment returns (ADR-0100 Decision 4).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ModelPosture {
    /// The model id exactly as the picker set it.
    #[serde(default)]
    pub model: Option<String>,
    /// The thought-level id exactly as the picker set it.
    #[serde(default)]
    pub thought_level: Option<String>,
}

/// Engine default parameters (ADR-0005 L3). Persisted so a user's preferred
/// resource ceiling survives a restart, and consumed at session construction
/// (issue #741): each new/resumed session reads the CURRENT config as its
/// session-level snapshot, so a settings change only reaches later sessions.
/// A stale `statement_timeout_ms` key in a pre-retirement file is harmless
/// (ignored at parse, never re-written) -- the field was retired with the
/// timeout mechanism itself: the engine has no native per-statement timeout,
/// and one built on the interrupt slot would collide with user cancel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EngineDefaults {
    /// DuckDB memory limit string (e.g. `"512MB"`). Applied verbatim as a
    /// PRAGMA; a malformed value is logged + falls back at apply time.
    pub memory_limit: String,
    /// Max worker threads a query may use.
    pub threads: u32,
    /// Ceiling on a materialized result's row count (ADR-0005/0030).
    pub row_cap: u64,
}

impl Default for EngineDefaults {
    fn default() -> Self {
        // Derives from the `guardrail` constants: the persisted default IS the
        // fresh-install engine default, and the constants stay the single
        // default/fallback source (missing or corrupt config degrades here).
        Self {
            memory_limit: MEMORY_LIMIT.to_string(),
            threads: MAX_THREADS,
            row_cap: DEFAULT_MAX_RESULT_ROWS,
        }
    }
}

/// Default-for-new-datasets privacy knobs (ADR-0011). Per-dataset overrides
/// still ride each descriptor; this is only the starting switch a new dataset
/// inherits. ADR-0038 places "privacy defaults" on the app-config IN side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrivacyDefaults {
    /// Whether new datasets ship sample rows off-machine by default.
    pub send_samples: bool,
}

impl Default for PrivacyDefaults {
    fn default() -> Self {
        Self { send_samples: true }
    }
}

/// Export starting directory + default format (ADR-0004/0015). `last_dir` is a
/// path POINTER (the last-used export folder), not user-data content -- allowed
/// under ADR-0038's pointer-vs-content split.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExportDefaults {
    /// Last-used export directory (re-opened as the export dialog's start folder).
    #[serde(default)]
    pub last_dir: Option<String>,
    /// Default export format (e.g. `"csv"`).
    #[serde(default = "default_export_format")]
    pub default_format: String,
}

impl Default for ExportDefaults {
    fn default() -> Self {
        Self {
            last_dir: None,
            default_format: "csv".to_string(),
        }
    }
}

fn default_export_format() -> String {
    "csv".to_string()
}

/// Session sidebar grouping mode (ADR-0072, issue #251). `Flat` renders every
/// session in a single "Recent" group sorted by mtime descending; `Time`
/// preserves the ADR-0060 Chat-style Today / Yesterday / Previous 7 days / Older
/// buckets. The default is `Flat` (the "by recent" browse default); the user
/// toggles between the two from the sidebar's group-title Popover, persisting
/// alongside the two collapse prefs. The variant names avoid `recent` to stay
/// clear of the MRU-list sense (ADR-0072).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum SidebarGrouping {
    #[default]
    #[serde(rename = "flat")]
    Flat,
    #[serde(rename = "time")]
    Time,
}

/// Shell collapse preferences (ADR-0054, issue #84). The two manual collapse
/// levels that are UI state (NOT the third -- Tauri minWidth/minHeight, which is
/// a native window config, not a preference): the session sidebar (full hide +
/// topbar call-out) and the thread rail (workspace goes full-width). Both
/// default expanded; both persist across restarts via app-config (ADR-0038),
/// alongside theme / locale. The two stack -- a user may
/// collapse either, both, or neither independently.
///
/// `sidebar_grouping` (ADR-0072, issue #251) extends the same shell-chrome
/// preference surface: the sidebar's flat/time render mode persists + restores
/// with the two collapse prefs.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ShellPrefs {
    /// Session sidebar collapsed (ADR-0054/0060). Fully hidden; the topbar
    /// toggle calls it back out.
    #[serde(default)]
    pub sidebar_collapsed: bool,
    /// Session sidebar grouping mode (ADR-0072, issue #251). Forward-compat: a
    /// pre-#251 file has no `sidebar_grouping` key, so serde(default) fills
    /// `Flat` rather than rejecting the whole document.
    #[serde(default)]
    pub sidebar_grouping: SidebarGrouping,
}

/// Tunable defaults (ADR-0013/0023/0028). Persisted so a user's tuned values
/// survive a restart. Applying them to the live orchestrator/window assembler is
/// a follow-up slice; this artifact stores + round-trips them per issue #53 AC.
///
/// The per-turn retry budget (ADR-0028) was retired with the single-SQL turn
/// contract (ADR-0077, issue #318): the agent loop self-corrects from
/// tool-level errors instead of blind retry, so the tunable lost its subject.
/// A stale `retry_budget` key in a pre-retirement file is harmless (ignored at
/// parse), so no format-version bump accompanies the removal -- the #268
/// `window` retirement set the precedent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tunables {
    /// Recent-turn window size N (ADR-0023).
    #[serde(default = "default_window_turns")]
    pub window_turns: u32,
    /// Far-window cap M (ADR-0028).
    #[serde(default = "default_far_window")]
    pub far_window: u32,
}

impl Default for Tunables {
    fn default() -> Self {
        Self {
            window_turns: WINDOW_TURNS as u32,
            far_window: DEFAULT_FAR_WINDOW,
        }
    }
}

fn default_window_turns() -> u32 {
    WINDOW_TURNS as u32
}

fn default_far_window() -> u32 {
    DEFAULT_FAR_WINDOW
}

/// The app-config document (ADR-0038). Lives in the OS app-data directory; the
/// only at-rest artifact for machine-local preferences. Each field defaults so a
/// partial / older-same-version file fills the gaps (forward-compat within v1);
/// the read path scans for secret-named keys and rejects any present.
///
/// This struct crosses IPC verbatim (get_app_config / set_app_config) -- it is
/// all non-secret, so no separate "view" type is needed (unlike the provider
/// key, which never crosses). The key stays in the OS keychain, NOT here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppConfig {
    pub format_version: u32,
    #[serde(default)]
    pub theme: Theme,
    #[serde(default)]
    pub locale: LocalePreference,
    #[serde(default)]
    pub engine: EngineDefaults,
    #[serde(default)]
    pub privacy: PrivacyDefaults,
    #[serde(default)]
    pub provider: ProviderConfig,
    #[serde(default)]
    pub export: ExportDefaults,
    #[serde(default)]
    pub tunables: Tunables,
    /// Shell collapse preferences (ADR-0054, issue #84). Forward-compat: a
    /// pre-#84 file has no `shell` key, so serde(default) fills the expanded
    /// defaults rather than rejecting the whole document.
    #[serde(default)]
    pub shell: ShellPrefs,
    /// User-configured external MCP servers (issue #301, ADR-0076).
    /// Forward-compat: a pre-#301 file has no `mcp_servers` key, so
    /// serde(default) fills an empty registry rather than rejecting the whole
    /// document. Secret env values live in the OS keychain, never here
    /// (ADR-0029/0036 -- see [`McpServerRegistry`]).
    #[serde(default)]
    pub mcp_servers: McpServerRegistry,
    /// User-registered CLI tools (issue #671, ADR-0108/0109): the second
    /// external tool source's registry, living next to the MCP registry
    /// (ADR-0109 Decision 9). Forward-compat: a pre-#671 file has no
    /// `cli_tools` key, so serde(default) fills an empty registry rather
    /// than rejecting the whole document. All values are non-secret (the
    /// read-time secret-name scan backstops hand-edits, as for MCP env).
    #[serde(default)]
    pub cli_tools: CliToolRegistry,
    /// The builtin skills' baseline side table (issue #677, ADR-0109
    /// Decision 5): materialized skill name -> the recorded baseline
    /// (rendered-content hash + the locale it was rendered in). Pure
    /// derivation anchor -- `edited` iff the current file's hash differs
    /// from the record -- so the edit path never writes here; the scan
    /// window (materialize / upgrade / cleanup) and the explicit restore
    /// are the only writers, both under the config write lock.
    /// Forward-compat: a pre-#677 file has no `builtin_skill_baselines`
    /// key, so serde(default) fills an empty table rather than rejecting
    /// the whole document (the additive-field pattern of `cli_tools`).
    #[serde(default)]
    pub builtin_skill_baselines: BTreeMap<String, BuiltinSkillBaseline>,
    /// Managed sessions directory override (issue #452, ADR-0089 Decision 2).
    /// None = runtime-computed default (`<Documents>/toptopduck/sessions/`).
    /// Some(path) = user-chosen directory. Forward-compat: a pre-#452 file has
    /// no `sessions_dir` key, so serde(default) fills None rather than
    /// rejecting the whole document. The format_version is NOT bumped — the
    /// new field is additive (same pattern as `mcp_servers` / `shell`).
    #[serde(default)]
    pub sessions_dir: Option<String>,
    /// The default runtime new sessions + resumes start on (ADR-0098 Decision
    /// 2, issue #569). Forward-compat: a pre-#569 file has no
    /// `default_runtime` key, so serde(default) fills `BuiltIn` rather than
    /// rejecting the whole document. The format_version is NOT bumped — the
    /// new field is additive (same pattern as `sessions_dir`).
    #[serde(default)]
    pub default_runtime: DefaultRuntime,
    /// Per-adapter last-selected model postures (ADR-0100, issue #581): the
    /// `{model, thought_level}` a new session on that adapter starts with,
    /// keyed by adapter id. Forward-compat: a pre-#581 file has no
    /// `last_model_postures` key, so serde(default) fills an empty map rather
    /// than rejecting the whole document. The format_version is NOT bumped —
    /// the new field is additive (same pattern as `default_runtime`).
    /// `BTreeMap` (not `HashMap`) so serialization is deterministic (the
    /// `McpServerConfig.env` precedent).
    #[serde(default)]
    pub last_model_postures: BTreeMap<String, ModelPosture>,
}

impl AppConfig {
    /// The built-in defaults (ADR-0038 honest-degrade target). Returned verbatim
    /// by the read path on any failure (missing / corrupt / version mismatch /
    /// secret field detected), so a bad config never bricks the app.
    pub fn defaults() -> Self {
        Self {
            format_version: APP_CONFIG_FORMAT_VERSION,
            theme: Theme::default(),
            locale: LocalePreference::default(),
            engine: EngineDefaults::default(),
            privacy: PrivacyDefaults::default(),
            provider: ProviderConfig::default(),
            export: ExportDefaults::default(),
            tunables: Tunables::default(),
            shell: ShellPrefs::default(),
            mcp_servers: McpServerRegistry::default(),
            cli_tools: CliToolRegistry::default(),
            builtin_skill_baselines: BTreeMap::new(),
            sessions_dir: None,
            default_runtime: DefaultRuntime::default(),
            last_model_postures: BTreeMap::new(),
        }
    }

    /// Normalize IPC-supplied fields in place so the stored config is always
    /// valid. Only the fields whose invalid value would break a downstream
    /// invariant are touched (the rest are persisted verbatim -- over-clamping
    /// now would mask values a follow-up slice needs to apply):
    /// - `format_version` pinned to the current schema version (a wrong/foreign
    ///   value would make the next read honest-degrade the WHOLE config to
    ///   defaults, silently losing every pref the user just saved);
    /// - `provider.profiles` may stay empty (zero profiles is a legal state,
    ///   ADR-0098 -- no skeleton re-seed) and a dangling `active_profile`
    ///   nulls (no first-profile fallback);
    /// - empty/whitespace `base_url` / `model` on the ACTIVE profile (when one
    ///   exists) -> the canonical defaults (so the provider always has a valid
    ///   endpoint);
    /// - `threads` clamped to >= 1 (DuckDB rejects `PRAGMA threads=0`);
    /// - `window_turns` clamped to >= 1 (0 would summarize every turn, which is
    ///   nonsensical rather than dangerous);
    /// - `last_model_postures` shape-repaired only (whitespace trimmed, an
    ///   empty value -> None, a blank adapter key dropped): a dangling entry
    ///   -- an adapter the build no longer detects, or a model the catalog no
    ///   longer carries -- is KEPT (ADR-0100 Decision 4), and an all-empty
    ///   entry is the explicit "cleared" form, not garbage.
    pub fn normalize(&mut self) {
        self.format_version = APP_CONFIG_FORMAT_VERSION;
        // ADR-0098: an empty profile list stays empty -- the zero-profile state
        // is legal persistence, not a malformed gap to repair with a skeleton.
        // A dangling active pointer nulls (the repair target is "no active
        // profile", not "the first profile"): the write is a hand-edit / race
        // artifact, and silently activating a profile the user did not choose
        // would point the live provider and the keychain read at the wrong slot.
        // `active()` IS the dangling check (a pointer that resolves to no
        // profile is `None`), so a `None` pointer is an idempotent no-op.
        if self.provider.active().is_none() {
            self.provider.active_profile = None;
        }
        // Normalize the active profile's endpoint fields (mirrors the legacy
        // set_provider_config normalization): empty -> canonical defaults so the
        // provider always has a valid endpoint. Only the ACTIVE profile is
        // touched; with no active profile there is no endpoint to repair.
        if let Some(active) = self.provider.active_mut() {
            let base_url = active.base_url.trim().to_string();
            active.base_url = if base_url.is_empty() {
                DEFAULT_PROVIDER_BASE_URL.to_string()
            } else {
                base_url
            };
            let model = active.model.trim().to_string();
            active.model = if model.is_empty() {
                DEFAULT_PROVIDER_MODEL.to_string()
            } else {
                model
            };
        }
        self.engine.threads = self.engine.threads.max(1);
        self.tunables.window_turns = self.tunables.window_turns.max(1);
        // Drop duplicate MCP server ids so the keychain-account suffix
        // (`mcp-<id>-<env_key>`, issue #301) stays unambiguous. A hand-edited
        // file with dupes keeps the first occurrence per id; the gateway
        // surfaces a connection fault for any malformed entry at spawn time
        // rather than the config layer guessing validity.
        self.mcp_servers.normalize();
        // Same invariant class for the CLI registry: unique names, first
        // occurrence wins (the MCP registry's honest-degrade precedent).
        self.cli_tools.normalize();
        // Trim whitespace on the sessions_dir override; an all-whitespace
        // value collapses to None so the runtime falls back to the default
        // rather than resolving a whitespace-named directory (issue #452).
        if let Some(ref mut dir) = self.sessions_dir {
            *dir = dir.trim().to_string();
            if dir.is_empty() {
                self.sessions_dir = None;
            }
        }
        // ADR-0100 Decision 4 (issue #581): repair posture SHAPE only -- trim
        // whitespace, an empty value -> None, a blank adapter key drops --
        // while keeping dangling entries (undetected adapter / catalog-drifted
        // model: they re-enable automatically once the environment returns)
        // and the all-empty "cleared" entry (the explicit "back to default"
        // form). Clearing anything here would silently destroy the recorded
        // startup preference.
        let postures = std::mem::take(&mut self.last_model_postures);
        self.last_model_postures = postures
            .into_iter()
            .filter_map(|(id, posture)| {
                let id = id.trim().to_string();
                if id.is_empty() {
                    return None;
                }
                let trim_value = |value: Option<String>| {
                    value
                        .map(|v| v.trim().to_string())
                        .filter(|v| !v.is_empty())
                };
                Some((
                    id,
                    ModelPosture {
                        model: trim_value(posture.model),
                        thought_level: trim_value(posture.thought_level),
                    },
                ))
            })
            .collect();
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self::defaults()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A provider config with one active profile -- the pre-0098 stored shape.
    /// The ADR-0098 defaults ship zero profiles, so every test that needs a
    /// live endpoint seeds one explicitly.
    fn seeded_provider() -> crate::model::ProviderConfig {
        let profile = crate::model::ProviderProfile::default_anthropic();
        crate::model::ProviderConfig {
            active_profile: Some(profile.id.clone()),
            profiles: vec![profile],
        }
    }

    #[test]
    fn defaults_match_live_engine_constants() {
        // The persisted engine defaults must mirror the live guardrail constants
        // so a fresh app-config reproduces the current engine behavior exactly.
        let engine = EngineDefaults::default();
        assert_eq!(engine.memory_limit, MEMORY_LIMIT);
        assert_eq!(engine.threads, MAX_THREADS);
        assert_eq!(engine.row_cap, DEFAULT_MAX_RESULT_ROWS);
    }

    #[test]
    fn defaults_use_canonical_provider_profile() {
        // app-config reuses model::ProviderConfig verbatim, so its default must
        // equal the canonical provider default (zero profiles, no active
        // pointer -- ADR-0098).
        let provider = ProviderConfig::default();
        assert_eq!(provider, crate::model::ProviderConfig::defaults());
    }

    #[test]
    fn defaults_round_trip_losslessly() {
        // A defaults() config must serialize + deserialize back to itself -- the
        // honest-degrade target is itself a valid document (a corrupt write of
        // the defaults would otherwise loop on read).
        let cfg = AppConfig::defaults();
        let json = serde_json::to_string(&cfg).expect("serialize");
        let back: AppConfig = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, cfg);
    }

    #[test]
    fn theme_serializes_as_lowercase_variant() {
        // Crosses IPC as the bare lowercase name (mirrors the ChartKind convention;
        // the frontend's types.ts mirrors this union).
        assert_eq!(
            serde_json::to_string(&Theme::System).unwrap(),
            r#""system""#
        );
        assert_eq!(serde_json::to_string(&Theme::Light).unwrap(), r#""light""#);
        assert_eq!(serde_json::to_string(&Theme::Dark).unwrap(), r#""dark""#);
    }

    #[test]
    fn locale_serializes_as_bcp47_shaped_string() {
        // Crosses IPC as the BCP-47-shaped string the frontend IntlProvider
        // keys on. The region subtag stays uppercase (NOT kebab-cased) so it
        // matches the Intl convention exactly.
        assert_eq!(
            serde_json::to_string(&LocalePreference::System).unwrap(),
            r#""system""#
        );
        assert_eq!(
            serde_json::to_string(&LocalePreference::ZhCN).unwrap(),
            r#""zh-CN""#
        );
        assert_eq!(
            serde_json::to_string(&LocalePreference::EnUS).unwrap(),
            r#""en-US""#
        );
    }

    #[test]
    fn locale_defaults_to_system_follow_os() {
        // ADR-0052: the zero-config default follows the OS locale (local-first,
        // no mandatory language pick on first launch).
        assert_eq!(LocalePreference::default(), LocalePreference::System);
    }

    #[test]
    fn locale_field_defaults_make_app_config_round_trip() {
        // A persisted-defaults config must round-trip with locale=system when
        // the field is absent (forward-compat: a pre-#78 file has no locale
        // key; serde(default) fills system rather than rejecting the file).
        let json = r#"{"format_version":1,"theme":"dark"}"#;
        let cfg: AppConfig = serde_json::from_str(json).expect("partial deserialize");
        assert_eq!(cfg.locale, LocalePreference::System);
        assert_eq!(cfg.theme, Theme::Dark);
    }

    #[test]
    fn normalize_fills_empty_endpoint_fields_with_defaults() {
        // Empty / whitespace base_url + model on the ACTIVE profile must fall
        // back to the canonical defaults so the stored config always hands the
        // provider a valid endpoint.
        let mut cfg = AppConfig::defaults();
        cfg.provider = seeded_provider();
        let active = cfg
            .provider
            .active_mut()
            .expect("seeded config has an active profile");
        active.base_url = "   ".into();
        active.model = "".into();
        cfg.normalize();
        let active = cfg.provider.active().expect("active profile still present");
        assert_eq!(active.base_url, DEFAULT_PROVIDER_BASE_URL);
        assert_eq!(active.model, DEFAULT_PROVIDER_MODEL);
    }

    #[test]
    fn normalize_keeps_a_set_endpoint_value() {
        // A user-supplied custom endpoint on the active profile survives
        // normalization (only empties reset to the default).
        let mut cfg = AppConfig::defaults();
        cfg.provider = seeded_provider();
        let active = cfg
            .provider
            .active_mut()
            .expect("seeded config has an active profile");
        active.base_url = "  https://gateway.example.test  ".into();
        active.model = "claude-opus-4-8".into();
        cfg.normalize();
        let active = cfg.provider.active().expect("active profile still present");
        assert_eq!(active.base_url, "https://gateway.example.test");
        assert_eq!(active.model, "claude-opus-4-8");
    }

    #[test]
    fn normalize_keeps_an_empty_profile_list_empty() {
        // ADR-0098: zero profiles is a legal persistent state. normalize must
        // NOT re-seed the skeleton -- deleting every profile and restarting
        // stays at zero profiles (the pre-0098 behavior resurrected a keyless
        // skeleton and masked "not configured"). defaults() IS the zero-profile
        // shape, so no setup teardown is needed.
        let mut cfg = AppConfig::defaults();
        cfg.normalize();
        assert!(cfg.provider.profiles.is_empty());
        assert_eq!(cfg.provider.active_profile, None);
        assert!(cfg.provider.active().is_none());
        // The zero-profile state also survives a persistence round trip: the
        // file on disk is re-read as written (defaults ARE this shape, so the
        // round-trip pin doubles as the fresh-install pin).
        let json = serde_json::to_string(&cfg).expect("serialize");
        let back: AppConfig = serde_json::from_str(&json).expect("deserialize");
        assert!(back.provider.profiles.is_empty());
        assert_eq!(back.provider.active_profile, None);
    }

    #[test]
    fn normalize_nulls_a_dangling_active_profile() {
        // ADR-0098: active_profile pointing at a non-existent id repairs to
        // None -- NOT the first profile (silently activating a profile the
        // user did not choose would point the live provider and the keychain
        // read at the wrong slot).
        let mut cfg = AppConfig::defaults();
        cfg.provider = seeded_provider();
        cfg.provider.active_profile = Some(crate::model::ProfileId("no-such-profile".into()));
        cfg.normalize();
        assert_eq!(cfg.provider.active_profile, None);
        assert!(cfg.provider.active().is_none());
        // The profiles themselves survive the repair untouched.
        assert_eq!(cfg.provider.profiles.len(), 1);
    }

    #[test]
    fn normalize_preserves_a_stored_skeleton_profile() {
        // ADR-0098 file compat: a pre-0098 app-config carries the seeded
        // skeleton profile. Reading it back + normalizing keeps it verbatim --
        // visible in the UI, deletable by the user, never silently cleaned.
        let json = serde_json::json!({
            "format_version": 2,
            "theme": "dark",
            "provider": {
                "profiles": [{
                    "id": "default",
                    "display_name": "Anthropic",
                    "protocol": "anthropic",
                    "base_url": "https://api.anthropic.com",
                    "model": "claude-sonnet-4-6"
                }],
                "active_profile": "default"
            }
        });
        let mut cfg: AppConfig = serde_json::from_value(json).expect("pre-0098 file parses");
        cfg.normalize();
        assert_eq!(cfg.provider.profiles.len(), 1, "skeleton not cleaned");
        let profile = &cfg.provider.profiles[0];
        assert_eq!(profile.id.as_str(), "default");
        assert_eq!(profile.display_name, "Anthropic");
        assert_eq!(
            cfg.provider.active_profile.as_ref().map(|id| id.as_str()),
            Some("default"),
            "active pointer stays on the stored skeleton"
        );
    }

    #[test]
    fn renaming_display_name_keeps_profile_id_stable() {
        // ADR-0037 split (referenced by ADR-0064): display_name is renamable;
        // id is stable. Renaming the label does NOT mint a new id, so the
        // keychain account (`key-<id>`) and the active_profile pointer stay
        // valid across a rename.
        let mut cfg = AppConfig::defaults();
        cfg.provider = seeded_provider();
        let original_id = cfg.provider.active().expect("active profile").id.clone();
        cfg.provider
            .active_mut()
            .expect("active profile")
            .display_name = "Renamed".into();
        let active = cfg.provider.active().expect("active profile");
        assert_eq!(active.id, original_id);
        assert_eq!(active.display_name, "Renamed");
    }

    #[test]
    fn view_surfaces_active_profile_endpoint_and_has_key() {
        // The IPC view carries the active profile's base URL + model verbatim
        // and the key read outcome as-is (ADR-0029: a boolean + read-fault
        // detail cross, never the key).
        let mut provider = seeded_provider();
        provider.active_mut().expect("active profile").base_url =
            "https://gateway.example.test".into();
        let view = provider.view(Ok(true));
        assert_eq!(
            view.base_url.as_deref(),
            Some("https://gateway.example.test")
        );
        assert_eq!(
            view.model.as_deref(),
            Some(crate::model::DEFAULT_PROVIDER_MODEL)
        );
        assert!(view.has_key);
        assert!(view.keychain_fault.is_none());
    }

    #[test]
    fn view_exposes_nulls_when_active_profile_dangling() {
        // ADR-0098: a dangling active_profile (a hand-edit normalize nulls on
        // the next store) yields NULL endpoint fields -- there is no endpoint
        // to read, and the canonical defaults must not masquerade as a
        // configured value. No normalize() here -- pin the read-time shape,
        // not the store-time repair.
        let mut provider = seeded_provider();
        provider.active_profile = Some(crate::model::ProfileId("no-such-profile".into()));
        let view = provider.view(Ok(false));
        assert_eq!(view.base_url, None);
        assert_eq!(view.model, None);
        assert!(!view.has_key);
        assert!(view.keychain_fault.is_none());
    }

    #[test]
    fn view_maps_a_keychain_read_fault_onto_keychain_fault() {
        // Issue #275: view() takes the keychain read outcome as a Result so a
        // read fault surfaces on keychain_fault (with has_key a placeholder
        // false) instead of being honest-degraded behind a bare false -- the
        // header indicator renders "keychain unavailable", not "no key".
        let provider = seeded_provider();
        let view = provider.view(Err("keychain access failed: locked".into()));
        assert!(!view.has_key);
        assert_eq!(
            view.keychain_fault.as_deref(),
            Some("keychain access failed: locked")
        );
        // The endpoint fields are unaffected by the key read outcome.
        assert_eq!(
            view.base_url.as_deref(),
            Some(crate::model::DEFAULT_PROVIDER_BASE_URL)
        );
    }

    #[test]
    fn provider_config_round_trips_a_non_default_active_profile() {
        // ADR-0037: ProfileId is the stable reference half -- it must survive
        // a serde round trip so active_profile still resolves to the right
        // profile (and thus the right `key-<id>` slot) after a store -> load.
        // A non-default id is used so the assertion cannot pass by coincidence
        // with DEFAULT_PROFILE_ID.
        let mut cfg = AppConfig::defaults();
        cfg.provider = seeded_provider();
        let profile = cfg.provider.profiles.get_mut(0).expect("seeded profile");
        profile.id = crate::model::ProfileId("user-profile-7".into());
        profile.display_name = "My Gateway".into();
        cfg.provider.active_profile = Some(crate::model::ProfileId("user-profile-7".into()));

        let json = serde_json::to_string(&cfg).expect("serialize");
        let back: AppConfig = serde_json::from_str(&json).expect("deserialize");

        let active = back
            .provider
            .active()
            .expect("active resolves after round trip");
        assert_eq!(active.id, crate::model::ProfileId("user-profile-7".into()));
        assert_eq!(active.display_name, "My Gateway");
    }

    #[test]
    fn normalize_clamps_counts_to_at_least_one() {
        // threads=0 would make DuckDB reject the PRAGMA; window_turns=0 would
        // summarize every turn. Both clamp to >=1.
        let mut cfg = AppConfig::defaults();
        cfg.engine.threads = 0;
        cfg.tunables.window_turns = 0;
        cfg.normalize();
        assert_eq!(cfg.engine.threads, 1);
        assert_eq!(cfg.tunables.window_turns, 1);
    }

    #[test]
    fn normalize_pins_format_version_to_current() {
        // A frontend-supplied wrong/foreign format_version must be overwritten
        // with the current schema version on write -- otherwise the next read
        // would honest-degrade the WHOLE config to defaults, losing every pref
        // the user just saved.
        let mut cfg = AppConfig::defaults();
        cfg.format_version = APP_CONFIG_FORMAT_VERSION + 1; // a "future" version
        cfg.normalize();
        assert_eq!(cfg.format_version, APP_CONFIG_FORMAT_VERSION);

        let mut low = AppConfig::defaults();
        low.format_version = 0; // impossibly low
        low.normalize();
        assert_eq!(low.format_version, APP_CONFIG_FORMAT_VERSION);
    }

    #[test]
    fn shell_prefs_default_expanded() {
        // ADR-0054: the sidebar defaults EXPANDED (false). The user opts into
        // collapse; first launch and the honest-degrade target both surface
        // the full three-column shell.
        let shell = ShellPrefs::default();
        assert!(!shell.sidebar_collapsed);
        // ADR-0072 (#251): the grouping mode defaults to Flat (the "by recent"
        // browse default), persisting alongside the collapse pref.
        assert_eq!(shell.sidebar_grouping, SidebarGrouping::Flat);
    }

    #[test]
    fn sidebar_grouping_serializes_as_lowercase_variant() {
        // Crosses IPC as the bare lowercase name, mirroring Theme. The TS union
        // `SidebarGrouping = "flat" | "time"` mirrors this exact spelling.
        assert_eq!(
            serde_json::to_string(&SidebarGrouping::Flat).unwrap(),
            r#""flat""#
        );
        assert_eq!(
            serde_json::to_string(&SidebarGrouping::Time).unwrap(),
            r#""time""#
        );
    }

    #[test]
    fn sidebar_grouping_round_trips_through_shell_prefs() {
        // A user who switched to Time reopens in Time; Flat likewise.
        let mut cfg = AppConfig::defaults();
        cfg.shell.sidebar_grouping = SidebarGrouping::Time;
        let json = serde_json::to_string(&cfg).expect("serialize");
        let back: AppConfig = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.shell.sidebar_grouping, SidebarGrouping::Time);
    }

    #[test]
    fn shell_prefs_round_trip_collapsed_states() {
        // A user who collapsed the sidebar reopens with it collapsed.
        let mut cfg = AppConfig::defaults();
        cfg.shell.sidebar_collapsed = true;
        let json = serde_json::to_string(&cfg).expect("serialize");
        let back: AppConfig = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.shell, cfg.shell);
        assert!(back.shell.sidebar_collapsed);
    }

    #[test]
    fn shell_field_defaults_when_absent_for_forward_compat() {
        // A pre-#84 app-config file has NO `shell` key. serde(default) on the
        // field + ShellPrefs::default must fill the expanded defaults rather
        // than rejecting the whole document (forward-compat: the user's prior
        // theme / locale survive an app upgrade).
        let json = r#"{"format_version":1,"theme":"dark"}"#;
        let cfg: AppConfig = serde_json::from_str(json).expect("partial deserialize");
        assert_eq!(cfg.theme, Theme::Dark);
        assert_eq!(cfg.shell, ShellPrefs::default());
        assert!(!cfg.shell.sidebar_collapsed);
    }

    #[test]
    fn shell_prefs_partial_deserialize_fills_missing_collapse() {
        // A partial `shell` object (one key present, the others absent) must
        // fill the missing fields from default, not reject. Each field carries
        // its own #[serde(default)], so a future addition to ShellPrefs is also
        // forward-compat at the field level.
        let json = r#"{"format_version":1,"shell":{"sidebar_collapsed":true}}"#;
        let cfg: AppConfig = serde_json::from_str(json).expect("partial shell deserialize");
        assert!(cfg.shell.sidebar_collapsed);
        assert_eq!(cfg.shell.sidebar_grouping, SidebarGrouping::Flat); // absent -> Flat
    }

    #[test]
    fn unknown_sidebar_grouping_value_rejects_the_whole_document() {
        // ADR-0072: SidebarGrouping has NO #[serde(other)] fallback. A typo'd
        // or forward-incompatible value ("recent" / "Flat" / 1) makes serde
        // reject the whole AppConfig, and the read path honest-degrades to
        // defaults. Pin this so adding #[serde(other)] later is a deliberate
        // decision (it would silently shift the degrade semantics from
        // document-level to field-level), not a silent drift.
        let json = r#"{"format_version":2,"shell":{"sidebar_grouping":"recent"}}"#;
        let result: Result<AppConfig, _> = serde_json::from_str(json);
        assert!(
            result.is_err(),
            "unknown sidebar_grouping value must reject, not silently default"
        );
    }

    // --- mcp_servers (issue #301) -----------------------------------------

    #[test]
    fn mcp_servers_defaults_empty() {
        // A fresh config ships with no preconfigured external servers -- the
        // user adds them from settings. An empty registry is the honest-degrade
        // target + the first-launch shape.
        let cfg = AppConfig::defaults();
        assert!(cfg.mcp_servers.servers.is_empty());
    }

    #[test]
    fn mcp_servers_round_trips_a_configured_server() {
        // A config with one stdio server (the common shape) survives a serde
        // round trip identically -- the artifact is a faithful record.
        let mut cfg = AppConfig::defaults();
        let mut env = std::collections::BTreeMap::new();
        env.insert("LOG_LEVEL".into(), "info".into());
        cfg.mcp_servers
            .servers
            .push(crate::mcp::config::McpServerConfig {
                id: crate::mcp::config::McpServerId("github-mcp".into()),
                display_name: "GitHub".into(),
                transport: crate::mcp::config::McpTransport::stdio(
                    "/usr/local/bin/github-mcp",
                    vec!["--stdio".into()],
                ),
                env,
                keychain_env_keys: Vec::new(),
                timeout_ms: None,
                enabled: true,
            });
        let json = serde_json::to_string(&cfg).expect("serialize");
        let back: AppConfig = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, cfg);
        assert_eq!(back.mcp_servers.servers.len(), 1);
    }

    #[test]
    fn mcp_servers_absent_fills_empty_for_forward_compat() {
        // A pre-#301 app-config file has NO `mcp_servers` key. serde(default)
        // on the field + McpServerRegistry::default must fill an empty registry
        // rather than rejecting the whole document (the user's prior theme /
        // locale / provider survive an app upgrade). Mirrors the shell-pref
        // forward-compat pattern.
        let json = r#"{"format_version":2,"theme":"dark"}"#;
        let cfg: AppConfig = serde_json::from_str(json).expect("partial deserialize");
        assert_eq!(cfg.theme, Theme::Dark);
        assert!(
            cfg.mcp_servers.servers.is_empty(),
            "absent mcp_servers -> empty"
        );
    }

    #[test]
    fn normalize_dedupes_mcp_servers_by_id() {
        // A hand-edited config with duplicate server ids is repaired on write:
        // normalize drops the second occurrence, so the keychain-account suffix
        // (`mcp-<id>-<env_key>`) stays unambiguous.
        use crate::mcp::config::{McpServerConfig, McpServerId, McpTransport};
        let mut cfg = AppConfig::defaults();
        let make = |id: &str, name: &str| McpServerConfig {
            id: McpServerId(id.into()),
            display_name: name.into(),
            transport: McpTransport::stdio("/bin/srv", Vec::new()),
            env: std::collections::BTreeMap::new(),
            keychain_env_keys: Vec::new(),
            timeout_ms: None,
            enabled: true,
        };
        cfg.mcp_servers.servers = vec![
            make("dup", "First"),
            make("dup", "Second"),
            make("uniq", "Unique"),
        ];
        cfg.normalize();
        assert_eq!(cfg.mcp_servers.servers.len(), 2, "duplicate id dropped");
        assert_eq!(
            cfg.mcp_servers.servers[0].display_name, "First",
            "first kept"
        );
        assert_eq!(cfg.mcp_servers.servers[1].id, McpServerId("uniq".into()));
    }

    // --- sessions_dir (issue #452) -----------------------------------------

    #[test]
    fn sessions_dir_defaults_to_none() {
        let cfg = AppConfig::defaults();
        assert!(cfg.sessions_dir.is_none());
    }

    #[test]
    fn normalize_trims_sessions_dir_whitespace() {
        let mut cfg = AppConfig::defaults();
        cfg.sessions_dir = Some("  /path/to/sessions  ".into());
        cfg.normalize();
        assert_eq!(cfg.sessions_dir.as_deref(), Some("/path/to/sessions"));
    }

    #[test]
    fn normalize_collapses_all_whitespace_sessions_dir_to_none() {
        let mut cfg = AppConfig::defaults();
        cfg.sessions_dir = Some("   ".into());
        cfg.normalize();
        assert!(
            cfg.sessions_dir.is_none(),
            "all-whitespace sessions_dir collapses to None (default fallback)"
        );
    }

    #[test]
    fn normalize_collapses_empty_sessions_dir_to_none() {
        let mut cfg = AppConfig::defaults();
        cfg.sessions_dir = Some(String::new());
        cfg.normalize();
        assert!(cfg.sessions_dir.is_none());
    }

    #[test]
    fn sessions_dir_absent_fills_none_for_forward_compat() {
        // A pre-#452 config file has no `sessions_dir` key. serde(default)
        // fills None rather than rejecting the document (same forward-compat
        // pattern as mcp_servers / shell).
        let json = r#"{"format_version":2,"theme":"dark"}"#;
        let cfg: AppConfig = serde_json::from_str(json).expect("partial deserialize");
        assert_eq!(cfg.theme, Theme::Dark);
        assert!(cfg.sessions_dir.is_none());
    }

    #[test]
    fn sessions_dir_round_trips_through_serde() {
        let mut cfg = AppConfig::defaults();
        cfg.sessions_dir = Some("/custom/sessions".into());
        let json = serde_json::to_string(&cfg).expect("serialize");
        let back: AppConfig = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.sessions_dir.as_deref(), Some("/custom/sessions"));
    }

    // --- default_runtime (issue #569, ADR-0098 Decision 2) -------------------

    #[test]
    fn default_runtime_defaults_to_built_in() {
        // The fresh-install default is the built-in runtime, so a brand-new
        // install starts exactly as before the field existed (issue #569 AC1).
        let cfg = AppConfig::defaults();
        assert_eq!(cfg.default_runtime, DefaultRuntime::BuiltIn);
    }

    #[test]
    fn default_runtime_absent_fills_built_in_for_forward_compat() {
        // A pre-#569 config file has no `default_runtime` key. serde(default)
        // fills BuiltIn rather than rejecting the document (same forward-compat
        // pattern as sessions_dir / mcp_servers).
        let json = r#"{"format_version":2,"theme":"dark"}"#;
        let cfg: AppConfig = serde_json::from_str(json).expect("partial deserialize");
        assert_eq!(cfg.default_runtime, DefaultRuntime::BuiltIn);
    }

    #[test]
    fn default_runtime_round_trips_external_through_serde() {
        // The external choice persists verbatim -- including an adapter id that
        // is not currently detected (ADR-0098 Decision 3: no write-time
        // validation; degradation is per-startup resolution, never a rewrite).
        let mut cfg = AppConfig::defaults();
        cfg.default_runtime = DefaultRuntime::External("gemini-cli".into());
        let json = serde_json::to_string(&cfg).expect("serialize");
        let back: AppConfig = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(
            back.default_runtime,
            DefaultRuntime::External("gemini-cli".into())
        );
    }

    // --- last_model_postures (issue #581, ADR-0100) ---------------------------

    #[test]
    fn last_model_postures_default_to_an_empty_map() {
        // The fresh-install default is empty: no adapter has a recorded
        // posture, so every new session starts unselected (issue #581 AC1).
        assert!(AppConfig::defaults().last_model_postures.is_empty());
    }

    #[test]
    fn last_model_postures_absent_fill_empty_map_for_forward_compat() {
        // A pre-#581 config file has no `last_model_postures` key.
        // serde(default) fills an empty map rather than rejecting the document
        // (same forward-compat pattern as `default_runtime` / `sessions_dir`).
        let json = r#"{"format_version":2,"theme":"dark"}"#;
        let cfg: AppConfig = serde_json::from_str(json).expect("partial deserialize");
        assert!(cfg.last_model_postures.is_empty());
    }

    #[test]
    fn last_model_postures_round_trip_dangling_entries_verbatim() {
        // A posture naming an adapter that is not detected (or a model the
        // catalog no longer carries) round-trips verbatim -- ADR-0100
        // Decision 4: nothing validates ids at rest, so the entry
        // re-enables automatically once the environment returns.
        let mut cfg = AppConfig::defaults();
        cfg.last_model_postures.insert(
            "gemini-cli".into(),
            ModelPosture {
                model: Some("gemini-2.5-pro".into()),
                thought_level: Some("high".into()),
            },
        );
        cfg.last_model_postures.insert(
            "uninstalled-cli".into(),
            ModelPosture {
                model: Some("gone-model".into()),
                thought_level: None,
            },
        );
        let json = serde_json::to_string(&cfg).expect("serialize");
        let back: AppConfig = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.last_model_postures, cfg.last_model_postures);
    }

    #[test]
    fn normalize_repairs_posture_shape_but_keeps_dangling_and_cleared_entries() {
        // Shape-repair only (ADR-0100 Decision 4): a blank adapter key drops,
        // whitespace trims, an all-whitespace value reads as None. A dangling
        // adapter id and the all-empty "cleared" entry survive normalize --
        // clearing them would silently destroy the recorded startup
        // preference (issue #581 AC5).
        let mut cfg = AppConfig::defaults();
        cfg.last_model_postures.insert(
            "  gemini-cli  ".into(),
            ModelPosture {
                model: Some("  gemini-2.5-pro  ".into()),
                thought_level: Some("   ".into()),
            },
        );
        cfg.last_model_postures.insert(
            "   ".into(),
            ModelPosture {
                model: Some("orphaned-by-blank-key".into()),
                thought_level: None,
            },
        );
        cfg.last_model_postures.insert(
            "uninstalled-cli".into(),
            ModelPosture {
                model: Some("gone-model".into()),
                thought_level: None,
            },
        );
        cfg.last_model_postures.insert(
            "codex".into(),
            ModelPosture {
                model: None,
                thought_level: None,
            },
        );
        cfg.normalize();
        let expected: BTreeMap<String, ModelPosture> = [
            (
                "gemini-cli",
                ModelPosture {
                    model: Some("gemini-2.5-pro".into()),
                    thought_level: None,
                },
            ),
            (
                "uninstalled-cli",
                ModelPosture {
                    model: Some("gone-model".into()),
                    thought_level: None,
                },
            ),
            (
                "codex",
                ModelPosture {
                    model: None,
                    thought_level: None,
                },
            ),
        ]
        .into_iter()
        .map(|(id, posture)| (id.to_string(), posture))
        .collect();
        assert_eq!(cfg.last_model_postures, expected);
    }
}
