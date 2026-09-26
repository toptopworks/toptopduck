// A vega-lite fence inside round prose (ADR-0120). Charts are produced as
// fences in the terminal prose (Decision 1): one fence = one chart, its body a
// self-contained Vega-Lite JSON spec, any number of them interleaved with the
// discourse. This module is the fence's render surface -- decode through the
// same whitelist gate the result card uses, draw through the same lazy
// VegaChart + ADR-0050 theme bridge, and degrade with an honest disclosure on
// failure (ADR-0033).
//
// Two entry points, one streaming rule (Decision 4): while the turn is LIVE a
// vega-lite fence renders as a lightweight placeholder only -- no parse, no
// failure judgment, and never the half-streamed source (a spec re-parsed per
// delta would also produce a new object identity and re-embed per delta). Once
// the turn settles, VizFence takes over: decode -> chart, or decode/render
// failure -> disclosure. The live/settled choice is the caller's (RoundProse's
// two module-level component maps); neither function parses on the live side.
//
// No data-volume gate on this surface (Decision 5): the ~150-row teaching
// guardrail lives in the skill's production guidance -- by render time a cap
// would only mis-degrade a chart that would have drawn fine.

import { useMemo } from "react";
import { useIntl } from "react-intl";
import { Loader2 } from "lucide-react";
import { VizChartSlot } from "./LazyVegaChart";
import { VizDegradeDisclosure } from "./VizDegradeDisclosure";
import { VizEnlargeDialog } from "./VizEnlargeDialog";
import { useVizChartGate } from "./useVizChartGate";
import { decodeVizSpec } from "./viz";

/** The live placeholder (ADR-0120 Decision 4): names what is coming without
 * showing the source or attempting a render. Deliberately parse-free -- it
 * takes no spec at all, so a half-streamed fence can never fail here. */
export function VizFencePending() {
  const intl = useIntl();
  return (
    // Bare on purpose: the prose root's space-y owns the inter-block rhythm,
    // so this surface carries no margin classes of its own (the same contract
    // CodeBlock's wrapper follows).
    <div
      role="status"
      className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-3 text-xs text-muted-foreground"
    >
      <Loader2 aria-hidden="true" className="w-3.5 h-3.5 shrink-0 animate-spin" />
      {intl.formatMessage({ id: "viz.fence.pending", defaultMessage: "Generating chart…" })}
    </div>
  );
}

/** The settled fence renderer: one decoded spec through the chart, or an
 * honest disclosure. `spec` is the fence's raw body text (bare Vega-Lite JSON,
 * no wire `kind`). */
export function VizFence({ spec }: { spec: string }) {
  // The shared decode gate (viz.ts): parse + whitelist mark. A fence that
  // fails degrades like a result-card spec does, only the disclosure wording
  // differs (no table rides under a fence chart).
  const decoded = useMemo(() => decodeVizSpec(spec), [spec]);
  // The render-failure gate rides the shared hook (#1085), keyed on the
  // fence's raw spec text -- a new fence body gets a fresh try.
  const { renderError, onError } = useVizChartGate(spec);

  const degradedReason = decoded.ok ? renderError : decoded.reason;
  return (
    <>
      {decoded.ok && renderError === null && (
        // The chart slot: the shared door (lazy + Suspense boundary + the
        // standard fallback). The wrapper zeroes the fallback/chart class's
        // own 0.5rem margins (a result-pane concern) so the prose root's
        // space-y owns this block's rhythm like every other block; `relative`
        // anchors the enlarge affordance to the chart's corner (#1050).
        <div className="relative [&_.viz-chart]:m-0">
          <VizChartSlot spec={decoded.spec} onError={onError} />
          {/* The overlay re-embeds the same decoded spec at full readable
              size; a degrade swaps this whole block for the disclosure below,
              so the affordance dies with the chart it would enlarge. */}
          <VizEnlargeDialog spec={decoded.spec} />
        </div>
      )}
      {degradedReason !== null && (
        // ADR-0033: a fence chart that failed to decode/render gets the
        // shared honest disclosure instead of silence.
        <VizDegradeDisclosure reason={degradedReason} />
      )}
    </>
  );
}
