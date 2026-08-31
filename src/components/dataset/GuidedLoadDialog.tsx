import { useId, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Loader2 } from "lucide-react";
import type {
  GuidanceRequest,
  GuidanceSheet,
  SheetGuidance,
  SheetRectify,
} from "../../types/dataset";
import type { AppError } from "../../types/error";
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
// 表头/跳过 text marks), and a setter-level contradiction invariant -- skips
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
          // backend silently dropped such skips (excel.rs only honors rows
          // below header_row). Moving the header clears every skip it
          // overtakes so the pair never reaches submit.
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

// One sheet's guidance block (#749): a headline-sm heading, the Select-driven
// header row, and the preview table with dual-channel row states. useId gives
// every sheet its own heading / select ids -- hooks cannot run inside the
// parent's map callback, hence the component split.
function GuidedSheetSection({
  sheet,
  choice,
  loading,
  onHeaderRow,
  onToggleSkip,
}: {
  sheet: GuidanceSheet;
  choice: SheetChoice;
  loading: boolean;
  onHeaderRow: (row: number) => void;
  onToggleSkip: (row: number) => void;
}) {
  const intl = useIntl();
  const headingId = useId();
  const selectId = useId();
  return (
    <section className="py-4" aria-labelledby={headingId}>
      <h3 id={headingId} className="text-base font-semibold">
        {sheet.name}
      </h3>
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
          disabled={loading}
        >
          <SelectTrigger id={selectId} className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sheet.preview.map((_, i) => (
              <SelectItem key={i} value={String(i + 1)}>
                {intl.formatMessage(
                  { id: "guidedLoad.rowOption", defaultMessage: "Row {n}" },
                  { n: i + 1 },
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Table className="preview" aria-labelledby={headingId}>
        <TableBody>
          {sheet.preview.map((cells, i) => {
            const rowNo = i + 1;
            const isHeader = rowNo === choice.headerRow;
            const isSkip = choice.skipRows.includes(rowNo);
            return (
              <TableRow
                key={i}
                className={
                  isHeader
                    ? "bg-accent text-accent-foreground hover:bg-accent"
                    : isSkip
                      ? "bg-muted text-muted-foreground hover:bg-muted"
                      : undefined
                }
              >
                {/* Row-state dual channel (#749): the tint rides a token bg on
                    the whole row, and the caption mark in the row-number
                    column names the state in text, not color alone. The first
                    column stays sticky across a wide table's horizontal
                    scroll; the opaque per-state bg keeps the scrolled cells
                    from shining through. */}
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
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={isSkip}
                      onCheckedChange={() => onToggleSkip(rowNo)}
                      disabled={loading || rowNo <= choice.headerRow}
                      aria-label={intl.formatMessage(
                        {
                          id: "guidedLoad.skipRowAria",
                          defaultMessage: "Skip row {row} of {sheet}",
                        },
                        { row: rowNo, sheet: sheet.name },
                      )}
                    />
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
