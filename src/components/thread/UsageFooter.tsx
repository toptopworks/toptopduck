import { FormattedMessage, useIntl } from "react-intl";

import { formatTokens } from "./tokenFormat";
import type { TokenUsage } from "../../types/thread";

// The usage footer (ADR-0129 Decision 5, issue #1270): the turn card's
// always-visible token line -- input (with its cache-read breakdown) and
// output as absolute numbers on the fixed K/M scale (ADR-0130 Decision 5;
// 1.2K, 3.4M -- locale-independent).
// The cache-write and reasoning counters persist but ride the technical
// fold (a collapsed <details>): they are billing-side detail, not the
// reading surface. No price conversion, no percentage, no model-cap table
// (all explicitly out of scope, Decision 5) -- provider-reported absolute
// numbers are the whole display.

/** The always-visible segment pair: input (with the cache-read breakdown
 * when non-zero) and output. Pure -- unit-tested without the fold. */
function UsageSegments({ usage }: { usage: TokenUsage }) {
  const intl = useIntl();
  // One <span> per segment: each number is its own element (a text run
  // never merges with its siblings, so queries and copy both stay clean).
  return (
    <>
      <span className="usage-seg">
        <FormattedMessage
          id="thread.usage.input"
          defaultMessage="Input {n}"
          values={{ n: formatTokens(usage.input_tokens, intl) }}
        />
      </span>
      {usage.cache_read_tokens > 0 && (
        <span className="usage-seg">
          <FormattedMessage
            id="thread.usage.cache"
            defaultMessage="cache {n}"
            values={{ n: formatTokens(usage.cache_read_tokens, intl) }}
          />
        </span>
      )}
      <span className="usage-seg">
        <FormattedMessage
          id="thread.usage.output"
          defaultMessage="Output {n}"
          values={{ n: formatTokens(usage.output_tokens, intl) }}
        />
      </span>
    </>
  );
}

/** The turn card's usage footer. The zero/absent shapes never mount this
 * component at all -- the fail-closed rule runs upstream (a turn without
 * provider evidence carries no `usage` field, so the caller's conditional
 * is the whole guard). */
export function UsageFooter({ usage }: { usage: TokenUsage }) {
  const intl = useIntl();
  const hasFold =
    usage.cache_write_tokens > 0 || usage.reasoning_tokens !== undefined;
  return (
    <span className="usage-footer inline-flex items-center gap-1.5">
      <UsageSegments usage={usage} />
      {hasFold && (
        // The technical fold: cache write + reasoning, collapsed by
        // default -- a native <details>, the same self-contained toggle
        // posture the trace's folds take (no controlled state).
        <details className="usage-fold inline-block">
          <summary className="cursor-pointer list-none">
            <FormattedMessage
              id="thread.usage.more"
              defaultMessage="…"
            />
          </summary>
          <span className="usage-fold-body block">
            {usage.cache_write_tokens > 0 && (
              <FormattedMessage
                id="thread.usage.cacheWrite"
                defaultMessage="cache write {n}"
                values={{ n: formatTokens(usage.cache_write_tokens, intl) }}
              />
            )}
            {usage.reasoning_tokens !== undefined && (
              <FormattedMessage
                id="thread.usage.reasoning"
                defaultMessage="reasoning {n}"
                values={{ n: formatTokens(usage.reasoning_tokens, intl) }}
              />
            )}
          </span>
        </details>
      )}
    </span>
  );
}
