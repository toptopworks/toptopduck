import { FormattedMessage, useIntl } from "react-intl";

import { cn } from "@/lib/utils";

import { formatTokens } from "./tokenFormat";
import type { TokenUsage } from "../../types/thread";

// The usage footer (ADR-0129 Decision 5, issue #1270): the turn card's
// always-visible token line -- input (with its cache-read breakdown) and
// output as absolute numbers on the fixed K/M scale (ADR-0130 Decision 5;
// 1.2K, 3.4M -- locale-independent), segments parted by ` · `. The
// cache-write and reasoning counters persist as a labeled
// native <details> toggle (issue #1276): collapsed it names its items, open
// it carries their numbers inline (the [open] gate lives in app.css).
// Labels read muted, numbers foreground tabular -- the turn card's
// muted-prefix convention. No price conversion, no percentage, no
// model-cap table (all explicitly out of scope, Decision 5) --
// provider-reported absolute numbers are the whole display.

/** The number's level span (issue #1276): foreground + tabular figures
 * against the muted label text -- the react-intl element value keeps the
 * locale string whole ("Input {n}") while the number lands in its own
 * element, so queries and copy stay clean. */
function UsageNumber({ children, className }: { children: string; className?: string }) {
  return <span className={cn("text-foreground tabular-nums", className)}>{children}</span>;
}

/** The always-visible segment pair: input (with the cache-read breakdown
 * when non-zero) and output. The separators ride whitespace-pre spans:
 * bare text children of the flex root wrap into anonymous flex items
 * whose flanking spaces collapse, gluing the dot to its neighbors (issue
 * #1276). Pure -- unit-tested without the fold. */
function UsageSegments({ usage }: { usage: TokenUsage }) {
  const intl = useIntl();
  return (
    <>
      <span className="usage-seg text-muted-foreground">
        <FormattedMessage
          id="thread.usage.input"
          defaultMessage="Input {n}"
          values={{
            n: <UsageNumber>{formatTokens(usage.input_tokens, intl)}</UsageNumber>,
          }}
        />
      </span>
      {usage.cache_read_tokens > 0 && (
        <>
          <span className="whitespace-pre">{" · "}</span>
          <span className="usage-seg text-muted-foreground">
            <FormattedMessage
              id="thread.usage.cache"
              defaultMessage="cache {n}"
              values={{
                n: (
                  <UsageNumber>
                    {formatTokens(usage.cache_read_tokens, intl)}
                  </UsageNumber>
                ),
              }}
            />
          </span>
        </>
      )}
      <span className="whitespace-pre">{" · "}</span>
      <span className="usage-seg text-muted-foreground">
        <FormattedMessage
          id="thread.usage.output"
          defaultMessage="Output {n}"
          values={{
            n: (
              <UsageNumber>{formatTokens(usage.output_tokens, intl)}</UsageNumber>
            ),
          }}
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
    <span className="usage-footer inline-flex items-center">
      <UsageSegments usage={usage} />
      {hasFold && (
        <>
          <span className="whitespace-pre">{" · "}</span>
          {/* The technical fold: cache write + reasoning as a labeled
              native <details> -- the same self-contained toggle posture the
              trace's folds take (no controlled state, zero JS). Collapsed
              the toggle names its items; the numbers ride the [open] gate
              (app.css), so open they read inline after the names. */}
          <details className="usage-fold">
            <summary className="cursor-pointer list-none">
              <span className="usage-fold-marker" aria-hidden="true">
                ▸
              </span>
              {" "}
              {usage.cache_write_tokens > 0 && (
                <span className="text-muted-foreground">
                  <FormattedMessage
                    id="thread.usage.cacheWrite"
                    defaultMessage="cache write {n}"
                    values={{
                      n: (
                        <UsageNumber className="usage-fold-num">
                          {formatTokens(usage.cache_write_tokens, intl)}
                        </UsageNumber>
                      ),
                    }}
                  />
                </span>
              )}
              {usage.cache_write_tokens > 0 &&
                usage.reasoning_tokens !== undefined && " · "}
              {usage.reasoning_tokens !== undefined && (
                <span className="text-muted-foreground">
                  <FormattedMessage
                    id="thread.usage.reasoning"
                    defaultMessage="reasoning {n}"
                    values={{
                      n: (
                        <UsageNumber className="usage-fold-num">
                          {formatTokens(usage.reasoning_tokens, intl)}
                        </UsageNumber>
                      ),
                    }}
                  />
                </span>
              )}
            </summary>
          </details>
        </>
      )}
    </span>
  );
}
