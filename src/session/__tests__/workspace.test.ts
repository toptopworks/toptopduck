import { describe, expect, it } from "vitest";
import { deriveWorkspaceContent, findMaterializedPayload } from "../workspace";
import { materialized, src, textual } from "./fixtures";
import type { ThreadEntry } from "../../types/thread";

// Unit tests for the pure workspace-derivation helpers (ADR-0051 / ADR-0062
// R2, calibrated by ADR-0114). These are the architectural invariants the
// shell's "what does the workspace show right now?" decision hinges on --
// testing them in isolation (without React / the IPC mock layer) pins the
// two-state rule + the truth-source split (thread = turn payload truth)
// precisely.

describe("findMaterializedPayload", () => {
  it("returns the assumption + viz for a result_N in the thread", () => {
    const entry: ThreadEntry = {
      entry: "Turn",
      data: {
        question: "q",
        outcome: {
          kind: "Materialized",
          data: {
            promotions: [{ dataset: src("result_1"), sql: "SELECT 1" }],
            viz: { kind: "bar", spec: "{\"mark\":\"bar\"}" },
            assumption: "grouped by product",
          },
        },
        trace: [], provenance: { skills: [] },
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

describe("deriveWorkspaceContent (ADR-0062 R2 two-state, ADR-0114)", () => {
  it("shows hero when there is no viewed result", () => {
    expect(deriveWorkspaceContent([], null, new Map())).toEqual({ kind: "hero" });
    // A last Materialized turn with viewedResult null also -> hero (the user
    // has not opened the result pane).
    expect(deriveWorkspaceContent([materialized("result_1")], null, new Map())).toEqual({
      kind: "hero",
    });
  });

  it("is inert to a non-materialized last turn (B/C/D never reach the workspace)", () => {
    // ADR-0114: the rail is the full read surface for turn content. A B/C/D
    // last turn produces no workspace content -- no viewedResult, hero.
    expect(deriveWorkspaceContent([textual("which?")], null, new Map())).toEqual({
      kind: "hero",
    });
  });

  it("keeps showing the viewed result when the last turn goes B/C/D", () => {
    // ADR-0114: non-materialized turns do not disturb the current view; the
    // result stays until a new Materialized or another selection moves it.
    const thread = [materialized("result_1"), textual("which name?")];
    const content = deriveWorkspaceContent(thread, { referenceName: "result_1" }, new Map());
    expect(content.kind).toBe("result");
    if (content.kind === "result") {
      expect(content.referenceName).toBe("result_1");
    }
  });

  it("shows the viewed result chart + table for a history selection", () => {
    const thread = [materialized("result_1"), materialized("result_2")];
    const content = deriveWorkspaceContent(thread, { referenceName: "result_1" }, new Map());
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
    const content = deriveWorkspaceContent(thread, { referenceName: "result_1" }, staleByReference);
    expect(content.kind).toBe("result");
    if (content.kind === "result") {
      expect(content.staleAnchor?.reason).toBe("Deleted");
      expect(content.staleAnchor?.display_name).toBe("orders");
    }
  });

  it("falls back to hero when viewedResult points at a turn not in the thread", () => {
    // viewedResult set but the producing turn was GC'd / not yet appended.
    expect(deriveWorkspaceContent([], { referenceName: "result_1" }, new Map()).kind).toBe("hero");
  });
});
