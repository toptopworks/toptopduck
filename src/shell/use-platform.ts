import { platform as readTauriPlatform } from "@tauri-apps/plugin-os";

// Platform detection hook (ADR-0074, issue #262). The macOS traffic-light
// route (ADR-0074 Decision) needs the frontend to dispatch window controls by
// OS, and `@tauri-apps/plugin-os` `platform()` is the Tauri-official signal:
// the plugin injects the compile-time OS as a webview global via its init
// script, and `platform()` reads it synchronously (no IPC round-trip -- only
// `locale()` / `hostname()` go through commands). The value is process-lifetime
// fixed, so this module reads it ONCE and caches -- every usePlatform() call
// after the first serves the cache without touching the global again.
//
// Fallback: in jsdom (tests) no init script runs, so the global is undefined
// and `platform()` throws TypeError; a non-desktop value (e.g. "ios" on a
// hypothetical mobile build) also falls through. Both collapse to the default
// platform -- "macos" per the issue #262 spec, so the test suite exercises the
// macOS dispatch path by default. Production builds on the three desktop
// targets (windows / macos / linux) never hit the fallback.

/** The three desktop platforms the app ships on. Narrowed from plugin-os's
 *  broader `Platform` union (which also lists ios / android / *bsd / solaris)
 *  because the custom titlebar (ADR-0074) only dispatches between macOS and
 *  the Windows/Linux right-side layout. */
export type Platform = "windows" | "macos" | "linux";

const FALLBACK_PLATFORM: Platform = "macos";

// Module-level cache. Null until the first resolve, then the authoritative
// platform for the rest of the process lifetime. A `let` (not useState) so the
// cache is shared across every component that calls the hook -- the OS does not
// change between mounts, and re-reading the global per mount would be wasted
// work (plus a redundant throw-catch in tests).
let cachedPlatform: Platform | null = null;

function isDesktopPlatform(raw: string): raw is Platform {
  return raw === "windows" || raw === "macos" || raw === "linux";
}

function detectPlatform(): Platform {
  if (cachedPlatform !== null) return cachedPlatform;
  try {
    const raw = readTauriPlatform();
    cachedPlatform = isDesktopPlatform(raw) ? raw : FALLBACK_PLATFORM;
  } catch {
    // jsdom (no Tauri init script) OR a hypothetical runtime without the
    // injected global -- honest-degrade to the default platform instead of
    // crashing the shell. Mirrors the log.ts plugin-failure pattern.
    cachedPlatform = FALLBACK_PLATFORM;
  }
  return cachedPlatform;
}

/** The current desktop platform. Reads `@tauri-apps/plugin-os` `platform()`
 *  once (module-level cache) and returns the cached value on every subsequent
 *  call. Use this to dispatch OS-specific chrome (ADR-0074 window controls). */
export function usePlatform(): Platform {
  return detectPlatform();
}
