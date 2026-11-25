import { describe, expect, it } from "vitest";

import {
  deriveDimensionRows,
  derivePostureDirectory,
  type DimensionRowReads,
  type PostureCatalog,
} from "../posture-directory";
import type { BuiltinCatalogModel, CatalogModel } from "../../../types/runtime";

// posture-directory tests: the cascade menu's display decisions as pure
// projections. Each pin carries one ruling the mounted suite used to pay
// the full-tree tax for -- the recent fixes (#1639/#1645/#1648) all landed
// on these blocks.

const catalogModel = (
  id: string,
  efforts: string[] = ["low", "high"],
  isDefault = false,
): CatalogModel => ({
  id,
  display_name: id,
  is_default: isDefault,
  default_reasoning_effort: efforts[0] ?? "",
  supported_reasoning_efforts: efforts,
});

const builtinModel = (id: string, tiers: string[] = []): BuiltinCatalogModel => ({
  id,
  display_name: id,
  supported_reasoning_efforts: tiers,
});

describe("derivePostureDirectory", () => {
  it("normalizes the acp arm: lists and currents pass through, the held chain prefers the explicit selection", () => {
    const acp: PostureCatalog = {
      kind: "acp",
      models: ["m-1", "m-2"],
      thoughtLevels: ["low", "high"],
      currentModel: "m-1",
      currentThoughtLevel: "low",
    };
    expect(derivePostureDirectory({ catalog: acp, model: null, thoughtLevel: null })).toEqual({
      isBuiltin: false,
      modelIds: ["m-1", "m-2"],
      currentModel: "m-1",
      levelIds: ["low", "high"],
      currentLevel: "low",
      levelUnavailable: false,
      heldModel: "m-1",
      heldLevel: "low",
      builtinLoading: undefined,
    });
    expect(derivePostureDirectory({ catalog: acp, model: "m-2", thoughtLevel: "high" })).toMatchObject({
      heldModel: "m-2",
      heldLevel: "high",
    });
  });

  it("normalizes the builtin arm: the pinned model is the current, tiers seat the strength list, availability rides held tiers", () => {
    const catalog: PostureCatalog = {
      kind: "builtin",
      models: [builtinModel("tiered", ["low", "high"]), builtinModel("toggle-only")],
      profileModel: "tiered",
    };
    expect(derivePostureDirectory({ catalog, model: null, thoughtLevel: null })).toMatchObject({
      isBuiltin: true,
      modelIds: ["tiered", "toggle-only"],
      currentModel: "tiered",
      currentLevel: null,
      levelIds: ["low", "high"],
      levelUnavailable: false,
      heldModel: "tiered",
    });
    // A held model without discrete tiers reads unavailable -- the permanent
    // seat's disabled hint (issue #1648 feedback).
    const toggleOnly = derivePostureDirectory({
      catalog: { ...catalog, profileModel: "toggle-only" },
      model: null,
      thoughtLevel: null,
    });
    expect(toggleOnly).toMatchObject({ levelIds: [], levelUnavailable: true });
    // A held level (explicit selection) never reads unavailable (issue #529).
    const heldLevel = derivePostureDirectory({
      catalog: { ...catalog, profileModel: "toggle-only" },
      model: null,
      thoughtLevel: "medium",
    });
    expect(heldLevel).toMatchObject({ levelUnavailable: false, heldLevel: "medium" });
  });

  it("keeps the builtin strength row seated while the probe is in flight", () => {
    const catalog: PostureCatalog = {
      kind: "builtin",
      models: [builtinModel("toggle-only")],
      profileModel: "toggle-only",
      loading: true,
    };
    expect(derivePostureDirectory({ catalog, model: null, thoughtLevel: null })).toMatchObject({
      isBuiltin: true,
      levelUnavailable: false,
      builtinLoading: true,
    });
  });

  it("normalizes the perModel arm: strength rides the held model, unavailable only with no held id", () => {
    const catalog: PostureCatalog = {
      kind: "perModel",
      models: [
        catalogModel("gpt-5", ["low", "medium", "high"], true),
        catalogModel("gpt-5-codex", ["low"]),
      ],
    };
    // Nothing selected: the flagged default is the held model, its efforts
    // seat the list, its declared default is the current level (issue #1648).
    expect(derivePostureDirectory({ catalog, model: null, thoughtLevel: null })).toMatchObject({
      modelIds: ["gpt-5", "gpt-5-codex"],
      currentModel: "gpt-5",
      currentLevel: "low",
      levelIds: ["low", "medium", "high"],
      levelUnavailable: false,
      heldModel: "gpt-5",
    });
    // An explicit pick outside the directory stays held: enabled, empty list.
    expect(derivePostureDirectory({ catalog, model: "claude-x", thoughtLevel: null })).toMatchObject({
      levelIds: [],
      levelUnavailable: false,
      heldModel: "claude-x",
    });
    // Empty directory: no held id is knowable -- the pick-a-model case.
    expect(
      derivePostureDirectory({ catalog: { kind: "perModel", models: [] }, model: null, thoughtLevel: null }),
    ).toMatchObject({ currentModel: null, levelUnavailable: true, heldModel: null });
    // No flagged default: the current is null, but an explicit pick still
    // holds the row open -- unavailable reads the held id, not the current.
    const noDefault = derivePostureDirectory({
      catalog: { kind: "perModel", models: [catalogModel("solo", ["low"], false)] },
      model: "solo",
      thoughtLevel: null,
    });
    expect(noDefault).toMatchObject({ currentModel: null, levelUnavailable: false });
  });
});

describe("deriveDimensionRows", () => {
  it("filters rows by id substring, case-insensitively; a blank query is the full list", () => {
    const ids = ["claude-sonnet-4-5", "gpt-5.1", "custom-deploy-7"];
    expect(deriveDimensionRows({ ids, displayValue: null, query: "" }).filteredIds).toEqual(ids);
    // A whitespace-only query reads as blank (issue #1645).
    expect(deriveDimensionRows({ ids, displayValue: null, query: "  " }).filteredIds).toEqual(ids);
    expect(
      deriveDimensionRows({ ids, displayValue: null, query: "CLAUDE-SONNET" }).filteredIds,
    ).toEqual(["claude-sonnet-4-5"]);
    // The display-name half no longer matches: ids only (issue #1648).
    expect(deriveDimensionRows({ ids, displayValue: null, query: "Sonnet 4.5" }).filteredIds).toEqual([]);
  });

  it("gates the no-match line on searchable, settled, non-blank query, non-empty directory, and zero matches", () => {
    const rows = (overrides: Partial<DimensionRowReads> = {}) =>
      deriveDimensionRows({
        ids: ["m-1"],
        displayValue: null,
        query: "zzz",
        searchable: true,
        ...overrides,
      });
    expect(rows().showNoMatch).toBe(true);
    expect(rows({ searchable: false }).showNoMatch).toBe(false);
    expect(rows({ loading: true }).showNoMatch).toBe(false);
    expect(rows({ query: "" }).showNoMatch).toBe(false);
    // An empty directory is the probe's settled fallback, not a filter miss
    // (issue #1648 review).
    expect(rows({ ids: [] }).showNoMatch).toBe(false);
    expect(rows({ query: "m" }).showNoMatch).toBe(false);
  });

  it("derives the synthetic row from a held id outside the directory, with the runtime note off the builtin model dimension", () => {
    const rows = (overrides: Partial<DimensionRowReads> = {}) =>
      deriveDimensionRows({
        ids: ["m-1"],
        displayValue: "held-x",
        query: "",
        ...overrides,
      });
    expect(rows().unrepresentedId).toBe("held-x");
    expect(rows().note).toBe("runtime");
    // In-directory, null, and empty displays seat no synthetic row.
    expect(rows({ displayValue: "m-1" }).unrepresentedId).toBeNull();
    expect(rows({ displayValue: null }).unrepresentedId).toBeNull();
    expect(rows({ displayValue: "" }).unrepresentedId).toBeNull();
    // The built-in runtime has no CLI to "not offer" anything: bare name.
    expect(rows({ isBuiltinModel: true }).note).toBeUndefined();
  });
});
