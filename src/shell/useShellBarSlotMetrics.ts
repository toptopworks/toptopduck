import { useEffect, useRef } from "react";
import type { RefObject } from "react";

// Issue #836: the bar is an overlay on the main area, so the rail's
// scroll container spans the full height and its tail passes behind the
// bar. The rail keeps the thread's end readable above the bar with a
// bottom padding sized from the bar's live height: this observer
// publishes it as --shell-bar-h on the main area (styles.css turns it
// into the rail's padding-bottom). A height change (a growing draft, the
// picker opening) only grows or shrinks that padding -- content above
// never reflows, so the scroll position holds (a shrink while parked at
// max scroll clamps by the same delta, a visual no-op that keeps the
// view pinned to the tail). A centered-to-bottom flip briefly leaves
// the stale centered height in the var -- the taller of the two, so the
// frame the observer needs to catch up is conservative. (The reverse
// flip leaves the shorter bottom height; harmless, because closing the
// last session unmounts its layer in the same commit, so no rail
// consumes the var during the glide.) The slot never unmounts
// (ADR-0092 single instance), so one mount-scoped observer covers every
// posture.
//
// Returns the slot ref the shell bar renders into; the observer binds to
// it on mount and tears down with it.
export function useShellBarSlotMetrics(
  areaRef: RefObject<HTMLElement | null>,
): RefObject<HTMLDivElement | null> {
  const slotRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const slot = slotRef.current;
    const area = areaRef.current;
    if (!slot || !area) return;
    // The rail's scrollbar column must stay uncovered (that is the point of
    // the overlay), but thread content that overflows its reading column
    // horizontally paints across the rail's padding up to the clip edge --
    // so the strip's backdrop must stop at the scrollbar itself, not a full
    // gutter short of it. Scrollbar width is constant for the app's
    // lifetime; measure it once with a hidden scrollable probe (overlay
    // scrollbars measure 0, which is exactly right: the notch then
    // collapses to the 1px column border).
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:absolute;visibility:hidden;overflow:scroll;width:50px;height:50px";
    document.body.appendChild(probe);
    const scrollbarW = probe.offsetWidth - probe.clientWidth;
    probe.remove();
    area.style.setProperty("--rail-sb-w", `${scrollbarW}px`);
    if (typeof ResizeObserver === "undefined") return; // jsdom (test-setup stubs it)
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.borderBoxSize?.[0];
      const height = box ? box.blockSize : (entries[0]?.contentRect.height ?? 0);
      // A hidden slot (settings-mode's display:none) reports 0 -- keep the
      // last real height so the rail's bound never collapses.
      if (height > 0) area.style.setProperty("--shell-bar-h", `${height}px`);
    });
    ro.observe(slot);
    return () => ro.disconnect();
  }, [areaRef]);
  return slotRef;
}
