import { useEffect, useState } from "react";
import type { GuidanceRequest, SheetGuidance, SheetRectify } from "../types";

// Per-sheet guided choices gathered in the dialog.
interface SheetChoice {
  headerRow: number;
  skipRows: number[];
}

// Guided-load dialog (ADR-0015): shown when auto-tidy can't confidently rectify
// a workbook. For each sheet the user points at the header row and ticks any
// rows to skip; the submitted choices re-enter ingest as rectify params
// (ADR-0042 explicit user decisions).
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
  const [choices, setChoices] = useState<Record<string, SheetChoice>>(() => {
    const init: Record<string, SheetChoice> = {};
    for (const s of request.sheets) {
      init[s.name] = { headerRow: 1, skipRows: [] };
    }
    return init;
  });

  // ESC closes the dialog (a11y); disabled mid-load so a pending ingest isn't
  // interrupted -- mirrors the cancel button's loading-disabled state.
  useEffect(() => {
    if (loading) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loading, onCancel]);

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
    <div className="dialog-overlay">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guided-load-title"
      >
        <h2 id="guided-load-title">引导加载：{request.workbook_name}</h2>
        <p className="muted">
          自动规整无法确定表头位置。请为每个工作表指定表头所在行，并勾选要跳过的非数据行。
        </p>
        {request.sheets.map((sheet) => {
          const c = choices[sheet.name];
          return (
            <section key={sheet.name}>
              <h3>{sheet.name}</h3>
              <label>
                表头所在行：
                <select
                  value={c.headerRow}
                  onChange={(e) => setHeaderRow(sheet.name, Number(e.target.value))}
                  disabled={loading}
                >
                  {sheet.preview.map((_, i) => (
                    <option key={i} value={i + 1}>
                      第 {i + 1} 行
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
        <div className="dialog-actions">
          <button onClick={onCancel} disabled={loading}>
            取消
          </button>
          <button onClick={submit} disabled={loading}>
            {loading ? "加载中…" : "按选择加载"}
          </button>
        </div>
      </div>
    </div>
  );
}
