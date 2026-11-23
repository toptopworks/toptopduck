// The swap-stable round skeleton (ADR-0103 live isomorphism, issues
// #610/#620): the settled TraceRoundBlock and the live exchange's
// per-round blocks mount the SAME wrapper + connective prose, so the
// settle swap does not move them. The settled round's other members ride
// this module too (the thinking fold below) or the `children` slot (the
// step fold + subtrace); the live side mounts the same members through
// the same slots (#1656) -- the tail round prose-only (its calls and
// thinking are the activity line's domain until the round seals), the
// sealed rounds with the thinking fold and the step fold exactly as the
// settled side. The max-w-full cap
// is unconditional: a non-stretched flex item (the stream's items-start)
// sizes its width by fit-content, which floors at min-content -- a nowrap
// summary then stretches the round past the card instead of truncating, and
// the cap hands the overflow back to the row's truncate (issue #826). Absent
// members render nothing (honest degrade: an entirely empty round -> no
// chrome at all); the guard consumes a falsy `children`.

import type { ReactNode } from "react";
import { RoundProse, type RoundProseMode } from "./RoundProse";
import { ThinkingFold } from "./ThinkingFold";
import type { ThinkingTrace } from "../../types/thread";

export function RoundBody({
  thinking,
  text,
  proseMode,
  onSelectViz,
  selectedVizSpec,
  children,
}: {
  thinking?: ThinkingTrace;
  text?: string;
  /** The prose render mode (issue #1128): "streaming" while the round
   *  still grows -- the caret arms and a vega-lite fence holds the
   *  placeholder until the round closes or the turn settles (ADR-0120
   *  Decision 4); absent for the settled rounds, where a fence decodes. */
  proseMode?: RoundProseMode;
  /** Issue #1093 viz passthrough: only the settled stream wires it; the live
   *  prose holds fences at the placeholder. */
  onSelectViz?: (spec: string) => void;
  selectedVizSpec?: string | null;
  children?: ReactNode;
}) {
  if (thinking === undefined && text === undefined && !children) return null;
  return (
    <div className="trace-round max-w-full">
      {thinking !== undefined && <ThinkingFold thinking={thinking} />}
      {text !== undefined && (
        // #1573: the caller-side selection-source mark -- this prose (the
        // settled trace round AND, through the live adapter, the streaming
        // live prose) is a selection-surface source. The wrapper stays
        // layout-inert: the prose root carries its own cap and spacing.
        <div data-selection-source="">
          <RoundProse
            text={text}
            mode={proseMode}
            onSelectViz={onSelectViz}
            selectedVizSpec={selectedVizSpec}
          />
        </div>
      )}
      {children}
    </div>
  );
}
