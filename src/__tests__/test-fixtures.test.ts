import { describe, expect, it } from "vitest";

import { baseAppConfig, skillEntry } from "../test-fixtures";

// The factories are the single source of truth for the wire defaults
// (issue #967) -- these pins hold the baseline and the override precedence
// directly at the seam, the mutation class the consumer suites cannot see
// (their mocks all ride the factory output).
describe("test-fixtures factory contract (issue #967)", () => {
  it("mints a registry row with every wire default", () => {
    expect(skillEntry("pdf-tools")).toEqual({
      name: "pdf-tools",
      description: "pdf-tools skill",
      acquired: "local",
      license: null,
      compatibility: null,
      body: "",
      link_target: null,
      content_hash: "ab".repeat(32),
      enabled: true,
    });
  });

  it("applies skill overrides after the baseline", () => {
    const entry = skillEntry("alpha", {
      acquired: "builtin",
      content_hash: "registry-hash",
    });
    expect(entry.acquired).toBe("builtin");
    expect(entry.content_hash).toBe("registry-hash");
    expect(entry.description).toBe("alpha skill");
  });

  it("mints the app config with every wire default", () => {
    const cfg = baseAppConfig();
    expect(cfg.format_version).toBe(2);
    expect(cfg.default_runtime).toEqual({ kind: "built_in" });
    expect(cfg.disabled_skills).toEqual([]);
    expect(cfg.enabled_agents).toEqual([]);
    expect(cfg.shell).toEqual({
      sidebar_collapsed: false,
      sidebar_grouping: "flat",
    });
  });

  it("applies config overrides after the baseline", () => {
    const cfg = baseAppConfig({
      format_version: 1,
      disabled_skills: ["pdf-tools"],
    });
    expect(cfg.format_version).toBe(1);
    expect(cfg.disabled_skills).toEqual(["pdf-tools"]);
    expect(cfg.theme).toBe("system");
  });
});
