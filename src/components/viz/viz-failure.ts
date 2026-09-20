// The typed viz failure reason rendered as a locale-catalog string (ADR-0052
// i18n closeout, issue #138). Both decode failures (from the viz.ts gate) and
// render failures (from VegaChart) flow through here on every chart surface --
// the result card (ResultView) and a round-prose vega-lite fence (VizFence,
// ADR-0120) -- so the {reason} interpolated into a disclosure is always in the
// active locale and no Chinese leaks into an en-US disclosure. The `mark` on
// unsupportedMark is engine output (layer 4 -- never translated), interpolated
// verbatim. The `default` arm keeps the switch exhaustive as VizFailureReason
// grows. Shared module rather than a per-surface copy: the two surfaces must
// not drift apart on the same four reasons.

import type { IntlShape } from "react-intl";
import type { VizFailureReason } from "./viz";

export function formatVizFailure(reason: VizFailureReason, intl: IntlShape): string {
  switch (reason.kind) {
    case "invalidJson":
      return intl.formatMessage({
        id: "viz.error.invalidJson",
        defaultMessage: "the spec is not valid JSON",
      });
    case "notObject":
      return intl.formatMessage({
        id: "viz.error.notObject",
        defaultMessage: "the spec is not a Vega-Lite object",
      });
    case "unsupportedMark":
      return intl.formatMessage(
        {
          id: "viz.error.unsupportedMark",
          defaultMessage:
            "the chart type \"{mark}\" is not supported (only bar/line/area/scatter/pie/heatmap)",
        },
        { mark: reason.mark },
      );
    case "render":
      return intl.formatMessage({
        id: "viz.error.render",
        defaultMessage: "render error",
      });
    default: {
      const unhandled: never = reason;
      throw new Error(`unhandled VizFailureReason kind: ${JSON.stringify(unhandled)}`);
    }
  }
}
