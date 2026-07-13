import { type ReactNode } from "react";
import { FormattedMessage } from "react-intl";

import { Alert, AlertDescription } from "./ui/alert";

// react-intl rich-text tag: <bold>...</bold> in a message resolves to <strong>,
// preserving the emphasis the prior hard-coded <strong> carried. Module-scope so
// the renderer identity stays stable across renders (react-refresh-friendly);
// shared by the three privacy messages below.
const boldValues = { bold: (chunks: ReactNode) => <strong>{chunks}</strong> };

// Privacy disclosure (ADR-0011/0029, issue #29): honest about the payload that
// leaves the machine when asking, and about where the API key lives. The LLM is
// wired -- asking sends the pruned schema + samples to the configured endpoint;
// loading still sends nothing. Rendered as a shadcn Alert (ADR-0050, issue
// #108) with the chrome text sourced from the react-intl catalog (ADR-0052 --
// the prior hard-coded zh violated the i18n invariant). role="note" overrides
// the Alert's assertive "alert" default: this is static reference info shown
// inside a collapsible <details>, not an announcement.
export function DisclosureBanner() {
  return (
    <Alert role="note">
      <AlertDescription className="space-y-2 text-card-foreground">
        <p>
          <FormattedMessage
            id="disclosure.privacy.payload"
            defaultMessage="The full dataset never leaves this machine. <bold>When you ask</bold>, the default payload sent = schema (column names + DuckDB types) + the first 3 sample rows frozen at load time (see the preview below), to the LLM endpoint you configured in Settings (Anthropic direct by default; configurable to your own Anthropic-protocol-compatible gateway — if you use a gateway, the payload passes through it, and its retention/training policy is yours to evaluate). <bold>Loading</bold> the data itself sends nothing. In each dataset's Privacy Controls you can <bold>turn off sample sending per dataset</bold> (no value from that dataset is ever sent), or <bold>mark a column as type-only</bold> (neither the column's values nor its name are sent, only its type) — you stay in full control."
            values={boldValues}
          />
        </p>
        <p>
          <FormattedMessage
            id="disclosure.privacy.apiKey"
            defaultMessage="<bold>API key isolation:</bold> your Anthropic API key lives only in this machine's OS keychain, read by the app's Rust core to make the endpoint call; the frontend and page never hold the key and have no arbitrary network egress. Aside from the LLM endpoint you configured, the app sends data to no server."
            values={boldValues}
          />
        </p>
        <p>
          <FormattedMessage
            id="disclosure.privacy.loading"
            defaultMessage="<bold>Loading semantics:</bold> each dataset is a read-only snapshot taken at load time (ADR-0012). An Excel workbook loads each sheet as a separate dataset; hidden sheets are skipped; formula cells take their cached value at load time (not recomputed), so later edits to the original file require a reload to show. Excel sheets are auto-rectified where possible — leading title rows skipped, merged cells un-merged (forward-filled) — to produce a single-header table; when auto-rectify can't pin down the header, you pick the header row and the rows to skip (your choice is recorded as that dataset's rectify params). .xls is not supported — save as .xlsx before loading."
            values={boldValues}
          />
        </p>
      </AlertDescription>
    </Alert>
  );
}
