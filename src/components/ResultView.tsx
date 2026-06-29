import { useCallback, useEffect, useId, useRef, useState } from "react";
import { fmtError, readRows } from "../api";
import type { ColumnSchema } from "../types";

const DEFAULT_PAGE_SIZE = 100;

interface ResultViewProps {
  referenceName: string;
  assumption: string | null;
  pageSize?: number;
}

// Windowed display of a materialized result (ADR-0024). Loads one bounded page
// at a time via readRows; `total` is shown alongside the page so a truncated
// view never looks complete (ADR-0030). The assumption note (ADR-0009) renders
// as a correctable side note.
export function ResultView({
  referenceName,
  assumption,
  pageSize = DEFAULT_PAGE_SIZE,
}: ResultViewProps) {
  const [columns, setColumns] = useState<ColumnSchema[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable id linking the table to its heading so the heading text is the
  // table's accessible name.
  const headingId = useId();
  // Monotonic request id: each loadPage bumps it and ignores any response whose
  // id is no longer current, so a late-arriving page (or its error) can never
  // overwrite the page the user navigated to next.
  const seqRef = useRef(0);
  const loadPage = useCallback(
    async (off: number) => {
      const seq = (seqRef.current += 1);
      setLoading(true);
      setError(null);
      try {
        const page = await readRows(referenceName, off, pageSize);
        if (seq !== seqRef.current) return; // superseded -- discard the stale page
        setColumns(page.columns);
        setRows(page.rows);
        setTotal(page.total);
        setOffset(off);
      } catch (e) {
        if (seq !== seqRef.current) return;
        setError(fmtError(e));
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [referenceName, pageSize],
  );

  useEffect(() => {
    // External system -> state: a legitimate one-shot fetch on reference change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPage(0);
  }, [loadPage]);

  const hasNext = offset + rows.length < total;
  const hasPrev = offset > 0;
  const shown = rows.length;

  return (
    <section className="result-view">
      <h2 id={headingId}>结果：{referenceName}</h2>
      <p className="meta">行数：{total}</p>
      {assumption && <p className="assumption">假设：{assumption}</p>}
      {error && <p className="error">{error}</p>}
      <div className="table-scroll">
        <table className="result" aria-labelledby={headingId}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.name}>{c.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown === 0 && !loading && (
              <tr>
                <td className="muted">（无数据行）</td>
              </tr>
            )}
            {/* key is the in-window index, not offset+i: rows are window-scoped,
                so a position-derived key would mis-reuse DOM when one page's last
                rows overlap the next page's first rows. */}
            {rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="page-info">
        <span aria-live="polite">
          第 {total === 0 ? 0 : offset + 1}–{offset + shown} 行（共 {total} 行）
        </span>
        <button
          type="button"
          disabled={!hasPrev || loading}
          onClick={() => loadPage(Math.max(0, offset - pageSize))}
        >
          上一页
        </button>
        <button
          type="button"
          disabled={!hasNext || loading}
          onClick={() => loadPage(offset + pageSize)}
        >
          下一页
        </button>
      </p>
    </section>
  );
}
