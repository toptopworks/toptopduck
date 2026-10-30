import { afterEach, describe, expect, it, vi } from "vitest";

// Issue #814 boot seed seam: the main window's initialization script assigns
// a global BEFORE any frontend script runs; parseBootSeed is the whitelist
// boundary deciding whether that global is trusted, and readBootSeed is the
// thin reader useAppConfigState calls once per mount. Rust serializes typed
// enums, so an invalid variant can only mean the global is not ours -- every
// seeded field must validate or the whole seed drops (the IPC full config
// stays the only authority; a dropped seed reproduces the pre-#814 null
// behavior).

import { BOOT_SEED_GLOBAL, parseBootSeed, readBootSeed } from "../bootSeed";

describe("parseBootSeed (whitelist boundary)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts every valid variant pair", () => {
    expect(
      parseBootSeed({ theme: "dark", locale: "zh-CN", sidebar_collapsed: true }),
    ).toEqual({ theme: "dark", locale: "zh-CN", sidebar_collapsed: true });
    expect(
      parseBootSeed({ theme: "light", locale: "en-US", sidebar_collapsed: false }),
    ).toEqual({ theme: "light", locale: "en-US", sidebar_collapsed: false });
    expect(
      parseBootSeed({ theme: "system", locale: "system", sidebar_collapsed: false }),
    ).toEqual({ theme: "system", locale: "system", sidebar_collapsed: false });
  });

  it("drops the whole seed when any seeded field fails its whitelist", () => {
    expect(
      parseBootSeed({ theme: "dark", locale: "klingon", sidebar_collapsed: false }),
    ).toBeNull();
    expect(
      parseBootSeed({ theme: "DARK", locale: "zh-CN", sidebar_collapsed: false }),
    ).toBeNull();
    expect(
      parseBootSeed({ theme: 1, locale: "zh-CN", sidebar_collapsed: false }),
    ).toBeNull();
    expect(
      parseBootSeed({ theme: "dark", locale: "zh-CN", sidebar_collapsed: "no" }),
    ).toBeNull();
    expect(
      parseBootSeed({ theme: "dark", locale: "zh-CN" }),
    ).toBeNull();
  });

  it("tolerates unknown extra keys (mirrors the app-config serde read)", () => {
    expect(
      parseBootSeed({
        theme: "dark",
        locale: "zh-CN",
        sidebar_collapsed: false,
        extra: "future field",
      }),
    ).toEqual({ theme: "dark", locale: "zh-CN", sidebar_collapsed: false });
  });

  it("rejects non-object shapes", () => {
    expect(parseBootSeed(undefined)).toBeNull();
    expect(parseBootSeed(null)).toBeNull();
    expect(parseBootSeed("dark")).toBeNull();
    expect(parseBootSeed(42)).toBeNull();
    expect(parseBootSeed(["dark", "zh-CN"])).toBeNull();
  });
});

describe("readBootSeed", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pins the global name the Rust writer assigns", () => {
    // The Rust side pins this literal byte-for-byte in boot_seed.rs; this
    // is the TS half of the cross-language agreement -- a one-sided rename
    // here would silently disable first-paint seeding with every gate green.
    expect(BOOT_SEED_GLOBAL).toBe("__TOPTOPDUCK_BOOT_SEED__");
  });

  it("parses the injected global when present", () => {
    vi.stubGlobal(BOOT_SEED_GLOBAL, {
      theme: "dark",
      locale: "zh-CN",
      sidebar_collapsed: true,
    });
    expect(readBootSeed()).toEqual({
      theme: "dark",
      locale: "zh-CN",
      sidebar_collapsed: true,
    });
  });

  it("returns null when the global is absent (script did not run)", () => {
    expect(readBootSeed()).toBeNull();
  });
});
