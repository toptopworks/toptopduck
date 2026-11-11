import { useId, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  TriangleAlert,
} from "lucide-react";
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

// The auto-tidy failure reason surfaced under the active sheet's heading
// (issue #750). The four id / defaultMessage pairs stay LITERAL at their
// FormattedMessage sites -- a descriptor map indirection would hide them from
// the formatjs extractor and break the i18n catalog guard. defaultMessage
// stays English; the zh-CN counterparts live in the locale catalog.
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
    default: {
      // Exhaustiveness guard (mirrors useIngestFlow's LoadOutcome guard): a
      // GuidanceReason variant added on the Rust side without a TS case must
      // fail the build, not render a blank reason line.
      const unhandled: never = reason;
      throw new Error(`unhandled GuidanceReason: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Decode a sheet's two-state (#751) into the rendering pair the dialog needs:
// whether auto-tidy resolved it, the header-row pre-fill (the guess for a
// resolved sheet, the blind row-1 default for a deferred one), and the failure
// reason (deferred only). The switch is exhaustive with a never-asserted
// default (mirrors GuidanceReasonMessage above): a GuidanceSheetState variant
// added on the Rust side without a TS case must fail the build, not silently
// pre-fill row 1 and render a blank reason line.
function decodeSheetState(state: GuidanceSheet["state"]): {
  isAutoTidied: boolean;
  headerRow: number;
  reason: GuidanceReason | null;
} {
  switch (state.kind) {
    case "AutoTidied":
      return { isAutoTidied: true, headerRow: state.data.header_row, reason: null };
    case "NeedsGuidance":
      return { isAutoTidied: false, headerRow: 1, reason: state.data.reason };
    default: {
      const unhandled: never = state;
      throw new Error(`unhandled GuidanceSheetState: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Seed the per-sheet choices from a request's sheets (#751): a sheet the
// auto-tidy resolved pre-fills its header pick with the detected row (the
// guess); a deferred sheet keeps the blind row-1 default. Both start with no
// skips -- the auto path never produces skip rows, and the deferred path
// gathers them interactively.
function prefillChoices(sheets: GuidanceSheet[]): Record<string, SheetChoice> {
  const init: Record<string, SheetChoice> = {};
  for (const s of sheets) {
    init[s.name] = { headerRow: decodeSheetState(s.state).headerRow, skipRows: [] };
  }
  return init;
}

// Seed the per-sheet import checks (ADR-0148 default selection): a sheet the
// auto-tidy resolved is pre-checked (importing it on acceptance costs the user
// one glance); a DEFERRED sheet starts unticked -- the algorithm punted on
// that shape, so the user must preview it and make the call before it can
// enter the working set (a tidy fallback guess is never confirmation).
function prefillChecked(sheets: GuidanceSheet[]): Set<string> {
  const checked = new Set<string>();
  for (const s of sheets) {
    if (decodeSheetState(s.state).isAutoTidied) checked.add(s.name);
  }
  return checked;
}

// The sheet the detail pane opens on: the first deferred sheet -- the one that
// needs eyes first -- or, in a fully resolved workbook, the first sheet.
function defaultActiveSheet(sheets: GuidanceSheet[]): string {
  const firstDeferred = sheets.find((s) => !decodeSheetState(s.state).isAutoTidied);
  return (firstDeferred ?? sheets[0])?.name ?? "";
}

// Excel import confirmation dialog (ADR-0148): EVERY workbook ingest parks
// here before anything enters the working set -- a tidy guess is never
// confirmation. Master-detail: the left pane lists each sheet with its import
// check (resolved sheets pre-checked, deferred ones not) + state icon + row
// count; the right pane is the active sheet's preview (issue #750 pager,
// #749 header/skip controls, #751 auto-detected summary line). Submit sends
// ONLY the checked sheets' guidance; an empty selection disables the submit
// (the backend rejects an empty selection too, as the defensive floor).
//
// The shell is a Radix Dialog (issue #105): portal + focus-trap + scroll-lock
// + ESC + overlay-click dismiss come from the primitive. The fixed-height
// flex skeleton survives from issue #749 (header + footer pinned, the two
// panes scroll independently), as do the design-system controls and the
// setter-level contradiction invariant -- skips can only sit below the header
// row, so a header move clears any skip it overtakes and the submitted
// payload can never pair the header row with an at/above skip.
//
// Issue #748: a guided-submit failure renders INLINE via the `error` prop --
// the shared workspace ErrorBanner sits in the workspace body BEHIND the modal
// scrim, so it was invisible; the failure had no visible feedback at all. The
// dialog stays open on failure (in-place retry keeps the sheet choices), the
// parent clears the error on re-submit / cancel / a freshly routed guidance,
// and remounts this component keyed on the source path so a resumed batch's
// next file starts from clean choices (a same-path re-route re-derives them
// in place -- the `requestAtMount` identity check below, which also bumps the
// pane epoch so the detail pane remounts onto the new parse).
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
  const [requestAtMount, setRequestAtMount] = useState(request);
  const [choices, setChoices] = useState<Record<string, SheetChoice>>(() =>
    prefillChoices(request.sheets),
  );
  const [checked, setChecked] = useState<Set<string>>(() => prefillChecked(request.sheets));
  const [activeName, setActiveName] = useState(() => defaultActiveSheet(request.sheets));
  // Bumped on every same-path re-route so the detail pane's remount key
  // changes even when the active sheet's name doesn't -- a stale window must
  // never survive a re-parked parse.
  const [paneEpoch, setPaneEpoch] = useState(0);
  // A same-path re-route re-parks the dialog WITHOUT remounting it (the
  // remount key is the path, #748 -- a file drop on the window while the
  // dialog is open bypasses the modal, per useIngestFlow): the request object
  // is replaced in place, so re-derive every piece of dialog state the moment
  // its identity changes, or a re-dropped workbook rides the stale parse --
  // a moved guess renders and submits mislabeled as auto-detected, a newly
  // added sheet name has no choice at all (issue #751 review), and stale
  // checks would import sheets the user never saw.
  if (requestAtMount !== request) {
    setRequestAtMount(request);
    setChoices(prefillChoices(request.sheets));
    setChecked(prefillChecked(request.sheets));
    setActiveName(defaultActiveSheet(request.sheets));
    setPaneEpoch((v) => v + 1);
  }

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

  function toggleChecked(name: string) {
    setChecked((cur) => {
      const next = new Set(cur);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }

  const checkedCount = request.sheets.filter((s) => checked.has(s.name)).length;
  const activeSheet = request.sheets.find((s) => s.name === activeName) ?? request.sheets[0];

  function submit() {
    // Only the checked sheets ride the payload, in workbook order (ADR-0148):
    // an unchecked sheet is skipped server-side, not default-imported.
    const guidance: SheetGuidance[] = request.sheets
      .filter((s) => checked.has(s.name))
      .map((s) => {
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
    if (guidance.length === 0) return; // unreachable (submit disabled); belt and braces
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
          header + footer stay pinned and each pane scrolls independently, so
          the submit button remains reachable on multi-sheet workbooks. */}
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => {
          if (loading) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (loading) e.preventDefault();
        }}
        className="flex h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
      >
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 text-left">
          <DialogTitle>
            <FormattedMessage
              id="guidedLoad.title"
              defaultMessage="Import Excel: {name}"
              values={{ name: request.workbook_name }}
            />
          </DialogTitle>
          <DialogDescription>
            <FormattedMessage
              id="guidedLoad.description"
              defaultMessage="Every sheet is confirmed here before it enters the working set: sheets detected automatically are pre-checked; ambiguous sheets start unchecked — preview each one, set its header row, then check it to import. Rows above the header row are excluded automatically."
            />
          </DialogDescription>
        </DialogHeader>
        <div data-slot="dialog-body" className="flex min-h-0 min-w-0 flex-1">
          {/* Master pane: the per-sheet import list. */}
          <aside
            data-slot="sheet-list"
            aria-label={intl.formatMessage({
              id: "guidedLoad.sheetList",
              defaultMessage: "Sheet list",
            })}
            className="flex w-56 shrink-0 flex-col border-r"
          >
            <div className="shrink-0 border-b px-4 py-2 text-xs text-muted-foreground tabular-nums">
              <FormattedMessage
                id="guidedLoad.selectedCount"
                defaultMessage="{selected} of {total} selected"
                values={{ selected: checkedCount, total: request.sheets.length }}
              />
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto py-1">
              {request.sheets.map((sheet) => (
                <SheetListRow
                  key={sheet.name}
                  sheet={sheet}
                  isChecked={checked.has(sheet.name)}
                  isActive={sheet.name === activeSheet?.name}
                  loading={loading}
                  onToggle={() => toggleChecked(sheet.name)}
                  onActivate={() => setActiveName(sheet.name)}
                />
              ))}
            </ul>
          </aside>
          {/* Detail pane: the active sheet's preview + rectify controls. The
              remount key covers BOTH the sheet switch (fresh first window per
              sheet) and the same-path re-route (paneEpoch), so a stale window
              can never survive a re-parked parse. */}
          <div data-slot="sheet-detail" className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-4">
            {activeSheet && (
              <GuidedSheetPane
                key={`${activeSheet.name}@${paneEpoch}`}
                sheet={activeSheet}
                choice={choices[activeSheet.name]}
                loading={loading}
                onHeaderRow={(row) => setHeaderRow(activeSheet.name, row)}
                onToggleSkip={(row) => toggleSkip(activeSheet.name, row)}
                onFetchWindow={onFetchWindow}
              />
            )}
          </div>
        </div>
        {error && (
          <div className="shrink-0 px-6 pt-4">
            <ErrorBanner error={error} />
          </div>
        )}
        <DialogFooter className="shrink-0 px-6 py-4">
          {checkedCount === 0 && !loading && (
            <p className="mr-auto text-xs text-muted-foreground">
              <FormattedMessage
                id="guidedLoad.noSelection"
                defaultMessage="No sheets selected — check at least one sheet to import."
              />
            </p>
          )}
          <Button variant="outline" onClick={onCancel} disabled={loading}>
            <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
          </Button>
          <Button onClick={submit} disabled={loading || checkedCount === 0}>
            {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {loading
              ? intl.formatMessage({
                  id: "guidedLoad.loading",
                  defaultMessage: "Loading…",
                })
              : intl.formatMessage({
                  id: "common.load",
                  defaultMessage: "Load",
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// One row of the master pane's sheet list: the import check (ADR-0148
// selection), the two-state icon (check = resolved, alert = deferred -- shape,
// not color alone), the sheet name as the activation control, and the row
// count caption. The check and the activation are SEPARATE controls so both
// stay valid interactive targets (no nesting interactive elements): the
// checkbox toggles import, the name button opens the sheet in the detail pane.
function SheetListRow({
  sheet,
  isChecked,
  isActive,
  loading,
  onToggle,
  onActivate,
}: {
  sheet: GuidanceSheet;
  isChecked: boolean;
  isActive: boolean;
  loading: boolean;
  onToggle: () => void;
  onActivate: () => void;
}) {
  const intl = useIntl();
  const checkboxId = useId();
  const { isAutoTidied } = decodeSheetState(sheet.state);
  return (
    <li>
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-2",
          isActive && "bg-accent text-accent-foreground",
        )}
      >
        <Checkbox
          id={checkboxId}
          checked={isChecked}
          disabled={loading}
          onCheckedChange={() => onToggle()}
          aria-label={intl.formatMessage(
            { id: "guidedLoad.importSheetAria", defaultMessage: "Import {sheet}" },
            { sheet: sheet.name },
          )}
        />
        <button
          type="button"
          onClick={onActivate}
          disabled={loading}
          aria-current={isActive ? "true" : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left"
        >
          {isAutoTidied ? (
            <Check data-slot="sheet-state-icon" className="size-4 shrink-0" aria-hidden />
          ) : (
            <TriangleAlert
              data-slot="sheet-state-icon"
              className="size-4 shrink-0 text-warning"
              aria-hidden
            />
          )}
          <span className="truncate text-sm">{sheet.name}</span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
            <FormattedMessage
              id="guidedLoad.rowCount"
              defaultMessage="{count, plural, one {# row} other {# rows}}"
              values={{ count: sheet.total_rows }}
            />
          </span>
        </button>
      </div>
    </li>
  );
}

// The detail pane's one active sheet (#749 controls): the headline-sm heading,
// the auto-tidy failure reason (issue #750) or the resolved sheet's
// auto-detected summary (#751), the Select-driven header row, the preview
// window pager (issue #750), and the preview table with dual-channel row
// states. Remounted per sheet switch + per same-path re-route (the parent's
// key) -- no expansion state to track: the master-detail layout made every
// sheet inspectable, so the #751 collapse/Adjust affordance is gone.
//
// Paging model (issue #750): the FIRST window rides the inlined
// `sheet.preview`; the pager (visible only when the sheet outgrows one
// window) swaps `windowState` for fetched windows. The window size is read
// off the inlined first window, so the backend constant and the pager can
// never drift. Selections live in ABSOLUTE row numbers (choices) -- a window
// swap never disturbs them, and picks made across different windows coexist.
// Both the header Select and the skip checkboxes offer ONLY the current
// window's rows: a row that isn't rendered is not selectable.
function GuidedSheetPane({
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
  const { isAutoTidied, reason } = decodeSheetState(sheet.state);
  // The first window is the inlined preview; its height IS the page size.
  // The max-1 clamp keeps pageCount finite for a zero-preview sheet (an
  // EmptySheet guidance) -- the backend drops rowless sheets, so the clamp
  // is belt-and-braces, but removing it would divide by zero.
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
    <section className="py-1" aria-labelledby={headingId}>
      <h3 id={headingId} className="text-base font-semibold">
        {sheet.name}
      </h3>
      {reason ? (
        <p className="mt-1 text-xs text-muted-foreground">
          <GuidanceReasonMessage reason={reason} />
        </p>
      ) : (
        isAutoTidied && (
          <p className="mt-1 text-xs text-muted-foreground">
            <FormattedMessage
              id="guidedLoad.autoSummary"
              defaultMessage="Header row {n} (auto-detected)"
              values={{ n: choice.headerRow }}
            />
          </p>
        )
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
