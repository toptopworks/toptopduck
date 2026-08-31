import { useId, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import type {
  GuidanceReason,
  GuidanceRequest,
  GuidanceSheet,
  SheetGuidance,
  SheetRectify,
} from "../../types/dataset";
import type { AppError } from "../../types/error";
import { log } from "../../lib/log";
import { ErrorBanner } from "../common/ErrorBanner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

// Per-sheet guided choices gathered in the dialog.
interface SheetChoice {
  headerRow: number;
  skipRows: number[];
}

// One sheet's currently rendered preview window (issue #750): the absolute
// 0-based row offset plus the window's rendered rows. Selections are NEVER
// stored here -- choices live in absolute row numbers, so paging a window
// never disturbs them.
interface SheetWindow {
  offset: number;
  rows: string[][];
}

// The auto-tidy failure reason surfaced under a sheet heading (issue #750).
// The four id / defaultMessage pairs stay LITERAL at their FormattedMessage
// sites -- a descriptor map indirection would hide them from the formatjs
// extractor and break the i18n catalog guard. defaultMessage stays English;
// the zh-CN counterparts live in the locale catalog.
function GuidanceReasonMessage({ reason }: { reason: GuidanceReason }) {
  switch (reason) {
    case "EmptySheet":
      return (
        <FormattedMessage
          id="guidedLoad.reason.EmptySheet"
          defaultMessage="The sheet is blank — no data rows were found."
        />
      );
    case "MultipleHeaderRows":
      return (
        <FormattedMessage
          id="guidedLoad.reason.MultipleHeaderRows"
          defaultMessage="Multiple header-like rows detected — point at the real header row."
        />
      );
    case "NoHeaderRow":
      return (
        <FormattedMessage
          id="guidedLoad.reason.NoHeaderRow"
          defaultMessage="Data starts on the first row — no header row detected."
        />
      );
    case "AmbiguousHeaderZone":
      return (
        <FormattedMessage
          id="guidedLoad.reason.AmbiguousHeaderZone"
          defaultMessage="Several rows above the data don't look like a header — point at the header row and tick the rows to skip."
        />
      );
  }
}

// Guided-load dialog (ADR-0015): shown when auto-tidy can't confidently rectify
// a workbook. For each sheet the user points at the header row and ticks any
// rows to skip; the submitted choices re-enter ingest as rectify params
// (ADR-0042 explicit user decisions).
//
// The shell is a Radix Dialog (issue #105): portal + focus-trap + scroll-lock
// + ESC + overlay-click dismiss come from the primitive. Issue #749 rebuilt
// the body: a fixed-height flex skeleton (header + footer pinned, only the
// sheet stack scrolls), design-system controls (Select primitive for the
// header row, Checkbox copy-in for the skip ticks, headline-sm sheet
// headings), dual-channel row states (accent/muted token tints + caption
// Header/Skipped text marks), and a setter-level contradiction invariant --
// skips
// can only live below the header row, so a header move clears any skip it
// overtakes and the submitted payload can never pair the header row with an
// at/above skip.
//
// Issue #748: a guided-submit failure renders INLINE via the `error` prop --
// the shared workspace ErrorBanner sits in the workspace body BEHIND the modal
// scrim, so it was invisible; the failure had no visible feedback at all. The
// dialog stays open on failure (in-place retry keeps the sheet choices), the
// parent clears the error on re-submit / cancel / a freshly routed guidance,
// and remounts this component keyed on the source path so a resumed batch's
// next file starts from clean choices (the `choices` init runs at mount only).
export function GuidedLoadDialog({
  request,
  loading,
  error,
  onSubmit,
  onCancel,
  onFetchWindow,
}: {
  request: GuidanceRequest;
  loading: boolean;
  /** The guided-submit failure to render inline above the footer (#748), or
   *  null. The parent owns the lifecycle: written by the guided-submit
   *  Error / NeedsGuidance-recur / IPC-reject branches, cleared on re-submit
   *  and cancel. */
  error: AppError | null;
  onSubmit: (guidance: SheetGuidance[]) => void;
  onCancel: () => void;
  /** Fetch one preview window for a sheet (issue #750): rows [offset, offset
   *  + limit) rendered as strings, served from the backend's retained parse.
   *  A reject keeps the current window (logged, never thrown into the UI). */
  onFetchWindow: (sheetName: string, offset: number, limit: number) => Promise<string[][]>;
}) {
  const intl = useIntl();
  const [choices, setChoices] = useState<Record<string, SheetChoice>>(() => {
    const init: Record<string, SheetChoice> = {};
    for (const s of request.sheets) {
      init[s.name] = { headerRow: 1, skipRows: [] };
    }
    return init;
  });

  // The parent mounts this component only while the dialog is open and unmounts
  // it on close (SessionPane's `s.guidance` guard), so `open` is always true
  // here and a Radix dismiss (ESC / overlay click) routes to onCancel for the
  // parent to unmount. The loading-guarded dismiss survives: mid-ingest both
  // escape and overlay-click are cancelled (onEscapeKeyDown / onInteractOutside
  // below) so a pending load isn't interrupted -- mirrors the cancel button's
  // loading-disabled state.
  function setHeaderRow(name: string, row: number) {
    setChoices((cur) => {
      const c = cur[name];
      return {
        ...cur,
        [name]: {
          headerRow: row,
          // Contradiction invariant (#749): skips can only sit BELOW the header
          // row -- rows at/above it never enter the data, and before #749 the
          // backend silently dropped such skips (the rectify filter in
          // session/ingest.rs only honors rows below header_row). Moving the
          // header clears every skip it overtakes so the pair never reaches
          // submit.
          skipRows: c.skipRows.filter((r) => r > row),
        },
      };
    });
  }

  function toggleSkip(name: string, row: number) {
    setChoices((cur) => {
      const c = cur[name];
      // The UI disables rows at/above the header; the setter guards the same
      // invariant so no interaction path can tick a contradicting skip.
      if (row <= c.headerRow) return cur;
      const has = c.skipRows.includes(row);
      return {
        ...cur,
        [name]: {
          ...c,
          skipRows: has ? c.skipRows.filter((r) => r !== row) : [...c.skipRows, row],
        },
      };
    });
  }

  function submit() {
    const guidance: SheetGuidance[] = request.sheets.map((s) => {
      const c = choices[s.name];
      const rectify: SheetRectify = {
        header_row: c.headerRow,
        // Belt and braces on the #749 invariant: the setters keep skips below
        // the header, and the payload re-derives it so a contradicting
        // combination can never leave the dialog.
        skip_rows: c.skipRows.filter((r) => r > c.headerRow),
      };
      return { name: s.name, rectify };
    });
    onSubmit(guidance);
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      {/* Fixed-height flex skeleton (#749): the dialog itself never scrolls --
          header + footer stay pinned and only the sheet stack does, so the
          submit button remains reachable on multi-sheet workbooks. */}
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => {
          if (loading) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (loading) e.preventDefault();
        }}
        className="flex h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
      >
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 text-left">
          <DialogTitle>
            <FormattedMessage
              id="guidedLoad.title"
              defaultMessage="Guided load: {name}"
              values={{ name: request.workbook_name }}
            />
          </DialogTitle>
          <DialogDescription>
            <FormattedMessage
              id="guidedLoad.description"
              defaultMessage="Auto-tidy could not pin down the header row. For each sheet, point at the header row and tick any non-data rows to skip. Rows above the header row are excluded automatically."
            />
          </DialogDescription>
        </DialogHeader>
        <div
          data-slot="dialog-body"
          className="min-h-0 flex-1 divide-y overflow-y-auto px-6"
        >
          {request.sheets.map((sheet) => (
            <GuidedSheetSection
              key={sheet.name}
              sheet={sheet}
              choice={choices[sheet.name]}
              loading={loading}
              onHeaderRow={(row) => setHeaderRow(sheet.name, row)}
              onToggleSkip={(row) => toggleSkip(sheet.name, row)}
              onFetchWindow={onFetchWindow}
            />
          ))}
        </div>
        {error && (
          <div className="shrink-0 px-6 pt-4">
            <ErrorBanner error={error} />
          </div>
        )}
        <DialogFooter className="shrink-0 px-6 py-4">
          <Button variant="outline" onClick={onCancel} disabled={loading}>
            <FormattedMessage id="guidedLoad.cancel" defaultMessage="Cancel" />
          </Button>
          <Button onClick={submit} disabled={loading}>
            {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {loading
              ? intl.formatMessage({
                  id: "guidedLoad.loading",
                  defaultMessage: "Loading…",
                })
              : intl.formatMessage({
                  id: "guidedLoad.submit",
                  defaultMessage: "Load",
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// One sheet's guidance block (#749): a headline-sm heading, the auto-tidy
// failure reason (issue #750), the Select-driven header row, the preview
// window pager (issue #750), and the preview table with dual-channel row
// states. useId gives every sheet its own heading / select ids -- hooks cannot
// run inside the parent's map callback, hence the component split.
//
// Paging model (issue #750): the FIRST window rides the inlined
// `sheet.preview`; the pager (visible only when the sheet outgrows one
// window) swaps `windowState` for fetched windows. The window size is read
// off the inlined first window, so the backend constant and the pager can
// never drift. Selections live in ABSOLUTE row numbers (choices) -- a window
// swap never disturbs them, and picks made across different windows coexist.
// Both the header Select and the skip checkboxes offer ONLY the current
// window's rows: a row that isn't rendered is not selectable.
function GuidedSheetSection({
  sheet,
  choice,
  loading,
  onHeaderRow,
  onToggleSkip,
  onFetchWindow,
}: {
  sheet: GuidanceSheet;
  choice: SheetChoice;
  loading: boolean;
  onHeaderRow: (row: number) => void;
  onToggleSkip: (row: number) => void;
  onFetchWindow: (sheetName: string, offset: number, limit: number) => Promise<string[][]>;
}) {
  const intl = useIntl();
  const headingId = useId();
  const selectId = useId();
  // The first window is the inlined preview; its height IS the page size.
  const pageSize = Math.max(sheet.preview.length, 1);
  const pageCount = Math.ceil(sheet.total_rows / pageSize);
  const canPage = pageCount > 1;
  const [windowState, setWindowState] = useState<SheetWindow>({
    offset: 0,
    rows: sheet.preview,
  });
  const [isFetchingWindow, setIsFetchingWindow] = useState(false);
  const currentPage = Math.floor(windowState.offset / pageSize);

  async function gotoPage(page: number) {
    const offset = page * pageSize;
    if (page < 0 || page >= pageCount || offset === windowState.offset) return;
    setIsFetchingWindow(true);
    try {
      const rows = await onFetchWindow(sheet.name, offset, pageSize);
      setWindowState({ offset, rows });
    } catch (e) {
      // A miss (retention committed / discarded / superseded) or IPC failure
      // keeps the current window -- the user can still submit what they see.
      log.warn("GuidedLoadDialog", "preview window fetch failed; keeping current window", {
        sheet: sheet.name,
        offset,
        error: String(e),
      });
    } finally {
      setIsFetchingWindow(false);
    }
  }

  // Absolute 1-based row numbers of the window's first / last rendered row
  // (the last one honors a short final window).
  const firstRow = windowState.offset + 1;
  const lastRow = windowState.offset + windowState.rows.length;
  const rowOptionLabel = (row: number) =>
    intl.formatMessage({ id: "guidedLoad.rowOption", defaultMessage: "Row {n}" }, { n: row });
  return (
    <section className="py-4" aria-labelledby={headingId}>
      <h3 id={headingId} className="text-base font-semibold">
        {sheet.name}
      </h3>
      {sheet.reason && (
        <p className="mt-1 text-xs text-muted-foreground">
          <GuidanceReasonMessage reason={sheet.reason} />
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Label htmlFor={selectId}>
          <FormattedMessage
            id="guidedLoad.headerRowLabel"
            defaultMessage="Header row:"
          />
        </Label>
        <Select
          value={String(choice.headerRow)}
          onValueChange={(v) => onHeaderRow(Number(v))}
          disabled={loading || isFetchingWindow}
        >
          <SelectTrigger id={selectId} className="w-32">
            {/* The placeholder doubles as the label for a selection that sits
                in ANOTHER window: Radix falls back to it when the value
                matches no rendered item, so the trigger never reads empty. */}
            <SelectValue placeholder={rowOptionLabel(choice.headerRow)} />
          </SelectTrigger>
          <SelectContent>
            {windowState.rows.map((_, i) => {
              const rowNo = windowState.offset + i + 1;
              return (
                <SelectItem key={rowNo} value={String(rowNo)}>
                  {rowOptionLabel(rowNo)}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
      {canPage && (
        <div className="mt-2 flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => void gotoPage(currentPage - 1)}
            disabled={loading || isFetchingWindow || currentPage === 0}
            aria-label={intl.formatMessage({
              id: "guidedLoad.prevPage",
              defaultMessage: "Previous page",
            })}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          {/* The position indicator is the pager's live region: a page swap
              announces the new range without moving focus. */}
          <span aria-live="polite" className="text-xs text-muted-foreground">
            {intl.formatMessage(
              {
                id: "guidedLoad.pagePosition",
                defaultMessage: "Rows {start}–{end} of {total}",
              },
              {
                start: intl.formatNumber(firstRow),
                end: intl.formatNumber(lastRow),
                total: intl.formatNumber(sheet.total_rows),
              },
            )}
          </span>
          <Button
            variant="outline"
            size="icon"
            onClick={() => void gotoPage(currentPage + 1)}
            disabled={loading || isFetchingWindow || currentPage >= pageCount - 1}
            aria-label={intl.formatMessage({
              id: "guidedLoad.nextPage",
              defaultMessage: "Next page",
            })}
          >
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      )}
      <Table className="preview" aria-labelledby={headingId}>
        <TableBody>
          {windowState.rows.map((cells, i) => {
            const rowNo = windowState.offset + i + 1;
            const isHeader = rowNo === choice.headerRow;
            const isSkip = choice.skipRows.includes(rowNo);
            const skipId = `${selectId}-skip-${rowNo}`;
            return (
              <TableRow
                key={rowNo}
                className={
                  isHeader
                    ? "group bg-accent text-accent-foreground hover:bg-accent"
                    : isSkip
                      ? "group bg-muted text-muted-foreground hover:bg-muted"
                      : "group"
                }
              >
                {/* Row-state dual channel (#749): the tint rides a token bg on
                    the whole row, and the caption mark in the row-number
                    column names the state in text, not color alone. The first
                    column stays sticky across a wide table's horizontal
                    scroll; the opaque per-state bg keeps the scrolled cells
                    from shining through. Plain rows layer the row hover tint
                    as a veil UNDER the content: the resting bg must stay
                    opaque (occlusion), and a direct group-hover bg would turn
                    translucent mid-scroll. */}
                <TableCell
                  className={cn(
                    "sticky left-0 z-10",
                    isHeader
                      ? "bg-accent"
                      : isSkip
                        ? "bg-muted"
                        : "bg-background",
                  )}
                >
                  {!isHeader && !isSkip && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-0 -z-10 bg-muted/50 opacity-0 transition-opacity group-hover:opacity-100"
                    />
                  )}
                  {/* The checkbox and its row number + state mark share one
                      label so the whole first cell is the hit target (#749
                      review: a bare 16px button sits under the 24px WCAG
                      2.5.8 minimum). font-normal drops the Label primitive's
                      medium weight so the number reads as table text. */}
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={skipId}
                      checked={isSkip}
                      onCheckedChange={() => onToggleSkip(rowNo)}
                      disabled={loading || isFetchingWindow || rowNo <= choice.headerRow}
                      aria-label={intl.formatMessage(
                        {
                          id: "guidedLoad.skipRowAria",
                          defaultMessage: "Skip row {row} of {sheet}",
                        },
                        { row: rowNo, sheet: sheet.name },
                      )}
                    />
                    <Label htmlFor={skipId} className="cursor-pointer font-normal">
                      <span>{rowNo}</span>
                      {isHeader && (
                        <span className="text-xs">
                          <FormattedMessage
                            id="guidedLoad.headerRowMark"
                            defaultMessage="Header"
                          />
                        </span>
                      )}
                      {isSkip && (
                        <span className="text-xs">
                          <FormattedMessage
                            id="guidedLoad.skipRowMark"
                            defaultMessage="Skipped"
                          />
                        </span>
                      )}
                    </Label>
                  </div>
                </TableCell>
                {cells.map((cell, j) => (
                  <TableCell key={j}>{cell}</TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}
