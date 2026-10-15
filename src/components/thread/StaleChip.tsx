// The clickable stale causal chip (ADR-0041/0047): a compact label that jumps
// to the invalidating source event. Disabled (not hidden) when no matching event
// follows the turn, so the chip never promises a jump it cannot perform -- the
// title then explains why. Extracted so the verb is computed once and the
// Materialized body reads cleanly. The wording splits honestly by reason:
// Replaced = re-askable, Deleted = gone.

import { useIntl } from "react-intl";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { staleChipVerb } from "./turn-visual";
import type { StaleReason } from "../../types/dataset";

export function StaleChip({
  reason,
  hasJumpTarget,
  onJump,
}: {
  reason: StaleReason;
  hasJumpTarget: boolean;
  onJump: (() => void) | undefined;
}) {
  const intl = useIntl();
  const verb = staleChipVerb(intl, reason);
  // Badge secondary = muted-neutral (ADR-0050 stale semantic); asChild merges
  // the variant onto the <button> so the chip stays a real focusable / clickable
  // control with a disabled state. ADR-0067 (issue #169): the stale-chip class
  // now carries layout + the disabled dim only; the variant owns the color so
  // the chip rides the --secondary token and flips with .dark. The hover tint
  // (ADR-0050 stale = muted) is gated on enabled: the inert chip never promises
  // a hover it cannot perform. The disabled dim is opacity-[0.55] -- a value
  // between Tailwind v4's 0.4/0.5/0.6 opacity steps (hence the arbitrary
  // bracket), tuned so the inert chip still reads as present without inviting a
  // click.
  return (
    <Badge
      variant="secondary"
      asChild
      className={cn(
        "stale-chip ml-1 cursor-pointer",
        "enabled:hover:bg-muted disabled:cursor-not-allowed disabled:opacity-[0.55]",
      )}
    >
      <button
        type="button"
        disabled={!hasJumpTarget}
        aria-label={intl.formatMessage(
          {
            id: "thread.staleChip.aria",
            defaultMessage: "Stale because {reason}, jump to the source event",
          },
          { reason: verb },
        )}
        title={
          hasJumpTarget
            ? undefined
            : intl.formatMessage({
                id: "thread.staleChip.noTarget",
                defaultMessage: "Source event no longer in the timeline",
              })
        }
        onClick={onJump}
      >
        {verb}
      </button>
    </Badge>
  );
}
