// Draggable sidebar resize (issue: sidebar width adjust). Manages the sidebar
// pixel width via pointer events + localStorage persistence. The width is
// surfaced as a CSS custom property (--sidebar-width) on the .shell element,
// which the grid-template-columns consumes -- keeping the CSS-driven layout
// intact while allowing interactive resize.
//
// Persistence is frontend-only (localStorage): the width is a live UI pref,
// not an app-config field, so no Rust/IPC change is needed. The clamp range
// (238-518) keeps the sidebar usable without overwhelming the content area.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

const STORAGE_KEY = "toptopduck.sidebar-width";

/** Default sidebar width in pixels (matches the CSS fallback). */
export const SIDEBAR_DEFAULT_WIDTH = 238;

/** Minimum resizable width -- keeps session entries readable. */
const MIN_WIDTH = 238;
/** Maximum resizable width -- allows the sidebar to grow large without
 *  swallowing the entire workspace. */
const MAX_WIDTH = 518;

function clampWidth(px: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, px));
}

function loadStoredWidth(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return clampWidth(Number(stored) || SIDEBAR_DEFAULT_WIDTH);
  } catch {
    // localStorage unavailable (SSR / restricted context)
  }
  return SIDEBAR_DEFAULT_WIDTH;
}

export function useSidebarResize(): {
  /** Current sidebar width in pixels. */
  width: number;
  /** Whether a drag is in progress (for cursor / highlight styling). */
  isDragging: boolean;
  /** Attach to the resize handle's onPointerDown. */
  onResizeStart: (e: ReactPointerEvent) => void;
} {
  // Lazy-init from localStorage so no mount effect is needed (avoids the
  // cascading-render lint on setState-in-effect).
  const [width, setWidth] = useState(() => loadStoredWidth());
  const [isDragging, setIsDragging] = useState(false);
  const widthRef = useRef(width);
  const draggingRef = useRef(false);

  const onResizeStart = useCallback((e: ReactPointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    setIsDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  // Global pointer listeners active for the component's lifetime. The
  // draggingRef gate makes them no-ops unless a drag is in progress, so
  // they can stay mounted without per-drag add/remove overhead.
  useEffect(() => {
    function onPointerMove(e: PointerEvent): void {
      if (!draggingRef.current) return;
      // clientX maps directly to the desired sidebar width because the
      // sidebar starts at the window's left edge (x = 0).
      const clamped = clampWidth(e.clientX);
      widthRef.current = clamped;
      setWidth(clamped);
    }

    function onPointerUp(): void {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setIsDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        localStorage.setItem(STORAGE_KEY, String(widthRef.current));
      } catch {
        // Write failed (quota / private mode) -- width stays in-memory only.
      }
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    // pointercancel fires when the OS aborts the pointer stream (e.g. a
    // system gesture intercepts on touch devices). Without it the drag
    // state + body cursor would stick permanently.
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      // Restore body styles if unmounted mid-drag (React Strict Mode, fast
      // navigation) — the listeners above are gone so onPointerUp cannot fire.
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  return { width, isDragging, onResizeStart };
}
