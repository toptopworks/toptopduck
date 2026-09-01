import type { DatasetDescriptor } from "../../types/dataset";
import type { ThreadEntry } from "../../types/thread";

// Shared thread fixtures for src/session/__tests__/* tests. Each helper mints
// a minimal-but-real ThreadEntry / DatasetDescriptor (all required fields, no
// hand-rolled subset) so type errors surface at compile time, not runtime.

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
          assumption: null,
        },
      },
      trace: [], provenance: { skills: [] },
    },
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
