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
// toast). ONE busy flag disables both actions while either is in flight (no
// re-trigger, no concurrent full pulls; no progress bar by design). Failures
// surface through the caller's error lane (toAppError read semantics ->
// ResultView's ErrorBanner) -- never silent, never a fake ack.
//
// i18n (ADR-0052): the shared "Copied" flip reuses thread.copy.copied's id;
// the two idle labels are this file's own static literals for @formatjs/cli
// extract.

import { useState } from "react";
import { useIntl } from "react-intl";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Check, Copy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopiedAck } from "./useCopiedAck";
import { exportRowsCsv, readRowsTsv } from "../../api";
import { log } from "../../lib/log";

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
  // Which full pull is in flight -- one flag for both actions, so neither can
  // re-trigger (or start alongside the other) until the pull settles.
  const [busy, setBusy] = useState<"export" | "copy" | null>(null);
  // The ack flag + hold timer live in the shared copied-ack hook; the copy
  // tooltip's natural open state (hover/focus intent) stays here, with the
  // copied ack ORing in to force it open for the hold window.
  const { copied, acknowledge } = useCopiedAck();
  const [tooltipOpen, setTooltipOpen] = useState(false);

  async function exportCsv() {
    setBusy("export");
    try {
      // Native save dialog; a cancel (null) is a quiet no-op -- no export, no
      // error surface.
      const dest = await saveDialog({
        defaultPath: `${referenceName}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (dest === null) return;
      await exportRowsCsv(sessionId, referenceName, dest);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  }

  async function copyAll() {
    setBusy("copy");
    try {
      const tsv = await readRowsTsv(sessionId, referenceName);
      await navigator.clipboard.writeText(tsv);
      acknowledge();
    } catch (e) {
      // Honest failure: no ack flip -- the error lane carries the reason (the
      // lane stays diagnosable in the log sink too).
      log.warn("ResultActions", "full-result copy failed", e);
      onError(e);
    } finally {
      setBusy(null);
    }
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
  const disabled = busy !== null;
  return (
    <div className="flex shrink-0 gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            // Constant box (CopyButton's sizing): the icon never widens the
            // header row.
            className="size-6 p-1 text-muted-foreground hover:text-foreground"
            onClick={() => {
              void exportCsv();
            }}
          >
            <Download aria-hidden="true" className="w-3.5 h-3.5" />
            <span className="sr-only">{exportLabel}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{exportLabel}</TooltipContent>
      </Tooltip>
      <Tooltip open={copied || tooltipOpen} onOpenChange={setTooltipOpen}>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            className="size-6 p-1 text-muted-foreground hover:text-foreground"
            onClick={() => {
              void copyAll();
            }}
          >
            {copied ? (
              <Check aria-hidden="true" className="w-3.5 h-3.5" />
            ) : (
              <Copy aria-hidden="true" className="w-3.5 h-3.5" />
            )}
            <span className="sr-only">{copied ? copiedLabel : copyLabel}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{copied ? copiedLabel : copyLabel}</TooltipContent>
      </Tooltip>
    </div>
  );
}
