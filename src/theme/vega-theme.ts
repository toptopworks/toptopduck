import { THEME_CHANGE_EVENT } from "./useTheme";
import { log } from "../lib/log";
import type { EffectiveTheme, ThemeChangeDetail } from "./useTheme";

// Vega-Lite theme bridge (ADR-0050 Q12). The chart palette is derived at runtime
// from the same shadcn CSS tokens the app shell uses, so the chart never drifts
// from the app and flips with the .dark class automatically. The single source
// of truth is the token set in app.css; this util only reads + reshapes it into
// a Vega config. Not wired yet: the future Vega renderer (deferred past issue
// #77) will call buildVegaTheme on mount and re-call it on each theme-change
// event via onThemeChange. This slice ships the util + tokens only.

// Okabe-Ito colorblind-safe palette (ADR-0050 multi-series). v1 ships a proven
// accessible category palette rather than a bespoke brand ramp (deferred to v2).
export const CATEGORY_PALETTE: readonly string[] = [
  "#0072B2",
  "#E69F00",
  "#009E73",
  "#CC79A7",
  "#56B4E9",
  "#D55E00",
  "#F0E442",
];

/** Reads a CSS custom property by name. The default reads getComputedStyle on
 * the document root; tests inject a fake reader so buildVegaTheme stays a pure
 * function (no DOM). */
export type CssVarReader = (name: string) => string;

const documentVarReader: CssVarReader = (name) => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!value && import.meta.env.DEV) {
    // A missing token usually means app.css and this reader drifted apart
    // (rename/typo, or the .dark class did not apply). Warn in dev so it
    // surfaces before a chart silently renders the fallback palette in the
    // wrong mode; production stays silent (the fallback handles it).
    log.warn("vega-theme", `CSS token ${name} is unset on :root; using fallback`);
  }
  return value;
};

/** The Vega config derived from the live tokens. background/text come from the
 * shadcn shell tokens; domain/grid are the axis domain line + gridlines
 * (ADR-0050: --border / --muted); primary is the single-series mark color
 * (teal); category is the multi-series palette (Okabe-Ito). Reserved for the
 * v1 whitelist marks (ADR-0016); not mapped onto a spec until the renderer
 * lands post-#77. */
export interface VegaThemeConfig {
  background: string;
  text: string;
  /** Axis domain line color (--border, ADR-0050). */
  domain: string;
  /** Gridline color (--muted, ADR-0050). */
  grid: string;
  primary: string;
  /** The only valid value today is CATEGORY_PALETTE (Okabe-Ito). Typed as the
   * literal tuple so the field reflects the real invariant rather than admitting
   * an arbitrary open string list. */
  category: typeof CATEGORY_PALETTE;
}

/** The single-series mark color: the teal --primary token (ADR-0050). Falls
 * back to the literal teal so a missing var never blanks the chart. */
export function primaryColor(read: CssVarReader = documentVarReader): string {
  return read("--primary") || "#0d9488";
}

/** Build a Vega config derived from the live CSS tokens (ADR-0050 Q12). Pure
 * given the reader; the default reads the document root at call time, so call
 * it on mount and again on each theme change to track the .dark flip. */
export function buildVegaTheme(read: CssVarReader = documentVarReader): VegaThemeConfig {
  return {
    background: read("--background") || "#ffffff",
    text: read("--foreground") || "#1a1a1a",
    domain: read("--border") || "#e3e3e8",
    grid: read("--muted") || "#f0f0f3",
    primary: primaryColor(read),
    category: CATEGORY_PALETTE,
  };
}

/** Subscribe to effective-theme changes. useTheme dispatches these; the Vega
 * renderer rebuilds its derived config on each one. Returns an unsubscribe.
 * The event name is a plain window-wide string, so a foreign/shape-mismatched
 * event could land here -- narrow before invoking the callback rather than
 * trusting the `as` cast. */
export function onThemeChange(cb: (effective: EffectiveTheme) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<ThemeChangeDetail>).detail;
    if (detail?.effective === "light" || detail?.effective === "dark") {
      cb(detail.effective);
    }
  };
  window.addEventListener(THEME_CHANGE_EVENT, handler);
  return () => window.removeEventListener(THEME_CHANGE_EVENT, handler);
}
