// The stage's viz view (issue #1093): a fence chart promoted onto the
// workspace stage. One decode through the shared gate, the export-bearing
// frame, and the honest disclosure on failure (ADR-0033). No header facts
// are fabricated: a fence chart carries no stale anchor, producing
// question, or assumption, so the view IS the chart -- the pane's own
// scroll owns the height (the retired enlarge overlay's max-height
// semantics moved here, unbounded within the pane).

import { useMemo } from "react";
import { VizDegradeDisclosure } from "./VizDegradeDisclosure";
import { VizExportFrame } from "./VizExportFrame";
import { useVizChartGate } from "./useVizChartGate";
import { decodeVizSpec } from "./viz";

export function VizStageView({ spec }: { spec: string }) {
  // The shared decode gate (viz.ts): the staged body is exactly a fence
  // body, so it degrades like one -- a decode failure is a disclosure, not
  // an empty pane.
  const decoded = useMemo(() => decodeVizSpec(spec), [spec]);
  // The render-failure gate rides the shared hook (#1085), keyed on the raw
  // spec text -- a re-staged chart body gets a fresh try.
  const { renderError, onError } = useVizChartGate(spec);

  const degradedReason = decoded.ok ? renderError : decoded.reason;
  // A bare <section> on purpose: the stage viz view carries no header facts,
  // so there is nothing to hook (no selector, no test needs one).
  return (
    <section>
      {decoded.ok && renderError === null && (
        <VizExportFrame spec={decoded.spec} onError={onError} />
      )}
      {degradedReason !== null && (
        <VizDegradeDisclosure reason={degradedReason} />
      )}
    </section>
  );
}
