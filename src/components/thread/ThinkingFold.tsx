// The per-round thinking fold (ADR-0103): an honest duration label (seconds,
// one decimal), collapsed by default; the raw reasoning text is layer-4
// content and passes through untranslated in a muted, scroll-capped block.
// Extracted from the settled TraceRoundBlock (issue #609) so the live round
// block (issue #610) renders the identical fold. Uncontrolled: the fold
// state lives here, with two optional seams for the live -> settled
// continuity (issue #620) -- `initialExpanded` seeds a fold mounted already
// open (the settled round picks up the live fold the user left open), and
// `onExpandedChange` reports the current posture whenever it or the block's
// identity changes, so the caller can snapshot the posture across the swap
// (a same-round repeated completion swaps the thinking reference -- the
// report must follow the NEW one). Fold state is session-ephemeral either
// way.

import { useEffect, useState } from "react";
import { FormattedMessage } from "react-intl";
import { FoldToggle } from "./FoldToggle";
import type { ThinkingTrace } from "../../types/thread";

export function ThinkingFold({
  thinking,
  initialExpanded = false,
  onExpandedChange,
}: {
  thinking: ThinkingTrace;
  initialExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  // Report on every posture/identity change (idempotent -- the collector
  // no-ops a report that matches its current state): a toggle flips
  // `expanded`; a last-wins completion swaps `thinking` while the fold the
  // user opened stays open, and the report must carry the new reference or
  // the settle seed keys on a block the settled round no longer holds.
  useEffect(() => {
    onExpandedChange?.(expanded);
  }, [expanded, thinking, onExpandedChange]);
  const toggle = () => setExpanded((e) => !e);
  return (
    <>
      <FoldToggle hookClass="thinking-toggle" expanded={expanded} onToggle={toggle}>
        <FormattedMessage
          id="thread.trace.thinkingToggle"
          defaultMessage="Thinking · {sec}s"
          values={{ sec: (thinking.duration_ms / 1000).toFixed(1) }}
        />
      </FoldToggle>
      {expanded && (
        <p className="round-thinking m-0 mt-0.5 ml-5 rounded-md bg-muted p-2 text-xs text-muted-foreground whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
          {thinking.text}
        </p>
      )}
    </>
  );
}
