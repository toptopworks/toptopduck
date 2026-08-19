// App-level config types split from the single-file src/types.ts (issue #197,
// ADR-0038). The second at-rest artifact (alongside .duck): preferences,
// defaults, and the no-key endpoint config. Mirrors the Rust
// `app_config::model` types verbatim. The API key NEVER appears here -- it
// lives in the OS keychain; app-config has no key field at all (enforced
// structurally + a read-time secret scan). Crosses IPC via get/set_app_config.
// Window geometry is owned by tauri_plugin_window_state (issue #268), not
// app-config.

import type { McpServerRegistry } from "./mcp";
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
// buckets. The variant names avoid `recent` to stay clear of the MRU-list
// sense (ADR-0072). Mirrors the Rust `SidebarGrouping`;
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
  sidebar_grouping: SidebarGrouping;
}

// The default runtime new sessions + resumes start on (ADR-0098 Decision 2,
// issue #569). A machine-level preference like the active provider profile,
// NOT a last-used hint. Mirrors the Rust `DefaultRuntime` -- a type distinct
// from `SessionRuntimeChoice`, mirroring the config-vs-session domain split
// on the Rust side; the two wire shapes are pinned identical in
// tests/ipc_contract.rs so the unions cannot drift. An `external` id the
// backend does not currently detect still persists -- startup RESOLUTION
// degrades to built-in per-startup without rewriting the field
// (ADR-0098 Decision 3).
export type DefaultRuntime = { kind: "built_in" } | { kind: "external"; data: string };

// One adapter's last-selected model posture (ADR-0100, issue #581): the
// startup model + thought-level a NEW session on that adapter starts with --
// selected + injected, not a display-only hint. Both null = the explicit
// cleared form (or never chosen): the "default (recommended)" unselected
// start. Mirrors the Rust `ModelPosture`.
export interface ModelPosture {
  // The model id exactly as the picker set it (adapter-namespaced, never
  // validated against the live catalog at rest -- dangling entries are kept).
  model: string | null;
  // The thought-level id exactly as the picker set it.
  thought_level: string | null;
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
  // Shell collapse preferences (ADR-0054, issue #84).
  shell: ShellPrefs;
  // User-configured external MCP servers (issue #301, ADR-0076). Secret env
  // values live in the OS keychain, never here (ADR-0029/0036). serde(default)
  // fills an empty registry for a pre-#301 file, but serialization ALWAYS
  // carries the field, so the wire shape is non-optional here too.
  mcp_servers: McpServerRegistry;
  // Managed sessions directory override (issue #452, ADR-0089 Decision 2).
  // null = runtime-computed default (<Documents>/toptopduck/sessions/).
  // serde(default) fills null for a pre-#452 file.
  sessions_dir: string | null;
  // The default runtime new sessions + resumes start on (ADR-0098 Decision 2,
  // issue #569). serde(default) fills built_in for a pre-#569 file.
  default_runtime: DefaultRuntime;
  // Per-adapter last-selected model postures (ADR-0100, issue #581), keyed by
  // adapter id. serde(default) fills an empty map for a pre-#581 file, but
  // serialization ALWAYS carries the field, so the wire shape is non-optional
  // here too. Dangling entries (adapter undetected / model gone from the
  // catalog) are kept -- they re-enable automatically on re-detection
  // (ADR-0100 Decision 4).
  last_model_postures: Record<string, ModelPosture>;
}
