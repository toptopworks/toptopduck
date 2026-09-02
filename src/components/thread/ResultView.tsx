import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import { readRows } from "../../api";
import { toAppError } from "../../lib/error-presentation";
import { decodeViz, type VizFailureReason } from "../viz/viz";
import { cn } from "@/lib/utils";
import { ErrorBanner } from "../common/ErrorBanner";
import { ResultActions } from "./ResultActions";
import { TruncatingTooltip } from "./TruncatingTooltip";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
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

// Numeric column header + cell chrome (issue #222): the .num hook stays for
// selector / test stability; text-right right-aligns per ADR-0057; tabular-nums
// (font-variant-numeric) lines digits up in a column under a proportional UI
// font so a numeric column reads as one aligned column. Shared by <th> and
// <td> (ADR-0067 (2): Tailwind scale utility, no new token).
const NUMERIC_CELL = "num text-right tabular-nums";

// Issue #768 banner-stack rhythm: warning-class notices (the stale
// disclosure, the viz degradation, the read-error banner) take the sm step
// (my-3, 12px) while the info banner keeps xs (my-2, 8px), so a multi-banner
// stack no longer reads as one uniform rhythm. Shared by all three warning
// surfaces (cf. PAGE_BTN) -- the rhythm is a cross-banner contract, not a
// per-banner choice, so the call sites must not drift apart.
const WARNING_NOTICE_MARGIN = "my-3";

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
  /** Issue #772: the question that produced this result -- the pane title's
   * text, rendered verbatim (user data, never the catalog). Absent/empty (a
   * thread persisted before the question rode the payload, issue #758) falls
   * back to the reference-name title. */
  question?: string;
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
  /** Issue #758: fires the question that produced this result as a fresh turn
   * (the stale banner's "ask again" advice, made an action). The question
   * rides the caller's derivation, so the handler arrives pre-bound. null =
   * the caller did not wire a rerun -- the banner keeps its text advice and
   * renders no button (honest degrade). */
  onRerun?: (() => void) | null;
  /** Issue #758: the session busy gate (the composer's mirror) -- a turn or
   * mutation in flight; the rerun button renders disabled until it clears. */
  rerunBusy?: boolean;
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
  question,
  assumption,
  viz,
  staleAnchor = null,
  onRerun = null,
  rerunBusy = false,
  pageSize = DEFAULT_PAGE_SIZE,
}: ResultViewProps) {
  const [columns, setColumns] = useState<ColumnSchema[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  // Issue #194: readRows reject typed as AppError, kind "read" (a readRows
  // reject is the read phase of a turn; toAppError applies no verb prefix on the
  // read kind, and ErrorBanner renders only message + detail, not kind).
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
        setError(toAppError(e, intl, "read"));
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
      {/* Issue #769: the header's take-it-away actions (export CSV / copy all)
          sit right of the title + row-count meta. They live inside this view,
          so the hero empty state (no result) never renders them. Failures land
          in the same read-error banner as page-load rejects (issue #194 lane:
          toAppError kind "read"). */}
      <div className="flex items-start justify-between gap-2">
        {/* min-w-0 lets this flex child shrink so the truncating title clips
            instead of stretching the header row past the actions. */}
        <div className="min-w-0">
          {/* ADR-0067 (issue #173): the .result-view h2 margin rule retired
              from styles.css onto utility. */}
          <h2 id={headingId} className="mb-1">
            {question ? (
              /* Issue #772: the title is the producing question's verbatim
               * text -- a human coordinate, not the machine reference name
               * (which stays rail-side). Single-line truncate with hover
               * recovery; the full text stays in the DOM, so the table's
               * aria-labelledby name carries it whole. */
              <TruncatingTooltip text={question} className="block truncate">
                {question}
              </TruncatingTooltip>
            ) : (
              /* Honest fallback for threads persisted before the question
               * rode the payload: the reference-name title, never an empty
               * heading. */
              <FormattedMessage
                id="result.title"
                defaultMessage="Result: {name}"
                values={{ name: referenceName }}
              />
            )}
          </h2>
          <p className="meta">
            <FormattedMessage
              id="result.rowCount"
              defaultMessage="Rows: {count}"
              values={{ count: total }}
            />
          </p>
        </div>
        <ResultActions
          sessionId={sessionId}
          referenceName={referenceName}
          onError={(e) => {
            setError(toAppError(e, intl, "read"));
          }}
        />
      </div>

      {staleAnchor && (
        // ADR-0047 stage-stale / ADR-0041 honest wording: the rows below are
        // real (they still load), but the result is no longer valid to build on
        // -- the invalidating source was removed/replaced. Rerun the question
        // against the new source to recompute. A warning Alert (ADR-0050);
        // role="status" is polite -- important, not an interrupting emergency.
        // The verb splits honestly via an ICU select on the anchor reason.
        <Alert variant="warning" role="status" className={WARNING_NOTICE_MARGIN}>
          <AlertDescription
            className={cn(onRerun && "flex items-center justify-between gap-3")}
          >
            <p className="m-0">
              <FormattedMessage
                id="disclosure.result.stale"
                defaultMessage="This result is stale (source {name} was {reason, select, Replaced {updated} other {deleted}}) — ask again to recompute against the new source."
                values={{ name: staleAnchor.display_name, reason: staleAnchor.reason }}
              />
            </p>
            {onRerun && (
              // Issue #758: the disclosure's "ask again" advice, made an
              // action -- fires the producing question as a fresh turn. The
              // aria-label carries the fuller accessible name (it contains the
              // visible label, WCAG 2.5.3).
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={rerunBusy}
                onClick={onRerun}
                aria-label={intl.formatMessage({
                  id: "disclosure.result.staleRerunLabel",
                  defaultMessage: "Rerun the original question",
                })}
              >
                <FormattedMessage id="disclosure.result.staleRerun" defaultMessage="Rerun" />
              </Button>
            )}
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

      {(showRowDisclosure || showColumnDisclosure) && (
        // ADR-0057 disclosures, merged into one banner (issue #768): the two
        // info-class hints share a trigger scenario (result scale) and a
        // semantic ("big result; the UI answers with pagination / horizontal
        // scroll; ask to focus"), so both landing at once is one notice with
        // two segments, not two stacked banners. Each segment renders only
        // when its threshold is crossed; thresholds and copy are unchanged.
        // Info Alert (ADR-0050); role="note" is static reference, not
        // announced. The segments sit an xxs (4px) apart via space-y -- the
        // intra-banner rhythm is tighter than the banner-to-banner rhythm.
        <Alert role="note" className="my-2">
          <AlertDescription className="space-y-1">
            {showRowDisclosure && (
              <p>
                <FormattedMessage
                  id="disclosure.result.largeRows"
                  defaultMessage="This result is large ({count} rows) and is paginated; ask a follow-up to focus on part of it."
                  values={{ count: total }}
                />
              </p>
            )}
            {showColumnDisclosure && (
              <p>
                <FormattedMessage
                  id="disclosure.result.manyColumns"
                  defaultMessage="This result has {count} columns; scroll horizontally to see them all."
                  values={{ count: columns.length }}
                />
              </p>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/*
        Chart slot (ADR-0062 R4): the chart, OR -- when a viz was emitted but
        failed -- the degradation disclosure REPLACING this slot (not a fourth
        stacked item). A null viz (plain table turn) renders neither.
      */}
      {showChart && decoded?.ok && (
        // Suspense boundary (issue #218): the fallback reuses the real chart's
        // .viz-chart class so the slot's margins match the loaded chart -- the
        // surrounding result-area layout stays put while the vega chunk loads.
        // The chart height itself is not reserved (vega-embed injects the
        // canvas, so the slot grows from 0 to the spec height on resolve; a
        // brief transient in a desktop app where the chunk is local and cached
        // after the first view). aria-hidden keeps the empty placeholder out of
        // the a11y tree. This load state is a separate layer from the
        // render-failure degrade path below -- a Vega rejection still routes
        // through onError and swaps in the disclosure.
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
        <Alert variant="warning" role="status" className={WARNING_NOTICE_MARGIN}>
          <AlertDescription>
            <FormattedMessage
              id="disclosure.result.vizDegraded"
              defaultMessage="The chart could not render; the table is shown instead. {reason}"
              values={{ reason: formatVizFailure(degradedReason, intl) }}
            />
          </AlertDescription>
        </Alert>
      )}

      {/* The read-error banner rides the warning rhythm (issue #768) via its
          className passthrough -- the only ErrorBanner caller that stacks
          against the other notices. */}
      {error && <ErrorBanner error={error} className={WARNING_NOTICE_MARGIN} />}

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
                className={isNumericType(c.canonical_type) ? NUMERIC_CELL : undefined}
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
                  <TableCell key={j} className={numeric ? NUMERIC_CELL : undefined}>
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
