import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import embed, { type VisualizationSpec } from "vega-embed";
import { fmtError, readRows } from "../api";
import { decodeViz } from "../viz";
import type { ColumnSchema, VizSpec } from "../types";

const DEFAULT_PAGE_SIZE = 100;

interface ResultViewProps {
  referenceName: string;
  assumption: string | null;
  /** The provider's optional viz spec for this result (ADR-0016/0033): null =
   * a plain table turn; a spec the frontend renders via Vega-Embed, or degrades
   * to the table with a disclosure when malformed or failing to render. */
  viz: VizSpec | null;
  pageSize?: number;
}

// Windowed display of a materialized result (ADR-0024) with an optional viz
// (ADR-0016/0033). The table rows always load (one bounded page at a time via
// readRows), so a viz that renders successfully shows the chart, while a
// malformed spec or a render failure degrades to the table instantly with an
// honest disclosure (AC5 / ADR-0033 -- silent degradation is a silent lie).
// `total` rides the page so a truncated view never looks complete (ADR-0030).
// The assumption note (ADR-0009) renders as a correctable side note.
export function ResultView({
  referenceName,
  assumption,
  viz,
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

  // --- Viz (ADR-0016/0033) ------------------------------------------------
  // decodeViz is a pure pre-check (parse + whitelist mark). A spec that passes
  // is handed to Vega-Embed; a spec that fails, OR a render failure from
  // Vega-Embed, degrades to the table with a disclosure. memoized so the
  // render-effect dependency stays stable across re-renders.
  const decoded = useMemo(() => (viz ? decodeViz(viz) : null), [viz]);
  const chartSpec: VisualizationSpec | null = decoded?.ok
    ? (decoded.spec as VisualizationSpec)
    : null;
  const [renderError, setRenderError] = useState<string | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);

  // A new result/viz resets the render-failure state so it gets a fresh try.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRenderError(null);
  }, [referenceName, viz]);

  // Render the decoded Vega-Lite spec via Vega-Embed (ADR-0016). A render
  // failure degrades to the table with a disclosure (ADR-0033); the returned
  // finalize is invoked on cleanup so an unmounted/replaced chart frees its
  // view.
  useEffect(() => {
    if (!chartSpec || !chartRef.current) return;
    const node = chartRef.current;
    let cancelled = false;
    let finalize: (() => void) | undefined;
    embed(node, chartSpec, { actions: false })
      .then((result) => {
        if (cancelled) result.finalize();
        else finalize = result.finalize;
      })
      .catch(() => {
        if (!cancelled) setRenderError("渲染出错");
      });
    return () => {
      cancelled = true;
      finalize?.();
    };
  }, [chartSpec]);

  // The degradation reason (null = not degraded): a decode failure explains the
  // cause; a render failure is a generic engine error. The chart shows only
  // when a spec decoded AND rendered without error.
  const degradedReason = decoded !== null && !decoded.ok ? decoded.reason : renderError;
  const showChart = chartSpec !== null && renderError === null;

  const hasNext = offset + rows.length < total;
  const hasPrev = offset > 0;
  const shown = rows.length;

  return (
    <section className="result-view">
      <h2 id={headingId}>结果：{referenceName}</h2>
      <p className="meta">行数：{total}</p>
      {assumption && <p className="assumption">假设：{assumption}</p>}
      {degradedReason && (
        <p className="viz-disclosure" role="note">
          图表无法渲染，已显示表格。{degradedReason}
        </p>
      )}
      {showChart && <div ref={chartRef} className="viz-chart" aria-label="图表" />}
      {error && <p className="error">{error}</p>}
      {!showChart && (
        <>
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
        </>
      )}
    </section>
  );
}
