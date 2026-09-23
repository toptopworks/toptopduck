// The chart degrade disclosure (ADR-0033, ADR-0052): the warning Alert that
// replaces a failed chart on the surfaces where nothing rides under it -- the
// vega-lite fence and the enlarge overlay's dialog body. Extracted at the
// third verbatim copy (#1050 review): one place for the wording decision and
// the role/variant pairing, so the surfaces cannot drift apart on the same
// four reasons. The result card keeps its own variant (a table rides under
// its chart, so its wording names that fallback instead).

import { FormattedMessage, useIntl } from "react-intl";
import { Alert, AlertDescription } from "../ui/alert";
import { formatVizFailure } from "./viz-failure";
import type { VizFailureReason } from "./viz";

/** The honest disclosure for a chart that failed to decode or render:
 *  warning Alert (ADR-0050), role="status", {reason} through the shared
 *  catalog path so it lands in the active locale (ADR-0052). Bare on
 *  purpose where mounted in prose -- the caller's rhythm owns the spacing. */
export function VizDegradeDisclosure({ reason }: { reason: VizFailureReason }) {
  const intl = useIntl();
  return (
    <Alert variant="warning" role="status">
      <AlertDescription>
        <FormattedMessage
          id="disclosure.viz.fenceDegraded"
          defaultMessage="The chart could not render. {reason}"
          values={{ reason: formatVizFailure(reason, intl) }}
        />
      </AlertDescription>
    </Alert>
  );
}
