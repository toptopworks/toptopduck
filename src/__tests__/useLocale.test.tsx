import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  coerceLocalePreference,
  isLocalePreference,
  resolveEffectiveLocale,
  resolveLocaleTag,
  useLocale,
} from "../i18n/useLocale";

// useLocale + locale-resolution tests (ADR-0052, issue #78). Mirrors the
// useTheme test shape: pure-function coverage (resolveEffectiveLocale /
// resolveLocaleTag) + hook coverage (system follows OS, override wins, live
// OS flip is followed). The "system -> OS -> fallback" mapping is ADR-0052.

describe("resolveLocaleTag (ADR-0052 mapping)", () => {
  it("maps zh* tags to zh-CN and en* tags to en-US", () => {
    // Cross-language parity with resolve_locale_from_tag (prompt.rs): the case
    // set MUST stay aligned so a resolve-rule change on one side breaks the
    // other side's test. The Rust &str signature has no undefined, so the
    // frontend's undefined case (below) maps to the empty-string case there.
    expect(resolveLocaleTag("zh-CN")).toBe("zh-CN");
    expect(resolveLocaleTag("zh-TW")).toBe("zh-CN");
    expect(resolveLocaleTag("zh")).toBe("zh-CN");
    expect(resolveLocaleTag("en-US")).toBe("en-US");
    expect(resolveLocaleTag("en_GB.UTF-8")).toBe("en-US");
    expect(resolveLocaleTag("en")).toBe("en-US");
  });

  it("falls back to en-US for unknown or empty tags", () => {
    expect(resolveLocaleTag("de-DE")).toBe("en-US");
    expect(resolveLocaleTag("ja-JP")).toBe("en-US");
    expect(resolveLocaleTag("")).toBe("en-US");
    expect(resolveLocaleTag(undefined)).toBe("en-US");
  });
});

describe("resolveEffectiveLocale (three-state)", () => {
  it("maps explicit preferences to themselves", () => {
    expect(resolveEffectiveLocale("zh-CN")).toBe("zh-CN");
    expect(resolveEffectiveLocale("en-US")).toBe("en-US");
  });

  it("resolves system to zh-CN when the OS language is zh*", () => {
    expect(resolveEffectiveLocale("system", "zh-CN")).toBe("zh-CN");
    expect(resolveEffectiveLocale("system", "zh-Hans")).toBe("zh-CN");
  });

  it("resolves system to en-US when the OS language is en* or unknown", () => {
    expect(resolveEffectiveLocale("system", "en-US")).toBe("en-US");
    expect(resolveEffectiveLocale("system", "de-DE")).toBe("en-US");
    expect(resolveEffectiveLocale("system", undefined)).toBe("en-US");
  });
});

describe("coerceLocalePreference (IPC boundary guard)", () => {
  it("passes known wire values through", () => {
    expect(coerceLocalePreference("system")).toBe("system");
    expect(coerceLocalePreference("zh-CN")).toBe("zh-CN");
    expect(coerceLocalePreference("en-US")).toBe("en-US");
  });

  it("degrades corrupt / foreign values to the system default", () => {
    // ADR-0052: persisted value corrupt/unknown -> system (then OS -> fallback),
    // never crash. Guards a hand-edited app-config or a foreign-locale stale file.
    expect(coerceLocalePreference(undefined)).toBe("system");
    expect(coerceLocalePreference("zh")).toBe("system");
    expect(coerceLocalePreference("en_US")).toBe("system");
    expect(coerceLocalePreference("fr-FR")).toBe("system");
    expect(coerceLocalePreference(42)).toBe("system");
  });

  it("isLocalePreference narrows correctly", () => {
    expect(isLocalePreference("system")).toBe(true);
    expect(isLocalePreference("zh-CN")).toBe(true);
    expect(isLocalePreference("en-US")).toBe(true);
    expect(isLocalePreference("zh")).toBe(false);
    expect(isLocalePreference(null)).toBe(false);
  });
});

describe("useLocale (ADR-0052 three-state hook)", () => {
  // Stub navigator.language so the "system" branch is deterministic; jsdom
  // defaults to en-US but the test must not depend on the host.
  function installNavigatorLanguage(lang: string | undefined) {
    if (lang === undefined) {
      vi.stubGlobal("navigator", undefined);
    } else {
      // jsdom's navigator is non-configurable in some versions; redefine via a
      // plain object stub (useLocale only reads navigator.language).
      vi.stubGlobal("navigator", { language: lang });
    }
  }

  beforeEach(() => {
    installNavigatorLanguage("en-US");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the explicit preference for zh-CN / en-US", () => {
    installNavigatorLanguage("zh-CN"); // OS zh, but explicit overrides win
    const { result, rerender } = renderHook(({ p }: { p: "zh-CN" | "en-US" }) => useLocale(p), {
      initialProps: { p: "zh-CN" },
    });
    expect(result.current).toBe("zh-CN");
    rerender({ p: "en-US" });
    expect(result.current).toBe("en-US");
  });

  it("follows the OS language when set to system (default, ADR-0052)", () => {
    installNavigatorLanguage("zh-CN"); // OS zh
    const { result } = renderHook(() => useLocale("system"));
    expect(result.current).toBe("zh-CN");
  });

  it("falls back to en-US when the OS language is unsupported", () => {
    installNavigatorLanguage("de-DE"); // unsupported -> en-US fallback
    const { result } = renderHook(() => useLocale("system"));
    expect(result.current).toBe("en-US");
  });

  it("falls back to en-US when navigator is absent (never crash)", () => {
    installNavigatorLanguage(undefined);
    const { result } = renderHook(() => useLocale("system"));
    expect(result.current).toBe("en-US");
  });

  it("re-applies when the OS language flips while in system mode", () => {
    // jsdom does not emit a real `languagechange` event; the hook's listener is
    // exercised via a manual dispatch (mirrors the useTheme matchMedia stub).
    installNavigatorLanguage("en-US");
    const { result } = renderHook(() => useLocale("system"));
    expect(result.current).toBe("en-US");
    act(() => {
      // Flip the navigator language + dispatch the event the hook listens for.
      vi.stubGlobal("navigator", { language: "zh-CN" });
      window.dispatchEvent(new Event("languagechange"));
    });
    expect(result.current).toBe("zh-CN");
  });
});
