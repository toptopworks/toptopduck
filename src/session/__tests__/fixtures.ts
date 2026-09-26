import type { DatasetDescriptor } from "../../types/dataset";
import type { ThreadEntry, TurnRecord } from "../../types/thread";

// Shared thread fixtures for session tests plus cross-directory consumers
// (e.g. src/__tests__/App.test.tsx). Each helper mints a minimal-but-real
// ThreadEntry / DatasetDescriptor (all required fields, no hand-rolled
// subset) so type errors surface at compile time, not runtime.

export function src(name: string): DatasetDescriptor {
  return {
    reference_name: name,
    display_name: name,
    source_path: `/x/${name}.csv`,
    columns: [{ name: "id", canonical_type: "BIGINT" }],
    row_count: 1,
    sample: [["1"]],
    fingerprint: "ff".repeat(32),
    rectify: { kind: "NotApplicable" },
    privacy: { send_samples: true, type_only_columns: [] },
  };
}

export function materialized(referenceName: string): ThreadEntry {
  return {
    entry: "Turn",
    data: {
      question: `q:${referenceName}`,
      outcome: {
        kind: "Materialized",
        data: {
          // ADR-0084: a single-promotion result turn (the common case); the
          // chain tail is the primary result.
          promotions: [{ dataset: src(referenceName), sql: "SELECT 1" }],
          viz: null,
          body: null,
          assumption: null,
        },
      },
      trace: [], provenance: { skills: [] },
    },
  };
}

/** A textual turn carrying a delivered-files manifest (ADR-0124, issue
 * #1088): artifacts land on the TurnRecord (settle-frozen), whatever the
 * outcome kind. Paths default to an artifacts-dir shape (in scope). */
export function artifactTurn(
  paths: string[],
  outcome: TurnRecord["outcome"] = { kind: "Textual", data: { text_kind: "Agent", body: "done", assumption: null } },
): ThreadEntry {
  return {
    entry: "Turn",
    data: {
      question: "q",
      outcome,
      trace: [], provenance: { skills: [] },
      artifacts: paths.map((path) => {
        const name = path.split(/[\\/]/).pop() ?? path;
        return { path, file_name: name, durable: true };
      }),
    },
  };
}

/** The recorded row a settled ask leaves behind (issue #1088 mock parity):
 * record_turn commits before `ask` resolves, so the turn-end thread refetch
 * sees this row -- ask-flow tests seed it into their thread state like the
 * backend would, or the refetch wipes the optimistic append. */
export function recordedTurn(question: string, outcome: TurnRecord["outcome"]): ThreadEntry {
  return {
    entry: "Turn",
    data: { question, outcome, trace: [], provenance: { skills: [] } },
  };
}

export function textual(body: string): ThreadEntry {
  return {
    entry: "Turn",
    data: {
      question: "q",
      outcome: { kind: "Textual", data: { text_kind: "Clarify", body, assumption: null } },
      trace: [], provenance: { skills: [] },
    },
  };
}

export function failed(question: string): ThreadEntry {
  return {
    entry: "Turn",
    data: {
      question,
      outcome: { kind: "Failed", data: { kind: "Execute", data: { detail: "boom" } } },
      trace: [], provenance: { skills: [] },
    },
  };
}

export function cancelled(question: string): ThreadEntry {
  return {
    entry: "Turn",
    data: {
      question,
      outcome: { kind: "Cancelled", data: null },
      trace: [], provenance: { skills: [] },
    },
  };
}

/** A source-added lifecycle event (issue #1005's tail-scan consumers):
 *  never a turn, so it never displaces a latest-turn verdict. */
export function sourceAdded(referenceName: string): ThreadEntry {
  return {
    entry: "Source",
    data: { kind: "Added", reference_name: referenceName, display_name: referenceName },
  };
}
