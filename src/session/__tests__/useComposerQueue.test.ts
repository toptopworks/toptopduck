import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useComposerQueue } from "../useComposerQueue";

// The queue machine rides the batch's boolean Promise (handleIngestMany's
// contract), so every scenario drives it through a deferred: arm the batch,
// submit while the Promise is pending, then settle it in act.
function deferredBoolean() {
  let resolve!: (loaded: boolean) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<boolean>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeDeps() {
  return {
    sessionId: "sess-1",
    ingestMany: vi.fn(() => Promise.resolve(true)),
    ask: vi.fn(() => Promise.resolve()),
    onSeedDraft: vi.fn(),
    onSeedInvocations: vi.fn(),
  };
}

describe("useComposerQueue (#1500 queued ask behind an in-flight ingest batch)", () => {
  it("fires the ask directly when no batch is in flight", async () => {
    // Arrange
    const deps = makeDeps();
    const { result } = renderHook(() => useComposerQueue(deps));

    // Act
    await act(async () => {
      await result.current.handleAsk("几行", ["skill-a"]);
    });

    // Assert
    expect(deps.ask).toHaveBeenCalledOnce();
    expect(deps.ask).toHaveBeenCalledWith("几行", ["skill-a"]);
    expect(result.current.queued).toBe(false);
    expect(deps.onSeedDraft).not.toHaveBeenCalled();
  });

  it("queues the submit while a batch is in flight and auto-sends on full load", async () => {
    // Arrange
    const deps = makeDeps();
    const batch = deferredBoolean();
    deps.ingestMany.mockReturnValue(batch.promise);
    const { result } = renderHook(() => useComposerQueue(deps));

    // Act: arm the batch, then submit while it is in flight.
    let tracked!: Promise<boolean>;
    act(() => {
      tracked = result.current.ingestMany(["/x/a.csv"]);
    });
    act(() => {
      void result.current.handleAsk("几行", ["skill-a"]);
    });

    // Assert: queued posture, no ask yet.
    expect(result.current.queued).toBe(true);
    expect(deps.ask).not.toHaveBeenCalled();
    expect(deps.onSeedDraft).not.toHaveBeenCalled();

    // Act: the batch fully loads -> the held question auto-sends.
    await act(async () => {
      batch.resolve(true);
      await tracked;
    });

    // Assert
    expect(deps.ask).toHaveBeenCalledOnce();
    expect(deps.ask).toHaveBeenCalledWith("几行", ["skill-a"]);
    expect(result.current.queued).toBe(false);
    expect(deps.onSeedDraft).not.toHaveBeenCalled();
  });

  it("seeds the question and invocations back to the draft when the batch halts", async () => {
    // Arrange
    const deps = makeDeps();
    const batch = deferredBoolean();
    deps.ingestMany.mockReturnValue(batch.promise);
    const { result } = renderHook(() => useComposerQueue(deps));
    act(() => {
      result.current.ingestMany(["/x/a.csv"]);
    });
    act(() => {
      void result.current.handleAsk("几行", ["skill-a"]);
    });
    expect(result.current.queued).toBe(true);

    // Act: a terminal halt (Error / cancel / superseded) settles false.
    await act(async () => {
      batch.resolve(false);
      await batch.promise;
    });

    // Assert: the #991 atomic rollback channel -- the question AND the staged
    // names return; nothing auto-sends.
    expect(result.current.queued).toBe(false);
    expect(deps.onSeedDraft).toHaveBeenCalledOnce();
    expect(deps.onSeedDraft).toHaveBeenCalledWith("sess-1", "几行");
    expect(deps.onSeedInvocations).toHaveBeenCalledOnce();
    expect(deps.onSeedInvocations).toHaveBeenCalledWith("sess-1", ["skill-a"]);
    expect(deps.ask).not.toHaveBeenCalled();
  });

  it("seeds only the draft when no invocations rode the queued submit", async () => {
    // Arrange
    const deps = makeDeps();
    const batch = deferredBoolean();
    deps.ingestMany.mockReturnValue(batch.promise);
    const { result } = renderHook(() => useComposerQueue(deps));
    act(() => {
      result.current.ingestMany(["/x/a.csv"]);
    });
    act(() => {
      void result.current.handleAsk("几行");
    });

    // Act
    await act(async () => {
      batch.resolve(false);
      await batch.promise;
    });

    // Assert
    expect(deps.onSeedDraft).toHaveBeenCalledOnce();
    expect(deps.onSeedInvocations).not.toHaveBeenCalled();
    expect(deps.ask).not.toHaveBeenCalled();
  });

  it("holds the queued posture while the batch parks on guidance (promise pending)", async () => {
    // Arrange: a NeedsGuidance park keeps handleIngestMany pending (#500
    // gate) -- the queued question must keep waiting, never exit early.
    const deps = makeDeps();
    deps.ingestMany.mockReturnValue(new Promise<boolean>(() => {}));
    const { result } = renderHook(() => useComposerQueue(deps));
    act(() => {
      result.current.ingestMany(["/x/m.xlsx"]);
    });

    // Act
    act(() => {
      void result.current.handleAsk("几行");
    });

    // Assert: no exit fires under the parked batch.
    expect(result.current.queued).toBe(true);
    expect(deps.ask).not.toHaveBeenCalled();
    expect(deps.onSeedDraft).not.toHaveBeenCalled();
  });

  it("ignores a second submit while a question is already queued", async () => {
    // Arrange
    const deps = makeDeps();
    const batch = deferredBoolean();
    deps.ingestMany.mockReturnValue(batch.promise);
    const { result } = renderHook(() => useComposerQueue(deps));
    act(() => {
      result.current.ingestMany(["/x/a.csv"]);
    });

    // Act: the bar disables the input while queued, so a second submit is
    // the belt-and-suspenders path (same contract as the loading guard).
    act(() => {
      void result.current.handleAsk("第一问");
    });
    act(() => {
      void result.current.handleAsk("第二问");
    });
    await act(async () => {
      batch.resolve(true);
      await batch.promise;
    });

    // Assert: single slot -- the first submit wins.
    expect(deps.ask).toHaveBeenCalledOnce();
    expect(deps.ask).toHaveBeenCalledWith("第一问", []);
  });

  it("discards the queued question when the pane unmounts before the settle", async () => {
    // Arrange
    const deps = makeDeps();
    const batch = deferredBoolean();
    deps.ingestMany.mockReturnValue(batch.promise);
    const { result, unmount } = renderHook(() => useComposerQueue(deps));
    act(() => {
      result.current.ingestMany(["/x/a.csv"]);
    });
    act(() => {
      void result.current.handleAsk("几行", ["skill-a"]);
    });

    // Act: close the session (pane unmount) while the batch is still out.
    unmount();
    await act(async () => {
      batch.resolve(false);
      await batch.promise;
    });

    // Assert: neither a leaked auto-send nor a draft slot for a dropped sid.
    expect(deps.ask).not.toHaveBeenCalled();
    expect(deps.onSeedDraft).not.toHaveBeenCalled();
    expect(deps.onSeedInvocations).not.toHaveBeenCalled();
  });

  it("exits the queue under StrictMode's double-invoked effects (#1500 live-app report)", async () => {
    // The dev double-invoke runs setup -> cleanup -> setup on mount; the
    // alive guard must RE-ARM in the setup, or it reads false forever and
    // every settle early-returns -- the held question strands in the slot
    // while later submits fire direct (the real-app symptom).
    const deps = makeDeps();
    const batch = deferredBoolean();
    deps.ingestMany.mockReturnValue(batch.promise);
    const { result } = renderHook(() => useComposerQueue(deps), {
      wrapper: StrictMode,
    });

    act(() => {
      result.current.ingestMany(["/x/a.csv"]);
    });
    act(() => {
      void result.current.handleAsk("几行", ["skill-a"]);
    });
    expect(result.current.queued).toBe(true);

    await act(async () => {
      batch.resolve(true);
      await batch.promise;
    });

    expect(deps.ask).toHaveBeenCalledOnce();
    expect(deps.ask).toHaveBeenCalledWith("几行", ["skill-a"]);
    expect(result.current.queued).toBe(false);
    expect(deps.onSeedDraft).not.toHaveBeenCalled();
  });

  it("hold occupies the slot and the settle exit auto-sends the chain's question", async () => {
    // The ADR-0092 chain's held question rides the SAME slot (#1500 live
    // follow-up): occupy at arming, auto-send on a full load.
    const deps = makeDeps();
    const batch = deferredBoolean();
    deps.ingestMany.mockReturnValue(batch.promise);
    const { result } = renderHook(() => useComposerQueue(deps));
    act(() => {
      result.current.ingestMany(["/x/a.csv"]);
    });
    act(() => {
      result.current.hold("链上第一问", ["charting"]);
    });
    expect(result.current.queued).toBe(true);

    await act(async () => {
      batch.resolve(true);
      await batch.promise;
    });

    expect(deps.ask).toHaveBeenCalledOnce();
    expect(deps.ask).toHaveBeenCalledWith("链上第一问", ["charting"]);
    expect(result.current.queued).toBe(false);
  });

  it("hold's halt exit seeds the question and invocations back", async () => {
    const deps = makeDeps();
    const batch = deferredBoolean();
    deps.ingestMany.mockReturnValue(batch.promise);
    const { result } = renderHook(() => useComposerQueue(deps));
    act(() => {
      result.current.ingestMany(["/x/a.csv"]);
    });
    act(() => {
      result.current.hold("链上第一问", ["charting"]);
    });

    await act(async () => {
      batch.resolve(false);
      await batch.promise;
    });

    expect(deps.onSeedDraft).toHaveBeenCalledWith("sess-1", "链上第一问");
    expect(deps.onSeedInvocations).toHaveBeenCalledWith("sess-1", ["charting"]);
    expect(deps.ask).not.toHaveBeenCalled();
  });

  it("a bar submit while the chain holds the slot is inert (single slot, first wins)", async () => {
    // The #1500 live-app scenario: the cold-start chain occupies the slot at
    // mount, so the bar's submit during the chain window must not enter a
    // second question.
    const deps = makeDeps();
    const batch = deferredBoolean();
    deps.ingestMany.mockReturnValue(batch.promise);
    const { result } = renderHook(() => useComposerQueue(deps));
    act(() => {
      result.current.ingestMany(["/x/a.csv"]);
    });
    act(() => {
      result.current.hold("链上第一问", []);
    });

    act(() => {
      void result.current.handleAsk("第二问");
    });
    expect(result.current.queued).toBe(true);

    await act(async () => {
      batch.resolve(true);
      await batch.promise;
    });

    expect(deps.ask).toHaveBeenCalledOnce();
    expect(deps.ask).toHaveBeenCalledWith("链上第一问", []);
    expect(deps.onSeedDraft).not.toHaveBeenCalled();
  });

  it("passes the batch verdict through untouched", async () => {
    // Arrange: the tracked wrapper must stay transparent -- the pane's
    // pendingPayload consumption and the manual "+" section consume the same
    // boolean Promise as before.
    const deps = makeDeps();
    const batch = deferredBoolean();
    deps.ingestMany.mockReturnValue(batch.promise);
    const { result } = renderHook(() => useComposerQueue(deps));

    // Act
    let tracked!: Promise<boolean>;
    act(() => {
      tracked = result.current.ingestMany(["/x/a.csv"]);
    });
    await act(async () => {
      batch.resolve(true);
    });
    const verdict = await tracked;

    // Assert
    expect(verdict).toBe(true);
    expect(deps.ingestMany).toHaveBeenCalledOnce();
    expect(deps.ingestMany).toHaveBeenCalledWith(["/x/a.csv"]);
  });

  it("seeds the draft back when an unexpected batch rejection slips the contract", async () => {
    // Arrange: handleIngestMany resolves false on an IPC reject by contract;
    // an unexpected rejection must not strand the question queued forever.
    const deps = makeDeps();
    const batch = deferredBoolean();
    deps.ingestMany.mockReturnValue(batch.promise);
    const { result } = renderHook(() => useComposerQueue(deps));
    act(() => {
      result.current.ingestMany(["/x/a.csv"]);
    });
    act(() => {
      void result.current.handleAsk("几行");
    });

    // Act
    await act(async () => {
      batch.promise.catch(() => {});
      batch.reject(new Error("ipc down"));
    });

    // Assert: the halt exit -- seed-back, never an auto-send.
    expect(result.current.queued).toBe(false);
    expect(deps.onSeedDraft).toHaveBeenCalledOnce();
    expect(deps.ask).not.toHaveBeenCalled();
  });

  it("keeps the slot waiting when an older batch settles under a newer one (identity gate)", async () => {
    // Arrange: two overlapping tracked batches -- reachable via a mid-batch
    // "+" pick, an OS-level window drop, or the #748 drop-under-dialog
    // supersede resolving the parked batch synchronously under the newer
    // arming. The older batch's settle must neither exit the slot nor clear
    // the newer batch's gate.
    const deps = makeDeps();
    const batch1 = deferredBoolean();
    const batch2 = deferredBoolean();
    deps.ingestMany
      .mockReturnValueOnce(batch1.promise)
      .mockReturnValueOnce(batch2.promise);
    const { result } = renderHook(() => useComposerQueue(deps));
    act(() => {
      result.current.ingestMany(["/x/a.csv"]);
    });
    act(() => {
      void result.current.handleAsk("几行");
    });
    act(() => {
      result.current.ingestMany(["/x/b.csv"]);
    });

    // Act: the older batch settles first -- under the newer one.
    await act(async () => {
      batch1.resolve(false);
      await batch1.promise;
    });

    // Assert: the question keeps waiting behind the newest batch.
    expect(result.current.queued).toBe(true);
    expect(deps.onSeedDraft).not.toHaveBeenCalled();
    expect(deps.ask).not.toHaveBeenCalled();

    // Act: the newer batch's settle owns the exit.
    await act(async () => {
      batch2.resolve(true);
      await batch2.promise;
    });

    // Assert
    expect(deps.ask).toHaveBeenCalledOnce();
    expect(deps.ask).toHaveBeenCalledWith("几行", []);
    expect(result.current.queued).toBe(false);
  });

  it("returns to direct fire after a settle (the gate resets for the next cycle)", async () => {
    // Arrange
    const deps = makeDeps();
    const batch = deferredBoolean();
    deps.ingestMany.mockReturnValueOnce(batch.promise);
    const { result } = renderHook(() => useComposerQueue(deps));
    act(() => {
      result.current.ingestMany(["/x/a.csv"]);
    });
    act(() => {
      void result.current.handleAsk("第一问");
    });
    await act(async () => {
      batch.resolve(true);
      await batch.promise;
    });
    expect(deps.ask).toHaveBeenCalledOnce();

    // Act: with no batch in flight, the next submit must fire direct -- a
    // settle that fails to reset the gate strands every later submit in a
    // slot no batch will free.
    await act(async () => {
      await result.current.handleAsk("第二问");
    });

    // Assert
    expect(deps.ask).toHaveBeenCalledTimes(2);
    expect(deps.ask).toHaveBeenLastCalledWith("第二问", undefined);
    expect(result.current.queued).toBe(false);
  });

  it("keeps the first holder when hold arrives at an occupied slot", async () => {
    // Arrange: the bar question already queued behind the batch -- a late
    // hold must be inert (single slot, first wins).
    const deps = makeDeps();
    const batch = deferredBoolean();
    deps.ingestMany.mockReturnValueOnce(batch.promise);
    const { result } = renderHook(() => useComposerQueue(deps));
    act(() => {
      result.current.ingestMany(["/x/a.csv"]);
    });
    act(() => {
      void result.current.handleAsk("bar 第一问");
    });

    // Act
    act(() => {
      result.current.hold("链上问题", ["charting"]);
    });
    await act(async () => {
      batch.resolve(true);
      await batch.promise;
    });

    // Assert: the bar's question auto-sends; the late hold was dropped.
    expect(deps.ask).toHaveBeenCalledOnce();
    expect(deps.ask).toHaveBeenCalledWith("bar 第一问", []);
    expect(deps.onSeedDraft).not.toHaveBeenCalled();
  });

  it("drops a hold that arrives with no armed batch instead of stranding the slot", () => {
    // Arrange: hold's temporal contract requires an armed batch (the sole
    // production caller arms in the same synchronous task); this pins the
    // misuse guard -- the question must not occupy a slot nothing frees.
    const deps = makeDeps();
    const { result } = renderHook(() => useComposerQueue(deps));

    // Act
    act(() => {
      result.current.hold("孤儿问题", []);
    });

    // Assert
    expect(result.current.queued).toBe(false);
  });
});
