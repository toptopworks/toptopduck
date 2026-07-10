import { describe, expect, it } from "vitest";
import {
  deriveWorkspaceContent,
  findMaterializedPayload,
  isNonMaterialized,
  lastTurnEntry,
} from "../workspace";
import type { DatasetDescriptor, ThreadEntry, TurnRecord } from "../../types";

// Unit tests for the pure workspace-derivation helpers (ADR-0051 / ADR-0062
// R2). These are the architectural invariants the shell's "what does the
// workspace show right now?" decision hinges on -- testing them in isolation
// (without React / the IPC mock layer) pins the three-state rule + the truth-
// source split (thread = turn payload truth) precisely.

function src(name: string): DatasetDescriptor {
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

function materialized(referenceName: string): ThreadEntry {
  return {
    entry: "Turn",
    data: {
      question: `q:${referenceName}`,
      outcome: {
        kind: "Materialized",
        data: { dataset: src(referenceName), viz: null, assumption: null, sql: null },
      },
    },
  };
}

function textual(body: string): ThreadEntry {
  return {
    entry: "Turn",
    data: {
      question: "q",
      outcome: { kind: "Textual", data: { text_kind: "Clarify", body, assumption: null } },
    },
  };
}

function source(kind: "Added" | "Deleted" | "Replaced", name: string): ThreadEntry {
  return { entry: "Source", data: { kind, reference_name: name, display_name: name } };
}

describe("lastTurnEntry / isNonMaterialized", () => {
  it("returns null for an empty thread", () => {
    expect(lastTurnEntry([])).toBeNull();
  });

  it("skips source lifecycle events (ADR-0040) and returns the last Turn", () => {
    const thread = [materialized("result_1"), source("Added", "orders"), textual("which?")];
    const last = lastTurnEntry(thread);
    expect(last?.question).toBe("q");
    expect(last?.outcome.kind).toBe("Textual");
  });

  it("isNonMaterialized is true only for B/C/D outcomes", () => {
    const cancelledTurn: TurnRecord = {
      question: "q",
      outcome: { kind: "Cancelled" },
    };
    expect(isNonMaterialized(cancelledTurn)).toBe(true);
    const m = materialized("result_1");
    if (m.entry === "Turn") expect(isNonMaterialized(m.data)).toBe(false);
  });
});

describe("findMaterializedPayload", () => {
  it("returns the assumption + viz for a result_N in the thread", () => {
    const entry: ThreadEntry = {
      entry: "Turn",
      data: {
        question: "q",
        outcome: {
          kind: "Materialized",
          data: {
            dataset: src("result_1"),
            viz: { kind: "bar", spec: "{\"mark\":\"bar\"}" },
            assumption: "grouped by product",
            sql: null,
          },
        },
      },
    };
    const payload = findMaterializedPayload([entry], "result_1");
    expect(payload?.assumption).toBe("grouped by product");
    expect(payload?.viz?.kind).toBe("bar");
  });

  it("returns null when no turn materialized that reference name", () => {
    expect(findMaterializedPayload([materialized("result_1")], "result_99")).toBeNull();
    expect(findMaterializedPayload([textual("which?")], "result_1")).toBeNull();
  });
});

describe("deriveWorkspaceContent (ADR-0062 R2 three-state)", () => {
  it("shows hero when there is no viewed result and no non-materialized last turn", () => {
    expect(deriveWorkspaceContent([], null, false, new Map())).toEqual({ kind: "hero" });
    // A last Materialized turn with viewedResult null also -> hero (the user
    // has not opened the result pane; R2 "末轮 A 未产出" leg).
    expect(deriveWorkspaceContent([materialized("result_1")], null, false, new Map())).toEqual({
      kind: "hero",
    });
  });

  it("shows the last-turn text card when the last turn is B/C/D and not pinned", () => {
    const thread = [materialized("result_1"), textual("which name?")];
    const content = deriveWorkspaceContent(thread, null, false, new Map());
    expect(content.kind).toBe("lastTurnText");
    if (content.kind === "lastTurnText") {
      expect(content.turn.outcome.kind).toBe("Textual");
    }
  });

  it("overrides the last-turn text when the user pins to a history result", () => {
    // Last turn is a Clarify (would show textual card), but the user pinned to
    // result_1 -> the viewed result wins (ADR-0062 R2 "末轮 B/C/D 时 pin 让
    // viewedResult 压过末轮文本").
    const thread = [materialized("result_1"), textual("which name?")];
    const content = deriveWorkspaceContent(
      thread,
      { referenceName: "result_1" },
      true,
      new Map(),
    );
    expect(content.kind).toBe("result");
    if (content.kind === "result") {
      expect(content.referenceName).toBe("result_1");
    }
  });

  it("shows the viewed result chart + table when pinned to a non-last Materialized", () => {
    const thread = [materialized("result_1"), materialized("result_2")];
    const content = deriveWorkspaceContent(
      thread,
      { referenceName: "result_1" },
      true,
      new Map(),
    );
    expect(content.kind).toBe("result");
    if (content.kind === "result") {
      expect(content.referenceName).toBe("result_1");
      expect(content.assumption).toBeNull();
      expect(content.viz).toBeNull();
    }
  });

  it("carries the stale anchor from the working-set map (runtime truth)", () => {
    const thread = [materialized("result_1")];
    const staleByReference = new Map([
      ["result_1", { reference_name: "orders", display_name: "orders", reason: "Deleted" as const }],
    ]);
    const content = deriveWorkspaceContent(
      thread,
      { referenceName: "result_1" },
      false,
      staleByReference,
    );
    expect(content.kind).toBe("result");
    if (content.kind === "result") {
      expect(content.staleAnchor?.reason).toBe("Deleted");
      expect(content.staleAnchor?.display_name).toBe("orders");
    }
  });

  it("falls back to hero when viewedResult points at a turn not in the thread", () => {
    // viewedResult set but the producing turn was GC'd / not yet appended.
    expect(
      deriveWorkspaceContent([], { referenceName: "result_1" }, false, new Map()).kind,
    ).toBe("hero");
  });
});
