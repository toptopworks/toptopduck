// Shared test fixtures for the IPC wire types (issue #967). Every hand-rolled
// full literal was migrated here: the next schema field lands as one factory
// edit for every typed call site instead of another sweep across the test
// tree (the tax already paid for content_hash #381, enabled_agents #932,
// enabled + disabled_skills #966). Per-test variants go through the
// `overrides` parameter (spread AFTER the baseline). The two vi.mock-hoisted
// config literals (App.i18n / App.theme) cannot import this module and stay
// hand-rolled there; the CliSection / McpSection cast partials also remain,
// tracked as follow-up.
import type { AppConfig } from "./types/app-config";
import type { SkillEntry } from "./types/skills";

// The default SkillEntry: a minimal-but-real registry row (all required wire
// fields, only the name varying) as the composer / settings / shell tests
// mint it. `overrides` carries the per-test variants (acquired, link_target,
// content_hash, ...) so each test states only what it actually exercises.
export function skillEntry(name: string, overrides?: Partial<SkillEntry>): SkillEntry {
  return {
    name,
    description: `${name} skill`,
    acquired: "local",
    license: null,
    compatibility: null,
    body: "",
    link_target: null,
    content_hash: "ab".repeat(32),
    enabled: true,
    ...overrides,
  };
}

// The default AppConfig: an empty-registry, built-in-runtime document with
// the engine/tunable values most tests treat as just-shape noise. Overrides
// (spread AFTER the baseline) carry the per-file deltas (format_version 1, a
// non-flat grouping, ...) and the fields a test actually exercises.
export function baseAppConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    format_version: 2,
    theme: "system",
    locale: "system",
    engine: { memory_limit: "512MB", threads: 1, row_cap: 100 },
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
    shell: { sidebar_collapsed: false, sidebar_grouping: "flat" },
    mcp_servers: { servers: [] },
    cli_tools: { tools: [] },
    builtin_skill_baselines: {},
    sessions_dir: null,
    default_runtime: { kind: "built_in" },
    last_model_postures: {},
    enabled_agents: [],
    materialized_builtin_agents: [],
    disabled_skills: [],
    ...overrides,
  };
}
