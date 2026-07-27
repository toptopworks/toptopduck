import type { ReactElement } from "react";
import { usePlatform } from "./use-platform";
import { MacOSWindowControls } from "./MacOSWindowControls";
import { WindowsWindowControls } from "./WindowsWindowControls";

// Platform dispatcher (ADR-0074, issue #263). The custom titlebar ships two
// window-control shapes: macOS traffic lights (MacOSWindowControls — three
// colored dots with default-visible glyphs) and a Windows/Linux right-side
// min/max/close cluster (WindowsWindowControls). usePlatform() is module-
// cached, so this is a synchronous branch over a process-lifetime-fixed OS
// value. POSITION (left vs right) is decided by App.tsx — this component only
// picks the SHAPE so the call site stays declarative.
//
// ADR-0052 (layer 1): aria-labels on both children are UI chrome and localize
// via STATIC intl.formatMessage literals (reuses window.close / window.minimize
// / window.maximize / window.restore ids — no new catalog keys). Both children
// mount inside <IntlProvider> (App topbar), so useIntl reaches the catalog
// directly. The shared fireWindowAction helper (window-actions.ts) routes IPC
// failures for both paths — close → log.error, minimize/toggleMaximize →
// log.warn.
export function WindowControls(): ReactElement {
  const platform = usePlatform();
  return platform === "macos" ? (
    <MacOSWindowControls />
  ) : (
    <WindowsWindowControls />
  );
}
