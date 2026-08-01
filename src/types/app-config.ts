// App-level config types split from the single-file src/types.ts (issue #197,
// ADR-0038). The second at-rest artifact (alongside .duck): preferences,
// defaults, recent files, and the no-key endpoint config. Mirrors the Rust
// `app_config::model` types verbatim. The API key NEVER appears here -- it
// lives in the OS keychain; app-config has no key field at all (enforced
// structurally + a read-time secret scan). Crosses IPC via get/set_app_config.
// Window geometry is owned by tauri_plugin_window_state (issue #268), not
// app-config.

import type { ProviderConfig } from "./provider";

// UI theme preference (ADR-0050). Crosses IPC as the bare lowercase variant.
export type Theme = "system" | "light" | "dark";

// UI response-locale preference (ADR-0052, issue #78). Three-state, mirroring
// Theme: "system" defers to the OS language, "zh-CN" / "en-US" are explicit
// overrides. Crosses IPC as the BCP-47-shaped string the IntlProvider keys on.
// The Rust side resolves "system" independently (locale never crosses IPC from
// the frontend) for the canonical-prompt locale directive.
export type LocalePreference = "system" | "zh-CN" | "en-US";

// Engine default parameters (ADR-0005 L3). Stored + round-tripped here;
// applying them to the live DuckDB is a follow-up slice.
export interface EngineDefaults {
  // DuckDB memory limit string (e.g. "512MB").
  memory_limit: string;
  threads: number;
  // Ceiling on a materialized result's row count.
  row_cap: number;
  // Per-statement timeout in milliseconds.
  statement_timeout_ms: number;
}

// Default-for-new-datasets privacy knob (ADR-0011). Per-dataset overrides still
// ride each descriptor; this is only the starting switch.
export interface PrivacyDefaults {
  send_samples: boolean;
}

// Export starting directory + default format (ADR-0004/0015). last_dir is a path
// POINTER (not user-data content).
export interface ExportDefaults {
  last_dir: string | null;
  default_format: string;
}

// Tunable defaults (ADR-0013/0023/0028). Stored + round-tripped here; applying
// them to the live orchestrator is a follow-up slice. The per-turn retry
// budget was retired with the single-SQL contract (ADR-0077, issue #318); a
// stale `retry_budget` key in an older config file is ignored at parse.
export interface Tunables {
  window_turns: number;
  far_window: number;
}

// Session sidebar grouping mode (ADR-0072, issue #251). `flat` renders every
// session in a single "Recent" group sorted by mtime descending; `time`
// preserves the ADR-0060 Chat-style Today/Yesterday/Previous 7 days/Older
// buckets. The variant names avoid `recent` to stay clear of the
// `recent_files` MRU-list sense (ADR-0072). Mirrors the Rust `SidebarGrouping`;
// crosses IPC as the bare lowercase variant name.
export type SidebarGrouping = "flat" | "time";

// Shell collapse preferences (ADR-0054, issue #84). The two MANUAL collapse
// levels that are UI state (not the third -- Tauri minWidth/minHeight, a native
// window config not a preference): session sidebar + thread rail. Both default
// expanded; both persist via app-config (ADR-0038) and stack independently.
// `sidebar_grouping` (ADR-0072, issue #251) extends the same shell-chrome
// surface: the sidebar's flat/time render mode persists + restores with the two
// collapse prefs. Mirrors the Rust `ShellPrefs`.
export interface ShellPrefs {
  sidebar_collapsed: boolean;
  rail_collapsed: boolean;
  sidebar_grouping: SidebarGrouping;
}

// The full app-config document. Lives in the OS app-data directory; all
// non-secret, so it crosses IPC verbatim (no separate "view" type).
export interface AppConfig {
  format_version: number;
  theme: Theme;
  locale: LocalePreference;
  engine: EngineDefaults;
  privacy: PrivacyDefaults;
  provider: ProviderConfig;
  export: ExportDefaults;
  tunables: Tunables;
  // Recently-opened .duck paths, most-recent first. Capped server-side.
  recent_files: string[];
  // Shell collapse preferences (ADR-0054, issue #84).
  shell: ShellPrefs;
}
