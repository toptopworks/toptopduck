import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  resolveEffective,
  THEME_CHANGE_EVENT,
  useTheme,
} from "../theme/useTheme";
import type { Theme } from "../types/app-config";

// jsdom ships no matchMedia. Install a controllable stub so the system-mode
// tests can script the OS preference and its change events. Returns a handle to
// flip the matches value the hook reads.
function installMatchMedia(matches: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (_type: string, listener: (e: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (e: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    addListener: () => {},
    removeListener: () => {},
  };
  vi.stubGlobal("matchMedia", () => mql);
  return {
    // A real MediaQueryList updates .matches before dispatching the change
    // event; the hook reads mq.matches in its listener, so keep them in sync.
    dispatch(nextMatches: boolean) {
      mql.matches = nextMatches;
      const event = { matches: nextMatches } as MediaQueryListEvent;
      for (const l of listeners) l(event);
    },
  };
}

describe("resolveEffective", () => {
  // Without matchMedia, system resolves to light (the safe default) rather than
  // throwing -- the hook must never crash a render over theme resolution.
  beforeEach(() => vi.stubGlobal("matchMedia", undefined));

  it("maps light/dark preferences to themselves", () => {
    expect(resolveEffective("light")).toBe("light");
    expect(resolveEffective("dark")).toBe("dark");
  });

  it("resolves system to dark when the OS prefers dark", () => {
    expect(resolveEffective("system", true)).toBe("dark");
  });

  it("resolves system to light when the OS prefers light", () => {
    expect(resolveEffective("system", false)).toBe("light");
  });
});

describe("useTheme (ADR-0050 three-state)", () => {
  beforeEach(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies the .dark class + color-scheme for a dark preference", () => {
    installMatchMedia(false);
    renderHook(() => useTheme("dark"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("clears the .dark class for a light preference", () => {
    installMatchMedia(false);
    renderHook(() => useTheme("light"));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("follows the OS preference when set to system (default, ADR-0050)", () => {
    installMatchMedia(true); // OS dark
    renderHook(() => useTheme("system"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("re-applies when the OS preference flips while in system mode", () => {
    const media = installMatchMedia(false); // OS light at mount
    renderHook(() => useTheme("system"));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    // The state update fires from outside React's event handler; act() flushes
    // the scheduled re-render + the applyTheme effect synchronously.
    act(() => {
      media.dispatch(true); // OS flips to dark
    });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("re-applies when the user preference changes (Settings toggle)", () => {
    installMatchMedia(false);
    const { rerender } = renderHook(({ p }: { p: Theme }) => useTheme(p), {
      initialProps: { p: "light" as Theme },
    });
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    rerender({ p: "dark" });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("dispatches a theme-change event the Vega bridge can subscribe to", () => {
    installMatchMedia(false);
    const seen: string[] = [];
    const handler = (e: Event) => {
      seen.push((e as CustomEvent<{ effective: string }>).detail.effective);
    };
    window.addEventListener(THEME_CHANGE_EVENT, handler);
    const { rerender, unmount } = renderHook(({ p }: { p: Theme }) => useTheme(p), {
      initialProps: { p: "light" as Theme },
    });
    rerender({ p: "dark" });
    unmount();
    window.removeEventListener(THEME_CHANGE_EVENT, handler);
    expect(seen).toContain("dark");
  });

  it("ignores OS flips while in an explicit (non-system) preference", () => {
    const media = installMatchMedia(false); // OS light at mount
    renderHook(() => useTheme("light"));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    // OS flips to dark -- explicit light must NOT follow it.
    act(() => {
      media.dispatch(true);
    });
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("drops the OS listener on unmount (no re-apply after unmount)", () => {
    const media = installMatchMedia(false);
    const seen: string[] = [];
    const handler = (e: Event) => {
      seen.push((e as CustomEvent<{ effective: string }>).detail.effective);
    };
    window.addEventListener(THEME_CHANGE_EVENT, handler);
    const { unmount } = renderHook(() => useTheme("system"));
    // Mount dispatches once for the initial effective (light).
    expect(seen).toEqual(["light"]);
    unmount();
    act(() => {
      media.dispatch(true); // OS flips after unmount
    });
    window.removeEventListener(THEME_CHANGE_EVENT, handler);
    // No further event after unmount -- the matchMedia listener was cleaned up.
    expect(seen).toEqual(["light"]);
  });
});
