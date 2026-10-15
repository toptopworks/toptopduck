// Draggable sidebar resize (issue: sidebar width adjust). Manages the sidebar
// width as a preference/rendered split (issue #1303): the PREFERENCE is the
// user's width choice (written only by the drag), the RENDERED width is the
// pure derivation min(preference, dynamic ceiling) recomputed from the
// window-resize listener. Environmental shrinks cap the rendered width but
// never rewrite the preference, so widening the window springs the column
// back with no re-drag. The rendered width is surfaced as a CSS custom
// property (--sidebar-width) on the .shell element, which the
// grid-template-columns consumes -- keeping the CSS-driven layout intact
// while allowing interactive resize.
//
// Persistence is frontend-only (localStorage): the preference is a live UI
// pref, not an app-config field, so no Rust/IPC change is needed. The static
// clamp range (238-518) keeps the sidebar usable without overwhelming the
// content area; the dynamic availability ceiling additionally caps the
// rendered width as the available width shrinks (issue #770) via the
// optional getMaxWidth availability getter.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { clampRenderedWidth, mergeCeiling } from "./layoutBounds";

const STORAGE_KEY = "toptopduck.sidebar-width";

/** Default sidebar width in pixels (matches the CSS fallback). */
export const SIDEBAR_DEFAULT_WIDTH = 280;

/** Minimum resizable width -- keeps session entries readable. */
const MIN_WIDTH = 238;
/** Maximum resizable width -- allows the sidebar to grow large without
 *  swallowing the entire workspace. */
const MAX_WIDTH = 518;

/** Clamp to [MIN_WIDTH, max] — the max parameter carries the merged static +
 *  availability ceiling while MIN_WIDTH stays the hard floor. */
function clampWidth(px: number, max: number): number {
  return Math.max(MIN_WIDTH, Math.min(max, px));
}

/** Preference init: clamp to the STATIC range only. The dynamic ceiling
 *  never rewrites the preference (#1303) — it shapes the rendered width. */
function loadStoredWidth(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return clampWidth(Number(stored) || SIDEBAR_DEFAULT_WIDTH, MAX_WIDTH);
    }
  } catch {
    // localStorage unavailable (SSR / restricted context)
  }
  return clampWidth(SIDEBAR_DEFAULT_WIDTH, MAX_WIDTH);
}

export function useSidebarResize(options?: {
  /** Called with the per-frame rendered-width delta during drag. Used by
   *  App.tsx to compensate the rail width (−delta) so the workspace stays
   *  visually fixed when the sidebar is dragged. */
  onDelta?: (delta: number) => void;
  /** Dynamic width ceiling in px (issue #770: shell width minus the rail and
   *  workspace floors), consulted on every pointermove, at the initial
   *  render derivation, and on every window resize. Return undefined to
   *  fall back to the static MAX_WIDTH — e.g. jsdom, where clientWidth
   *  reads as 0. */
  getMaxWidth?: () => number | undefined;
}): {
  /** Current RENDERED sidebar width in pixels (min of the preference and
   *  the dynamic ceiling, #1303). */
  width: number;
  /** Whether a drag is in progress (for cursor / highlight styling). */
  isDragging: boolean;
  /** Attach to the resize handle's onPointerDown. */
  onResizeStart: (e: ReactPointerEvent) => void;
} {
  // Lazy-init the preference from localStorage so no mount effect is needed
  // (avoids the cascading-render lint on setState-in-effect). Static-range
  // clamping only — the availability ceiling shapes the rendered width.
  const [prefWidth, setPrefWidth] = useState(loadStoredWidth);
  const [isDragging, setIsDragging] = useState(false);
  const prefRef = useRef(prefWidth);
  const draggingRef = useRef(false);
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

  // Rendered width: derived min(preference, dynamic ceiling). The initial
  // derivation rides the same pre-mount getter fallback as the old restore
  // clamp (see App's getSidebarMaxWidth), so a stored wide preference still
  // renders within a narrow launch window on the first frame. Read from
  // options directly — the initializer runs during render, where the
  // getMaxWidthRef indirection would trip react-hooks/refs.
  const [renderedWidth, setRenderedWidth] = useState(() =>
    clampRenderedWidth(
      prefWidth,
      mergeCeiling(options?.getMaxWidth?.(), MAX_WIDTH),
      MIN_WIDTH,
    ),
  );
  const renderedRef = useRef(renderedWidth);

  // Re-derive the rendered width from the untouched preference (#1303) —
  // shared by the drag-write path and the window-resize listener.
  const renderFromPreference = useCallback(() => {
    const rendered = clampRenderedWidth(
      prefRef.current,
      effectiveMax(),
      MIN_WIDTH,
    );
    renderedRef.current = rendered;
    setRenderedWidth(rendered);
  }, [effectiveMax]);

  /** Write the preference (drag-only) and re-derive the rendered width. */
  const applyPreference = useCallback(
    (next: number) => {
      prefRef.current = next;
      setPrefWidth(next);
      renderFromPreference();
    },
    [renderFromPreference],
  );

  const onResizeStart = useCallback((e: ReactPointerEvent) => {
    e.preventDefault();
    // Pointer capture for the same hover-stuck fix as useRailResize
    // (release re-runs the hover hit-test once the handle stops at a
    // clamp bound and pointerup lands outside it).
    e.currentTarget?.setPointerCapture?.(e.pointerId);
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
      const clamped = clampWidth(e.clientX, effectiveMax());
      // Delta of the RENDERED width: the preference and the rendered width
      // can diverge after a mid-drag environmental shrink, and the rail
      // compensation must absorb exactly what the sidebar visually moves
      // (#1303).
      const delta = clamped - renderedRef.current;
      applyPreference(clamped);
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
        // The preference is drag-owned and never environmentally rewritten
        // (#1303), so the release persists it unconditionally — a mid-drag
        // window shrink lowers only the rendered width.
        localStorage.setItem(STORAGE_KEY, String(prefRef.current));
      } catch {
        // Write failed (quota / private mode) -- width stays in-memory only.
      }
    }

    // Re-derive the rendered width on window resize (#1303): the preference
    // is untouched, so a later widen springs the column back with no
    // re-drag.
    const onWindowResize = renderFromPreference;

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
  }, [applyPreference, effectiveMax, renderFromPreference]);

  return { width: renderedWidth, isDragging, onResizeStart };
}
