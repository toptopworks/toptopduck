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
//
// Settled container shrinks re-clamp the width to the availability ceiling
// one-way (issue #781), mirroring the sidebar's window-resize re-clamp but
// riding layout observations instead: the rail's ceiling reads the track
// host, whose clientWidth lags the sidebar's own re-clamp inside a single
// window-resize event, so a resize listener alone would miss snap-style
// one-shot shrinks.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { COMPENSATED_MIN_WIDTH, mergeCeiling } from "./layoutBounds";

/** Default rail width in pixels. Equals MIN_WIDTH so the cold-start width
 *  is always within the clamp range (no handle/column boundary offset on
 *  first render). */
export const RAIL_DEFAULT_WIDTH = 350;

/** Minimum width when dragged directly via the rail handle -- protects the
 *  QuestionBar toolbar (submit button + auth chip + context + provider triggers). */
const MIN_WIDTH = 350;
/** Lower floor for sidebar-driven compensation lives in layoutBounds
 *  (COMPENSATED_MIN_WIDTH) alongside the other width algebra (issue #770). */
/** Maximum resizable width -- lets the rail grow wide without swallowing the
 *  entire workspace column. */
const MAX_WIDTH = 600;

/** Clamp to [min, max]. The min parameter lets direct drag and sidebar
 *  compensation share one clamp path with different floors; the max parameter
 *  lets the static ceiling and the availability ceiling (issue #770) share
 *  one path too. */
function clampWidth(px: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, px));
}

export function useRailResize(options?: {
  /** Dynamic width ceiling in px (issue #770: track-host width minus the
   *  workspace floor), consulted on every pointermove and every
   *  sidebar-compensation adjustment. Return undefined to fall back to the
   *  static MAX_WIDTH — e.g. jsdom, where clientWidth reads as 0. */
  getMaxWidth?: () => number | undefined;
  /** Element whose settled layout drives the re-clamp (issue #781): the
   *  track host, which must be attached by this hook's first effect run
   *  (the App wiring's ref is set in the same commit as the hook). Observed
   *  via ResizeObserver where available — the observer fires after the
   *  layout actually changes and its observe-time initial callback covers
   *  cold start. Environments without ResizeObserver keep the width
   *  static-only. */
  observeTarget?: RefObject<HTMLElement | null>;
}): {
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
  // Store the latest getMaxWidth in a ref so the global pointermove listener
  // (mounted once) always reads the current availability without
  // re-subscribing — same pattern as useSidebarResize's onDeltaRef.
  const getMaxWidthRef = useRef(options?.getMaxWidth);
  useEffect(() => {
    getMaxWidthRef.current = options?.getMaxWidth;
  });

  /** min(MAX_WIDTH, dynamic ceiling) — an undefined getter reads as
   *  static-only (mergeCeiling, shared with useSidebarResize). */
  const effectiveMax = useCallback(
    (): number => mergeCeiling(getMaxWidthRef.current?.(), MAX_WIDTH),
    [],
  );

  /** One-way re-clamp to the availability ceiling (issue #781): a settled
   *  container shrink pulls the state width down so --rail-width never
   *  exceeds the rendered width (the handle returns to the boundary and the
   *  direct drag responds again). A later widen does not restore the
   *  pre-shrink width (re-drag instead) — same one-way semantics as the
   *  sidebar's re-clamp. Mid-drag shrinks re-anchor the drag so the next
   *  pointermove recomputes from the clamped width instead of clamping up
   *  through an inverted range. The floor is defensive: the width algebra
   *  keeps the ceiling at or above COMPENSATED_MIN_WIDTH for windows at
   *  minWidth (840). */
  const clampToCeiling = useCallback(() => {
    const max = effectiveMax();
    if (widthRef.current > max) {
      widthRef.current = Math.max(COMPENSATED_MIN_WIDTH, max);
      if (draggingRef.current) startWidthRef.current = widthRef.current;
      setWidth(widthRef.current);
    }
  }, [effectiveMax]);

  // Observe the track host's settled layout (issue #781): window shrinks, the
  // sidebar's own re-clamp, and cold start (the observe-time initial
  // callback) all surface here after the layout has actually settled.
  useEffect(() => {
    const target = options?.observeTarget;
    if (!target || typeof ResizeObserver === "undefined") return;
    const element = target.current;
    if (!element) return;
    const observer = new ResizeObserver(clampToCeiling);
    observer.observe(element);
    return () => observer.disconnect();
  }, [options?.observeTarget, clampToCeiling]);

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
      const clamped = clampWidth(
        startWidthRef.current + delta,
        effectiveMin,
        effectiveMax(),
      );
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
  }, [effectiveMax]);

  // Externally-driven width adjustment (sidebar drag coordination). Uses the
  // lower COMPENSATED_MIN_WIDTH floor so the sidebar can push the rail past
  // its own direct-drag floor while keeping the workspace usable.
  const adjustWidth = useCallback((delta: number) => {
    const clamped = clampWidth(
      widthRef.current + delta,
      COMPENSATED_MIN_WIDTH,
      effectiveMax(),
    );
    widthRef.current = clamped;
    setWidth(clamped);
  }, [effectiveMax]);

  return { width, isDragging, onResizeStart, adjustWidth };
}
