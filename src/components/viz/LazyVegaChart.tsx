// The shared chart door (issue #218, ADR-0120). vega-embed + vega-lite are
// hundred-KB deps only needed when a surface turns up a chart -- the result
// card (ResultView) and a round-prose vega-lite fence (VizFence). Deferring
// them out of the static import graph keeps the cold-start hero and
// plain-table turns off the vega parse/exec path. Shared so the bundle split
// stays a single decision: two lazy() doors to the same module would drift in
// fallback shape and defeat the point of one chunk boundary.
//
// VizChartSlot is the whole slot -- the lazy door, its Suspense boundary and
// fallback, and the load-failure boundary around both. The Suspense fallback
// reuses the real chart's .viz-chart class so the slot's margins match the
// loaded chart and the surrounding layout stays put while the vega chunk
// loads; the chart height itself is not reserved (vega-embed injects the
// canvas, so the slot grows from 0 to the spec height on resolve; a brief
// transient in a desktop app where the chunk is local and cached after the
// first view). aria-hidden keeps the empty placeholder out of the a11y tree.
// This load state is a separate layer from a render-failure degrade (the
// caller owns that swap via onError) -- a Vega rejection still routes through
// onError.
//
// A chunk-load rejection is the one throw this module can produce (React.lazy
// turns a rejected import into a render throw, and it caches the rejection --
// a remount does not retry the import). The boundary scopes it to ONE chart:
// without it the throw bubbles to the thread-track region boundary and takes
// the whole conversation down. No Retry on purpose -- the cached rejection
// makes a remount futile; everything around the failed chart keeps rendering.
//
// VegaChart is a named export, so the dynamic import is reshaped to a default
// for React.lazy. The component's own render / theme-bridge / resize-on-unhide
// / finalize logic is untouched -- lazy only shifts the module load time, not
// behavior.

import { Suspense, lazy } from "react";
import { FormattedMessage } from "react-intl";
import { Alert, AlertDescription } from "../ui/alert";
import { ErrorBoundary } from "../common/ErrorBoundary";
import type { TopLevelSpec } from "vega-lite";
import type { DecodedVizSpec, VizFailureReason } from "./viz";

const LazyVegaChart = lazy(() =>
  import("./VegaChart").then((m) => ({ default: m.VegaChart })),
);

/** One decoded spec through the lazy chart inside the standard Suspense
 * boundary, with a load-failure boundary scoping a chunk rejection to one
 * chart. `spec` is a decodeViz/decodeVizSpec success payload; `onError`
 * receives the typed render failure so the caller can swap in its disclosure
 * (ADR-0033). */
export function VizChartSlot({
  spec,
  onError,
}: {
  spec: DecodedVizSpec;
  onError: (reason: VizFailureReason) => void;
}) {
  return (
    <ErrorBoundary
      name="viz-chart"
      fallback={() => (
        <Alert variant="warning" role="status">
          <AlertDescription>
            <FormattedMessage
              id="disclosure.viz.chartLoadFailed"
              defaultMessage="The chart could not be loaded"
            />
          </AlertDescription>
        </Alert>
      )}
    >
      <Suspense fallback={<div className="viz-chart" aria-hidden="true" />}>
        {/* The slot stays schema-light (DecodedVizSpec) to match the decode
         * payload; the always-vega-lite fact is asserted here, at the single
         * door. */}
        <LazyVegaChart spec={spec as unknown as TopLevelSpec} onError={onError} />
      </Suspense>
    </ErrorBoundary>
  );
}
