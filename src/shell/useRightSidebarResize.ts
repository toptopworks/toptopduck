// Draggable right-sidebar resize (issue #1685: explicit panel width).
// Manages the width as a preference/rendered split (issue #1303): the
// PREFERENCE is the user's width choice (written only by the drag), the
// RENDERED width is the pure derivation min(preference, dynamic ceiling)
// recomputed from the window-resize listener and the track-host observer.
// Environmental shrinks cap the rendered width but never rewrite the
// preference, so widening springs the panel back with no re-drag. The
// rendered width is surfaced as a CSS custom property (--right-sidebar-width)
// on the .shell element, which the session-body grid consumes -- keeping the
// CSS-driven layout intact while allowing interactive resize.
//
// Persistence is frontend-only (localStorage): the preference is a live UI
// pref, not an app-config field. The static clamp range (300-1200) keeps the
// panel usable without swallowing the workspace; the dynamic availability
// ceiling additionally caps the rendered width as the available width
// shrinks via the optional getMaxWidth getter — the ceiling subtracts the
// conversation column's 420px protection floor (layoutBounds), so the
// conversation keeps its reading measure whenever the window can afford it.
//
// Unlike the sidebar, the handle sits on the panel's LEFT edge (the
// conversation/panel boundary), so clientX cannot map directly to the
// desired width. The drag is delta-based with an INVERTED mapping: the
// pointer-down clientX + starting rendered width are captured, and each
// move adds (start − clientX) — dragging left grows the panel.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import {
  clampRenderedWidth,
  mergeCeiling,
  rightSidebarDefaultWidth,
  RIGHT_SIDEBAR_MAX_WIDTH,
  RIGHT_SIDEBAR_MIN_WIDTH,
} from "./layoutBounds";

const STORAGE_KEY = "toptopduck.right-sidebar-width";

/** Preference init: clamp to the STATIC range only, falling back to the
 *  viewport-derived default when nothing valid is stored. The dynamic
 *  ceiling never rewrites the preference (#1303) — it shapes the rendered
 *  width. jsdom-style zero viewports bottom out at the 360 default floor. */
function loadStoredWidth(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = Number(stored);
      if (!Number.isNaN(parsed)) {
        return Math.max(
          RIGHT_SIDEBAR_MIN_WIDTH,
          Math.min(RIGHT_SIDEBAR_MAX_WIDTH, parsed),
        );
      }
    }
  } catch {
    // localStorage unavailable (SSR / restricted context)
  }
  return clampWidth(
    rightSidebarDefaultWidth(document.documentElement.clientWidth),
  );
}

/** Clamp to the static [300, 1200] range — the max parameter carries the
 *  merged static + availability ceiling while the min stays the hard
 *  floor. */
function clampWidth(px: number, max: number = RIGHT_SIDEBAR_MAX_WIDTH): number {
  return Math.max(RIGHT_SIDEBAR_MIN_WIDTH, Math.min(max, px));
}

export function useRightSidebarResize(options?: {
  /** Dynamic width ceiling in px (the track host minus the conversation's
   *  420px protection floor), consulted on every pointermove, at the initial
   *  render derivation, and on every window resize. Return undefined to fall
   *  back to the static ceiling — e.g. jsdom, where clientWidth reads as 0. */
  getMaxWidth?: () => number | undefined;
  /** Element whose settled layout drives the rendered-width re-derivation
   *  (issue #781 pattern): the track host. Its width changes without a
   *  window resize whenever the sidebar drags or collapses, so the observer
   *  is what keeps the rendered width honest during those moves. The
   *  observer follows the ref's current element — re-checked after every
   *  commit — so a replaced element is picked up automatically. Environments
   *  without ResizeObserver keep the rendered width at the static
   *  derivation. */
  observeTarget?: RefObject<HTMLElement | null>;
}): {
  /** Current RENDERED right-sidebar width in pixels (min of the preference
   *  and the dynamic ceiling, #1303). */
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
  // Delta-based drag anchors: the pointer-down clientX + the rendered width
  // at that moment. Each move computes startWidth + (startX − clientX) —
  // the inverted mapping of the panel's left-edge handle.
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  // Store the latest getMaxWidth in a ref so the global pointermove listener
  // (mounted once) always reads the current availability without
  // re-subscribing.
  const getMaxWidthRef = useRef(options?.getMaxWidth);
  useEffect(() => {
    getMaxWidthRef.current = options?.getMaxWidth;
  });

  /** min(1200, dynamic ceiling) — an undefined getter reads as static-only
   *  (mergeCeiling, shared with useSidebarResize). */
  const effectiveMax = useCallback(
    (): number => mergeCeiling(getMaxWidthRef.current?.(), RIGHT_SIDEBAR_MAX_WIDTH),
    [],
  );

  // Rendered width: derived min(preference, dynamic ceiling). The initial
  // derivation rides the pre-mount getter fallback, so a stored wide
  // preference still renders within a narrow launch window on the first
  // frame. Read from options directly — the initializer runs during render.
  const [renderedWidth, setRenderedWidth] = useState(() =>
    clampRenderedWidth(
      prefWidth,
      mergeCeiling(options?.getMaxWidth?.(), RIGHT_SIDEBAR_MAX_WIDTH),
      RIGHT_SIDEBAR_MIN_WIDTH,
    ),
  );
  const renderedRef = useRef(renderedWidth);

  // Re-derive the rendered width from the untouched preference (#1303) —
  // shared by the drag-write path, the window-resize listener, and the
  // track-host observer.
  const renderFromPreference = useCallback(() => {
    const rendered = clampRenderedWidth(
      prefRef.current,
      effectiveMax(),
      RIGHT_SIDEBAR_MIN_WIDTH,
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
    // Pointer capture for the same hover-stuck fix as the other resize
    // hooks (release re-runs the hover hit-test once the handle stops at a
    // clamp bound and pointerup lands outside it).
    e.currentTarget?.setPointerCapture?.(e.pointerId);
    startXRef.current = e.clientX;
    startWidthRef.current = renderedRef.current;
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
      // Inverted mapping: the handle sits on the panel's left edge, so
      // moving the pointer LEFT grows the panel.
      const clamped = clampWidth(
        startWidthRef.current + (startXRef.current - e.clientX),
        effectiveMax(),
      );
      applyPreference(clamped);
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
    // is untouched, so a later widen springs the panel back with no re-drag.
    const onWindowResize = renderFromPreference;

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    // pointercancel fires when the OS aborts the pointer stream — without
    // it the drag state + body cursor would stick permanently.
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

  // Observe the track host's settled layout (issue #781 pattern): sidebar
  // drags and collapse toggles reshape the host without a window resize,
  // and the host's clientWidth lags the same event loop as the sidebar's
  // own derivation — so the observation re-derives the rendered width once
  // the layout settles. The preference stays (#1303).
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => renderFromPreference());
    if (options?.observeTarget?.current) {
      observer.observe(options.observeTarget.current);
    }
    return () => observer.disconnect();
  });

  return { width: renderedWidth, isDragging, onResizeStart };
}
