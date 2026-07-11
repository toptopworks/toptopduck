//! App-level config model (ADR-0038): the durable shape of the SECOND at-rest
//! artifact, alongside the user-owned `.duck`. This holds ONLY preferences,
//! defaults, and data-free state (path pointers, numeric ceilings, booleans,
//! geometry) -- never a key, never user-data values, never dataset contents.
//!
//! The secrets-never invariant (ADR-0029/0036/0038) is enforced structurally:
//! there is no key field anywhere in this model, so the write path physically
//! cannot persist one. The read path additionally scans the raw JSON for any
//! secret-named field and honest-degrades to defaults if one is present (see
//! [`crate::app_config::io`]), so a hand-edited file cannot smuggle a key past
//! the type system into a plaintext-on-disk state.

use serde::{Deserialize, Serialize};

use crate::guardrail::{DEFAULT_MAX_RESULT_ROWS, MAX_THREADS, MEMORY_LIMIT};
use crate::model::{ProviderConfig, DEFAULT_PROVIDER_BASE_URL, DEFAULT_PROVIDER_MODEL};
use crate::window::WINDOW_TURNS;

/// App-config schema version (ADR-0038 -- separate domain from the `.duck`
/// `format_version`: app-config is machine-local and migrates with the app, not
/// across users). v1 is the first version; the read path honest-degrades any
/// other version to built-in defaults (ADR-0038 "corrupt/missing -> defaults").
pub const APP_CONFIG_FORMAT_VERSION: u32 = 1;

/// V1 default per-statement timeout (ms). No prior constant existed; 30s is a
/// conservative ceiling for a local DuckDB query under the resource caps.
const DEFAULT_STATEMENT_TIMEOUT_MS: u64 = 30_000;

/// V1 default far-window cap M (ADR-0028). Mirrors the M=100 invariant; not a
/// named constant elsewhere, so pinned here with the ADR pointer.
const DEFAULT_FAR_WINDOW: u32 = 100;

/// V1 default per-turn retry budget (ADR-0028). Mirrors `session::TURN_RETRY_BUDGET`
/// (private); kept in sync by comment. Applying the stored value to the live
/// orchestrator is a follow-up slice (issue #53 lands the storage layer).
const DEFAULT_RETRY_BUDGET: u32 = 2;

/// Cap on the recent-files list (issue #53). Keeps the on-disk blob bounded; a
/// new open unshifts and trims to this length.
pub const RECENT_FILES_CAP: usize = 10;

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

/// Persisted window geometry (ADR-0038 UI prefs). Restored on launch so the app
/// reopens at the size/position the user left it. `x`/`y` are `None` until the
/// first move is persisted (a first-run window is centered by the OS).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowGeometry {
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub x: Option<i32>,
    #[serde(default)]
    pub y: Option<i32>,
    #[serde(default)]
    pub maximized: bool,
}

impl Default for WindowGeometry {
    fn default() -> Self {
        // Mirrors the tauri.conf.json window defaults (1024x768, not maximized).
        Self {
            width: 1024,
            height: 768,
            x: None,
            y: None,
            maximized: false,
        }
    }
}

/// Engine default parameters (ADR-0005 L3). Persisted so a user's preferred
/// resource ceiling survives a restart. Applying these to the live DuckDB
/// (threading them through every Session constructor) is a follow-up slice; this
/// artifact stores + round-trips them faithfully per issue #53 AC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EngineDefaults {
    /// DuckDB memory limit string (e.g. `"512MB"`). Applied verbatim as a
    /// PRAGMA; a malformed value is logged + falls back at apply time.
    pub memory_limit: String,
    /// Max worker threads a query may use.
    pub threads: u32,
    /// Ceiling on a materialized result's row count (ADR-0005/0030).
    pub row_cap: u64,
    /// Per-statement timeout in milliseconds.
    pub statement_timeout_ms: u64,
}

impl Default for EngineDefaults {
    fn default() -> Self {
        // Mirrors the v1 `guardrail` constants so the persisted default matches
        // the live engine's current behavior (issue #53 stores; follow-up applies).
        Self {
            memory_limit: MEMORY_LIMIT.to_string(),
            threads: MAX_THREADS,
            row_cap: DEFAULT_MAX_RESULT_ROWS,
            statement_timeout_ms: DEFAULT_STATEMENT_TIMEOUT_MS,
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

/// Anthropic-protocol endpoint config (ADR-0019), SANS the API key. The key
/// lives ONLY in the OS keychain (ADR-0029/0038); app-config must never carry
/// it -- enforced structurally (the reused [`ProviderConfig`] carries only
/// `base_url` + `model`, no key field) plus a secret-field scan on read.
///
/// `ProviderConfig` is the single shape used both for app-config storage and as
/// the IPC wire type for `set_provider_config` -- no DRY split between a
/// "storage" and a "wire" variant. The key stays in the OS keychain, NOT here.
///
/// (Type alias kept so call sites read as "the endpoint half of app-config".)
pub type ProviderEndpoint = ProviderConfig;

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

/// Shell collapse preferences (ADR-0054, issue #84). The two manual collapse
/// levels that are UI state (NOT the third -- Tauri minWidth/minHeight, which is
/// a native window config, not a preference): the session sidebar (full hide +
/// topbar call-out) and the thread rail (workspace goes full-width). Both
/// default expanded; both persist across restarts via app-config (ADR-0038),
/// alongside theme / locale / window geometry. The two stack -- a user may
/// collapse either, both, or neither independently.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ShellPrefs {
    /// Session sidebar collapsed (ADR-0054/0060). Fully hidden; the topbar
    /// toggle calls it back out.
    #[serde(default)]
    pub sidebar_collapsed: bool,
    /// Thread rail collapsed (ADR-0054). Workspace takes the full pane width;
    /// the QuestionBar still spans it (ADR-0062 R1).
    #[serde(default)]
    pub rail_collapsed: bool,
}

/// Tunable defaults (ADR-0013/0023/0028). Persisted so a user's tuned values
/// survive a restart. Applying them to the live orchestrator/window assembler is
/// a follow-up slice; this artifact stores + round-trips them per issue #53 AC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tunables {
    /// Per-turn retry budget (ADR-0028).
    #[serde(default = "default_retry_budget")]
    pub retry_budget: u32,
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
            retry_budget: DEFAULT_RETRY_BUDGET,
            window_turns: WINDOW_TURNS as u32,
            far_window: DEFAULT_FAR_WINDOW,
        }
    }
}

fn default_retry_budget() -> u32 {
    DEFAULT_RETRY_BUDGET
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
    pub window: WindowGeometry,
    #[serde(default)]
    pub engine: EngineDefaults,
    #[serde(default)]
    pub privacy: PrivacyDefaults,
    #[serde(default)]
    pub provider: ProviderEndpoint,
    #[serde(default)]
    pub export: ExportDefaults,
    #[serde(default)]
    pub tunables: Tunables,
    /// Recently-opened `.duck` paths, most-recent first. Capped at
    /// [`RECENT_FILES_CAP`]; the open/save path unshifts + dedupes + trims.
    #[serde(default)]
    pub recent_files: Vec<String>,
    /// Shell collapse preferences (ADR-0054, issue #84). Forward-compat: a
    /// pre-#84 file has no `shell` key, so serde(default) fills the expanded
    /// defaults rather than rejecting the whole document.
    #[serde(default)]
    pub shell: ShellPrefs,
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
            window: WindowGeometry::default(),
            engine: EngineDefaults::default(),
            privacy: PrivacyDefaults::default(),
            provider: ProviderEndpoint::default(),
            export: ExportDefaults::default(),
            tunables: Tunables::default(),
            recent_files: Vec::new(),
            shell: ShellPrefs::default(),
        }
    }

    /// Unshift a path onto the recent-files list, dedupe, and trim to the cap.
    /// Returns whether the list changed (so the caller can skip a write when it
    /// did not). The path is stored verbatim (a path pointer, not data content).
    pub fn record_recent_file(&mut self, path: &str) -> bool {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return false;
        }
        if self.recent_files.iter().any(|p| p == trimmed) {
            let already_at_front = self.recent_files.first().is_some_and(|p| p == trimmed);
            if already_at_front {
                return false;
            }
            self.recent_files.retain(|p| p != trimmed);
        }
        self.recent_files.insert(0, trimmed.to_string());
        if self.recent_files.len() > RECENT_FILES_CAP {
            self.recent_files.truncate(RECENT_FILES_CAP);
        }
        true
    }

    /// Drop a path from the recent-files list (issue #81 delete-session).
    /// Returns whether the list changed (so the caller can skip a write when it
    /// did not). Like [`Self::record_recent_file`], the list is advisory -- a
    /// missing entry is a no-op success. The comparison is verbatim (the same
    /// spelling under which it was recorded); a path synonym stays, matching
    /// the record-side verbatim contract.
    pub fn remove_recent_file(&mut self, path: &str) -> bool {
        let before = self.recent_files.len();
        self.recent_files.retain(|p| p != path);
        before != self.recent_files.len()
    }

    /// Normalize IPC-supplied fields in place so the stored config is always
    /// valid. Only the fields whose invalid value would break a downstream
    /// invariant are touched (the rest are persisted verbatim -- over-clamping
    /// now would mask values a follow-up slice needs to apply):
    /// - `format_version` pinned to the current schema version (a wrong/foreign
    ///   value would make the next read honest-degrade the WHOLE config to
    ///   defaults, silently losing every pref the user just saved);
    /// - empty/whitespace `base_url` / `model` -> the canonical defaults (so the
    ///   provider always has a valid endpoint; mirrors the legacy
    ///   `set_provider_config` normalization);
    /// - `threads` clamped to >= 1 (DuckDB rejects `PRAGMA threads=0`);
    /// - `window_turns` clamped to >= 1 (0 would summarize every turn, which is
    ///   nonsensical rather than dangerous).
    pub fn normalize(&mut self) {
        self.format_version = APP_CONFIG_FORMAT_VERSION;
        let base_url = self.provider.base_url.trim().to_string();
        self.provider.base_url = if base_url.is_empty() {
            DEFAULT_PROVIDER_BASE_URL.to_string()
        } else {
            base_url
        };
        let model = self.provider.model.trim().to_string();
        self.provider.model = if model.is_empty() {
            DEFAULT_PROVIDER_MODEL.to_string()
        } else {
            model
        };
        self.engine.threads = self.engine.threads.max(1);
        self.tunables.window_turns = self.tunables.window_turns.max(1);
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
    fn defaults_use_canonical_provider_endpoint() {
        // app-config reuses model::ProviderConfig verbatim, so its default must
        // equal the canonical provider default (Anthropic direct, Sonnet-class).
        let provider = ProviderEndpoint::default();
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
    fn record_recent_file_unshifts_dedupes_and_trims() {
        // MRU-first, dedupe on re-open, hard cap at RECENT_FILES_CAP.
        let mut cfg = AppConfig::defaults();
        assert!(cfg.record_recent_file("/a.duck"));
        assert!(cfg.record_recent_file("/b.duck"));
        assert!(cfg.record_recent_file("/a.duck")); // re-open moves to front
        assert_eq!(
            cfg.recent_files,
            vec!["/a.duck".to_string(), "/b.duck".into()]
        );

        // Re-opening the already-front path is a no-op (no spurious write).
        assert!(!cfg.record_recent_file("/a.duck"));

        // Cap: push enough distinct paths to overflow.
        for i in 0..(RECENT_FILES_CAP + 3) {
            cfg.record_recent_file(&format!("/f{i}.duck"));
        }
        assert_eq!(cfg.recent_files.len(), RECENT_FILES_CAP);
        assert_eq!(
            cfg.recent_files[0],
            format!("/f{}.duck", RECENT_FILES_CAP + 2)
        );
    }

    #[test]
    fn record_recent_file_ignores_empty_path() {
        let mut cfg = AppConfig::defaults();
        assert!(!cfg.record_recent_file(""));
        assert!(!cfg.record_recent_file("   "));
        assert!(cfg.recent_files.is_empty());
    }

    #[test]
    fn remove_recent_file_drops_only_the_named_path() {
        // Issue #81 delete-session: the named path leaves the MRU list; siblings
        // stay in order. A missing entry is a no-op (no spurious write).
        let mut cfg = AppConfig::defaults();
        cfg.record_recent_file("/a.duck");
        cfg.record_recent_file("/b.duck");
        cfg.record_recent_file("/c.duck");

        assert!(cfg.remove_recent_file("/b.duck"));
        assert_eq!(
            cfg.recent_files,
            vec!["/c.duck".to_string(), "/a.duck".into()]
        );

        // A path synonym or unknown entry changes nothing -> false (skip write).
        assert!(!cfg.remove_recent_file("/b.duck"));
        assert!(!cfg.remove_recent_file("/never.duck"));
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
        // Empty / whitespace base_url + model must fall back to the canonical
        // defaults so the stored config always hands the provider a valid endpoint.
        let mut cfg = AppConfig::defaults();
        cfg.provider.base_url = "   ".into();
        cfg.provider.model = "".into();
        cfg.normalize();
        assert_eq!(cfg.provider.base_url, DEFAULT_PROVIDER_BASE_URL);
        assert_eq!(cfg.provider.model, DEFAULT_PROVIDER_MODEL);
    }

    #[test]
    fn normalize_keeps_a_set_endpoint_value() {
        // A user-supplied custom endpoint survives normalization (only empties
        // reset to the default).
        let mut cfg = AppConfig::defaults();
        cfg.provider.base_url = "  https://gateway.example.test  ".into();
        cfg.provider.model = "claude-opus-4-8".into();
        cfg.normalize();
        assert_eq!(cfg.provider.base_url, "https://gateway.example.test");
        assert_eq!(cfg.provider.model, "claude-opus-4-8");
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
        // ADR-0054: both collapse levels default EXPANDED (false). The user
        // opts into collapse; first launch and the honest-degrade target both
        // surface the full three-column shell.
        let shell = ShellPrefs::default();
        assert!(!shell.sidebar_collapsed);
        assert!(!shell.rail_collapsed);
    }

    #[test]
    fn shell_prefs_round_trip_collapsed_states() {
        // A user who collapsed both levels reopens with both collapsed.
        let mut cfg = AppConfig::defaults();
        cfg.shell.sidebar_collapsed = true;
        cfg.shell.rail_collapsed = true;
        let json = serde_json::to_string(&cfg).expect("serialize");
        let back: AppConfig = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.shell, cfg.shell);
        assert!(back.shell.sidebar_collapsed);
        assert!(back.shell.rail_collapsed);
    }

    #[test]
    fn shell_field_defaults_when_absent_for_forward_compat() {
        // A pre-#84 app-config file has NO `shell` key. serde(default) on the
        // field + ShellPrefs::default must fill the expanded defaults rather
        // than rejecting the whole document (forward-compat: the user's prior
        // theme / locale / geometry survive an app upgrade).
        let json = r#"{"format_version":1,"theme":"dark"}"#;
        let cfg: AppConfig = serde_json::from_str(json).expect("partial deserialize");
        assert_eq!(cfg.theme, Theme::Dark);
        assert_eq!(cfg.shell, ShellPrefs::default());
        assert!(!cfg.shell.sidebar_collapsed);
        assert!(!cfg.shell.rail_collapsed);
    }

    #[test]
    fn shell_prefs_partial_deserialize_fills_missing_collapse() {
        // A partial `shell` object (one key present, the other absent) must fill
        // the missing collapse from default, not reject. Each field carries its
        // own #[serde(default)], so a future addition to ShellPrefs is also
        // forward-compat at the field level.
        let json = r#"{"format_version":1,"shell":{"sidebar_collapsed":true}}"#;
        let cfg: AppConfig = serde_json::from_str(json).expect("partial shell deserialize");
        assert!(cfg.shell.sidebar_collapsed);
        assert!(!cfg.shell.rail_collapsed); // absent -> default false
    }
}
