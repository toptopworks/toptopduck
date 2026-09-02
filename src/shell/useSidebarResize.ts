// Draggable sidebar resize (issue: sidebar width adjust). Manages the sidebar
// pixel width via pointer events + localStorage persistence. The width is
// surfaced as a CSS custom property (--sidebar-width) on the .shell element,
// which the grid-template-columns consumes -- keeping the CSS-driven layout
// intact while allowing interactive resize.
//
// Persistence is frontend-only (localStorage): the width is a live UI pref,
// not an app-config field, so no Rust/IPC change is needed. The clamp range
// (238-518) keeps the sidebar usable without overwhelming the content area;
// the range's upper end additionally shrinks with the available width
// (issue #770) via the optional getMaxWidth availability getter.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { mergeCeiling } from "./layoutBounds";

const STORAGE_KEY = "toptopduck.sidebar-width";

/** Default sidebar width in pixels (matches the CSS fallback). */
export const SIDEBAR_DEFAULT_WIDTH = 238;

/** Minimum resizable width -- keeps session entries readable. */
const MIN_WIDTH = 238;
/** Maximum resizable width -- allows the sidebar to grow large without
 *  swallowing the entire workspace. */
const MAX_WIDTH = 518;

/** Clamp to [MIN_WIDTH, max] — the max parameter carries the availability
 *  ceiling (issue #770) while MIN_WIDTH stays the hard floor. */
function clampWidth(px: number, max: number): number {
  return Math.max(MIN_WIDTH, Math.min(max, px));
}

function loadStoredWidth(maxWidth?: number): number {
  const max = mergeCeiling(maxWidth, MAX_WIDTH);
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return clampWidth(Number(stored) || SIDEBAR_DEFAULT_WIDTH, max);
  } catch {
    // localStorage unavailable (SSR / restricted context)
  }
  return clampWidth(SIDEBAR_DEFAULT_WIDTH, max);
}

export function useSidebarResize(options?: {
  /** Called with the per-frame sidebar width delta during drag. Used by
   *  App.tsx to compensate the rail width (−delta) so the workspace stays
   *  visually fixed when the sidebar is dragged. */
  onDelta?: (delta: number) => void;
  /** Dynamic width ceiling in px (issue #770: shell width minus the rail and
   *  workspace floors), consulted on every pointermove, once at restore, and
   *  on window-resize re-clamp. Return undefined to fall back to the static
   *  MAX_WIDTH — e.g. jsdom, where clientWidth reads as 0. */
  getMaxWidth?: () => number | undefined;
}): {
  /** Current sidebar width in pixels. */
  width: number;
  /** Whether a drag is in progress (for cursor / highlight styling). */
  isDragging: boolean;
  /** Attach to the resize handle's onPointerDown. */
  onResizeStart: (e: ReactPointerEvent) => void;
} {
  // Lazy-init from localStorage so no mount effect is needed (avoids the
  // cascading-render lint on setState-in-effect). The availability ceiling
  // rides the same lazy init — the getter's own pre-mount fallback covers
  // the measurement (see App's getSidebarMaxWidth).
  const [width, setWidth] = useState(() =>
    loadStoredWidth(options?.getMaxWidth?.()),
  );
  const [isDragging, setIsDragging] = useState(false);
  const widthRef = useRef(width);
  const draggingRef = useRef(false);
  // True when the current width was last changed by a mid-drag window-shrink
  // re-clamp rather than by the user's pointer — the drag's pointerup skips
  // persistence so the transient value never overwrites the stored
  // preference (issue #770: persistence stays drag-owned).
  const resizeShrunkRef = useRef(false);
  // Store the latest onDelta / getMaxWidth in refs so the global pointermove
  // listener (mounted once) always reads the current callbacks without
  // re-subscribing.
  const onDeltaRef = useRef(options?.onDelta);
  const getMaxWidthRef = useRef(options?.getMaxWidth);
  useEffect(() => {
    onDeltaRef.current = options?.onDelta;
    getMaxWidthRef.current = options?.getMaxWidth;
  });

  /** min(MAX_WIDTH, dynamic ceiling) — an undefined getter reads as
   *  static-only (mergeCeiling, shared with useRailResize). */
  const effectiveMax = useCallback(
    (): number => mergeCeiling(getMaxWidthRef.current?.(), MAX_WIDTH),
    [],
  );

  const onResizeStart = useCallback((e: ReactPointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    resizeShrunkRef.current = false;
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
      const clamped = clampWidth(e.clientX, effectiveMax());
      const delta = clamped - widthRef.current;
      widthRef.current = clamped;
      setWidth(clamped);
      // A user move re-owns the width — clears any mid-drag shrink flag so
      // the eventual pointerup persists again.
      resizeShrunkRef.current = false;
      // Compensate the rail so the workspace stays fixed.
      if (delta !== 0) onDeltaRef.current?.(delta);
    }

    function onPointerUp(): void {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setIsDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        // Skip persistence when the only change since the user's last move
        // was the window-shrink re-clamp (environmental, not a width choice).
        if (!resizeShrunkRef.current) {
          localStorage.setItem(STORAGE_KEY, String(widthRef.current));
        }
      } catch {
        // Write failed (quota / private mode) -- width stays in-memory only.
      }
    }

    // Re-clamp the live width when the container narrows (issue #770): the
    // rail and workspace floors must stay satisfiable without crushing the
    // rail below its compensated floor. One-way by design — a later widen
    // does not restore the pre-shrink width (re-drag instead) — and NOT
    // persisted: a transient narrow window must not overwrite the stored
    // preference (the restore path re-clamps per launch).
    function onWindowResize(): void {
      const max = effectiveMax();
      if (widthRef.current > max) {
        widthRef.current = Math.max(MIN_WIDTH, max);
        setWidth(widthRef.current);
        if (draggingRef.current) resizeShrunkRef.current = true;
      }
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    // pointercancel fires when the OS aborts the pointer stream (e.g. a
    // system gesture intercepts on touch devices). Without it the drag
    // state + body cursor would stick permanently.
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("resize", onWindowResize);
      // Restore body styles if unmounted mid-drag (React Strict Mode, fast
      // navigation) — the listeners above are gone so onPointerUp cannot fire.
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [effectiveMax]);

  return { width, isDragging, onResizeStart };
}
