// The settled turn's process fold (issue #1282): the per-round blocks --
// thinking folds, connective prose, per-round step folds -- tuck behind ONE
// collapsed head, so the settled card reads question -> one head -> answer.
// The head names the turn's TERMINAL STATE -- the outcome mark's label, the
// same vocabulary the meta row's glyph aria-labels -- plus the frozen wall
// clock: a rail scan of collapsed cards reads status + duration at a glance
// (the reference posture). The word duplicates no visible text except on
// the Cancelled card, whose body IS the label (the #883 vocabulary split);
// the meta row's outcome is icon-only and the Failed card's reason
// narrative stays its own. Collapsed is the mount posture: the settle swap
// (the live exchange streams unfurled -- ADR-0078's visible-as-they-land
// posture ends at settle) mounts the settled card fresh, so no lifecycle
// latch exists; from there the user's toggle owns the state. Expanding
// mounts the incumbent round blocks verbatim. A trace with no content at
// all renders no head -- the children pass through bare (the same
// empty-guard philosophy as RoundBody). Either stamp missing renders the
// bare label (the ADR-0103 honest-degrade rule), and so does a settled
// stamp that predates its ask -- a backward clock step degrades bare
// rather than minting a floor-seconds face.

import { useState, type ReactNode } from "react";
import { ElapsedFace } from "./ElapsedFace";
import { FoldToggle } from "./FoldToggle";
import type { TraceRound } from "../../types/thread";

export function TurnProcessFold({
  trace,
  label,
  askedAt,
  settledAt,
  children,
}: {
  trace: TraceRound[];
  /** The head's status word -- the outcome mark's label (TurnCard computes
   *  it once for the glyph too), so the fold speaks the outcome vocabulary
   *  instead of carrying a process word of its own. */
  label: string;
  askedAt?: number;
  settledAt?: number;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  // The content predicate mirrors the members the round blocks render
  // (thinking, prose, calls) -- extend it alongside them when a round
  // grows a new renderable member.
  const hasContent = trace.some(
    (round) =>
      round.thinking !== undefined || round.text !== undefined || round.calls.length > 0,
  );
  if (!hasContent) return <>{children}</>;
  return (
    <>
      <FoldToggle
        hookClass="process-toggle"
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
      >
        {label}
        {askedAt !== undefined && settledAt !== undefined && settledAt >= askedAt && (
          <ElapsedFace seconds={Math.floor((settledAt - askedAt) / 1000)} />
        )}
      </FoldToggle>
      {expanded && children}
    </>
  );
}
