import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import { describeReject, readRows } from "../../api";
import { decodeViz, type VizFailureReason } from "../viz/viz";
import { ErrorBanner } from "../common/ErrorBanner";
import { Alert, AlertDescription } from "../ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import type { AppError } from "../../types/error";
import type { ColumnSchema, StaleAnchor } from "../../types/dataset";
import type { VizSpec } from "../../types/thread";

// VegaChart is lazy-loaded (issue #218): vega-embed + vega-lite are hundred-KB
// deps only needed when a session turns up a viz result. Deferring them out of
// the static ResultView -> SessionPane -> main bundle keeps the cold-start hero
// and plain-table turns off the vega parse/exec path. VegaChart is a named
// export, so the dynamic import is reshaped to a default for React.lazy. The
// component's own render / theme-bridge / resize-on-unhide / finalize logic is
// untouched -- lazy only shifts the module load time, not behavior.
const VegaChart = lazy(() =>
  import("../viz/VegaChart").then((m) => ({ default: m.VegaChart })),
);

const DEFAULT_PAGE_SIZE = 100;

// Pagination prev/next button base for the sticky bar (ADR-0057/0062 R4) --
// retired from styles.css's .page-info.sticky button rule onto utility +
// ADR-0050 token (ADR-0067, issue #173). Shared so prev/next stay in sync;
// padding / font snap to the Tailwind scale per ADR-0067 (2), matching the
// workspace tab buttons.
const PAGE_BTN =
  "px-3 py-1.5 cursor-pointer text-sm border border-border bg-card rounded-md disabled:opacity-50 disabled:cursor-progress";

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

// Render a typed viz-degradation reason as a locale-catalog string (ADR-0052
// i18n closeout, issue #138). Both decode failures (from decodeViz) and render
// failures (from VegaChart) flow through here, so the {reason} interpolated
// into disclosure.result.vizDegraded is always in the active locale -- no
// Chinese leaks into an en-US disclosure. The `mark` on unsupportedMark is
// engine output (layer 4 -- never translated), interpolated verbatim. The
// `default` arm keeps the switch exhaustive as VizFailureReason grows.
function formatVizFailure(reason: VizFailureReason, intl: IntlShape): string {
  switch (reason.kind) {
    case "invalidJson":
      return intl.formatMessage({
        id: "viz.error.invalidJson",
        defaultMessage: "the spec is not valid JSON",
      });
    case "notObject":
      return intl.formatMessage({
        id: "viz.error.notObject",
        defaultMessage: "the spec is not a Vega-Lite object",
      });
    case "unsupportedMark":
      return intl.formatMessage(
        {
          id: "viz.error.unsupportedMark",
          defaultMessage:
            "the chart type \"{mark}\" is not supported (only bar/line/area/scatter/pie)",
        },
        { mark: reason.mark },
      );
    case "render":
      return intl.formatMessage({
        id: "viz.error.render",
        defaultMessage: "render error",
      });
    default: {
      const unhandled: never = reason;
      throw new Error(`unhandled VizFailureReason kind: ${JSON.stringify(unhandled)}`);
    }
  }
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
  // Issue #194: readRows reject typed as AppError, kind "read" (a readRows
  // reject is the read phase of a turn; describeReject applies no verb prefix,
  // and ErrorBanner renders only message + detail, not kind).
  const [error, setError] = useState<AppError | null>(null);

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
        setError(describeReject(e, intl, "read"));
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
  const [renderError, setRenderError] = useState<VizFailureReason | null>(null);

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
      {/* ADR-0067 (issue #173): the .result-view h2 margin rule retired from
          styles.css onto utility. */}
      <h2 id={headingId} className="mb-1">
        <FormattedMessage
          id="result.title"
          defaultMessage="Result: {name}"
          values={{ name: referenceName }}
        />
      </h2>
      <p className="meta">
        <FormattedMessage
          id="result.rowCount"
          defaultMessage="Rows: {count}"
          values={{ count: total }}
        />
      </p>

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

      {assumption && (
        <p className="assumption">
          <FormattedMessage
            id="result.assumption"
            defaultMessage="Assumption: {text}"
            values={{ text: assumption }}
          />
        </p>
      )}

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
        // Suspense boundary (issue #218): an empty .viz-chart-sized container
        // reserves the chart slot's margins so the result-area layout does not
        // jump while the vega chunk loads; aria-hidden keeps the transient
        // placeholder out of the a11y tree. This load state is a separate layer
        // from the render-failure degrade path below -- a Vega rejection still
        // routes through onError and swaps in the disclosure.
        <Suspense fallback={<div className="viz-chart" aria-hidden="true" />}>
          <VegaChart spec={decoded.spec} onError={setRenderError} />
        </Suspense>
      )}
      {degradedReason && (
        // ADR-0033: an emitted viz that failed to decode/render REPLACES the
        // chart slot with this honest disclosure (not a fourth stacked item).
        // Warning Alert (ADR-0050), role="status"; the table still shows, so it
        // reads as a caution, not a fatal error. {reason} is the typed
        // decode/render failure rendered through formatVizFailure so it always
        // lands in the active locale (ADR-0052, issue #138).
        <Alert variant="warning" role="status" className="my-2">
          <AlertDescription>
            <FormattedMessage
              id="disclosure.result.vizDegraded"
              defaultMessage="The chart could not render; the table is shown instead. {reason}"
              values={{ reason: formatVizFailure(degradedReason, intl) }}
            />
          </AlertDescription>
        </Alert>
      )}

      {error && <ErrorBanner error={error} />}

      {/*
        Table (ADR-0057): always present below the chart. Columns render in full
        with horizontal scroll; numeric cells right-align; NULL cells (server
        NULL -> "") render as muted whitespace, never the literal "NULL".

        ADR-0067 (issue #173): the caller-scoped table.result th.num/td.num
        right-align + td.cell-null muted-bg rules retired from styles.css onto
        the cells as utility. The .num / .cell-null hooks stay on the cells for
        selector / test stability (components.test.tsx queries th.num / td.num /
        td.cell-null); the .result hook stays on the <table> as a semantic
        marker for the caller-scoped contract.
      */}
      <Table className="result" aria-labelledby={headingId}>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead
                key={c.name}
                className={isNumericType(c.canonical_type) ? "num text-right" : undefined}
              >
                {c.name}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown === 0 && !loading && (
            <TableRow>
              <TableCell className="text-muted-foreground">
                <FormattedMessage id="result.emptyRows" defaultMessage="(no data rows)" />
              </TableCell>
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
                  return <TableCell key={j} className="cell-null bg-muted" />;
                }
                return (
                  <TableCell key={j} className={numeric ? "num text-right" : undefined}>
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

        ADR-0067 (issue #173): the .page-info.sticky container visual chrome
        (bg / border-top / padding / flex row) + the .page-info.sticky button
        rules (border / bg-card / radius / font / disabled opacity + cursor)
        retired from styles.css onto utility + ADR-0050 token. The bare `sticky`
        class is the Tailwind position utility (position: sticky); `page-info`
        stays as a semantic hook. The button padding / font-size snap to the
        Tailwind scale (PAGE_BTN: px-3 / py-1.5 / text-sm) per ADR-0067 (2),
        matching the workspace tab buttons; the sub-pixel shift from the
        retired 0.3rem 0.8rem / 0.88rem is imperceptible.
      */}
      <div className="page-info sticky bottom-0 bg-background border-t border-border py-2 m-0 flex gap-2 items-center">
        <span aria-live="polite">
          <FormattedMessage
            id="result.pagination.range"
            defaultMessage="Rows {start}–{end} (of {total})"
            values={{
              start: total === 0 ? 0 : offset + 1,
              end: offset + shown,
              total,
            }}
          />
        </span>
        <button
          type="button"
          disabled={!hasPrev || loading}
          onClick={() => loadPage(Math.max(0, offset - pageSize))}
          className={PAGE_BTN}
        >
          <FormattedMessage id="result.pagination.prev" defaultMessage="Previous" />
        </button>
        <button
          type="button"
          disabled={!hasNext || loading}
          onClick={() => loadPage(offset + pageSize)}
          className={PAGE_BTN}
        >
          <FormattedMessage id="result.pagination.next" defaultMessage="Next" />
        </button>
      </div>
    </section>
  );
}
