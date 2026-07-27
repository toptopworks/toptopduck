import { usePlatform } from "./use-platform";
import { MacOSWindowControls } from "./MacOSWindowControls";
import { WindowsWindowControls } from "./WindowsWindowControls";

// Platform dispatcher (ADR-0074, issue #263). The custom titlebar ships two
// window-control shapes: macOS traffic lights (MacOSWindowControls -- three
// colored dots with hover-revealed glyphs) and a Windows/Linux right-side
// min/max/close cluster (WindowsWindowControls). usePlatform() is module-
// cached, so this is a synchronous branch over a process-lifetime-fixed OS
// value. POSITION (left vs right) is decided by App.tsx -- this component
// only picks the SHAPE so the call site stays declarative.
export function WindowControls() {
  const platform = usePlatform();
  return platform === "macos" ? (
    <MacOSWindowControls />
  ) : (
    <WindowsWindowControls />
  );
}
