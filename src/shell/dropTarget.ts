// Drop-target hit test for the single webview-level file drop router (#501).
// Tauri's onDragDropEvent is a window-level signal with no hit test (#81), so
// the shell's ONE drop listener owns per-target routing. ADR-0092 Decision 2:
// on cold start the empty-state main area AROUND the centered bar accepts
// file drops (the ADR-0061 drop-to-create path, carrier moved from the
// retired hero to the empty state), but the bar ITSELF is inert -- a drop ON
// the composer must not mint a session by accident. This module answers "did
// the drop land on the composer bar?" from the event's physical position.

/** Window-relative drop position in PHYSICAL pixels, as carried by Tauri's
 *  DragDropEvent. Structurally compatible with @tauri-apps/api's
 *  PhysicalPosition without importing the runtime module into the router. */
export interface DropPoint {
  x: number;
  y: number;
}

/** Stable class hook of the shell-level composer bar (QuestionBar's form). */
const COMPOSER_BAR_SELECTOR = ".question-bar";

/** Whether a drop position lands on the shell-level composer bar. The event
 *  position is physical pixels from the webview's top-left; the DOM rect is
 *  CSS pixels, so divide by the webview's scale factor (devicePixelRatio).
 *  Bounds are inclusive. Returns false when the bar is not mounted -- the
 *  fail-open default keeps the ADR-0061 drop-to-create path alive. */
export function isPointOverComposerBar(position: DropPoint): boolean {
  const bar = document.querySelector(COMPOSER_BAR_SELECTOR);
  if (!(bar instanceof HTMLElement)) return false;
  const rect = bar.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const x = position.x / scale;
  const y = position.y / scale;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
