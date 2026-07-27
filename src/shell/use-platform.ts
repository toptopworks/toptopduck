import { platform as readTauriPlatform } from "@tauri-apps/plugin-os";

import { log } from "../lib/log";

// Platform detection hook (ADR-0074, issue #262). The macOS traffic-light
// window-controls route needs the frontend to dispatch by OS, and
// @tauri-apps/plugin-os `platform()` is the Tauri-official signal: the plugin
// injects the compile-time OS as a webview global via its init script, and
// `platform()` reads it synchronously (no IPC round-trip -- only `locale()` /
// `hostname()` go through commands). The value is process-lifetime fixed, so
// this module reads it ONCE and caches -- every usePlatform() call after the
// first serves the cache without touching the global again.
//
// Fallback: in jsdom (tests) no init script runs, so the global is undefined
// and `platform()` throws TypeError. The same path is reachable in production
// if the init script is stripped or races first render (CSP/bundle change,
// plugin misregistration); the catch logs via log.warn so the regression is
// observable, not silent. A non-desktop value (e.g. "ios") also falls through.
// All three collapse to FALLBACK_PLATFORM ("macos").

/** The three desktop platforms the app ships on. Named `DesktopPlatform` to
 *  avoid shadowing @tauri-apps/plugin-os's broader `Platform` union (which
 *  also lists ios / android / *bsd / solaris); the custom titlebar (ADR-0074)
 *  only dispatches between macOS and the Windows/Linux right-side layout. */
export type DesktopPlatform = "windows" | "macos" | "linux";

const FALLBACK_PLATFORM: DesktopPlatform = "macos";

// Process-level cache (not useState): the OS does not change between mounts,
// so a shared `let` means only the first read touches the plugin global;
// re-reading would be wasted work and would re-throw in jsdom. Never reset in
// production -- tests reset it via vi.resetModules (re-imports the module).
let cachedPlatform: DesktopPlatform | null = null;

function isDesktopPlatform(raw: string): raw is DesktopPlatform {
  return raw === "windows" || raw === "macos" || raw === "linux";
}

/** The current desktop platform. Reads @tauri-apps/plugin-os `platform()` once
 *  (module-level cache) and returns the cached value on every subsequent call.
 *  Use this to dispatch OS-specific chrome (ADR-0074 window controls). */
export function usePlatform(): DesktopPlatform {
  if (cachedPlatform !== null) return cachedPlatform;
  try {
    const raw = readTauriPlatform();
    cachedPlatform = isDesktopPlatform(raw) ? raw : FALLBACK_PLATFORM;
  } catch (e) {
    // jsdom (no Tauri init script), OR a production regression (init script
    // stripped or racing first render, plugin misregistered). Honest-degrade
    // instead of crashing the shell; log.warn keeps a broken global observable
    // (ADR-0029 honest-degrade).
    log.warn("platform", "plugin-os platform() threw; using fallback", e);
    cachedPlatform = FALLBACK_PLATFORM;
  }
  return cachedPlatform;
}
