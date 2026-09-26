// The render-failure gate shared by every chart surface (#1085): the result
// card's viz section, the round-prose vega-lite fence, and the enlarge
// overlay's re-embed. What the three share verbatim is exactly one axis --
// a renderError held while the chart draws, an onError handed to the chart
// slot, and a reset the moment the surface's identity axis changes so a new
// chart gets a fresh try. Everything else stays per-surface on purpose:
// the decode inputs are heterogeneous (the wire VizSpec's spec text, a
// fence's raw JSON body, an already-decoded success payload) and so are the
// degrade presentations (the result card keeps its table under the
// disclosure; the fence and the overlay carry none). Folding either in
// would be a false seam over surfaces that legitimately differ.
//
// The reset is the render-phase "adjusting state when a prop changes"
// pattern (the SkillsSection prevSkills / ResultView windowRef precedent):
// a changed key adjusts state during render, so no effect runs after the
// stale UI has already committed. Callers must pass a STABLE identity per
// axis value -- a composite axis is memoized at the call site (the result
// card's [referenceName, decoded] pair); a fresh inline array would look
// like a new axis every render and loop.

import { useState } from "react";
import type { VizFailureReason } from "./viz";

/** The one-axis chart gate (#1085): `resetKey` is the surface's identity
 *  axis (see the header narrative); a key change clears the render failure
 *  so the next chart starts fresh. `showChart` is the render-failure axis
 *  alone -- the caller ANDs it with its own decode decision. `onError` is
 *  the chart slot's failure door (a useState setter, stable). */
export function useVizChartGate(resetKey: unknown): {
  renderError: VizFailureReason | null;
  showChart: boolean;
  onError: (reason: VizFailureReason) => void;
} {
  const [renderError, setRenderError] = useState<VizFailureReason | null>(null);
  // Render-phase reset: both states adjust together when the axis changed.
  const [prevKey, setPrevKey] = useState(resetKey);
  if (prevKey !== resetKey) {
    setPrevKey(resetKey);
    setRenderError(null);
  }
  return {
    renderError,
    showChart: renderError === null,
    onError: setRenderError,
  };
}
