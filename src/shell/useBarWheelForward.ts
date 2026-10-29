import { useCallback } from "react";
import type { RefObject, WheelEvent } from "react";

// WheelEvent deltaMode values (spec constants, inlined so the handler does
// not depend on the WheelEvent global being present) and the effective line
// height Chromium assigns a legacy line-mode tick. The Tauri webviews emit
// pixel deltas only; these normalize the legacy shapes defensively.
const WHEEL_DELTA_MODE_LINE = 1;
const WHEEL_DELTA_MODE_PAGE = 2;
const WHEEL_LINE_HEIGHT_PX = 16;

// Issue #834: ADR-0092 lifted the bar to the shell level, outside the rail's
// scroll container, so a wheel over the bar strip finds no scrollable
// ancestor and dies -- and the caret rests there exactly while reading the
// latest content. Forward the delta to the active pane's rail; scrollBy clamps
// at the edges natively. Zoom gestures (ctrl+wheel / pinch) stay with the
// browser -- the rail's native surface never scrolls on them either.
//
// A wheel that lands on a scrollable inside the bar itself (the multi-line
// textarea once it overflows, the open skill-picker list once its rows pass its
// cap) scrolls that element natively while it can still consume the tick --
// skip it so the rail does not double-scroll behind. At the scrollable's edge
// the delta has nowhere native to go (the bar has no scrollable ancestor), so
// it chains to the rail instead: the manual form of native scroll chaining.
// The per-event query tracks the keep-alive layer's .active flag without
// ref-lifecycle wiring; cold start has no active layer, so the forward is a
// structural no-op.
export function useBarWheelForward(
  mainAreaRef: RefObject<HTMLElement | null>,
): (event: WheelEvent) => void {
  return useCallback(
    (event: WheelEvent) => {
      if (event.ctrlKey) return;
      for (
        let node = event.target as Element | null;
        node && node !== event.currentTarget;
        node = node.parentElement
      ) {
        const { overflowY } = window.getComputedStyle(node);
        if (
          (overflowY === "auto" || overflowY === "scroll") &&
          node.scrollHeight > node.clientHeight
        ) {
          const atTop = node.scrollTop <= 0;
          const atBottom =
            node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
          if (
            event.deltaY > 0
              ? !atBottom
              : event.deltaY < 0
                ? !atTop
                : false
          ) {
            return;
          }
        }
      }
      const rail = mainAreaRef.current?.querySelector<HTMLElement>(
        ".session-pane-layer.active .session-rail",
      );
      if (!rail) return;
      const dy =
        event.deltaMode === WHEEL_DELTA_MODE_LINE
          ? event.deltaY * WHEEL_LINE_HEIGHT_PX
          : event.deltaMode === WHEEL_DELTA_MODE_PAGE
            ? event.deltaY * rail.clientHeight
            : event.deltaY;
      rail.scrollBy(0, dy);
    },
    [mainAreaRef],
  );
}
