import { describe, expect, it } from "vitest";
import {
  deriveWorkspaceContent,
  findLatestMaterializedPrimary,
  findMaterializedPayload,
} from "../workspace";
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

describe("findLatestMaterializedPrimary (issue #757)", () => {
  it("returns the last Materialized turn's primary (promotion chain tail)", () => {
    expect(
      findLatestMaterializedPrimary([materialized("result_1"), materialized("result_2")]),
    ).toBe("result_2");
  });

  it("skips trailing non-materialized turns", () => {
    // "Latest" means the latest MATERIALIZED turn: B/C/D turns appended after
    // it never reach the workspace (ADR-0114), so they never age the view.
    expect(
      findLatestMaterializedPrimary([materialized("result_1"), textual("which?")]),
    ).toBe("result_1");
  });

  it("skips a Materialized turn without a primary and keeps scanning", () => {
    const noPrimary: ThreadEntry = {
      entry: "Turn",
      data: {
        question: "q",
        outcome: { kind: "Materialized", data: { promotions: [], viz: null, assumption: null } },
        trace: [], provenance: { skills: [] },
      },
    };
    expect(findLatestMaterializedPrimary([materialized("result_1"), noPrimary])).toBe(
      "result_1",
    );
  });

  it("returns null when the thread materialized no primary", () => {
    expect(findLatestMaterializedPrimary([])).toBeNull();
    expect(findLatestMaterializedPrimary([textual("which?")])).toBeNull();
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

  describe("viewingHistory (issue #757 derived fact)", () => {
    it("is false when the viewed result is the latest Materialized primary", () => {
      const content = deriveWorkspaceContent(
        [materialized("result_1"), materialized("result_2")],
        { referenceName: "result_2" },
        new Map(),
      );
      expect(content.kind).toBe("result");
      if (content.kind === "result") expect(content.viewingHistory).toBe(false);
    });

    it("is true when the viewed result is an older result", () => {
      const content = deriveWorkspaceContent(
        [materialized("result_1"), materialized("result_2")],
        { referenceName: "result_1" },
        new Map(),
      );
      expect(content.kind).toBe("result");
      if (content.kind === "result") expect(content.viewingHistory).toBe(true);
    });

    it("stays false when a non-materialized turn trails the viewed latest primary", () => {
      // The comparison target is the latest MATERIALIZED turn -- a trailing
      // B/C/D turn leaves the view on the latest result (ADR-0114).
      const content = deriveWorkspaceContent(
        [materialized("result_1"), textual("which name?")],
        { referenceName: "result_1" },
        new Map(),
      );
      expect(content.kind).toBe("result");
      if (content.kind === "result") expect(content.viewingHistory).toBe(false);
    });

    it("is true when viewing a non-tail promotion of the latest turn", () => {
      // ADR-0084: the viewed result matches ANY promotion of a turn, but the
      // "latest" target is strictly the chain TAIL (the primary). A mid-chain
      // antecedent counts as history.
      const multiPromotion: ThreadEntry = {
        entry: "Turn",
        data: {
          question: "q",
          outcome: {
            kind: "Materialized",
            data: {
              promotions: [
                { dataset: src("scratch_1"), sql: "SELECT 1" },
                { dataset: src("result_1"), sql: "SELECT 2" },
              ],
              viz: null,
              assumption: null,
            },
          },
          trace: [], provenance: { skills: [] },
        },
      };
      const antecedent = deriveWorkspaceContent([multiPromotion], { referenceName: "scratch_1" }, new Map());
      expect(antecedent.kind).toBe("result");
      if (antecedent.kind === "result") expect(antecedent.viewingHistory).toBe(true);
      const tail = deriveWorkspaceContent([multiPromotion], { referenceName: "result_1" }, new Map());
      expect(tail.kind).toBe("result");
      if (tail.kind === "result") expect(tail.viewingHistory).toBe(false);
    });
  });
});
