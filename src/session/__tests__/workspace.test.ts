import { describe, expect, it } from "vitest";
import {
  artifactRenderKind,
  deriveWorkspaceContent,
  findArtifact,
  findLatestMaterializedPrimary,
  findMaterializedPayload,
  isWithinArtifactsDir,
  latestArtifactCandidate,
  resolveWorkingSetDetail,
} from "../workspace";
import { artifactTurn, materialized, src, textual } from "./fixtures";
import type { DatasetDescriptor } from "../../types/dataset";
import type { ThreadEntry, TurnRecord } from "../../types/thread";

// Unit tests for the pure workspace-derivation helpers (ADR-0051 / ADR-0062
// R2, calibrated by ADR-0114). These are the architectural invariants the
// shell's "what does the workspace show right now?" decision hinges on --
// testing them in isolation (without React / the IPC mock layer) pins the
// two-state rule + the truth-source split (thread = turn payload truth)
// precisely.

// A Materialized turn with no promotions: it carries no primary, so the
// latest-primary scan skips it and keeps scanning tail-first.
const noPrimaryTurn: ThreadEntry = {
  entry: "Turn",
  data: {
    question: "q",
    outcome: {
      kind: "Materialized",
      data: { promotions: [], viz: null, body: null, assumption: null },
    },
    trace: [], provenance: { skills: [] },
  },
};

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
            body: null,
            assumption: "grouped by product",
          },
        },
        trace: [], provenance: { skills: [] },
      },
    };
    const payload = findMaterializedPayload([entry], "result_1");
    expect(payload?.assumption).toBe("grouped by product");
    expect(payload?.viz?.kind).toBe("bar");
    expect(payload?.question).toBe("q");
  });

  it("carries the producing turn's question for the stale rerun (issue #758)", () => {
    // The stale banner's rerun fires the question that produced the viewed
    // result: the payload reads it straight off the matched turn (thread is
    // the single source of truth, ADR-0051), never from a separate snapshot.
    const payload = findMaterializedPayload([materialized("result_1")], "result_1");
    expect(payload?.question).toBe("q:result_1");
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
    expect(
      findLatestMaterializedPrimary([materialized("result_1"), noPrimaryTurn]),
    ).toBe("result_1");
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
    const content = deriveWorkspaceContent(thread, { kind: "dataset", referenceName: "result_1" }, new Map());
    expect(content.kind).toBe("result");
    if (content.kind === "result") {
      expect(content.referenceName).toBe("result_1");
    }
  });

  it("shows the viewed result chart + table for a history selection", () => {
    const thread = [materialized("result_1"), materialized("result_2")];
    const content = deriveWorkspaceContent(thread, { kind: "dataset", referenceName: "result_1" }, new Map());
    expect(content.kind).toBe("result");
    if (content.kind === "result") {
      expect(content.referenceName).toBe("result_1");
      expect(content.assumption).toBeNull();
      expect(content.viz).toBeNull();
    }
  });

  it("carries the producing turn's question on the result branch (issue #758)", () => {
    // The rerun button's question rides the derivation so the result pane
    // never re-scans the thread itself (one scan, ADR-0051).
    const content = deriveWorkspaceContent(
      [materialized("result_1")],
      { kind: "dataset", referenceName: "result_1" },
      new Map(),
    );
    expect(content.kind).toBe("result");
    if (content.kind === "result") expect(content.question).toBe("q:result_1");
  });

  it("carries the stale anchor from the working-set map (runtime truth)", () => {
    const thread = [materialized("result_1")];
    const staleByReference = new Map([
      ["result_1", { reference_name: "orders", display_name: "orders", reason: "Deleted" as const }],
    ]);
    const content = deriveWorkspaceContent(thread, { kind: "dataset", referenceName: "result_1" }, staleByReference);
    expect(content.kind).toBe("result");
    if (content.kind === "result") {
      expect(content.staleAnchor?.reason).toBe("Deleted");
      expect(content.staleAnchor?.display_name).toBe("orders");
    }
  });

  it("falls back to hero when viewedResult points at a turn not in the thread", () => {
    // viewedResult set but the producing turn was GC'd / not yet appended.
    expect(deriveWorkspaceContent([], { kind: "dataset", referenceName: "result_1" }, new Map()).kind).toBe("hero");
  });

  describe("viewingHistory (issue #757 derived fact)", () => {
    it("is false when the viewed result is the latest Materialized primary", () => {
      const content = deriveWorkspaceContent(
        [materialized("result_1"), materialized("result_2")],
        { kind: "dataset", referenceName: "result_2" },
        new Map(),
      );
      expect(content.kind).toBe("result");
      if (content.kind === "result") expect(content.viewingHistory).toBe(false);
    });

    it("is true when the viewed result is an older result", () => {
      const content = deriveWorkspaceContent(
        [materialized("result_1"), materialized("result_2")],
        { kind: "dataset", referenceName: "result_1" },
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
        { kind: "dataset", referenceName: "result_1" },
        new Map(),
      );
      expect(content.kind).toBe("result");
      if (content.kind === "result") expect(content.viewingHistory).toBe(false);
    });

    it("stays false when the latest Materialized turn carries no primary", () => {
      // The promotion-less tail must not flag the still-latest view: the scan
      // skips it and resolves the older turn's primary as the comparison
      // target (pinned here at the derivation level, not just the helper).
      const content = deriveWorkspaceContent(
        [materialized("result_1"), noPrimaryTurn],
        { kind: "dataset", referenceName: "result_1" },
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
              body: null,
              assumption: null,
            },
          },
          trace: [], provenance: { skills: [] },
        },
      };
      const antecedent = deriveWorkspaceContent([multiPromotion], { kind: "dataset", referenceName: "scratch_1" }, new Map());
      expect(antecedent.kind).toBe("result");
      if (antecedent.kind === "result") expect(antecedent.viewingHistory).toBe(true);
      const tail = deriveWorkspaceContent([multiPromotion], { kind: "dataset", referenceName: "result_1" }, new Map());
      expect(tail.kind).toBe("result");
      if (tail.kind === "result") expect(tail.viewingHistory).toBe(false);
    });
  });
});

describe("resolveWorkingSetDetail (issue #792)", () => {
  // A minimal-but-complete descriptor: the type demands every field, but the
  // derivation only reads reference_name -- the rest are inert fillers.
  function detailDataset(reference_name: string): DatasetDescriptor {
    return {
      reference_name,
      display_name: reference_name,
      source_path: `/x/${reference_name}.csv`,
      row_count: 1,
      fingerprint: "0".repeat(64),
      columns: [],
      sample: [],
      rectify: { kind: "NotApplicable" },
      privacy: { send_samples: true, type_only_columns: [] },
    };
  }
  const people = detailDataset("people");
  const orders = detailDataset("orders");

  it("keeps the tab's explicit pick when it still resolves", () => {
    expect(resolveWorkingSetDetail([people, orders], "orders", "people")).toBe(orders);
  });

  it("falls back to the active dataset when the pick was deleted", () => {
    // Delete the selected row -> the pick no longer resolves; the detail
    // follows the server's active truth (ADR-0051) instead of a placeholder.
    expect(resolveWorkingSetDetail([people], "orders", "people")).toBe(people);
  });

  it("falls back to the first list item when the active is absent too", () => {
    expect(resolveWorkingSetDetail([people, orders], "ghost", null)).toBe(people);
    // An active name that no longer resolves (GC'd between refreshes) hits
    // the same floor.
    expect(resolveWorkingSetDetail([people, orders], "ghost", "ghost2")).toBe(people);
  });

  it("resolves the active dataset when the tab has no pick yet (mount default)", () => {
    expect(resolveWorkingSetDetail([people, orders], null, "orders")).toBe(orders);
  });

  it("returns null only for an empty working set", () => {
    expect(resolveWorkingSetDetail([], null, null)).toBeNull();
  });
});

describe("artifact derivation (ADR-0124, issue #1088)", () => {
  const HTML = "C:/sessions/s1/artifacts/page.html";
  const PDF = "C:/sessions/s1/artifacts/report.pdf";
  const MD = "C:/sessions/s1/artifacts/notes.md";

  describe("artifactRenderKind (Decision 4 matrix)", () => {
    it("html/htm -> html, md -> markdown, the rest -> card", () => {
      expect(artifactRenderKind(HTML)).toBe("html");
      expect(artifactRenderKind("x/report.HTM")).toBe("html");
      expect(artifactRenderKind(MD)).toBe("markdown");
      expect(artifactRenderKind(PDF)).toBe("card");
      expect(artifactRenderKind("x/table.xlsx")).toBe("card");
      // Extension-less (unreachable via the whitelist) degrades to the card.
      expect(artifactRenderKind("x/README")).toBe("card");
    });
  });

  describe("isWithinArtifactsDir (the HTML scope gate)", () => {
    it("accepts paths under the duck path's artifacts dir, both separators", () => {
      expect(isWithinArtifactsDir(HTML, "C:/sessions/s1/session.duck")).toBe(true);
      expect(
        isWithinArtifactsDir("C:\\sessions\\s1\\artifacts\\a.html", "C:\\sessions\\s1\\session.duck"),
      ).toBe(true);
      expect(
        isWithinArtifactsDir("/home/u/.duck/s1/artifacts/a.html", "/home/u/.duck/s1/session.duck"),
      ).toBe(true);
    });

    it("rejects user-directory originals, temp paths, and prefix lookalikes", () => {
      const duck = "C:/sessions/s1/session.duck";
      expect(isWithinArtifactsDir("C:/Users/me/report.html", duck)).toBe(false);
      // artifactsFoo is not the artifacts dir -- the trailing separator pins
      // the boundary.
      expect(isWithinArtifactsDir("C:/sessions/s1/artifactsFoo/x.html", duck)).toBe(false);
      expect(isWithinArtifactsDir("/tmp/work/page.html", duck)).toBe(false);
    });
  });

  describe("findArtifact (the file view's thread resolve)", () => {
    it("resolves the entry by absolute path, newest turn wins", () => {
      const old = artifactTurn(["/a/first.pdf"]);
      const fresh = artifactTurn(["/a/first.pdf", "/a/second.pdf"]);
      expect(findArtifact([old, fresh], "/a/first.pdf")).toBe(
        (fresh.data as TurnRecord).artifacts?.[0],
      );
    });

    it("returns null for a path no turn carries", () => {
      expect(findArtifact([artifactTurn(["/a/x.pdf"])], "/a/foreign.pdf")).toBeNull();
      expect(findArtifact([textual("no files")], "/a/x.pdf")).toBeNull();
    });
  });

  describe("latestArtifactCandidate (the auto-open input)", () => {
    it("picks the latest manifest-bearing turn; primary is the first entry", () => {
      const older = artifactTurn(["/a/old.pdf"]);
      const latest = artifactTurn(["/a/page.html", "/a/report.pdf"]);
      const candidate = latestArtifactCandidate([older, latest]);
      expect(candidate?.primaryPath).toBe("/a/page.html");
      expect(candidate?.signature).toBe("/a/page.html\n/a/report.pdf");
      expect(candidate?.turnMaterialized).toBe(false);
    });

    it("flags a both-present turn (no stage steal) and skips artifact-less tails", () => {
      const both = artifactTurn(["/a/x.pdf"], (materialized("result_1").data as TurnRecord).outcome);
      expect(latestArtifactCandidate([both])?.turnMaterialized).toBe(true);
      // A trailing artifact-less turn is skipped, not a re-arm: the candidate
      // stays the older delivery (its signature already consumed -- the
      // one-shot does not re-fire on it).
      expect(
        latestArtifactCandidate([artifactTurn(["/a/x.pdf"]), textual("done")])?.primaryPath,
      ).toBe("/a/x.pdf");
    });

    it("returns null on an empty / manifest-less thread", () => {
      expect(latestArtifactCandidate([])).toBeNull();
      expect(latestArtifactCandidate([materialized("result_1")])).toBeNull();
    });
  });

  describe("deriveWorkspaceContent file branch (single stage)", () => {
    it("a file view resolves its manifest entry and render kind", () => {
      const thread = [artifactTurn([HTML, PDF])];
      const content = deriveWorkspaceContent(thread, { kind: "file", path: HTML }, new Map());
      expect(content).toEqual({
        kind: "file",
        path: HTML,
        fileName: "page.html",
        render: "html",
      });
    });

    it("a dataset view and a file view are the same selection domain -- last wins", () => {
      const thread = [artifactTurn([HTML]), materialized("result_1")];
      const filePick = deriveWorkspaceContent(thread, { kind: "file", path: HTML }, new Map());
      expect(filePick?.kind).toBe("file");
      // Re-selecting the dataset moves the SAME slot back -- no tabs, no stack.
      const datasetPick = deriveWorkspaceContent(
        thread,
        { kind: "dataset", referenceName: "result_1" },
        new Map(),
      );
      expect(datasetPick?.kind).toBe("result");
    });

    it("a file view naming a path no turn carries degrades to hero", () => {
      const content = deriveWorkspaceContent(
        [artifactTurn([HTML])],
        { kind: "file", path: "/a/foreign.pdf" },
        new Map(),
      );
      expect(content).toEqual({ kind: "hero" });
    });
  });
});
