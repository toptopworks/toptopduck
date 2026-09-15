import { useState } from "react";
import { FormattedMessage } from "react-intl";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RoundProse } from "./RoundProse";
import { ThinkingFold } from "./ThinkingFold";
import { TraceRowList } from "./TraceRow";
import type { TraceEntry, TraceRound } from "../../types/thread";

// The delegation entry's nested sub-trace viewer (ADR-0117 Decision 6, issue
// #934; the modal form was decided on the issue, triage comment): a
// delegation trace row renders a thin summary plus a view affordance; the
// dialog opens the sub-agent's rounds -- each round's thinking fold +
// connective prose + its tool-call string -- rendered by the same components
// the main trace uses, so a sub-round reads exactly like a main round. The
// dialog body scrolls (a sub-trace carries up to the sub-agent step cap's
// worth of rounds); the rows reuse TraceRowList, whose nesting is physically
// depth 1 (the sub-face excludes every delegation tool), so no recursion
// guard is needed.

/** The dialog's scrollable body: one section per sub-round, the thinking
 *  fold + prose + tool string rendered exactly as the main trace renders
 *  them. Never empty here: the dialog's self-guard below is the single
 *  gate, and no producer emits an empty sub-rounds array (the round
 *  convention is none-never-empty -- an empty-note branch at this layer
 *  was unreachable dead code, removed per the #946 review). */
function DelegationSubTraceBody({ rounds }: { rounds: ReadonlyArray<TraceRound> }) {
  return (
    <div className="space-y-3">
      {rounds.map((round, i) => (
        <div key={i} className="trace-round">
          {/* The round's thinking: the same honest fold the main trace
              renders, collapsed by default. */}
          {round.thinking && <ThinkingFold thinking={round.thinking} />}
          {/* The round's connective prose, the same markdown face the main
              rounds use. */}
          {round.text && <RoundProse text={round.text} />}
          {/* The round's tool string: the same row list the settled trace
              renders (a sub-agent's calls never carry their own sub-trace). */}
          <TraceRowList entries={round.calls} />
        </div>
      ))}
    </div>
  );
}

/** The delegation row's view affordance + the modal it opens. Owns the open
 *  state; the row renders the trigger button. */
export function DelegationTraceDialog({ entry }: { entry: TraceEntry }) {
  const [open, setOpen] = useState(false);
  const rounds = entry.sub_rounds ?? [];
  // Self-guarding: an entry without sub-rounds renders nothing at all -- the
  // callers inject the affordance unconditionally over their row lists, so
  // the gate on "does this row carry a sub-trace" lives here, once. (The
  // state hook stays above the guard -- rules-of-hooks.)
  if (rounds.length === 0) return null;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className="subtrace-open h-5 gap-0.5 px-1.5 text-xs text-muted-foreground"
        // stopPropagation: the affordance sits inside the row head's fold
        // toggle (the whole line toggles the summary fold on click); opening
        // the modal is a different action and must not also fold the row.
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <FormattedMessage
          id="thread.trace.viewSubtrace"
          defaultMessage="Sub-trace"
        />
        <ChevronRight aria-hidden="true" className="h-3 w-3" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="subtrace-dialog max-w-lg">
          <DialogHeader>
            {/* The delegation's identity + task head: layer-4 content
                (registry name, agent-written task), passing through. */}
            <DialogTitle className="subtrace-title text-left">
              <FormattedMessage
                id="thread.trace.subtraceTitle"
                defaultMessage="Sub-agent trace · {name}"
                values={{ name: entry.name }}
              />
            </DialogTitle>
            <DialogDescription className="subtrace-task text-left">
              {entry.summary}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto">
            <DelegationSubTraceBody rounds={rounds} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
