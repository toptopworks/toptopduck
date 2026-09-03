// The result header's take-it-away affordances (issue #769): export the full
// result as CSV and copy the full result as TSV. Both pull every row through
// the core's full path (no display-page cap, no page stitching), both carry
// the header row, and both stay available on a stale result -- the rows are
// real, the staleness disclosure has already done its duty, and the payload
// is pure data with no status markers.
//
// Export opens the native save dialog first (the session-export precedent): a
// cancel is a quiet no-op -- no write, no error. Copy fetches the TSV text
// then writes the system clipboard, acknowledging in place with the shared
// copied-ack hook (CopyButton's glyph + tooltip flip, constant box, no
// toast). ONE busy flag covers both actions (no re-trigger, no concurrent
// full pulls; no progress bar by design). Failures surface through the
// caller's error lane (toAppError read semantics -> ResultView's ErrorBanner)
// -- never silent, never a fake ack, and logged to the plugin sink either
// way. A ResultActions instance is reused across result switches (the header
// remounts on nothing), so settle-time effects (the error lane, the copied
// ack) are dropped when the result they started from is no longer on screen
// -- a late failure lands on the result that started the pull, not whichever
// result the user switched to.
//
// Full-pull guardrails (issue #779): a pull over the backend confirm
// threshold refuses with TooLarge, which parks the confirm dialog here (the
// re-send passes confirmed, reusing the destination the user already chose
// for export); a pull stopped through the session's cancel token ends with
// Cancelled, a quiet no-op like the save-dialog cancel -- the user asked for
// it, so neither the error lane nor an ack fires. While a pull is busy both
// buttons become stop entries: the cancel token fires without the session
// lock (ADR-0021), so the stop lands even while the pull itself holds it,
// and the row loop observes the flag within one row.
//
// i18n (ADR-0052): the shared "Copied" flip reuses thread.copy.copied's id;
// the idle / stop labels and the confirm dialog are this file's own literals
// for @formatjs/cli extract.

import { useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Check, Copy, Download, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useCopiedAck } from "./useCopiedAck";
import { cancelQuery, exportRowsCsv, readRowsTsv } from "../../api";
import { classifyFullPullRejection } from "../../lib/error-presentation";
import { log } from "../../lib/log";

// A TooLarge refusal parked on the confirm dialog (issue #779): which action
// to re-send with confirmed, the export destination (null for copy), and the
// row count the prompt quotes.
type PendingLargePull = {
  action: "export" | "copy";
  dest: string | null;
  rowCount: number;
};

export function ResultActions({
  sessionId,
  referenceName,
  onError,
}: {
  sessionId: string;
  referenceName: string;
  /** Failure lane: the caller wraps the reject with toAppError read semantics. */
  onError: (e: unknown) => void;
}) {
  const intl = useIntl();
  // One busy flag covers both actions, so neither can re-trigger (or start
  // alongside the other) until the pull settles. Busy does NOT disable the
  // buttons: it flips them to stop entries (see stopPull).
  const [busy, setBusy] = useState(false);
  // The ack flag + hold timer live in the shared copied-ack hook; the copy
  // tooltip's natural open state (hover/focus intent) stays here, with the
  // copied ack ORing in to force it open for the hold window.
  const { copied, acknowledge } = useCopiedAck();
  const [tooltipOpen, setTooltipOpen] = useState(false);
  // The parked TooLarge refusal awaiting the confirm dialog's decision.
  const [pendingLargePull, setPendingLargePull] = useState<PendingLargePull | null>(null);
  // Latest-props mirror: the handlers are async, so the props they closed over
  // at trigger time can go stale while a pull is in flight (the user switches
  // results under the reused instance); settle-time effects compare against
  // this mirror so a late failure or ack is dropped rather than misattributed.
  const currentRef = useRef({ sessionId, referenceName });
  useEffect(() => {
    currentRef.current = { sessionId, referenceName };
  });
  const isStale = (at: { sessionId: string; referenceName: string }) =>
    currentRef.current.sessionId !== at.sessionId ||
    currentRef.current.referenceName !== at.referenceName;

  // One runner for both full pulls: busy flag, save dialog, stale guard,
  // TooLarge parking, cancel quieting, and the error lane live here once
  // (issue #769/#779). The export's save dialog runs on the first attempt
  // only -- a confirmed re-send reuses the destination the user already chose.
  async function runPull(action: "export" | "copy", confirmed: boolean, dest?: string | null) {
    const atStart = { sessionId, referenceName };
    let target = dest ?? null;
    setBusy(true);
    try {
      if (action === "export") {
        // Native save dialog; a cancel (null) is a quiet no-op -- no export,
        // no error surface.
        target =
          target ??
          (await saveDialog({
            defaultPath: `${referenceName}.csv`,
            filters: [{ name: "CSV", extensions: ["csv"] }],
          }));
        if (target === null) return;
        await exportRowsCsv(atStart.sessionId, atStart.referenceName, target, confirmed);
      } else {
        const tsv = await readRowsTsv(atStart.sessionId, atStart.referenceName, confirmed);
        await navigator.clipboard.writeText(tsv);
        if (!isStale(atStart)) acknowledge();
      }
    } catch (e) {
      const guardrail = classifyFullPullRejection(e);
      if (guardrail?.kind === "tooLarge") {
        log.info("ResultActions", "full-result pull refused by the confirm gate", e);
        if (!isStale(atStart)) {
          setPendingLargePull({
            action,
            dest: action === "export" ? target : null,
            rowCount: guardrail.rowCount,
          });
        }
      } else if (guardrail?.kind === "cancelled") {
        // Quiet end (the save-dialog cancel precedent): the user asked for
        // the stop, so neither the error lane nor an ack fires.
        log.info("ResultActions", `full-result ${action} cancelled`);
      } else {
        // Honest failure: the error lane carries the reason (the lane stays
        // diagnosable in the log sink too -- symmetric across both actions).
        log.warn("ResultActions", `full-result ${action} failed`, e);
        if (!isStale(atStart)) onError(e);
      }
    } finally {
      setBusy(false);
    }
  }

  // The confirm dialog's Continue: re-send with confirmed (issue #779). The
  // dialog is modal, so the result cannot have switched underneath it and
  // the current props are still the pull's own.
  function confirmLargePull() {
    const pending = pendingLargePull;
    setPendingLargePull(null);
    if (pending === null) return;
    void runPull(pending.action, true, pending.dest);
  }

  // Stop the in-flight pull: best-effort fire of the session's cancel token.
  // The token is read by the pull's row loop (within one row) and fires
  // without the session lock (ADR-0021), so this lands even while the pull
  // itself holds it. Either button works -- the session has one token, and
  // exactly one pull can be in flight.
  function stopPull() {
    cancelQuery(sessionId).catch((e) => {
      log.warn("ResultActions", "stopping the full-result pull failed", e);
    });
  }

  const exportLabel = intl.formatMessage({
    id: "result.action.exportCsv",
    defaultMessage: "Export CSV",
  });
  const copyLabel = intl.formatMessage({
    id: "result.action.copyAll",
    defaultMessage: "Copy all",
  });
  const copiedLabel = intl.formatMessage({
    id: "thread.copy.copied",
    defaultMessage: "Copied",
  });
  const stopLabel = intl.formatMessage({
    id: "result.action.stop",
    defaultMessage: "Stop",
  });
  return (
    <div className="flex shrink-0 gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            // Busy does not disable: the button becomes the pull's stop
            // entry (issue #779). Constant box (CopyButton's sizing): the
            // icon never widens the header row.
            onClick={() => {
              if (busy) {
                stopPull();
              } else {
                void runPull("export", false);
              }
            }}
            className="size-6 p-1 text-muted-foreground hover:text-foreground"
          >
            {busy ? (
              <Square aria-hidden="true" className="w-3.5 h-3.5" />
            ) : (
              <Download aria-hidden="true" className="w-3.5 h-3.5" />
            )}
            <span className="sr-only">{busy ? stopLabel : exportLabel}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{busy ? stopLabel : exportLabel}</TooltipContent>
      </Tooltip>
      <Tooltip open={copied || tooltipOpen} onOpenChange={setTooltipOpen}>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              if (busy) {
                stopPull();
              } else {
                void runPull("copy", false);
              }
            }}
            className="size-6 p-1 text-muted-foreground hover:text-foreground"
          >
            {busy ? (
              <Square aria-hidden="true" className="w-3.5 h-3.5" />
            ) : copied ? (
              <Check aria-hidden="true" className="w-3.5 h-3.5" />
            ) : (
              <Copy aria-hidden="true" className="w-3.5 h-3.5" />
            )}
            <span className="sr-only">
              {busy ? stopLabel : copied ? copiedLabel : copyLabel}
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{busy ? stopLabel : copied ? copiedLabel : copyLabel}</TooltipContent>
      </Tooltip>
      {pendingLargePull !== null && (
        // The confirm gate's prompt (issue #779): mounted only while a
        // TooLarge refusal is parked, defaultOpen-uncontrolled (the
        // ActiveSourceDeleteDialog precedent). ESC is guarded (issue #766):
        // abandoning a pull this large must be an explicit Cancel, not a
        // stray keypress -- though Cancel is safe either way (nothing ran).
        <AlertDialog defaultOpen>
          <AlertDialogContent onEscapeKeyDown={(e) => e.preventDefault()}>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <FormattedMessage
                  id="result.action.confirmLarge.title"
                  defaultMessage="Large result"
                />
              </AlertDialogTitle>
              <AlertDialogDescription>
                <FormattedMessage
                  id="result.action.confirmLarge.body"
                  defaultMessage={
                    "This result has {rowCount, number} rows. Pulling all of them can take " +
                    "a while, and other actions on this session queue until it finishes. " +
                    "Continue?"
                  }
                  values={{ rowCount: pendingLargePull.rowCount }}
                />
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setPendingLargePull(null)}>
                <FormattedMessage
                  id="result.action.confirmLarge.cancel"
                  defaultMessage="Cancel"
                />
              </AlertDialogCancel>
              <AlertDialogAction onClick={confirmLargePull}>
                <FormattedMessage
                  id="result.action.confirmLarge.confirm"
                  defaultMessage="Continue"
                />
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
