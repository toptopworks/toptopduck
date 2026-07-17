import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import type { GuidanceRequest, SheetGuidance, SheetRectify } from "../types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

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
// The shell is now a Radix Dialog (issue #105): portal + focus-trap + scroll-
// lock + ESC + overlay-click dismiss come from the primitive, replacing the
// hand-written overlay div + window keydown listener. The inner controls
// (native select + checkbox + preview table) are bespoke to this flow and stay
// as-is -- the issue scope is the dialog chrome, not a form-control sweep.
export function GuidedLoadDialog({
  request,
  loading,
  onSubmit,
  onCancel,
}: {
  request: GuidanceRequest;
  loading: boolean;
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
    setChoices((cur) => ({
      ...cur,
      [name]: { ...cur[name], headerRow: row },
    }));
  }

  function toggleSkip(name: string, row: number) {
    setChoices((cur) => {
      const c = cur[name];
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
      const rectify: SheetRectify = { header_row: c.headerRow, skip_rows: c.skipRows };
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
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => {
          if (loading) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (loading) e.preventDefault();
        }}
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
      >
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
            defaultMessage="Auto-tidy could not pin down the header row. For each sheet, point at the header row and tick any non-data rows to skip."
          />
        </DialogDescription>
        {request.sheets.map((sheet) => {
          const c = choices[sheet.name];
          return (
            <section key={sheet.name}>
              <h3>{sheet.name}</h3>
              <label>
                <FormattedMessage
                  id="guidedLoad.headerRowLabel"
                  defaultMessage="Header row:"
                />
                <select
                  value={c.headerRow}
                  onChange={(e) => setHeaderRow(sheet.name, Number(e.target.value))}
                  disabled={loading}
                >
                  {sheet.preview.map((_, i) => (
                    <option key={i} value={i + 1}>
                      {intl.formatMessage(
                        { id: "guidedLoad.rowOption", defaultMessage: "Row {n}" },
                        { n: i + 1 },
                      )}
                    </option>
                  ))}
                </select>
              </label>
              <table className="preview">
                <tbody>
                  {sheet.preview.map((cells, i) => {
                    const rowNo = i + 1;
                    const isHeader = rowNo === c.headerRow;
                    const isSkip = c.skipRows.includes(rowNo);
                    return (
                      <tr
                        key={i}
                        className={isHeader ? "header-row" : isSkip ? "skip-row" : undefined}
                      >
                        <td className="row-no">
                          <label>
                            <input
                              type="checkbox"
                              checked={isSkip}
                              onChange={() => toggleSkip(sheet.name, rowNo)}
                              disabled={loading || isHeader}
                            />
                            {rowNo}
                          </label>
                        </td>
                        {cells.map((cell, j) => (
                          <td key={j}>{cell}</td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          );
        })}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={loading}>
            <FormattedMessage id="guidedLoad.cancel" defaultMessage="Cancel" />
          </Button>
          <Button onClick={submit} disabled={loading}>
            {loading
              ? intl.formatMessage({ id: "guidedLoad.loading", defaultMessage: "Loading…" })
              : intl.formatMessage({ id: "guidedLoad.submit", defaultMessage: "Load by selection" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
