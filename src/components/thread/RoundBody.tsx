// The swap-stable round skeleton (ADR-0103 live isomorphism, issues
// #610/#620): the settled TraceRoundBlock and the streaming LiveRoundBlock
// mount the SAME wrapper + empty guard + thinking fold + connective prose, so
// the settle swap does not move them. The round's third member -- the tool
// rows -- is genuinely different (the settled step fold + subtrace slot vs
// the live streaming rows) and rides the `children` slot. The max-w-full cap
// is unconditional: a non-stretched flex item (the stream's items-start)
// sizes its width by fit-content, which floors at min-content -- a nowrap
// summary then stretches the round past the card instead of truncating, and
// the cap hands the overflow back to the row's truncate (issue #826). Absent
// members render nothing (honest degrade: an entirely empty round -> no
// chrome at all); the guard consumes a falsy `children`, so adapters pass
// `rows.length > 0 && <...>` rather than hoisting the emptiness check.

import type { ReactNode } from "react";
import { RoundProse, type RoundProseMode } from "./RoundProse";
import { ThinkingFold } from "./ThinkingFold";
import type { ThinkingTrace } from "../../types/thread";

export function RoundBody({
  thinking,
  text,
  proseMode,
  initialThinkingExpanded = false,
  onThinkingExpandedChange,
  onSelectViz,
  selectedVizSpec,
  children,
}: {
  thinking?: ThinkingTrace;
  text?: string;
  /** The prose render mode (issue #1128): "streaming" while the round
   *  streams -- the caret arms and a vega-lite fence holds the placeholder
   *  until the settle swap (ADR-0120 Decision 4); absent for the settled
   *  rounds, where a fence decodes. */
  proseMode?: RoundProseMode;
  /** Issue #620: seeds the thinking fold mounted already open -- the settled
   *  adapter reads the live posture out of the thread's seed set. */
  initialThinkingExpanded?: boolean;
  /** Issue #620: reports the fold's posture whenever it or the block's
   *  identity changes -- the live adapter snapshots it for the settle seed.
   *  Pass a stable callback (the adapter's useCallback): the fold's report
   *  effect re-fires on identity churn otherwise. */
  onThinkingExpandedChange?: (expanded: boolean) => void;
  /** Issue #1093 viz passthrough: only the settled stream wires it; the live
   *  prose holds fences at the placeholder. */
  onSelectViz?: (spec: string) => void;
  selectedVizSpec?: string | null;
  children?: ReactNode;
}) {
  if (thinking === undefined && text === undefined && !children) return null;
  return (
    <div className="trace-round max-w-full">
      {thinking !== undefined && (
        <ThinkingFold
          thinking={thinking}
          initialExpanded={initialThinkingExpanded}
          onExpandedChange={onThinkingExpandedChange}
        />
      )}
      {text !== undefined && (
        <RoundProse
          text={text}
          mode={proseMode}
          onSelectViz={onSelectViz}
          selectedVizSpec={selectedVizSpec}
        />
      )}
      {children}
    </div>
  );
}
