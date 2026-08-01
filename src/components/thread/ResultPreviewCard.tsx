import { FormattedMessage, useIntl } from "react-intl";
import { cn } from "@/lib/utils";
import type { DatasetDescriptor } from "../../types/dataset";

// The inline result preview card (ADR-0083, issue #298): a Materialized turn
// carries the windowed sample of its PRIMARY result (the first rows frozen at
// copy-in, ADR-0026) so a rail scan shows what the answer looks like without
// opening the workspace. The card carries ONLY the sample -- wide tables /
// big charts stay workspace-only (ADR-0045's domain constraint survives via
// ADR-0083): horizontally scrollable at a fixed rail width, never stretched.
//
// Dual-view seam (ADR-0083): the card and the workspace result pane view the
// SAME dataset. Clicking the card selects its result (the caller opens the
// workspace + moves viewedResult); `active` mirrors the viewed selection back
// onto the card, so the rail and the panel always agree on which dataset is
// on stage.

export function ResultPreviewCard({
  dataset,
  active,
  stale,
  onSelect,
}: {
  dataset: DatasetDescriptor;
  /** This card's dataset is the viewed result (workspace dual-view linkage). */
  active: boolean;
  /** The turn is a stale ghost (ADR-0041/0047): the card dims + dashes with
   *  it. Still clickable -- a stale result stays viewable in the workspace. */
  stale: boolean;
  onSelect: () => void;
}) {
  const intl = useIntl();
  const { columns, sample, row_count } = dataset;
  const hasRows = row_count > 0 && sample.length > 0;
  return (
    <button
      type="button"
      // A real <button> (keyboard + focus for free); the sample grid rides
      // spans rather than a semantic <table> so the button's content model
      // (phrasing content) stays valid. The preview is a glance artifact --
      // the full table semantics live in the workspace ResultView.
      className={cn(
        "result-preview block mt-1.5 ml-6 max-w-full overflow-x-auto cursor-pointer",
        // The bare border rides the app.css base layer's var(--border) (same
        // as shadcn card / badge chrome); active flips it to --primary.
        "rounded-md border bg-background text-left text-xs transition-colors",
        "hover:bg-accent",
        // active (viewed in the workspace) = primary border (ADR-0050 active
        // semantic, mirroring the result-link's active state); stale = dashed
        // + muted like the result-link's stale state (the card's opacity dims
        // with the parent turn-card's stale-ghost treatment).
        active && "active border-primary",
        stale && "stale border-dashed",
      )}
      aria-label={intl.formatMessage(
        {
          id: "thread.preview.aria",
          defaultMessage: "Preview of {name} (first rows), open it in the workspace",
        },
        { name: dataset.reference_name },
      )}
      aria-current={active ? "true" : undefined}
      onClick={onSelect}
    >
      {hasRows ? (
        <span
          // w-max + min-w-full: content-width columns fill the card when the
          // table is narrow and overflow-scroll the button when it is wide
          // (the rail never stretches for a preview, ADR-0045 / ADR-0083).
          className="preview-grid grid w-max min-w-full"
          style={{ gridTemplateColumns: `repeat(${columns.length}, max-content)` }}
        >
          {/* Column index (not name) keys the grid: SQL may emit duplicate
            column names (an un-aliased `SELECT a.id, b.id`), which would
            collide React keys built from col.name. Column position is stable. */}
          {columns.map((col, c) => (
            <span
              key={c}
              className="preview-head px-1.5 py-1 font-medium text-muted-foreground whitespace-nowrap border-b"
            >
              {col.name}
            </span>
          ))}
          {sample.map((row, r) =>
            columns.map((_col, c) => (
              <span
                key={`${r}:${c}`}
                className={cn(
                  "preview-cell px-1.5 py-0.5 whitespace-nowrap text-foreground",
                  r > 0 && "border-t border-border/50",
                )}
              >
                {row[c] ?? ""}
              </span>
            )),
          )}
        </span>
      ) : null}
      <span
        className={cn(
          "preview-footer block px-1.5 py-1 text-muted-foreground whitespace-nowrap",
          hasRows && "border-t",
        )}
      >
        {hasRows ? (
          <FormattedMessage
            id="thread.preview.footer"
            defaultMessage="First {shown} of {total} rows"
            values={{ shown: sample.length, total: row_count }}
          />
        ) : (
          <FormattedMessage id="thread.preview.empty" defaultMessage="No rows" />
        )}
      </span>
    </button>
  );
}
