import { afterEach, describe, expect, it, vi } from "vitest";

// Issue #814 boot seed seam: the main window's initialization script assigns
// a global BEFORE any frontend script runs; parseBootSeed is the whitelist
// boundary deciding whether that global is trusted, and readBootSeed is the
// thin reader useAppConfigState calls once per mount. Rust serializes typed
// enums, so an invalid variant can only mean the global is not ours -- both
// fields must validate or the whole seed drops (the IPC full config stays
// the only authority; a dropped seed reproduces the pre-#814 null behavior).

import { BOOT_SEED_GLOBAL, parseBootSeed, readBootSeed } from "../bootSeed";

describe("parseBootSeed (whitelist boundary)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts every valid variant pair", () => {
    expect(parseBootSeed({ theme: "dark", locale: "zh-CN" })).toEqual({
      theme: "dark",
      locale: "zh-CN",
    });
    expect(parseBootSeed({ theme: "light", locale: "en-US" })).toEqual({
      theme: "light",
      locale: "en-US",
    });
    expect(parseBootSeed({ theme: "system", locale: "system" })).toEqual({
      theme: "system",
      locale: "system",
    });
  });

  it("drops the whole seed when either field leaves its enum", () => {
    expect(parseBootSeed({ theme: "dark", locale: "klingon" })).toBeNull();
    expect(parseBootSeed({ theme: "DARK", locale: "zh-CN" })).toBeNull();
    expect(parseBootSeed({ theme: 1, locale: "zh-CN" })).toBeNull();
    expect(parseBootSeed({ theme: "dark" })).toBeNull();
    expect(parseBootSeed({ locale: "zh-CN" })).toBeNull();
  });

  it("tolerates unknown extra keys (mirrors the app-config serde read)", () => {
    expect(
      parseBootSeed({ theme: "dark", locale: "zh-CN", extra: "future field" }),
    ).toEqual({ theme: "dark", locale: "zh-CN" });
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

  it("parses the injected global when present", () => {
    vi.stubGlobal(BOOT_SEED_GLOBAL, { theme: "dark", locale: "zh-CN" });
    expect(readBootSeed()).toEqual({ theme: "dark", locale: "zh-CN" });
  });

  it("returns null when the global is absent (script did not run)", () => {
    expect(readBootSeed()).toBeNull();
  });
});
