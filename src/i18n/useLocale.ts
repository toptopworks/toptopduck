import { useEffect, useState } from "react";
import type { LocalePreference } from "../types";

// Three-state locale module (ADR-0052, issue #78). Mirrors useTheme (ADR-0050):
// resolves the persisted preference (ADR-0038) to an effective Intl locale the
// IntlProvider consumes, follows the OS language while in "system" mode, and --
// like theme -- defaults to "system" before app-config resolves. The Rust side
// resolves the SAME preference independently for the canonical-prompt locale
// directive; locale never crosses IPC from the frontend.
//
// No DOM side-effect + no window event here (unlike useTheme): IntlProvider
// re-renders declaratively on the locale prop, so any Intl.* formatting tied
// to the locale follows the next render. KISS -- no event is needed until a
// non-React consumer appears.

/** The resolved two-state locale IntlProvider consumes. "system" is resolved to
 * one of these before reaching the provider/catalog layer. */
export type EffectiveLocale = "zh-CN" | "en-US";

/** The zero-config default preference (ADR-0052: follow the OS language). */
export const DEFAULT_LOCALE_PREFERENCE: LocalePreference = "system";

/** The fallback effective locale for any unknown / corrupt preference
 * (ADR-0052: never crash over an unrecognized locale). */
export const FALLBACK_LOCALE: EffectiveLocale = "en-US";

/** Map a raw BCP-47 tag (e.g. `"zh-CN"`, `"en_GB"`) to an EffectiveLocale.
 * ADR-0052: zh* -> zh-CN, en* -> en-US, else -> en-US fallback. Pure so the
 * mapping is unit-testable without a real navigator. Mirrors the Rust
 * `provider::prompt::resolve_locale_from_tag` -- keep the two in sync. */
export function resolveLocaleTag(tag: string | undefined): EffectiveLocale {
  const lower = (tag ?? "").toLowerCase();
  if (lower.startsWith("zh")) return "zh-CN";
  if (lower.startsWith("en")) return "en-US";
  return FALLBACK_LOCALE;
}

/** True when a value is a valid LocalePreference wire string (ADR-0038).
 * Used to guard the IPC boundary: a corrupt persisted value degrades to
 * "system" rather than crashing the hook. */
export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === "system" || value === "zh-CN" || value === "en-US";
}

/** Coerce an unknown persisted value to a safe LocalePreference: a known value
 * passes through, anything else (missing / corrupt / foreign) falls back to the
 * system default (ADR-0052 "persisted value corrupt/unknown -> system, which then
 * follows the OS -> en-US fallback"). */
export function coerceLocalePreference(value: unknown): LocalePreference {
  return isLocalePreference(value) ? value : DEFAULT_LOCALE_PREFERENCE;
}

/** Read the OS/browser language. Returns undefined when `navigator` is absent
 * (jsdom without a configured language) so "system" falls back to en-US rather
 * than crashing a render. */
function systemLanguage(): string | undefined {
  return typeof navigator !== "undefined" ? navigator.language : undefined;
}

/** Resolve a preference to the effective locale. The optional `systemTag` lets
 * callers (and tests) inject the OS language rather than re-read `navigator`. */
export function resolveEffectiveLocale(
  preference: LocalePreference,
  systemTag: string | undefined = systemLanguage(),
): EffectiveLocale {
  if (preference === "system") return resolveLocaleTag(systemTag);
  return preference;
}

/** Three-state locale hook (ADR-0052). Returns the effective locale the
 * IntlProvider should render. Tracks the OS language independently so a Settings
 * override takes effect on the next render + a live OS language change (the
 * `languagechange` event) is followed while in system mode. */
export function useLocale(preference: LocalePreference): EffectiveLocale {
  // Track the OS language independently; effective is derived from it + the
  // user preference, so a Settings toggle renders on the next tick without an
  // extra state hop. Default to navigator.language at mount.
  const [systemTag, setSystemTag] = useState<string | undefined>(() => systemLanguage());

  // Keep systemTag in sync with the OS (a user who switches their OS language
  // while the app is open sees the next render follow it, no restart). The
  // listener stays attached for the hook's life; effective only consumes it in
  // system mode, but a cheap always-on listener avoids attach/detach churn on
  // each preference change. No-op (and safe) when the event never fires (jsdom).
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const onChange = () => setSystemTag(navigator.language);
    window.addEventListener("languagechange", onChange);
    return () => window.removeEventListener("languagechange", onChange);
  }, []);

  return resolveEffectiveLocale(preference, systemTag);
}
