import { describe, expect, it } from "vitest";
import zhCN from "../../locales/zh-CN.json";
import enUS from "../../locales/en-US.json";

// Catalog key alignment (ADR-0052, issue #78 AC). The two catalogs MUST carry
// the same key set so no <FormattedMessage> renders a missing-translation
// fallback in either locale. This is the fast in-process guard (runs in `npm
// test`); scripts/check-i18n.mjs adds the source-coverage half in CI (it scans
// the JSX via @formatjs/cli, which a vitest test cannot do).

describe("i18n catalog alignment (ADR-0052)", () => {
  it("zh-CN and en-US carry identical key sets", () => {
    const zhKeys = Object.keys(zhCN).sort();
    const enKeys = Object.keys(enUS).sort();
    expect(enKeys).toEqual(zhKeys);
  });

  it("no catalog key maps to an empty translation", () => {
    // An empty-string translation would render as blank chrome -- a missing
    // translation in disguise. Both catalogs must have non-empty values.
    for (const [key, value] of Object.entries(enUS)) {
      expect(value, `en-US "${key}" is empty`).toBeTruthy();
    }
    for (const [key, value] of Object.entries(zhCN)) {
      expect(value, `zh-CN "${key}" is empty`).toBeTruthy();
    }
  });

  it("the canonical showcase key is present in both catalogs", () => {
    // A smoke check that the Settings dialog + header chrome keys exist -- guards
    // against an accidental rename that the CI extract guard would also catch.
    expect(zhCN["settings.title"]).toBe("应用设置");
    expect(enUS["settings.title"]).toBe("App Settings");
    expect(zhCN["header.settings"]).toBeDefined();
    expect(enUS["header.settings"]).toBeDefined();
  });
});
