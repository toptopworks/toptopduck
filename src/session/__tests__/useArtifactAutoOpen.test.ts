import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useArtifactAutoOpen } from "../useArtifactAutoOpen";
import { artifactTurn, materialized, textual } from "./fixtures";
import type { ThreadEntry, TurnRecord } from "../../types/thread";

// Tests for the artifact auto-open one-shot (ADR-0124 Decision 3, issue
// #1088): a delivered manifest with no Materialized result opens the
// workspace onto the manifest's primary ONCE per candidate -- the signature
// key absorbs rerenders and late duplicate arrivals, while a fresh delivery
// re-arms. The hook is plain React refs over a thread argument, so
// renderHook drives it directly (the useWorkspaceCollapse pattern).

function harness(initial: ThreadEntry[]) {
  const selectFile = vi.fn();
  const expandWorkspace = vi.fn();
  const { result, rerender } = renderHook(
    ({ thread }) => useArtifactAutoOpen(thread, selectFile, expandWorkspace),
    { initialProps: { thread: initial } },
  );
  return { selectFile, expandWorkspace, result, rerender };
}

describe("useArtifactAutoOpen", () => {
  it("a live artifact-only delivery expands and selects the primary", () => {
    // The live sequence: the optimistic append lands WITHOUT a manifest
    // (settle-computed fields are backend-only), then the turn-end refetch
    // replaces it with the recorded row. The init scan spends nothing on
    // the artifact-less first hop, so the manifest hop auto-opens.
    const h = harness([]);
    act(() => h.rerender({ thread: [textual("optimistic append")] }));
    expect(h.selectFile).not.toHaveBeenCalled();
    act(() => h.rerender({ thread: [artifactTurn(["/a/page.html", "/a/report.pdf"])] }));
    expect(h.expandWorkspace).toHaveBeenCalledTimes(1);
    expect(h.selectFile).toHaveBeenCalledWith("/a/page.html");
  });

  it("never re-fires for the same candidate: rerenders and duplicate arrivals", () => {
    const h = harness([]);
    const turn = artifactTurn(["/a/page.html"]);
    act(() => h.rerender({ thread: [textual("optimistic append")] }));
    act(() => h.rerender({ thread: [turn] }));
    expect(h.selectFile).toHaveBeenCalledTimes(1);
    // A rerender with a fresh array identity (a refetch rebuilt the thread)
    // and a LATE DUPLICATE (the manifest seen again after a later
    // artifact-less turn) both carry the same signature -- no re-consume.
    act(() => h.rerender({ thread: [{ ...turn }] }));
    act(() => h.rerender({ thread: [turn, materialized("result_1")] }));
    expect(h.selectFile).toHaveBeenCalledTimes(1);
    expect(h.expandWorkspace).toHaveBeenCalledTimes(1);
  });

  it("a genuinely fresh delivery re-arms (different signature)", () => {
    const h = harness([]);
    act(() => h.rerender({ thread: [textual("optimistic append")] }));
    act(() => h.rerender({ thread: [artifactTurn(["/a/first.pdf"])] }));
    expect(h.selectFile).toHaveBeenCalledTimes(1);
    act(() =>
      h.rerender({ thread: [artifactTurn(["/a/first.pdf"]), artifactTurn(["/a/second.pdf"])] }),
    );
    expect(h.selectFile).toHaveBeenCalledTimes(2);
    expect(h.selectFile).toHaveBeenLastCalledWith("/a/second.pdf");
  });

  it("a both-present turn never steals the stage (ADR-0124 Decision 3)", () => {
    const h = harness([]);
    const both = artifactTurn(["/a/x.pdf"], (materialized("result_1").data as TurnRecord).outcome);
    act(() => h.rerender({ thread: [both] }));
    expect(h.selectFile).not.toHaveBeenCalled();
    expect(h.expandWorkspace).not.toHaveBeenCalled();
    // And the no-steal verdict is per-delivery: a later rerender must not
    // revisit it.
    act(() => h.rerender({ thread: [{ ...both }] }));
    expect(h.selectFile).not.toHaveBeenCalled();
  });

  it("spends silently on resume: a thread that already carries a manifest", () => {
    // The #771 mirror -- a remount onto a session whose manifest already
    // landed has nothing to auto-open; the hero posture holds.
    const h = harness([artifactTurn(["/a/page.html"])]);
    expect(h.selectFile).not.toHaveBeenCalled();
    expect(h.expandWorkspace).not.toHaveBeenCalled();
    // A FRESH delivery after the mount still opens (the spend covered only
    // the resumed candidate).
    act(() => h.rerender({ thread: [artifactTurn(["/a/page.html"]), artifactTurn(["/a/new.pdf"])] }));
    expect(h.selectFile).toHaveBeenCalledWith("/a/new.pdf");
  });

  it("does nothing on a thread with no manifest", () => {
    const h = harness([]);
    act(() => h.rerender({ thread: [materialized("result_1")] }));
    expect(h.selectFile).not.toHaveBeenCalled();
    expect(h.expandWorkspace).not.toHaveBeenCalled();
  });
});
