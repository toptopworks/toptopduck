import { useEffect, useId, useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { toAppError } from "../../lib/error-presentation";
import { useRowPage } from "../../session/useRowPage";
import type { RowPage } from "../../types/dataset";
import { decodeViz, type VizFailureReason } from "../viz/viz";
import { VizChartSlot } from "../viz/LazyVegaChart";
import { VizEnlargeDialog } from "../viz/VizEnlargeDialog";
import { formatVizFailure } from "../viz/viz-failure";
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

// The chart rides the shared chart slot (issue #218) -- see VizChartSlot for
// why the lazy door and its Suspense fallback live in one place. The
// component's own render / theme-bridge / resize-on-unhide / finalize logic
// is untouched -- lazy only shifts the module load time, not behavior.

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

// Module-level empties so the pre-settle render path (no page yet) keeps a
// stable reference -- the numericFlags useMemo depends on `columns`, and an
// inline `?? []` would invalidate it every render (exhaustive-deps enforces
// this exact shape).
const EMPTY_COLUMNS: ColumnSchema[] = [];
const EMPTY_ROWS: string[][] = [];

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

interface ResultViewProps {
  /** ADR-0056: the session this result belongs to -- readRows addresses it. */
  sessionId: string;
  referenceName: string;
  /** Issue #772: the question that produced this result -- the pane title's
   * text, rendered verbatim (user data, never the catalog). Required like its
   * domain source (WorkspaceContent.result.question, itself derived from the
   * required persisted turn field); an empty string (the only degenerate form
   * -- an ask IPC caller bypassing the composer's trim guard) falls back to
   * the reference-name title, never an empty heading. */
  question: string;
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
  // The paging window is this view's UI state (the seam takes offset as a
  // parameter, issue #1079): a result switch resets it to page 0 -- adjusted
  // during render so the seam never fetches the prior result's offset
  // against the new reference (React discards the mid-render output before
  // committing, so no observer ever mounts on the stale window). The
  // take-it-away actions' failures (issue #769) ride their own slot: every
  // window move clears it, so a stale action failure never follows the user
  // into the next window.
  const [windowRef, setWindowRef] = useState(referenceName);
  const [offset, setOffset] = useState(0);
  const [actionError, setActionError] = useState<AppError | null>(null);
  if (windowRef !== referenceName) {
    setWindowRef(referenceName);
    setOffset(0);
    setActionError(null);
  }

  // Issue #1079: the paged read rides the useRowPage snapshot seam -- one
  // cached query per (reference, offset) window.
  const { page, inFlight, error: readError, refetch } = useRowPage(sessionId, referenceName, offset, pageSize);

  // An errored window has no placeholder (keepPreviousData holds only while
  // the new key is pending), so the last landed page is tracked separately
  // and shown through the error: without it a rejected turn renders a false
  // empty table with both pager buttons dead (the retired machine kept the
  // last page on screen through its catch).
  const [lastGoodPage, setLastGoodPage] = useState<RowPage | null>(null);
  if (page !== null && page !== lastGoodPage) {
    setLastGoodPage(page);
  }
  const shownPage = page ?? lastGoodPage;

  const columns = shownPage?.columns ?? EMPTY_COLUMNS;
  const rows = shownPage?.rows ?? EMPTY_ROWS;
  const total = shownPage?.total ?? 0;
  // The DISPLAYED window's offset (the snapshot's own, so the count and the
  // prev/next bounds stay pinned to the rows on screen). The component's
  // `offset` is the FETCH target and moves the instant a page turn starts --
  // deriving the count from it would mix the new offset with the previous
  // page's placeholder rows and flash a window that was never fetched.
  const shownOffset = shownPage?.offset ?? 0;

  // Stable id linking the table to its heading so the heading text is the
  // table's accessible name.
  const headingId = useId();
  const intl = useIntl();

  // Issue #194: a readRows reject typed as AppError, kind "read" (a readRows
  // reject is the read phase of a turn; toAppError applies no verb prefix on
  // the read kind, and ErrorBanner renders only message + detail, not kind).
  // The seam passes the reject through raw; the formatting happens here.
  // The actions' error wins when both exist: a snapshot read's reject is
  // sticky under its key -- without the priority the newest failure would
  // be silently swallowed.
  const error = actionError ?? (readError !== null ? toAppError(readError, intl, "read") : null);

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

  const hasNext = shownOffset + rows.length < total;
  const hasPrev = shownOffset > 0;
  const shown = rows.length;

  // Issue #773: has the first load settled (success OR error)? Gates the
  // pagination count's content so the pre-settle state (no page, no error)
  // never renders "Rows 0–0 (of 0)" -- a fake value flashing in the count
  // bar. Re-gates only where no honest value exists: a page turn or result
  // switch keeps the last real page on screen (keepPreviousData while
  // pending, the last-good fallback after an error), but a switch away from
  // an errored first load has neither, so the count waits for the new read.
  const settled = shownPage !== null || readError !== null;

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
          <h2 id={headingId} className="mb-1 text-base font-semibold">
            {question ? (
              /* Issue #772: the title is the producing question's verbatim
               * text -- a human coordinate, not the machine reference name
               * (which stays rail-side). Single-line truncate with hover
               * recovery; the full text stays in the DOM, so the table's
               * aria-labelledby name carries it whole. The recovery tooltip
               * keeps the question's line structure (the rail bubble's
               * whitespace-pre-wrap posture, ADR-0103) so a multi-line
               * question is recovered whole, not space-joined. */
              <TruncatingTooltip
                text={question}
                className="block truncate"
                contentClassName="whitespace-pre-wrap"
              >
                {question}
              </TruncatingTooltip>
            ) : (
              /* Degenerate-empty-string fallback (defense in depth: the
               * derivation layer types the question required and the composer
               * rejects blank submits, so only an ask caller bypassing the
               * editor can land here): the reference-name title, never an
               * empty heading. */
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
            // The error write owns only the error slot: ResultActions holds
            // the click-time closure across the pull's awaits, and its stale
            // guard does not cover paging within the same result, so
            // restating the window here would yank the view back to the
            // pull's start offset.
            setActionError(toAppError(e, intl, "read"));
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
        // `relative` anchors the enlarge affordance to the chart's corner
        // (#1050); the swap-in disclosure below carries no affordance, so a
        // failed chart has nothing to enlarge.
        <div className="relative">
          <VizChartSlot spec={decoded.spec} onError={setRenderError} />
          <VizEnlargeDialog spec={decoded.spec} />
        </div>
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
          {shown === 0 && !inFlight && (
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
        {/* Issue #773: the count's content mounts only after the first load
          settles. Before that, the pre-settle state (no page yet) would
          render "Rows 0–0 (of 0)" -- a fake value flashing in the count bar.
          The region itself stays mounted from the first frame, so the first
          real count lands as a text mutation -- the reliably announced class
          (content present when a live region is created is commonly not
          announced). In flight the content keeps the last real values (the
          buttons disable while in flight, so the stale count is never
          actionable), and a 0-row result renders its honest true "0–0 (of
          0)". */}
        <span aria-live="polite">
          {settled ? (
            <FormattedMessage
              id="result.pagination.range"
              defaultMessage="Rows {start}–{end} (of {total})"
              values={{
                start: total === 0 ? 0 : shownOffset + 1,
                end: shownOffset + shown,
                total,
              }}
            />
          ) : null}
        </span>
        <button
          type="button"
          disabled={!hasPrev || inFlight}
          onClick={() => {
            setOffset(Math.max(0, offset - pageSize));
            setActionError(null);
          }}
          className={PAGE_BTN}
        >
          <FormattedMessage id="result.pagination.prev" defaultMessage="Previous" />
        </button>
        <button
          type="button"
          disabled={!hasNext || inFlight}
          onClick={() => {
            // An errored window's Next is the in-place retry: the offset
            // already points at the failed window, so re-targeting it would
            // bail out on the same value -- refetch through the seam.
            if (readError !== null && page === null) {
              refetch();
            } else {
              setOffset(offset + pageSize);
            }
            setActionError(null);
          }}
          className={PAGE_BTN}
        >
          <FormattedMessage id="result.pagination.next" defaultMessage="Next" />
        </button>
      </div>
    </section>
  );
}
