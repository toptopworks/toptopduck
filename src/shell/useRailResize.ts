// Draggable conversation-rail resize. Manages the rail width as a
// preference/rendered split (issue #1303): the PREFERENCE is the user's
// width choice (written by the direct drag and the sidebar compensation),
// the RENDERED width is the pure derivation min(preference, dynamic ceiling)
// recomputed from container observations. Environmental shrinks cap the
// rendered width but never rewrite the preference, so a later widen springs
// the rail back with no re-drag. The rendered width is surfaced as a CSS
// custom property (--rail-width) on the .shell element, which the
// session-body grid-template-columns consumes -- keeping the CSS-driven
// layout intact while allowing interactive resize.
//
// Unlike the sidebar, the rail does NOT start at the window's left edge (it
// sits after the sidebar column), so clientX cannot map directly to the
// desired width. Instead the drag is delta-based: the pointer-down position
// + starting RENDERED width are captured, and each move adds the delta
// (clamped) — anchoring the rendered width keeps the handle under the
// pointer even when an earlier environmental shrink capped it below the
// preference (#1303).
//
// The rail preference is NOT persisted — it resets to RAIL_DEFAULT_WIDTH on
// every app launch. Only the sidebar preference is persisted (localStorage).
// The rail is an ephemeral layout adjustment that the user re-sets per
// session.
//
// Settled container shrinks cap the rendered width at the availability
// ceiling (issue #781) riding layout observations instead of a resize
// listener: the rail's ceiling reads the track host, whose clientWidth lags
// the sidebar's own window-resize derivation inside a single window-resize
// event, so a resize listener alone would miss snap-style one-shot shrinks.
// With the preference/render split the observation only re-derives the
// rendered width (#1303) — the preference stays, so widening springs back.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import {
  clampRenderedWidth,
  COMPENSATED_MIN_WIDTH,
  mergeCeiling,
} from "./layoutBounds";

/** Default rail width in pixels. Within the clamp range and at or below the
 *  availability ceiling for windows at the 1200px default width (track host
 *  920 minus the 320 workspace floor = 600), so the cold-start width needs
 *  no re-clamp there at the factory sidebar; narrower windows — or a stored
 *  sidebar wide enough to sink the ceiling below the default — cap the
 *  rendered width via the container observer. */
export const RAIL_DEFAULT_WIDTH = 460;

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
  /** Element whose settled layout drives the rendered-width re-derivation
   *  (issue #781): the track host. The observer follows the ref's current
   *  element — it is re-checked after every commit, so a replaced element (a
   *  boundary retry remounts the host under the same ref object) or a
   *  late-attached one is picked up automatically. Environments without
   *  ResizeObserver keep the rendered width at the static default. */
  observeTarget?: RefObject<HTMLElement | null>;
}): {
  /** Current RENDERED rail width in pixels (min of the preference and the
   *  dynamic ceiling, #1303). */
  width: number;
  /** Whether a drag is in progress (for cursor / highlight styling). */
  isDragging: boolean;
  /** Attach to the resize handle's onPointerDown. */
  onResizeStart: (e: ReactPointerEvent) => void;
  /** Adjust width by a delta (clamped). Used by sidebar drag coordination:
   *  sidebar grows → rail shrinks by the same delta, keeping workspace fixed. */
  adjustWidth: (delta: number) => void;
} {
  // Preference state — ephemeral (no localStorage; resets to default on
  // every mount), written only by the direct drag and the sidebar
  // compensation, never by the environment (#1303).
  const [prefWidth, setPrefWidth] = useState(RAIL_DEFAULT_WIDTH);
  // Rendered width — the initial value stays the default (no dynamic
  // reading at mount); the container observation derives it once the layout
  // settles.
  const [renderedWidth, setRenderedWidth] = useState(RAIL_DEFAULT_WIDTH);
  const [isDragging, setIsDragging] = useState(false);
  const prefRef = useRef(prefWidth);
  const renderedRef = useRef(renderedWidth);
  const draggingRef = useRef(false);
  // Delta-based drag anchors: the pointer-down clientX + the rendered width
  // at that moment. Each move computes startWidth + (clientX - startX).
  const startXRef = useRef(0);
  const startWidthRef = useRef(renderedWidth);
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

  // Re-derive the rendered width from the untouched preference (#1303) —
  // the observer callback and the drag-write path share it. A settled
  // container shrink caps the RENDERED width so --rail-width never exceeds
  // what fits (the handle returns to the boundary and the direct drag
  // responds again); the preference stays, so a later widen springs the
  // rail back to it. The floor is defensive: the width algebra keeps the
  // ceiling at or above COMPENSATED_MIN_WIDTH for windows at minWidth (840).
  const renderFromPreference = useCallback(() => {
    const rendered = clampRenderedWidth(
      prefRef.current,
      effectiveMax(),
      COMPENSATED_MIN_WIDTH,
    );
    renderedRef.current = rendered;
    setRenderedWidth(rendered);
  }, [effectiveMax]);

  /** Write the preference (drag / compensation only) and re-derive the
   *  rendered width. */
  const applyPreference = useCallback(
    (next: number) => {
      prefRef.current = next;
      setPrefWidth(next);
      renderFromPreference();
    },
    [renderFromPreference],
  );

  // Observe the track host's settled layout (issue #781): window shrinks,
  // the sidebar's own rendered-width cap, and cold start (the observe-time
  // initial callback) all surface here after the layout has actually
  // settled. The observer follows the ref's current element rather than the
  // ref object's identity — a boundary retry (ADR-0058 L3) can replace the
  // tracked host under the same ref object, and an identity-keyed effect
  // would never re-observe the new node, leaving the observer attached to a
  // detached node that never fires again. The dep-less sync re-checks after
  // every commit; the equality check keeps the steady state a no-op.
  const observerRef = useRef<ResizeObserver | null>(null);
  const observedNodeRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const element = options?.observeTarget?.current ?? null;
    if (typeof ResizeObserver === "undefined") return;
    if (element === observedNodeRef.current) return;
    observerRef.current?.disconnect();
    if (element) {
      const observer = new ResizeObserver(renderFromPreference);
      observer.observe(element);
      observerRef.current = observer;
      observedNodeRef.current = element;
    } else {
      observerRef.current = null;
      observedNodeRef.current = null;
    }
  });
  // Unmount cleanup resets the observation state, not just the observer:
  // a StrictMode remount must rebuild the observer, which the sync above
  // only does when the node record reads stale.
  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      observedNodeRef.current = null;
    },
    [],
  );

  const onResizeStart = useCallback((e: ReactPointerEvent) => {
    e.preventDefault();
    // Capture the pointer to the handle: the implicit capture drop on
    // pointerup makes the browser re-run the hover hit-test, clearing the
    // :hover that sticks when the handle stops at a clamp bound under the
    // moving pointer, so pointerup lands outside it (hover recomputation is
    // frozen while a button is pressed, so without this the line highlight
    // outlives the pointerup).
    e.currentTarget?.setPointerCapture?.(e.pointerId);
    draggingRef.current = true;
    startXRef.current = e.clientX;
    // Anchor the RENDERED width, not the preference: a prior environmental
    // shrink may have capped the rendered width below the preference, and
    // the drag must start from what is actually on screen (#1303).
    startWidthRef.current = renderedRef.current;
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
      applyPreference(clamped);
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
  }, [applyPreference, effectiveMax]);

  // Externally-driven width adjustment (sidebar drag coordination). Uses the
  // lower COMPENSATED_MIN_WIDTH floor so the sidebar can push the rail past
  // its own direct-drag floor while keeping the workspace usable. This is a
  // preference write per the split's contract (#1303): the compensation is
  // part of the user's sidebar-drag choice.
  const adjustWidth = useCallback(
    (delta: number) => {
      applyPreference(
        clampWidth(
          prefRef.current + delta,
          COMPENSATED_MIN_WIDTH,
          effectiveMax(),
        ),
      );
    },
    [applyPreference, effectiveMax],
  );

  return { width: renderedWidth, isDragging, onResizeStart, adjustWidth };
}
