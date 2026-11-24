// The per-round thinking fold (ADR-0103): an honest duration label (seconds,
// one decimal), collapsed by default; the raw reasoning text is layer-4
// content and passes through untranslated in a muted, scroll-capped block.
// Extracted from the settled TraceRoundBlock (issue #609) so the live
// activity line's expanded face (issue #1606) renders the identical fold
// -- one chrome, one label, both phases. Uncontrolled: the fold state
// lives here, session-ephemeral either way.

import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { FoldToggle } from "./FoldToggle";
import { THINKING_TEXT_CLASS } from "./thinkingTextStyles";
import type { ThinkingTrace } from "../../types/thread";

export function ThinkingFold({ thinking }: { thinking: ThinkingTrace }) {
  const [expanded, setExpanded] = useState(false);
  const intl = useIntl();
  const toggle = () => setExpanded((e) => !e);
  return (
    <>
      {/* The head steps one tier below the body (13px, body-sm): the fold
          head reads as chrome beside its 14px prose, not as a second body
          line. Same tier as the trace fold heads, so the fold family reads
          as one chrome. */}
      <FoldToggle
        hookClass="thinking-toggle"
        expanded={expanded}
        onToggle={toggle}
        className="text-[13px]"
      >
        <FormattedMessage
          id="thread.trace.thinkingToggle"
          defaultMessage="Thinking · {sec}s"
          values={{ sec: (thinking.duration_ms / 1000).toFixed(1) }}
        />
      </FoldToggle>
      {/* Keyboard-reachable scroll region (#1363): the tabindex puts the
          height-capped block in the Tab order so arrow keys scroll it
          instead of the page; the region label names it for assistive
          tech. */}
      {expanded && (
        <p
          className={THINKING_TEXT_CLASS}
          tabIndex={0}
          role="region"
          aria-label={intl.formatMessage({
            id: "thread.trace.thinkingAria",
            defaultMessage: "Agent thinking",
          })}
        >
          {thinking.text}
        </p>
      )}
    </>
  );
}
