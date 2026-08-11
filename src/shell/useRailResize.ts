// Draggable conversation-rail resize. Manages the rail pixel width via pointer
// events. The width is surfaced as a CSS custom property (--rail-width) on the
// .shell element, which the session-body grid-template-columns consumes --
// keeping the CSS-driven layout intact while allowing interactive resize.
//
// Unlike the sidebar, the rail does NOT start at the window's left edge (it
// sits after the sidebar column), so clientX cannot map directly to the
// desired width. Instead the drag is delta-based: the pointer-down position +
// starting width are captured, and each move adds the delta (clamped).
//
// The rail width is NOT persisted — it resets to RAIL_DEFAULT_WIDTH on every
// app launch. Only the sidebar width is persisted (localStorage). The rail is
// an ephemeral layout adjustment that the user re-sets per session.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/** Default rail width in pixels. Equals MIN_WIDTH so the cold-start width
 *  is always within the clamp range (no handle/column boundary offset on
 *  first render). */
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

/** Clamp to [min, MAX_WIDTH]. The min parameter lets direct drag and sidebar
 *  compensation share one clamp path with different floors. */
function clampWidth(px: number, min = MIN_WIDTH): number {
  return Math.max(min, Math.min(MAX_WIDTH, px));
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
  // Ephemeral state — no localStorage; resets to default on every mount.
  const [width, setWidth] = useState(RAIL_DEFAULT_WIDTH);
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
      // Use min(MIN_WIDTH, startWidthRef) as the effective floor so that
      // if sidebar compensation pushed the rail below MIN_WIDTH (to
      // COMPENSATED_MIN_WIDTH=280), the first direct-drag move does not
      // snap the rail back up to 350. When startWidthRef is at or above
      // MIN_WIDTH the floor stays at MIN_WIDTH (normal case).
      const effectiveMin = Math.min(MIN_WIDTH, startWidthRef.current);
      const clamped = clampWidth(startWidthRef.current + delta, effectiveMin);
      widthRef.current = clamped;
      setWidth(clamped);
    }

    function onPointerUp(): void {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setIsDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
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

  // Externally-driven width adjustment (sidebar drag coordination). Uses the
  // lower COMPENSATED_MIN_WIDTH floor so the sidebar can push the rail past
  // its own direct-drag floor while keeping the workspace usable.
  const adjustWidth = useCallback((delta: number) => {
    const clamped = clampWidth(widthRef.current + delta, COMPENSATED_MIN_WIDTH);
    widthRef.current = clamped;
    setWidth(clamped);
  }, []);

  return { width, isDragging, onResizeStart, adjustWidth };
}
