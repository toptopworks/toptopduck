import { FormattedMessage, useIntl } from "react-intl";
import { Zap } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

import { formatPercent, formatTokens } from "./tokenFormat";
import type { TokenUsage } from "../../types/thread";

// The usage pill (ADR-0129 Decision 5 as recalibrated by issue #1278):
// the turn card's always-visible token surface is a pill naming the
// turn's derived total (input + output) on the fixed K/M scale
// (ADR-0130 Decision 5; 1.2K, 3.4M -- locale-independent); the bucket
// detail -- input with its cache-read breakdown and hit rate, cache
// write, output, reasoning -- rides a click-open Popover (the technical
// <details> fold it replaces is retired with its [open]-gate CSS). The
// cache hit rate is cache-read over input through the shared percent
// formatter (a subset never reads past its whole, so the 100 cap holds),
// shown only while the read breakdown is non-zero: after normalization a
// zero read cannot distinguish "no hits" from "upstream did not report
// one", and no rate is the only honest posture. In the detail rows
// labels read muted, numbers foreground tabular -- the turn card's
// muted-prefix convention; the pill itself reads muted until hover.
// No price conversion, no model-cap table (both stay out of scope,
// Decision 5) -- provider-reported absolute numbers are the whole
// display.

/** The number's level span (issue #1276): foreground + tabular figures
 * against the muted label text -- the react-intl element value keeps
 * the locale string whole ("Input {n}") while the number lands in its
 * own element, so queries and copy stay clean. */
function UsageNumber({ children }: { children: string }) {
  return <span className="text-foreground tabular-nums">{children}</span>;
}

/** The turn card's usage pill. The zero/absent shapes never mount this
 * component at all -- the fail-closed rule runs upstream (a turn without
 * provider evidence carries no `usage` field, so the caller's conditional
 * is the whole guard). */
export function UsageFooter({ usage }: { usage: TokenUsage }) {
  const intl = useIntl();
  // The derived grand total (ADR-0129 Decision 1: no stored total field).
  const total = usage.input_tokens + usage.output_tokens;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="usage-footer inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Zap aria-hidden="true" className="size-4" />
          <FormattedMessage
            id="thread.usage.total"
            defaultMessage="Used {n}"
            values={{ n: formatTokens(total, intl) }}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-3 text-xs">
        {/* The detail title grounds the pill's figure: these are the
            turn's provider-reported buckets. */}
        <div className="font-medium text-foreground">
          <FormattedMessage
            id="thread.usage.title"
            defaultMessage="Turn usage"
          />
        </div>
        <div className="mt-1.5 space-y-1">
          <div className="text-muted-foreground">
            <FormattedMessage
              id="thread.usage.input"
              defaultMessage="Input {n}"
              values={{
                n: (
                  <UsageNumber>
                    {formatTokens(usage.input_tokens, intl)}
                  </UsageNumber>
                ),
              }}
            />
          </div>
          {usage.cache_read_tokens > 0 && (
            <div className="text-muted-foreground">
              <FormattedMessage
                id="thread.usage.cache"
                defaultMessage="cache {n} · {pct}%"
                values={{
                  n: (
                    <UsageNumber>
                      {formatTokens(usage.cache_read_tokens, intl)}
                    </UsageNumber>
                  ),
                  pct: formatPercent(usage.cache_read_tokens, usage.input_tokens),
                }}
              />
            </div>
          )}
          {usage.cache_write_tokens > 0 && (
            <div className="text-muted-foreground">
              <FormattedMessage
                id="thread.usage.cacheWrite"
                defaultMessage="cache write {n}"
                values={{
                  n: (
                    <UsageNumber>
                      {formatTokens(usage.cache_write_tokens, intl)}
                    </UsageNumber>
                  ),
                }}
              />
            </div>
          )}
          <div className="text-muted-foreground">
            <FormattedMessage
              id="thread.usage.output"
              defaultMessage="Output {n}"
              values={{
                n: (
                  <UsageNumber>
                    {formatTokens(usage.output_tokens, intl)}
                  </UsageNumber>
                ),
              }}
            />
          </div>
          {usage.reasoning_tokens !== undefined && (
            <div className="text-muted-foreground">
              <FormattedMessage
                id="thread.usage.reasoning"
                defaultMessage="reasoning {n}"
                values={{
                  n: (
                    <UsageNumber>
                      {formatTokens(usage.reasoning_tokens, intl)}
                    </UsageNumber>
                  ),
                }}
              />
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
