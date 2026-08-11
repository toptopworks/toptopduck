// Draggable conversation-rail resize (mirrors useSidebarResize). Manages the
// rail pixel width via pointer events + localStorage persistence. The width is
// surfaced as a CSS custom property (--rail-width) on the .shell element,
// which the session-body grid-template-columns consumes -- keeping the
// CSS-driven layout intact while allowing interactive resize.
//
// Unlike the sidebar, the rail does NOT start at the window's left edge (it
// sits after the sidebar column), so clientX cannot map directly to the
// desired width. Instead the drag is delta-based: the pointer-down position +
// starting width are captured, and each move adds the delta (clamped).
//
// Persistence is frontend-only (localStorage): the width is a live UI pref,
// not an app-config field, so no Rust/IPC change is needed. The clamp range
// (350-600) keeps the rail readable without swallowing the workspace.
// The default (350) matches MIN_WIDTH — the old fixed 320px from DESIGN.md
// was the pre-resizable width; now that the rail is draggable the floor
// IS the starting point.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

const STORAGE_KEY = "toptopduck.rail-width";

/** Default rail width in pixels. Equals MIN_WIDTH so the cold-start width
 *  is always within the clamp range (no handle/column boundary offset on
 *  first render). Users who drag wider persist the new width to localStorage. */
export const RAIL_DEFAULT_WIDTH = 350;

/** Minimum width when dragged directly via the rail handle -- protects the
 *  QuestionBar toolbar (submit button + auth chip + context + provider triggers). */
const MIN_WIDTH = 350;
/** Lower floor for sidebar-driven compensation: the sidebar drag may push
 *  the rail below its own MIN_WIDTH (down to 280) to keep the workspace
 *  usable. The toolbar compresses but stays functional (overflow scroll). */
const COMPENSATED_MIN_WIDTH = 280;
/** Maximum resizable width -- lets the rail grow wide without swallowing the
 *  entire workspace column. */
const MAX_WIDTH = 600;

function clampWidth(px: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, px));
}

function loadStoredWidth(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return clampWidth(Number(stored) || RAIL_DEFAULT_WIDTH);
  } catch {
    // localStorage unavailable (SSR / restricted context)
  }
  return RAIL_DEFAULT_WIDTH;
}

export function useRailResize(): {
  /** Current rail width in pixels. */
  width: number;
  /** Whether a drag is in progress (for cursor / highlight styling). */
  isDragging: boolean;
  /** Attach to the resize handle's onPointerDown. */
  onResizeStart: (e: ReactPointerEvent) => void;
  /** Adjust width by a delta (clamped). Used by sidebar drag coordination:
   *  sidebar grows → rail shrinks by the same delta, keeping workspace fixed. */
  adjustWidth: (delta: number) => void;
} {
  // Lazy-init from localStorage so no mount effect is needed (avoids the
  // cascading-render lint on setState-in-effect).
  const [width, setWidth] = useState(() => loadStoredWidth());
  const [isDragging, setIsDragging] = useState(false);
  const widthRef = useRef(width);
  const draggingRef = useRef(false);
  // Delta-based drag anchors: the pointer-down clientX + the width at that
  // moment. Each move computes startWidth + (clientX - startX).
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  const onResizeStart = useCallback((e: ReactPointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = widthRef.current;
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
      const delta = e.clientX - startXRef.current;
      const clamped = clampWidth(startWidthRef.current + delta);
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

  // Externally-driven width adjustment (sidebar drag coordination). Updates
  // both the ref (for the next pointermove) and React state in one call.
  const adjustWidth = useCallback((delta: number) => {
    const min = COMPENSATED_MIN_WIDTH;
    const clamped = Math.max(min, Math.min(MAX_WIDTH, widthRef.current + delta));
    widthRef.current = clamped;
    setWidth(clamped);
  }, []);

  return { width, isDragging, onResizeStart, adjustWidth };
}
