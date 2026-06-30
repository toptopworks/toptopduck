import type { TurnRecord, VizSpec } from "../types";

interface ThreadProps {
  records: TurnRecord[];
  /** The result reference currently shown in the result pane, so its thread
   * entry can be marked active. */
  selectedResult: string | null;
  /** Click a result turn to show its rows in the result pane. Carries the
   * turn's assumption so the side note is preserved across re-selections. */
  onSelectResult: (referenceName: string, assumption: string | null, viz: VizSpec | null) => void;
}

// The always-visible conversation thread (ADR-0028/0039). Every turn is listed
// in order, labeled by the verbatim question; the four TurnOutcome variants
// render distinctly (Materialized / Textual[Clarify,Refuse] / Failed /
// Cancelled), and the optional assumption note (ADR-0009/0018) shows as a
// correctable side note. A result turn is clickable to (re)show its rows in
// the result pane.
export function Thread({ records, selectedResult, onSelectResult }: ThreadProps) {
  if (records.length === 0) return null;
  return (
    <section className="panel thread" aria-label="对话历史">
      <h2>对话</h2>
      <ol>
        {records.map((record, i) => (
          // The thread is append-only and never reordered (ADR-0028/0039), so the
          // array index is a stable, unique key for each turn -- no separate id is
          // needed (YAGNI: an id would ripple through the Rust/TS model + wire
          // contract for no present benefit).
          <li key={i} className="turn">
            <p className="turn-question">{record.question}</p>
            <TurnBody
              record={record}
              selectedResult={selectedResult}
              onSelectResult={onSelectResult}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

interface TurnBodyProps {
  record: TurnRecord;
  selectedResult: string | null;
  onSelectResult: (referenceName: string, assumption: string | null, viz: VizSpec | null) => void;
}

// The provider's optional assumption note (ADR-0009/0018), rendered as a
// correctable side note on both Materialized and Textual turns. Extracted so
// the rendering isn't duplicated across the two outcomes that carry it.
function AssumptionNote({ assumption }: { assumption: string | null }) {
  if (!assumption) return null;
  return <span className="assumption">假设：{assumption}</span>;
}

function TurnBody({ record, selectedResult, onSelectResult }: TurnBodyProps) {
  switch (record.outcome.kind) {
    case "Materialized": {
      const { dataset, assumption, viz } = record.outcome.data;
      const active = dataset.reference_name === selectedResult;
      return (
        <p className="turn-outcome">
          <button
            type="button"
            className={active ? "result-link active" : "result-link"}
            aria-current={active ? "true" : undefined}
            onClick={() => onSelectResult(dataset.reference_name, assumption, viz)}
          >
            结果：{dataset.reference_name}
          </button>
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
