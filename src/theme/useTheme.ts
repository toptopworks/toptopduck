import { useEffect, useState } from "react";
import type { Theme } from "../types/app-config";

// Three-state theme module (ADR-0050). The hook resolves the persisted
// preference to an effective appearance, applies it to <html> via the .dark
// class (the shadcn/Tailwind dark tokens key off it), follows the OS preference
// while in "system" mode, and announces each change as a window event the Vega
// theme bridge (./vega-theme.ts onThemeChange) consumes to rebuild its derived
// config. Persistence itself lives in app-config (ADR-0038); this hook only
// reads the resolved preference.

export type EffectiveTheme = "light" | "dark";

/** The window event name the Vega bridge subscribes to (via onThemeChange in
 * ./vega-theme.ts). Dispatched whenever the effective appearance changes
 * (preference toggle or OS flip). Typed as a literal so a typo'd name at a
 * dispatch or subscribe site is a compile error, not a silent no-op. */
export const THEME_CHANGE_EVENT = "toptopduck:theme-change" as const;

export interface ThemeChangeDetail {
  effective: EffectiveTheme;
}

/** True when the OS prefers dark. Returns false when matchMedia is absent
 * (jsdom without a polyfill) so "system" defaults to light rather than crashing
 * a render. */
function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/** Resolve a preference to the appearance the UI should render. The optional
 * systemDark lets callers (and tests) inject the OS state rather than re-read
 * matchMedia. */
export function resolveEffective(
  preference: Theme,
  systemDark: boolean = systemPrefersDark(),
): EffectiveTheme {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

/** Apply the effective theme to the document root and announce it. Centralized
 * so the hook stays declarative and tests assert one observable side-effect.
 * color-scheme makes the UA chrome (scrollbars, form controls) follow. */
function applyTheme(effective: EffectiveTheme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", effective === "dark");
  root.style.colorScheme = effective;
  window.dispatchEvent(
    new CustomEvent<ThemeChangeDetail>(THEME_CHANGE_EVENT, { detail: { effective } }),
  );
}

/** Three-state theme hook (ADR-0050). Defaults to "system" (caller passes the
 * persisted preference, or "system" before app-config resolves). Returns the
 * effective appearance so callers like a status indicator can read it. */
export function useTheme(preference: Theme): EffectiveTheme {
  // Track the OS preference independently; effective is derived from it + the
  // user preference, so a Settings toggle takes effect on the next render
  // without an extra state hop.
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark());

  // Keep systemDark in sync with the OS (light/dark schedule, OS setting). The
  // listener stays attached for the hook's life; effective only consumes it in
  // system mode, but a cheap always-on listener avoids attach/detach churn on
  // each preference change. No-op (and safe) when matchMedia is absent.
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const effective = resolveEffective(preference, systemDark);

  // Apply + announce whenever the effective appearance changes.
  useEffect(() => {
    applyTheme(effective);
  }, [effective]);

  return effective;
}
