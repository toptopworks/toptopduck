import { type ReactNode } from "react";
import { FormattedMessage } from "react-intl";

import { Alert, AlertDescription } from "../ui/alert";

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
            defaultMessage="<bold>When you ask a question</bold>, part of your data is sent to the AI endpoint you configured in Settings — never the full dataset. What is sent: the table schema (column names and types) plus the first 3 sample rows captured at load time. <bold>Loading a file</bold> sends nothing at all. The endpoint is Anthropic by default, or your own compatible gateway — if you use a gateway, requests pass through it, and its retention and training policies are yours to check. You stay in control: in each dataset's privacy controls you can <bold>turn off sample sending</bold> for that dataset (nothing from it is ever sent), or <bold>mark a column as type-only</bold> (only the type is sent — not the name, not the values)."
            values={boldValues}
          />
        </p>
        <p>
          <FormattedMessage
            id="disclosure.privacy.apiKey"
            defaultMessage="<bold>API key isolation:</bold> your API key is stored only in this computer's keychain and is used solely to call the endpoint you configured. The app never sends your data to any other server."
            values={boldValues}
          />
        </p>
        <p>
          <FormattedMessage
            id="disclosure.privacy.loading"
            defaultMessage="<bold>Loading:</bold> each dataset is a read-only snapshot taken when the file loads — if you edit the original file afterwards, reload to see the changes. Excel: each sheet becomes its own dataset, hidden sheets are skipped, and formula cells keep their saved values. Sheets are auto-tidied into a single header table where possible; when the header is unclear, you pick it yourself. .xls is not supported — save as .xlsx first."
            values={boldValues}
          />
        </p>
      </AlertDescription>
    </Alert>
  );
}
