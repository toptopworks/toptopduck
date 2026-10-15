import { getCurrentWindow } from "@tauri-apps/api/window";

import { log } from "../lib/log";

// Window-control fire-and-forget helper (ADR-0074, issue #263). Extracted from
// the per-component `fire` closures that MacOSWindowControls and
// WindowsWindowControls duplicated verbatim. Centralizes the IPC + error
// routing so both platform paths share one source of truth.

/** The three window-control actions the macOS traffic lights and the Windows
 *  min/max/close cluster can fire. These map 1:1 to Tauri Window methods;
 *  TypeScript's union-key indexed access on `window[action]()` enforces that
 *  every member remains a `() => Promise<void>` method on the Window type — a
 *  future Tauri rename or removal breaks the build at the call site below. */
export type WindowAction = "minimize" | "toggleMaximize" | "close";

/** Fire a window-control action. Fire-and-forget: clicks are user intent, not
 *  a subscribe chain. A rejection is a real capability / runtime failure
 *  (capability missing, window torn down during teardown, IPC command failed).
 *  Mirrors the useAppConfigState window-IPC `.catch + log` template.
 *
 *  Failure routing: `close` is `log.error` (the user cannot dismiss the window
 *  — most severe); `minimize` / `toggleMaximize` are `log.warn` (OS-level
 *  alternatives remain). Failures land in the unified log file (ADR-0029
 *  diagnostic sink); a user-visible banner is intentionally NOT coupled here —
 *  the realistic failure modes are either covered by capabilities/default.json
 *  already (allow-minimize/maximize/toggle-maximize/close) or are transient
 *  teardown races that a banner would only annoy on. The unified log keeps the
 *  failure observable to ops/dev without coupling window controls to the shell
 *  error banner. */
export function fireWindowAction(action: WindowAction): void {
  void getCurrentWindow()[action]().catch((e) => {
    if (action === "close") {
      log.error("window", "close failed", e);
    } else {
      log.warn("window", `${action} failed`, e);
    }
  });
}
