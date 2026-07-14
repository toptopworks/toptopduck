import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { fmtError, readRows } from "../api";
import { decodeViz } from "../viz";
import { Alert, AlertDescription } from "./ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { VegaChart } from "./VegaChart";
import type { ColumnSchema, StaleAnchor, VizSpec } from "../types";

const DEFAULT_PAGE_SIZE = 100;

// Disclosure thresholds (ADR-0057: precise values are visual iteration, not
// architecture). A result above either threshold renders an honest banner
// rather than silently looking lightweight. Exported so tests can pin them.
export const ROW_DISCLOSURE_THRESHOLD = 10_000;
export const COLUMN_DISCLOSURE_THRESHOLD = 100;

// DuckDB numeric canonical types (ADR-0057). A cell in one of these columns
// aligns right; everything else aligns left. The set is the closed DuckDB
// numeric family -- BOOLEAN / VARCHAR / TIMESTAMP / BLOB etc. stay left. A
// DECIMAL type string may carry precision/scale ("DECIMAL(18,2)"), so the base
// token before any "(" is matched.
const NUMERIC_TYPES: ReadonlySet<string> = new Set([
  "TINYINT",
  "SMALLINT",
  "INTEGER",
  "BIGINT",
  "HUGEINT",
  "UTINYINT",
  "USMALLINT",
  "UINTEGER",
  "UBIGINT",
  "UHUGEINT",
  "FLOAT",
  "DOUBLE",
  "REAL",
  "DECIMAL",
]);

/** Is this canonical type numeric (right-aligned per ADR-0057)? Splits on the
 * first "(" so parameterized types (DECIMAL(18,2)) match the base token. */
function isNumericType(canonicalType: string): boolean {
  const base = canonicalType.split("(", 1)[0].toUpperCase().trim();
  return NUMERIC_TYPES.has(base);
}

interface ResultViewProps {
  /** ADR-0056: the session this result belongs to -- readRows addresses it. */
  sessionId: string;
  referenceName: string;
  assumption: string | null;
  /** The provider's optional viz spec for this result (ADR-0016/0033): null =
   * a plain table turn; a spec the frontend renders via VegaChart, or degrades
   * to the table with a disclosure when malformed or failing to render. */
  viz: VizSpec | null;
  /** ADR-0047 stage-stale: when the viewed result has been invalidated by a
   * source removal/replacement (issue #40/#41), the workspace shows the old
   * rows PLUS this honest disclosure. null = the result is live. Derived by
   * the caller from the working-set descriptor (runtime truth), NOT the thread. */
  staleAnchor?: StaleAnchor | null;
  pageSize?: number;
}

// The workspace "result" pane (ADR-0045/0062 R4). Layout order is fixed:
// assumption -> Vega chart -> table, all in one scroll; the table is ALWAYS
// present (it is the evidence layer), the chart sits above it as the "answer".
// An emitted viz that fails to decode/render REPLACES the chart slot with a
// disclosure (ADR-0033) -- it is not a fourth stacked item. Pagination sticks
// to the pane bottom so it stays reachable after scrolling past the chart.
//
// Rendering rules (ADR-0057): row-server pagination <=100/page, columns render
// in full with horizontal scroll (no column cap, no virtualization), numeric
// columns right-align by canonical_type, NULL cells (server NULL -> "") render
// as muted whitespace (never the literal "NULL"), and large results / many
// columns disclose honestly.
export function ResultView({
  sessionId,
  referenceName,
  assumption,
  viz,
  staleAnchor = null,
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
  const intl = useIntl();
  const loadPage = useCallback(
    async (off: number) => {
      const seq = (seqRef.current += 1);
      setLoading(true);
      setError(null);
      try {
        const page = await readRows(sessionId, referenceName, off, pageSize);
        if (seq !== seqRef.current) return; // superseded -- discard the stale page
        setColumns(page.columns);
        setRows(page.rows);
        setTotal(page.total);
        setOffset(off);
      } catch (e) {
        if (seq !== seqRef.current) return;
        setError(fmtError(e, intl));
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [intl, sessionId, referenceName, pageSize],
  );

  useEffect(() => {
    // External system -> state: a legitimate one-shot fetch on reference change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPage(0);
  }, [loadPage]);

  // --- Viz (ADR-0016/0033) ------------------------------------------------
  // decodeViz is a pure pre-check (parse + whitelist mark). A spec that passes
  // is handed to VegaChart; a spec that fails degrades to a disclosure. A
  // render failure reported by VegaChart degrades the same way. memoized so the
  // chart-slot decision stays stable across re-renders.
  const decoded = useMemo(() => (viz ? decodeViz(viz) : null), [viz]);
  const [renderError, setRenderError] = useState<string | null>(null);

  // A new result/viz resets the render-failure state so it gets a fresh try.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRenderError(null);
  }, [referenceName, viz]);

  // The chart renders only when a spec decoded AND no render error has landed.
  const showChart = decoded !== null && decoded.ok && renderError === null;
  // The degradation reason (null = not degraded): a decode failure explains the
  // cause; a render failure is a generic engine error.
  const degradedReason =
    decoded !== null && !decoded.ok ? decoded.reason : renderError;

  const numericFlags = useMemo(
    () => columns.map((c) => isNumericType(c.canonical_type)),
    [columns],
  );

  const hasNext = offset + rows.length < total;
  const hasPrev = offset > 0;
  const shown = rows.length;

  const showRowDisclosure = total > ROW_DISCLOSURE_THRESHOLD;
  const showColumnDisclosure = columns.length > COLUMN_DISCLOSURE_THRESHOLD;

  return (
    <section className="result-view">
      <h2 id={headingId}>结果：{referenceName}</h2>
      <p className="meta">行数：{total}</p>

      {staleAnchor && (
        // ADR-0047 stage-stale / ADR-0041 honest wording: the rows below are
        // real (they still load), but the result is no longer valid to build on
        // -- the invalidating source was removed/replaced. Rerun the question
        // against the new source to recompute. A warning Alert (ADR-0050);
        // role="status" is polite -- important, not an interrupting emergency.
        // The verb splits honestly via an ICU select on the anchor reason.
        <Alert variant="warning" role="status" className="my-2">
          <AlertDescription>
            <FormattedMessage
              id="disclosure.result.stale"
              defaultMessage="This result is stale (source {name} was {reason, select, Replaced {updated} other {deleted}}) — ask again to recompute against the new source."
              values={{ name: staleAnchor.display_name, reason: staleAnchor.reason }}
            />
          </AlertDescription>
        </Alert>
      )}

      {assumption && <p className="assumption">假设：{assumption}</p>}

      {showRowDisclosure && (
        // ADR-0057 large-result disclosure: an honest banner (not silent
        // pagination) when a result crosses the row threshold. Info Alert
        // (ADR-0050); role="note" is static reference, not announced.
        <Alert role="note" className="my-2">
          <AlertDescription>
            <FormattedMessage
              id="disclosure.result.largeRows"
              defaultMessage="This result is large ({count} rows) and is paginated; ask a follow-up to focus on part of it."
              values={{ count: total }}
            />
          </AlertDescription>
        </Alert>
      )}
      {showColumnDisclosure && (
        // ADR-0057 many-columns disclosure: columns render in full with
        // horizontal scroll (no cap); this banner tells the user to scroll.
        <Alert role="note" className="my-2">
          <AlertDescription>
            <FormattedMessage
              id="disclosure.result.manyColumns"
              defaultMessage="This result has {count} columns; scroll horizontally to see them all."
              values={{ count: columns.length }}
            />
          </AlertDescription>
        </Alert>
      )}

      {/*
        Chart slot (ADR-0062 R4): the chart, OR -- when a viz was emitted but
        failed -- the degradation disclosure REPLACING this slot (not a fourth
        stacked item). A null viz (plain table turn) renders neither.
      */}
      {showChart && decoded?.ok && (
        <VegaChart spec={decoded.spec} onError={setRenderError} />
      )}
      {degradedReason && (
        // ADR-0033: an emitted viz that failed to decode/render REPLACES the
        // chart slot with this honest disclosure (not a fourth stacked item).
        // Warning Alert (ADR-0050), role="status"; the table still shows, so it
        // reads as a caution, not a fatal error. {reason} is the decode/render
        // failure detail (sourced from decodeViz / Vega-Embed).
        <Alert variant="warning" role="status" className="my-2">
          <AlertDescription>
            <FormattedMessage
              id="disclosure.result.vizDegraded"
              defaultMessage="The chart could not render; the table is shown instead. {reason}"
              values={{ reason: degradedReason }}
            />
          </AlertDescription>
        </Alert>
      )}

      {error && <p className="error">{error}</p>}

      {/*
        Table (ADR-0057): always present below the chart. Columns render in full
        with horizontal scroll; numeric cells right-align; NULL cells (server
        NULL -> "") render as muted whitespace, never the literal "NULL".
      */}
      <Table className="result" aria-labelledby={headingId}>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c.name} className={isNumericType(c.canonical_type) ? "num" : undefined}>
                {c.name}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown === 0 && !loading && (
            <TableRow>
              <TableCell className="muted">（无数据行）</TableCell>
            </TableRow>
          )}
          {/* key is the in-window index, not offset+i: rows are window-scoped,
              so a position-derived key would mis-reuse DOM when one page's last
              rows overlap the next page's first rows. */}
          {rows.map((row, i) => (
            <TableRow key={i}>
              {row.map((cell, j) => {
                const numeric = numericFlags[j] ?? false;
                // NULL handling (ADR-0057): server CASTs NULL to "", rendered
                // as muted whitespace, never the literal "NULL" (honest display).
                if (cell === "") {
                  return <TableCell key={j} className="cell-null" />;
                }
                return (
                  <TableCell key={j} className={numeric ? "num" : undefined}>
                    {cell}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/*
        Pagination (ADR-0057/0062 R4): sticky at the pane bottom so it stays
        reachable after scrolling past the chart. No jump-page (ADR-0057).
      */}
      <div className="page-info sticky">
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
      </div>
    </section>
  );
}
