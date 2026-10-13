import { useQuery } from "@tanstack/react-query";
import { FormattedMessage, useIntl } from "react-intl";

import { conversation } from "../../api";
import { sessionKeys } from "../../session/queryKeys";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { formatPercent, formatTokens } from "./tokenFormat";
import type { OccupancySnapshot, ThreadEntry } from "../../types/thread";

// The composer's occupancy ring (ADR-0130, issue #1272): the send
// cluster's head constant, ahead of the runtime picker (issue #1276) -- a
// three-state reading whose every state maps an evidence shape, never a
// guess:
// - FULL ring: denominator known (the active profile's context_limit, or the
//   ACP snapshot's own window) -- a percentage arc, warning above 70%,
//   danger above 90%.
// - HOLLOW ring: numerator only (a reading landed, no window) -- the track
//   renders, no arc, no invented percentage.
// - NOT RENDERED: no reading ever landed (the channel stayed fail-closed).
// Hover opens the runtime picker's tooltip pill: a single line, the
// occupancy figure alone -- the session total retired from it, the
// turn's usage pill stays the billing display (ADR-0130 Decision 1).
// Numbers ride the
// fixed K/M scale (ADR-0130 Decision 5).

/** Above this filled fraction the arc takes the warning color. */
const WARNING_THRESHOLD = 0.7;
/** Above this filled fraction the arc takes the danger color. */
const DANGER_THRESHOLD = 0.9;
/** The ring's SVG geometry (16px viewBox, r=6, 2px stroke). */
const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export type OccupancyRingProps = {
  /** The timeline the reading derives from. Empty /
   * null (cold start, no active session) renders nothing. */
  entries: readonly ThreadEntry[] | null;
  /** The active profile's configured context window (ADR-0130 Decision 4).
   * Ignored when the reading itself carries a window (the ACP snapshot's
   * size is the channel's own report). */
  contextLimit?: number | null;
};

/** The latest occupancy reading in the timeline (the freshest measurement
 * wins -- a later turn without one does not erase it, an occupancy reading
 * is a reference figure, not a per-turn invariant). */
function latestOccupancy(entries: readonly ThreadEntry[]): OccupancySnapshot | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.entry === "Turn" && entry.data.occupancy != null) {
      return entry.data.occupancy;
    }
  }
  return null;
}

export function OccupancyRing({ entries, contextLimit = null }: OccupancyRingProps) {
  const intl = useIntl();
  if (entries == null) return null;
  const occupancy = latestOccupancy(entries);
  // No reading ever reported: no ring at all (the not-rendered state).
  if (occupancy == null) return null;
  // The denominator merge: the reading's own window (ACP) outranks the
  // config; a non-positive window on EITHER side is the no-window shape,
  // never a divide-by hazard.
  const limit =
    (occupancy.limit != null && occupancy.limit > 0 ? occupancy.limit : null) ??
    (contextLimit != null && contextLimit > 0 ? contextLimit : null);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-label={intl.formatMessage({
            id: "thread.occupancy.ariaLabel",
            defaultMessage: "Context occupancy",
          })}
        >
          <RingGlyph tokens={occupancy.tokens} limit={limit} />
        </button>
      </TooltipTrigger>
      {/* The runtime picker's pill shape (same component, same tokens): one
          line, the occupancy figure alone -- the glance is a send-decision
          reference, the billing sums live on the turn's usage pill (ADR-0130
          Decision 1). */}
      <TooltipContent side="top">
        {limit != null ? (
          <FormattedMessage
            id="thread.occupancy.main"
            defaultMessage="{pct}% · {used} / {limit} of context used"
            values={{
              pct: formatPercent(occupancy.tokens, limit),
              used: formatTokens(occupancy.tokens, intl),
              limit: formatTokens(limit, intl),
            }}
          />
        ) : (
          <FormattedMessage
            id="thread.occupancy.hollow"
            defaultMessage="{n} tokens used · context window unknown"
            values={{ n: formatTokens(occupancy.tokens, intl) }}
          />
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/** The cold-start key stand-in: the disabled query (sessionId null) still
 * needs a well-typed key, and one that matches no real session's. */
const NO_SESSION_KEY = "__no_session__";

/** The shell-side mount (ADR-0130, issue #1272): subscribes to the session's
 * thread on the SAME TanStack cache the SessionPane's query owns (one key,
 * one fetch, staleTime Infinity -- this subscription adds a reader at the
 * shell, never a second request), then renders the ring off it. A component
 * (not a hook in App) because the subscription must live INSIDE the
 * QueryClientProvider -- App's own body sits above it. The disabled form
 * (null id, cold start) matches no session's key and never fetches. */
export function ComposerOccupancy({
  sessionId,
  contextLimit = null,
}: {
  sessionId: string | null;
  contextLimit?: number | null;
}) {
  const { data } = useQuery({
    queryKey: sessionKeys.thread(sessionId ?? NO_SESSION_KEY),
    queryFn: () => conversation(sessionId ?? NO_SESSION_KEY),
    enabled: sessionId != null,
  });
  return <OccupancyRing entries={data ?? null} contextLimit={contextLimit} />;
}

/** The pure glyph: a 16px ring, arc only when the window is known. */
function RingGlyph({ tokens, limit }: { tokens: number; limit: number | null }) {
  const filled = limit != null && limit > 0 ? Math.min(1, tokens / limit) : null;
  const arcColor =
    filled == null
      ? undefined
      : filled > DANGER_THRESHOLD
        ? "var(--destructive)"
        : filled > WARNING_THRESHOLD
          ? "var(--warning)"
          : "var(--primary)";
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2"
        className="stroke-border"
      />
      {filled != null && (
        <circle
          cx="8"
          cy="8"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="2"
          stroke={arcColor}
          strokeLinecap="round"
          strokeDasharray={`${filled * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
          transform="rotate(-90 8 8)"
        />
      )}
    </svg>
  );
}
