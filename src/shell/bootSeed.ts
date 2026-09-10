// First-paint boot seed (issue #814, ADR-0113): the Rust setup hook injects
// `window.__TOPTOPDUCK_BOOT_SEED__` via the main window's initialization
// script BEFORE any frontend script runs, so the persisted theme / locale
// paint immediately instead of flashing through the OS-resolved defaults
// while the full getAppConfig IPC is in flight. This module is the consuming
// boundary: parseBootSeed whitelists the two enum fields, readBootSeed is
// the thin reader useAppConfigState calls once per mount.
import { isLocalePreference } from "../i18n";
import type { LocalePreference, Theme } from "../types/app-config";

/** Keep in sync with the Rust writer (`src-tauri/src/app_config/boot_seed.rs`). */
export const BOOT_SEED_GLOBAL = "__TOPTOPDUCK_BOOT_SEED__";

export interface BootSeed {
  theme: Theme;
  locale: LocalePreference;
}

// The satisfies clause keeps the list in lockstep with the Theme union --
// a typo here would compile against a plain string list and silently
// reject every valid seed.
const THEMES: readonly string[] = [
  "system",
  "light",
  "dark",
] satisfies readonly Theme[];

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && THEMES.includes(value);
}

/** Whitelist the seed global: BOTH enum fields must validate or the whole
 * seed is dropped. Rust serializes typed enums, so an invalid variant can
 * only mean the global is not ours -- a dropped seed reproduces the
 * pre-#814 null behavior (the IPC full config stays the only authority).
 * Unknown extra keys are tolerated, mirroring the app-config serde read
 * (no deny_unknown_fields). */
export function parseBootSeed(raw: unknown): BootSeed | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { theme, locale } = raw as Record<string, unknown>;
  if (!isTheme(theme)) return null;
  // The locale half reuses the IPC boundary guard so the seed whitelist and
  // the persisted-value whitelist can never drift apart (ADR-0113 Decision 3).
  if (!isLocalePreference(locale)) return null;
  return { theme, locale };
}

/** Read + validate the injected global. Null when the initialization script
 * did not run or its payload was dropped -- callers fall back. */
export function readBootSeed(): BootSeed | null {
  // Window carries no index signature for arbitrary injected globals, so the
  // read goes through unknown (the value is untrusted by definition -- the
  // whitelist in parseBootSeed is the trust boundary).
  const raw: unknown = (window as unknown as Record<string, unknown>)[BOOT_SEED_GLOBAL];
  return parseBootSeed(raw);
}
