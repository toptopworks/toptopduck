// The shared chart door (issue #218, ADR-0120). vega-embed + vega-lite are
// hundred-KB deps only needed when a surface turns up a chart -- the result
// card (ResultView) and a round-prose vega-lite fence (VizFence). Deferring
// them out of the static import graph keeps the cold-start hero and
// plain-table turns off the vega parse/exec path. Shared so the bundle split
// stays a single decision: two lazy() doors to the same module would drift in
// fallback shape and defeat the point of one chunk boundary.
//
// VizChartSlot is the whole slot -- the lazy door plus the Suspense boundary
// and its fallback. The fallback reuses the real chart's .viz-chart class so
// the surrounding layout stays put while the vega chunk loads; aria-hidden
// keeps the empty placeholder out of the a11y tree. This load state is a
// separate layer from a render-failure degrade (the caller owns that swap via
// onError) -- a Vega rejection still routes through onError.
//
// VegaChart is a named export, so the dynamic import is reshaped to a default
// for React.lazy. The component's own render / theme-bridge / resize-on-unhide
// / finalize logic is untouched -- lazy only shifts the module load time, not
// behavior.

import { Suspense, lazy } from "react";
import type { VizFailureReason } from "./viz";

const LazyVegaChart = lazy(() =>
  import("./VegaChart").then((m) => ({ default: m.VegaChart })),
);

/** One decoded spec through the lazy chart inside the standard Suspense
 * boundary. `spec` is a decodeViz/decodeVizSpec success payload; `onError`
 * receives the typed render failure so the caller can swap in its disclosure
 * (ADR-0033). */
export function VizChartSlot({
  spec,
  onError,
}: {
  spec: object;
  onError: (reason: VizFailureReason) => void;
}) {
  return (
    <Suspense fallback={<div className="viz-chart" aria-hidden="true" />}>
      <LazyVegaChart spec={spec} onError={onError} />
    </Suspense>
  );
}
