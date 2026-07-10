import { describe, expect, it, vi } from "vitest";
import {
  buildVegaTheme,
  CATEGORY_PALETTE,
  onThemeChange,
  primaryColor,
} from "../theme/vega-theme";
import { THEME_CHANGE_EVENT } from "../theme/useTheme";

// A fake CssVarReader: returns the value for a known token, "" for unset. Mirrors
// getComputedStyle, which yields "" for an undefined custom property.
function reader(map: Record<string, string>): (name: string) => string {
  return (name) => map[name] ?? "";
}

describe("buildVegaTheme (ADR-0050 Q12 Vega bridge)", () => {
  it("derives background/text/domain/grid from the shadcn tokens", () => {
    const cfg = buildVegaTheme(
      reader({
        "--background": "#ffffff",
        "--foreground": "#1a1a1a",
        "--border": "#e3e3e8",
        "--muted": "#f0f0f3",
        "--primary": "#0d9488",
      }),
    );
    expect(cfg.background).toBe("#ffffff");
    expect(cfg.text).toBe("#1a1a1a");
    expect(cfg.domain).toBe("#e3e3e8");
    expect(cfg.grid).toBe("#f0f0f3");
  });

  it("uses teal --primary as the single-series mark color", () => {
    const cfg = buildVegaTheme(reader({ "--primary": "#0d9488" }));
    expect(cfg.primary).toBe("#0d9488");
  });

  it("falls back to literal teal when --primary is unset", () => {
    expect(primaryColor(reader({}))).toBe("#0d9488");
  });

  it("uses the Okabe-Ito category palette for multi-series marks", () => {
    const cfg = buildVegaTheme(reader({}));
    expect(cfg.category).toBe(CATEGORY_PALETTE);
    // A recognized accessible multi-series palette (ADR-0050 defers a bespoke
    // brand ramp to v2); assert the shape, not an exact color list.
    expect(cfg.category.length).toBeGreaterThanOrEqual(7);
  });

  it("falls back to safe light defaults when no tokens are set", () => {
    const cfg = buildVegaTheme(reader({}));
    expect(cfg.background).toBe("#ffffff");
    expect(cfg.text).toBe("#1a1a1a");
    expect(cfg.domain).toBe("#e3e3e8");
    expect(cfg.grid).toBe("#f0f0f3");
  });

  it("warns in dev when a token is unset on the live document (drift signal)", () => {
    // The default reader hits getComputedStyle on the real (jsdom, token-empty)
    // root, so every fallback triggers. A token rename/typo in app.css surfaces
    // here as a dev warning rather than a silent wrong-palette chart.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    buildVegaTheme();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("--primary"));
    warn.mockRestore();
  });
});

describe("onThemeChange", () => {
  it("calls back with the effective theme on a theme-change event", () => {
    const cb = vi.fn();
    const off = onThemeChange(cb);
    window.dispatchEvent(
      new CustomEvent(THEME_CHANGE_EVENT, { detail: { effective: "dark" } }),
    );
    expect(cb).toHaveBeenCalledWith("dark");
    off();
  });

  it("stops calling back after unsubscribe", () => {
    const cb = vi.fn();
    onThemeChange(cb)();
    window.dispatchEvent(
      new CustomEvent(THEME_CHANGE_EVENT, { detail: { effective: "light" } }),
    );
    expect(cb).not.toHaveBeenCalled();
  });

  it("ignores a malformed theme-change event (no crash, no callback)", () => {
    const cb = vi.fn();
    const off = onThemeChange(cb);
    // Foreign/malformed events with the same name but missing detail.effective.
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: {} }));
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
    expect(cb).not.toHaveBeenCalled();
    off();
  });
});
