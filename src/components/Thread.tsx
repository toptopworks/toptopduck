import type { SourceLifecycleKind, StaleAnchor, ThreadEntry, TurnRecord, VizSpec } from "../types";
import { staleBadgeText } from "../staleBadge";

interface ThreadProps {
  /** The unified timeline (ADR-0040): turns interleaved with source lifecycle
   * events, in order. Source events render as non-interactive markers distinct
   * from turns. */
  entries: ThreadEntry[];
  /** The result reference currently shown in the result pane, so its thread
   * entry can be marked active. */
  selectedResult: string | null;
  /** Click a result turn to show its rows in the result pane. Carries the
   * turn's assumption so the side note is preserved across re-selections. */
  onSelectResult: (referenceName: string, assumption: string | null, viz: VizSpec | null) => void;
  /** Stale result_N anchors keyed by reference name (issue #40/#41,
   * ADR-0013): a Materialized turn whose result is now stale renders a
   * "因源已删除/已更新而失效" badge naming the invalidating source. The stale
   * flag lives on the live working-set descriptor (a TurnRecord's dataset
   * snapshot is the at-materialization state, always fresh), so the caller
   * derives this map from the current working set and passes it down -- the
   * thread itself holds no state. Optional so call sites that don't exercise
   * stale rendering (tests) can omit it; defaults to an empty map (no badges
   * rendered). */
  staleByReference?: ReadonlyMap<string, StaleAnchor>;
}

// The always-visible conversation thread (ADR-0028/0039/0040). Turns are listed
// in order, labeled by the verbatim question; the four TurnOutcome variants
// render distinctly (Materialized / Textual[Clarify,Refuse] / Failed /
// Cancelled), and the optional assumption note (ADR-0009/0018) shows as a
// correctable side note. A result turn is clickable to (re)show its rows, and a
// now-stale result (issue #40/#41) carries an "因源已删除/已更新而失效" badge
// while staying visible (soft invalidation, ADR-0013). Source lifecycle events
// (Added/Deleted/Replaced) render as non-interactive markers -- they occupy a
// timeline slot and are always visible but are NOT turns, so they never show a
// question/outcome and never enter the LLM window.
export function Thread({ entries, selectedResult, onSelectResult, staleByReference = new Map() }: ThreadProps) {
  if (entries.length === 0) return null;
  return (
    <section className="panel thread" aria-label="对话历史">
      <h2>对话</h2>
      <ol>
        {entries.map((entry, i) => (
          // The thread is append-only and never reordered (ADR-0028/0039/0040),
          // so the array index is a stable, unique key for each entry -- no
          // separate id is needed (YAGNI: an id would ripple through the
          // Rust/TS model + wire contract for no present benefit).
          // TODO: if thread truncation/pagination or entry-local UI state
          // (fold/copy/select) ever lands, switch to a stable monotonic id --
          // index keys would mispatch DOM state across re-renders then.
          <li key={i} className={entry.entry === "Turn" ? "turn" : "source-event"}>
            {entry.entry === "Turn" ? (
              <TurnEntry
                record={entry.data}
                selectedResult={selectedResult}
                onSelectResult={onSelectResult}
                staleByReference={staleByReference}
              />
            ) : (
              <SourceEvent kind={entry.data.kind} displayName={entry.data.display_name} />
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

// A source lifecycle event rendered as a non-interactive timeline marker
// (ADR-0040): distinct from a turn (no question, no outcome). Added = "＋", a
// source entered the working set; Deleted = "－", a source left it; Replaced =
// "↻", a source's backing snapshot was swapped under the same reference name
// (issue #41, ADR-0025). The display label is carried on the event so it still
// names what was added/removed/replaced after the descriptor is gone.
function SourceEvent({ kind, displayName }: { kind: SourceLifecycleKind; displayName: string }) {
  const { marker, verb } = sourceLifecycleText(kind);
  return (
    <p className={`source-lifecycle ${kind.toLowerCase()}`}>
      <span className="source-marker" aria-hidden="true">{marker}</span>
      <span className="source-text">{verb}「{displayName}」</span>
    </p>
  );
}

// Exhaustiveness guard mirroring Rust's compile-time match on
// `SourceLifecycleKind`: a future variant (e.g. Replaced, #41) must add a
// branch here. `types.ts` is the hand-maintained mirror of the Rust enum, so
// the TS compiler won't catch a missing branch without this `never` check
// (consistent with the `TurnBody` guard below).
function sourceLifecycleText(kind: SourceLifecycleKind): { marker: string; verb: string } {
  switch (kind) {
    case "Added":
      return { marker: "＋", verb: "加载了" };
    case "Deleted":
      return { marker: "－", verb: "删除了" };
    case "Replaced":
      // Mirrors the working-set list's ↻ replace glyph; "换源了" carries the
      // PRD term (CONTEXT.md / ADR-0025), distinct from 加载了 (a new name).
      return { marker: "↻", verb: "换源了" };
    default: {
      const unhandled: never = kind;
      throw new Error(`unhandled source lifecycle kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

interface TurnEntryProps {
  record: TurnRecord;
  selectedResult: string | null;
  onSelectResult: (referenceName: string, assumption: string | null, viz: VizSpec | null) => void;
  staleByReference: ReadonlyMap<string, StaleAnchor>;
}

// The provider's optional assumption note (ADR-0009/0018), rendered as a
// correctable side note on both Materialized and Textual turns. Extracted so
// the rendering isn't duplicated across the two outcomes that carry it.
function AssumptionNote({ assumption }: { assumption: string | null }) {
  if (!assumption) return null;
  return <span className="assumption">假设：{assumption}</span>;
}

function TurnEntry({ record, selectedResult, onSelectResult, staleByReference }: TurnEntryProps) {
  return (
    <>
      <p className="turn-question">{record.question}</p>
      <TurnBody
        record={record}
        selectedResult={selectedResult}
        onSelectResult={onSelectResult}
        staleByReference={staleByReference}
      />
    </>
  );
}

interface TurnBodyProps {
  record: TurnRecord;
  selectedResult: string | null;
  onSelectResult: (referenceName: string, assumption: string | null, viz: VizSpec | null) => void;
  staleByReference: ReadonlyMap<string, StaleAnchor>;
}

function TurnBody({ record, selectedResult, onSelectResult, staleByReference }: TurnBodyProps) {
  switch (record.outcome.kind) {
    case "Materialized": {
      const { dataset, assumption, viz } = record.outcome.data;
      const active = dataset.reference_name === selectedResult;
      // Issue #40/#41 / ADR-0013: if this result has since gone stale, render
      // the traceability badge naming the invalidating source (removed or
      // re-uploaded). The result stays visible (soft invalidation) -- the
      // badge is what tells the user it's no longer valid to build on.
      const staleAnchor = staleByReference.get(dataset.reference_name);
      return (
        <p className="turn-outcome">
          <button
            type="button"
            className={`${active ? "result-link active" : "result-link"}${staleAnchor ? " stale" : ""}`}
            aria-current={active ? "true" : undefined}
            onClick={() => onSelectResult(dataset.reference_name, assumption, viz)}
          >
            结果：{dataset.reference_name}
          </button>
          {staleAnchor && (
            <span className="stale-badge">{staleBadgeText(staleAnchor)}</span>
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
          <span className="textual-kind">{isClarify ? "需要澄清" : "无法处理"}</span>
          <span className="textual-body">{body}</span>
          <AssumptionNote assumption={assumption} />
        </p>
      );
    }
    case "Failed":
      return (
        <p className="turn-outcome failed">
          <span className="failed-reason">失败：{record.outcome.data.reason}</span>
        </p>
      );
    case "Cancelled":
      return <p className="turn-outcome cancelled">已取消</p>;
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
