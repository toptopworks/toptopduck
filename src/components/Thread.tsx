import { useCallback, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import {
  Ban,
  CircleOff,
  MessageCircleQuestion,
  Plus,
  RefreshCw,
  Table2,
  Trash2,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type {
  SourceLifecycleEvent,
  SourceLifecycleKind,
  StaleAnchor,
  StaleReason,
  ThreadEntry,
  TurnOutcome,
  TurnRecord,
} from "../types";

// A compact label for the active-chip match (ADR-0047): the thread only needs
// the names to detect when a question explicitly points at a dataset, so the
// descriptor is narrowed at the call site rather than threaded through whole.
export interface DatasetLabel {
  referenceName: string;
  displayName: string;
}

interface ThreadProps {
  /** The unified timeline (ADR-0040): turns interleaved with source lifecycle
   * events, in order. Source events render as non-interactive markers distinct
   * from turns. */
  entries: ThreadEntry[];
  /** The result reference currently shown in the result pane, so its thread
   * entry can be marked active. */
  selectedResult: string | null;
  /** Click a result turn to show its rows in the result pane. Carries only the
   * reference name -- assumption/viz are derived from the thread by the caller
   * (single source of truth, ADR-0051), not carried as a fat snapshot. */
  onSelectResult: (referenceName: string) => void;
  /** Stale result_N anchors keyed by reference name (issue #40/#41,
   * ADR-0013): a Materialized turn whose result is now stale renders as a ghost
   * (CircleOff + reduced opacity) plus a clickable causal chip that jumps to
   * the invalidating source event. The stale flag lives on the live working-set
   * descriptor (a TurnRecord's dataset snapshot is the at-materialization
   * state, always fresh), so the caller derives this map from the current
   * working set and passes it down -- the thread itself holds no state.
   * Optional so call sites that don't exercise stale rendering (tests) can omit
   * it; defaults to an empty map (no ghosts rendered). */
  staleByReference?: ReadonlyMap<string, StaleAnchor>;
  /** Non-stale dataset labels used to detect when a turn's question explicitly
   * names a working-set dataset (ADR-0047 conditional active chip). Most turns
   * act implicitly on the prior step, so the chip is absent by default; it
   * lights up only when the user typed a dataset name. Optional for tests that
   * do not exercise the chip; defaults to empty (no chips rendered). */
  datasetLabels?: ReadonlyArray<DatasetLabel>;
}

// The always-visible conversation thread (ADR-0028/0039/0040/0047). The rail
// hosts two visually distinct species: turn cards (single-line verbatim
// question + outcome glyph/color) and source lifecycle markers (thin, full-
// width, non-interactive). A Materialized result that has since gone stale
// renders as a ghost (CircleOff + reduced opacity) whose causal chip jumps to
// the invalidating source event (ADR-0041/0047). Source events are first-class
// in the thread (always visible, occupy a slot) but are NOT turns -- they never
// show a question/outcome and never enter the LLM window.
//
// i18n (ADR-0052): every layer-1 chrome string (headings, outcome/source
// labels, stale chips, active-chip tooltip) routes through react-intl with a
// STATIC literal id + defaultMessage so @formatjs/cli extract can resolve the
// source id set for the CI alignment guard. Layer-4 content (the verbatim
// question, reference names, display names, LLM failure reasons) passes through
// untranslated via ICU placeholders; the assumption note's text is layer-3 LLM
// content and is likewise passed through.
export function Thread({
  entries,
  selectedResult,
  onSelectResult,
  staleByReference = new Map(),
  datasetLabels = [],
}: ThreadProps) {
  const intl = useIntl();
  // The source-event index currently highlighted by a stale-chip jump-select
  // (ADR-0047 chip-trace). Persistent so the user sees which event a stale chip
  // pointed at; a subsequent jump moves it. null when no chip has been clicked.
  const [highlightedSourceIdx, setHighlightedSourceIdx] = useState<number | null>(null);
  // One ref per source-event <li> so a chip jump can scrollIntoView the match.
  // The thread is append-only (ADR-0028/0040) so indices are stable positions.
  const sourceRefs = useRef<(HTMLLIElement | null)[]>([]);

  // Stale-derivative count per (reference_name, reason), so a Replaced/Deleted
  // source marker can show "失效 N" naming how many results that event killed.
  // No event_id is added (ADR-0047 YAGNI); the count is attributed by matching
  // reference_name + kind, exact for the common single-event case.
  const staleCountsByKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const anchor of staleByReference.values()) {
      const key = `${anchor.reference_name}:${anchor.reason}`;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }, [staleByReference]);

  // Click a stale causal chip (ADR-0047): jump-select the nearest matching
  // SourceLifecycleEvent AFTER this result's turn. Causality guarantees the
  // invalidating event follows the turn (the result existed, then the source
  // changed); "nearest one" resolves same-source repeated lifecycles. No line
  // is drawn, no event_id is stored -- the chip reuses the existing
  // source-lifecycle derivation (ADR-0047).
  const handleStaleChipJump = useCallback(
    (turnIdx: number, anchor: StaleAnchor) => {
      const targetKind = reasonToSourceKind(anchor.reason);
      for (let i = turnIdx + 1; i < entries.length; i++) {
        const e = entries[i];
        if (
          e.entry === "Source" &&
          e.data.reference_name === anchor.reference_name &&
          e.data.kind === targetKind
        ) {
          setHighlightedSourceIdx(i);
          // Optional-call: jsdom does not implement scrollIntoView, so guard
          // the method itself (a real browser scrolls; tests assert the
          // data-highlighted attribute set on the line above instead).
          sourceRefs.current[i]?.scrollIntoView?.({ behavior: "smooth", block: "center" });
          return;
        }
      }
      // No matching event after the turn -- the resume edge case noted in
      // ADR-0047. No-op rather than a broken scroll to nothing.
    },
    [entries],
  );

  if (entries.length === 0) return null;
  return (
    <section
      className="panel thread"
      aria-label={intl.formatMessage({
        id: "thread.ariaLabel",
        defaultMessage: "Conversation history",
      })}
    >
      <h2>
        <FormattedMessage id="thread.title" defaultMessage="Conversation" />
      </h2>
      <ol>
        {entries.map((entry, i) => {
          if (entry.entry === "Turn") {
            const staleAnchor =
              entry.data.outcome.kind === "Materialized"
                ? staleByReference.get(entry.data.outcome.data.dataset.reference_name)
                : undefined;
            return (
              <li
                // The thread is append-only and never reordered (ADR-0028/0039/
                // 0040), so the array index is a stable, unique key for each
                // entry -- no separate id is needed (YAGNI: an id would ripple
                // through the Rust/TS model + wire contract for no present
                // benefit). Switch to a stable monotonic id if entry-local UI
                // state (fold/copy) ever lands.
                key={i}
                className="turn-entry"
                data-outcome={entry.data.outcome.kind.toLowerCase()}
              >
                <TurnCard
                  record={entry.data}
                  selectedResult={selectedResult}
                  onSelectResult={onSelectResult}
                  staleAnchor={staleAnchor}
                  mentionedDataset={findMentionedDataset(entry.data.question, datasetLabels)}
                  onStaleChipJump={(anchor) => handleStaleChipJump(i, anchor)}
                />
              </li>
            );
          }
          const staleCount =
            entry.data.kind === "Added"
              ? 0
              : staleCountsByKey.get(`${entry.data.reference_name}:${entry.data.kind}`) ?? 0;
          return (
            <li
              key={i}
              ref={(el) => {
                sourceRefs.current[i] = el;
              }}
              className="source-entry"
              data-source-kind={entry.data.kind.toLowerCase()}
              data-highlighted={highlightedSourceIdx === i ? "true" : undefined}
            >
              <SourceMarker event={entry.data} staleCount={staleCount} />
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// A source lifecycle event rendered as a non-interactive timeline marker
// (ADR-0040/0047): distinct species from a turn (no question, no outcome icon).
// Added = Plus (a source entered the working set); Deleted = Trash2 (a source
// left it); Replaced = RefreshCw (a source's backing snapshot was swapped under
// the same reference name, ADR-0025). A Replaced/Deleted marker names how many
// derivatives it invalidated ("失效 N") when that count is non-zero. The marker
// is thin and full-width so the two species read as visually distinct at a
// glance. The display name is layer-4 canonical (ADR-0037) and passes through
// the {name} ICU placeholder untranslated.
function SourceMarker({
  event,
  staleCount,
}: {
  event: SourceLifecycleEvent;
  staleCount: number;
}) {
  const intl = useIntl();
  const { Icon, text } = sourceMarkerText(intl, event.kind, event.display_name);
  return (
    <p className={`source-lifecycle ${event.kind.toLowerCase()}`}>
      <Icon className="source-icon" aria-hidden="true" />
      <span className="source-text">
        {text}
        {staleCount > 0 && (
          <span className="source-stale-count">
            <FormattedMessage
              id="thread.source.staleSuffix"
              defaultMessage=" · invalidated {count}"
              values={{ count: staleCount }}
            />
          </span>
        )}
      </span>
    </p>
  );
}

// Lucide glyph + i18n'd text per source lifecycle kind (ADR-0050 glyph mapping,
// ADR-0052 i18n). The verb + display name ride one ICU message so the quoting
// convention (zh 「」 vs en ") follows the locale. Exhaustiveness guard
// mirroring Rust's compile-time match on `SourceLifecycleKind`: a future variant
// must add a branch here. `types.ts` is the hand-maintained mirror of the Rust
// enum, so the TS compiler won't catch a missing branch without this `never`
// check.
function sourceMarkerText(
  intl: IntlShape,
  kind: SourceLifecycleKind,
  name: string,
): { Icon: LucideIcon; text: string } {
  switch (kind) {
    case "Added":
      return {
        Icon: Plus,
        text: intl.formatMessage(
          { id: "thread.source.added", defaultMessage: "Loaded \"{name}\"" },
          { name },
        ),
      };
    case "Deleted":
      return {
        Icon: Trash2,
        text: intl.formatMessage(
          { id: "thread.source.deleted", defaultMessage: "Deleted \"{name}\"" },
          { name },
        ),
      };
    case "Replaced":
      // "Replaced" carries the PRD term (CONTEXT.md / ADR-0025), distinct from
      // Added (a new name) and Deleted (a name gone).
      return {
        Icon: RefreshCw,
        text: intl.formatMessage(
          { id: "thread.source.replaced", defaultMessage: "Replaced \"{name}\"" },
          { name },
        ),
      };
    default: {
      const unhandled: never = kind;
      throw new Error(`unhandled source lifecycle kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

// A turn's outcome mapped to its Lucide glyph + accessible label (ADR-0047/0050
// four-outcome visual language, ADR-0052 i18n). A stale Materialized turn swaps
// Table2 for CircleOff (ghost). The label rides the icon's aria-label so the
// outcome kind is conveyed to assistive tech and is queryable in tests without
// relying on color alone.
function outcomeVisual(
  intl: IntlShape,
  outcome: TurnOutcome,
  stale: boolean,
): { Icon: LucideIcon; label: string } {
  if (stale && outcome.kind === "Materialized") {
    return {
      Icon: CircleOff,
      label: intl.formatMessage({ id: "thread.outcome.stale", defaultMessage: "Result stale" }),
    };
  }
  switch (outcome.kind) {
    case "Materialized":
      return {
        Icon: Table2,
        label: intl.formatMessage({
          id: "thread.outcome.materialized",
          defaultMessage: "Result ready",
        }),
      };
    case "Textual":
      return {
        // ADR-0050 maps B to Lucide `MessageSquareQuestion`, but that glyph is
        // absent in lucide-react@1.24.0; `MessageCircleQuestion` is the closest
        // available (question-mark semantics preserved). Switch back if a later
        // lucide version ships MessageSquareQuestion. B bundles Clarify + Refuse
        // behind one neutral glyph (the split icon is deferred to visual
        // polish); the label still names which sub-kind.
        Icon: MessageCircleQuestion,
        label:
          outcome.data.text_kind === "Clarify"
            ? intl.formatMessage({
                id: "thread.outcome.clarify",
                defaultMessage: "Needs clarification",
              })
            : intl.formatMessage({
                id: "thread.outcome.refused",
                defaultMessage: "Cannot fulfill",
              }),
      };
    case "Failed":
      return {
        Icon: TriangleAlert,
        label: intl.formatMessage({ id: "thread.outcome.failed", defaultMessage: "Failed" }),
      };
    case "Cancelled":
      return {
        Icon: Ban,
        label: intl.formatMessage({
          id: "thread.outcome.cancelled",
          defaultMessage: "Cancelled",
        }),
      };
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled turn outcome: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Detect whether a turn's question explicitly names a working-set dataset
// (ADR-0047 conditional active chip). Most turns act implicitly on the prior
// step, so the chip is absent by default; it lights up only when the user typed
// a dataset name ("在订单表上"), making the chip a signal rather than noise.
// Matches on the display label (what the user sees/types) first, then the
// reference name (for users who know the technical id); the first hit wins.
function findMentionedDataset(
  question: string,
  labels: ReadonlyArray<DatasetLabel>,
): DatasetLabel | null {
  for (const label of labels) {
    if (question.includes(label.displayName)) return label;
  }
  for (const label of labels) {
    if (question.includes(label.referenceName)) return label;
  }
  return null;
}

// Maps a stale reason to the source lifecycle kind that invalidates a result
// (ADR-0047 chip-trace mapping). A Replaced source invalidates via a Replaced
// event; a Deleted source via a Deleted event. Added never invalidates
// (ADR-0040), so it has no entry. Exhaustiveness guard so a future StaleReason
// variant forces a branch here.
function reasonToSourceKind(reason: StaleReason): SourceLifecycleKind {
  switch (reason) {
    case "Replaced":
      return "Replaced";
    case "Deleted":
      return "Deleted";
    default: {
      const unhandled: never = reason;
      throw new Error(`unhandled stale reason: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Concise verb for the stale causal chip (ADR-0041 honest split, ADR-0052 i18n):
// a Replaced source -> "Source updated" (the SQL still physically runs on the
// new backing; v1 just does not recompute); a Deleted source -> "Upstream
// deleted" (the reference name is gone, truly unavailable). The wording split
// signals whether the user could re-ask to recover the result. Distinct from
// staleBadgeText (the working-set list's full sentence) -- the chip is a
// compact, clickable label.
function staleChipVerb(intl: IntlShape, reason: StaleReason): string {
  switch (reason) {
    case "Replaced":
      return intl.formatMessage({
        id: "thread.staleChip.replaced",
        defaultMessage: "Source updated",
      });
    case "Deleted":
      return intl.formatMessage({
        id: "thread.staleChip.deleted",
        defaultMessage: "Upstream deleted",
      });
    default: {
      const unhandled: never = reason;
      throw new Error(`unhandled stale reason: ${JSON.stringify(unhandled)}`);
    }
  }
}

interface TurnCardProps {
  record: TurnRecord;
  selectedResult: string | null;
  onSelectResult: (referenceName: string) => void;
  staleAnchor: StaleAnchor | undefined;
  mentionedDataset: DatasetLabel | null;
  onStaleChipJump: (anchor: StaleAnchor) => void;
}

// One turn rendered as a single-row head (ADR-0047): outcome glyph + verbatim
// question (tail-truncated, head kept per ADR-0054) + a conditional active chip
// when the question named a dataset. The outcome body (result link / textual
// body / failure reason / cancelled marker) renders beneath so the four kinds
// stay distinguishable by text as well as by glyph/color (ADR-0028). A stale
// Materialized turn becomes a ghost (CircleOff + reduced opacity) and gains a
// clickable causal chip; Failed/Cancelled are weakened (opacity) but kept
// visible -- never collapsed away (ADR-0028 Why 2). The verbatim question and
// the chip's dataset display name are layer-4 content (ADR-0039/0037) and pass
// through untranslated.
function TurnCard({
  record,
  selectedResult,
  onSelectResult,
  staleAnchor,
  mentionedDataset,
  onStaleChipJump,
}: TurnCardProps) {
  const intl = useIntl();
  const isStale = !!staleAnchor;
  const { Icon, label } = outcomeVisual(intl, record.outcome, isStale);
  return (
    <div className={`turn-card${isStale ? " stale-ghost" : ""}`} data-stale={isStale ? "true" : undefined}>
      <div className="turn-head">
        <span className="outcome-icon" role="img" aria-label={label}>
          <Icon aria-hidden="true" />
        </span>
        {/* The verbatim question is the identity handle (ADR-0039): single-line,
            tail-ellipsis truncation keeps the head (where identity concentrates)
            visible at a fixed rail width (ADR-0054). The full text rides title. */}
        <span className="turn-question" title={record.question}>
          {record.question}
        </span>
        {mentionedDataset && (
          <span
            className="turn-active-chip"
            title={intl.formatMessage(
              { id: "thread.activeChip.title", defaultMessage: "Question names \"{name}\"" },
              { name: mentionedDataset.displayName },
            )}
          >
            →{mentionedDataset.displayName}
          </span>
        )}
      </div>
      <TurnBody
        record={record}
        selectedResult={selectedResult}
        onSelectResult={onSelectResult}
        staleAnchor={staleAnchor}
        onStaleChipJump={onStaleChipJump}
      />
    </div>
  );
}

// The provider's optional assumption note (ADR-0009/0018), rendered as a
// correctable side note on both Materialized and Textual turns. The assumption
// text is layer-3 LLM content (ADR-0052) and passes through the {text}
// placeholder untranslated; only the "Assumption:" prefix is chrome. Extracted
// so the rendering isn't duplicated across the two outcomes that carry it.
function AssumptionNote({ assumption }: { assumption: string | null }) {
  const intl = useIntl();
  if (!assumption) return null;
  return (
    <span className="assumption">
      {intl.formatMessage(
        { id: "thread.assumption", defaultMessage: "Assumption: {text}" },
        { text: assumption },
      )}
    </span>
  );
}

interface TurnBodyProps {
  record: TurnRecord;
  selectedResult: string | null;
  onSelectResult: (referenceName: string) => void;
  staleAnchor: StaleAnchor | undefined;
  onStaleChipJump: (anchor: StaleAnchor) => void;
}

function TurnBody({
  record,
  selectedResult,
  onSelectResult,
  staleAnchor,
  onStaleChipJump,
}: TurnBodyProps) {
  const intl = useIntl();
  switch (record.outcome.kind) {
    case "Materialized": {
      const { dataset, assumption } = record.outcome.data;
      const active = dataset.reference_name === selectedResult;
      return (
        <p className="turn-outcome">
          <button
            type="button"
            className={`${active ? "result-link active" : "result-link"}${staleAnchor ? " stale" : ""}`}
            aria-current={active ? "true" : undefined}
            onClick={() => onSelectResult(dataset.reference_name)}
          >
            <FormattedMessage
              id="thread.resultLink"
              defaultMessage="Result: {name}"
              values={{ name: dataset.reference_name }}
            />
          </button>
          {staleAnchor && (
            <button
              type="button"
              className="stale-chip"
              aria-label={intl.formatMessage(
                {
                  id: "thread.staleChip.aria",
                  defaultMessage: "Stale because {reason}, jump to the source event",
                },
                { reason: staleChipVerb(intl, staleAnchor.reason) },
              )}
              onClick={() => onStaleChipJump(staleAnchor)}
            >
              {staleChipVerb(intl, staleAnchor.reason)}
            </button>
          )}
          <AssumptionNote assumption={assumption} />
        </p>
      );
    }
    case "Textual": {
      const { text_kind, body, assumption } = record.outcome.data;
      const isClarify = text_kind === "Clarify";
      return (
        <p className={`turn-outcome textual ${text_kind.toLowerCase()}`}>
          <span className="textual-kind">
            {isClarify ? (
              <FormattedMessage id="thread.outcome.clarify" defaultMessage="Needs clarification" />
            ) : (
              <FormattedMessage id="thread.outcome.refused" defaultMessage="Cannot fulfill" />
            )}
          </span>
          <span className="textual-body">{body}</span>
          <AssumptionNote assumption={assumption} />
        </p>
      );
    }
    case "Failed":
      return (
        <p className="turn-outcome failed">
          <span className="failed-reason">
            <FormattedMessage
              id="thread.failedReason"
              defaultMessage="Failed: {reason}"
              values={{ reason: record.outcome.data.reason }}
            />
          </span>
        </p>
      );
    case "Cancelled":
      return (
        <p className="turn-outcome cancelled">
          <FormattedMessage id="thread.outcome.cancelled" defaultMessage="Cancelled" />
        </p>
      );
    default: {
      // Exhaustiveness guard: a future TurnOutcome variant must add a case here,
      // mirroring Rust's compile-time match exhaustiveness. types.ts is the
      // hand-maintained mirror, so the TS compiler won't catch a missing branch
      // without this `never` check.
      const unhandled: never = record.outcome;
      throw new Error(`unhandled turn outcome: ${JSON.stringify(unhandled)}`);
    }
  }
}
