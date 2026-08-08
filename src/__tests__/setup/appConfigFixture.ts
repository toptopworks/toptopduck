import type { AppConfig } from "../../types/app-config";

// Shared AppConfig fixture for lazy-fallback contract tests.
// Used by SessionPaneLazy.test.tsx and SettingsLazy.test.tsx so both
// stay in sync when AppConfig gains a field.
export const defaultAppConfig: AppConfig = {
  format_version: 2,
  theme: "system",
  locale: "zh-CN",
  engine: { memory_limit: "512MB", threads: 1, row_cap: 100, statement_timeout_ms: 30000 },
  privacy: { send_samples: true },
  provider: {
    profiles: [
      {
        id: "default",
        display_name: "Anthropic",
        protocol: "anthropic",
        base_url: "https://api.anthropic.com",
        model: "claude-sonnet-4-6",
      },
    ],
    active_profile: "default",
  },
  export: { last_dir: null, default_format: "csv" },
  tunables: { window_turns: 6, far_window: 12 },
  recent_files: [],
  shell: { sidebar_collapsed: false, rail_collapsed: false, sidebar_grouping: "flat" },
  mcp_servers: { servers: [] },
};
