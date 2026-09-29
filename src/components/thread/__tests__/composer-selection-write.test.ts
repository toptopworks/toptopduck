import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import {
  createSessionSelectionPort,
  useColdStartSelection,
} from "../composer-selection-write";
import {
  clearLastModelPosture,
  setSessionPosture,
  setSessionRuntime,
  type SetPosturePersistOutcome,
} from "../../../api";
import { adapterKeys, sessionKeys } from "../../../session/queryKeys";
import type { ModelPosture } from "../../../types/app-config";
import type { SessionModelConfig, SessionRuntimeChoice } from "../../../types/runtime";

// composer-selection-write tests (ADR-0095/0099/0100, issues #572/#574/#592):
// the selection write port -- the one write face behind the composer picker's
// posture + runtime selections. The session adapter owns the set-IPC
// orchestration (cache seed, persist verdict, resync-on-reject); the
// cold-start channel owns the shell-held pending state, the #592 gesture
// ledger that guards the backfill-clear rollback, and the ADR-0100 Decision 2
// namespace reset (a runtime switch -- explicit pick or startup-resolution
// drift -- resets the pending posture). Port-level so the timing semantics
// #592 pinned here need no popover mounts.

vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    setSessionPosture: vi.fn(),
    setSessionRuntime: vi.fn(),
    clearLastModelPosture: vi.fn(),
  };
});

const PERSIST_OK: SetPosturePersistOutcome = {
  persist_error: null,
  persist_suspended: false,
};

const POSTURE: ModelPosture = { model: "fake-opus", thought_level: "medium" };
const CLEAR: ModelPosture = { model: null, thought_level: "medium" };

const EXTERNAL_QWEN: SessionRuntimeChoice = { kind: "external", data: "qwen-code" };
const EXTERNAL_CODEX: SessionRuntimeChoice = { kind: "external", data: "codex" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(setSessionPosture).mockResolvedValue(PERSIST_OK);
  vi.mocked(setSessionRuntime).mockResolvedValue(undefined);
  // The clear's returned AppConfig is not consumed by the port -- the mock
  // only needs a resolving promise.
  vi.mocked(clearLastModelPosture).mockResolvedValue({} as never);
});

describe("session selection port (ADR-0095 set-IPC orchestration)", () => {
  function sessionPort(queryClient: QueryClient, adapterId: string | null = "qwen-code") {
    return createSessionSelectionPort({
      sessionId: "sess-1",
      queryClient,
      activeAdapterId: adapterId,
    });
  }

  it("seeds the model-config cache from the write and lands the persist verdict", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(sessionKeys.modelConfig("sess-1"), {
      model: null,
      thought_level: "high",
      cached_discovered: null,
    } satisfies SessionModelConfig);
    const outcome = await sessionPort(queryClient).writePosture(POSTURE, {
      clearsBackfill: false,
      rollbackTo: POSTURE,
    });
    expect(setSessionPosture).toHaveBeenCalledWith("sess-1", POSTURE);
    expect(outcome).toEqual({
      status: "written",
      persistError: null,
      persistSuspended: false,
    });
    // Functional merge: the untouched cache fields survive the seed.
    expect(queryClient.getQueryData(sessionKeys.modelConfig("sess-1"))).toEqual({
      model: "fake-opus",
      thought_level: "medium",
      cached_discovered: null,
    });
  });

  it("seeds an empty cache slot with the submitted pair alone", async () => {
    const queryClient = new QueryClient();
    await sessionPort(queryClient).writePosture(POSTURE, {
      clearsBackfill: false,
      rollbackTo: POSTURE,
    });
    expect(queryClient.getQueryData(sessionKeys.modelConfig("sess-1"))).toEqual({
      model: "fake-opus",
      thought_level: "medium",
      cached_discovered: null,
    });
  });

  it("invalidates the backfill entry after a successful set (single write point)", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await sessionPort(queryClient).writePosture(POSTURE, {
      clearsBackfill: false,
      rollbackTo: POSTURE,
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: adapterKeys.posture("qwen-code"),
    });
  });

  it("skips the backfill invalidation when no external adapter is active", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await sessionPort(queryClient, null).writePosture(POSTURE, {
      clearsBackfill: false,
      rollbackTo: POSTURE,
    });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("carries the persist verdict through a successful set", async () => {
    const queryClient = new QueryClient();
    vi.mocked(setSessionPosture).mockResolvedValue({
      persist_error: { kind: "Io", data: "locked" },
      persist_suspended: true,
    });
    const outcome = await sessionPort(queryClient).writePosture(POSTURE, {
      clearsBackfill: false,
      rollbackTo: POSTURE,
    });
    expect(outcome).toEqual({
      status: "written",
      persistError: { kind: "Io", data: "locked" },
      persistSuspended: true,
    });
  });

  it("rejects without seeding, and resyncs the model config from the server", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    vi.mocked(setSessionPosture).mockRejectedValueOnce(new Error("ipc down"));
    const outcome = await sessionPort(queryClient).writePosture(POSTURE, {
      clearsBackfill: false,
      rollbackTo: POSTURE,
    });
    expect(outcome).toEqual({ status: "rejected", error: new Error("ipc down") });
    expect(
      queryClient.getQueryData(sessionKeys.modelConfig("sess-1")),
    ).toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: sessionKeys.modelConfig("sess-1"),
    });
  });

  it("seeds the runtime cache after a successful switch and refetches the posture slot", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await sessionPort(queryClient).writeRuntime(EXTERNAL_QWEN);
    expect(setSessionRuntime).toHaveBeenCalledWith("sess-1", EXTERNAL_QWEN);
    expect(queryClient.getQueryData(sessionKeys.runtime("sess-1"))).toBe(
      EXTERNAL_QWEN,
    );
    // The switch re-seeds the posture slot server-side (ADR-0102 Decision 3).
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: sessionKeys.modelConfig("sess-1"),
    });
  });

  it("rejects a failed runtime switch and resyncs the runtime read", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    vi.mocked(setSessionRuntime).mockRejectedValueOnce(new Error("ipc down"));
    await sessionPort(queryClient).writeRuntime(EXTERNAL_QWEN);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: sessionKeys.runtime("sess-1"),
    });
  });
});

describe("cold-start selection channel (ADR-0099/0100, issues #572/#574)", () => {
  function renderColdStart(
    effectiveRuntime: SessionRuntimeChoice = EXTERNAL_QWEN,
  ) {
    const queryClient = new QueryClient();
    const view = renderHook(
      ({ runtime }) => useColdStartSelection({ startupRuntime: runtime, queryClient }),
      { initialProps: { runtime: effectiveRuntime } },
    );
    return { queryClient, ...view };
  }

  it("writes a pick to the pending posture with no IPCs", async () => {
    const { result } = renderColdStart();
    await act(async () => {
      const outcome = await result.current.channel.port.writePosture(POSTURE, {
        clearsBackfill: false,
        rollbackTo: POSTURE,
      });
      expect(outcome.status).toBe("written");
    });
    expect(result.current.pendingModelPosture).toEqual(POSTURE);
    expect(clearLastModelPosture).not.toHaveBeenCalled();
  });

  it("carries the effective runtime on the channel read face (ADR-0098 D4)", () => {
    const { result } = renderColdStart();
    expect(result.current.channel.effectiveRuntime).toBe(EXTERNAL_QWEN);
    expect(result.current.pendingRuntime).toBeNull();
  });

  it("clears the backfill entry over the IPC and empties the cache on success", async () => {
    const { result, queryClient } = renderColdStart();
    await act(async () => {
      await result.current.channel.port.writePosture(CLEAR, {
        clearsBackfill: true,
        rollbackTo: POSTURE,
      });
    });
    expect(clearLastModelPosture).toHaveBeenCalledWith("qwen-code");
    expect(queryClient.getQueryData(adapterKeys.posture("qwen-code"))).toEqual({
      model: null,
      thought_level: null,
    });
    expect(result.current.pendingModelPosture).toEqual(CLEAR);
  });

  it("rolls the pending clear back when the backfill-clear IPC rejects (ADR-0100 D3)", async () => {
    vi.mocked(clearLastModelPosture).mockRejectedValueOnce(
      new Error("config write failed"),
    );
    const { result } = renderColdStart();
    await act(async () => {
      const outcome = await result.current.channel.port.writePosture(CLEAR, {
        clearsBackfill: true,
        rollbackTo: POSTURE,
      });
      // The entry survived: the pending pair rolls back to the displayed
      // posture so the next cold start cannot re-seed the "cleared" one.
      expect(outcome).toEqual({
        status: "rejected",
        error: new Error("config write failed"),
      });
    });
    expect(result.current.pendingModelPosture).toEqual(POSTURE);
  });

  it("does not roll back when a later gesture rewrote the pair in the IPC window (#592)", async () => {
    let rejectClear: ((reason: unknown) => void) | undefined;
    vi.mocked(clearLastModelPosture).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectClear = reject;
        }),
    );
    const PICK: ModelPosture = { model: "fake-sonnet", thought_level: "medium" };
    const { result } = renderColdStart();
    let clearSettled: Promise<unknown> | undefined;
    act(() => {
      clearSettled = result.current.channel.port.writePosture(CLEAR, {
        clearsBackfill: true,
        rollbackTo: POSTURE,
      });
    });
    // The user picks a model while the clear IPC is still in flight.
    await act(async () => {
      await result.current.channel.port.writePosture(PICK, {
        clearsBackfill: false,
        rollbackTo: CLEAR,
      });
    });
    await act(async () => {
      rejectClear?.(new Error("config write failed"));
      await clearSettled;
    });
    // The pick survives the rejected clear -- no rollback to the pre-clear
    // snapshot.
    expect(result.current.pendingModelPosture).toEqual(PICK);
  });

  it("does not roll back when the same clear gesture repeats in the IPC window (#592)", async () => {
    // Double-submitting the clear rewrites an EQUAL pair -- a value check
    // alone cannot tell it from "no later gesture" -- so the ledger's fresh
    // entry identity keeps the twice-expressed clear intent.
    let rejectFirstClear: ((reason: unknown) => void) | undefined;
    vi.mocked(clearLastModelPosture)
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirstClear = reject;
          }),
      )
      .mockResolvedValue({} as never);
    const { result } = renderColdStart();
    let firstClear: Promise<unknown> | undefined;
    act(() => {
      firstClear = result.current.channel.port.writePosture(CLEAR, {
        clearsBackfill: true,
        rollbackTo: POSTURE,
      });
    });
    await act(async () => {
      await result.current.channel.port.writePosture(CLEAR, {
        clearsBackfill: true,
        rollbackTo: CLEAR,
      });
    });
    expect(clearLastModelPosture).toHaveBeenCalledTimes(2);
    await act(async () => {
      rejectFirstClear?.(new Error("config write failed"));
      await firstClear;
    });
    // No rollback: the twice-expressed clear stands.
    expect(result.current.pendingModelPosture).toEqual(CLEAR);
  });

  it("does not roll back when a runtime switch reset the pair in the IPC window (#592)", async () => {
    let rejectClear: ((reason: unknown) => void) | undefined;
    vi.mocked(clearLastModelPosture).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectClear = reject;
        }),
    );
    const { result } = renderColdStart();
    let clearSettled: Promise<unknown> | undefined;
    act(() => {
      clearSettled = result.current.channel.port.writePosture(CLEAR, {
        clearsBackfill: true,
        rollbackTo: POSTURE,
      });
    });
    // The user switches runtimes on the bar inside the IPC window: the
    // pending posture resets (ADR-0100 D2 namespacing).
    await act(async () => {
      await result.current.channel.port.writeRuntime({ kind: "built_in" });
    });
    expect(result.current.pendingModelPosture).toBeNull();
    await act(async () => {
      rejectClear?.(new Error("config write failed"));
      await clearSettled;
    });
    // No rollback: the pre-clear posture is not resurrected under the new
    // runtime.
    expect(result.current.pendingModelPosture).toBeNull();
  });

  it("does not roll back when a same-identity runtime re-pick replaced the ledger token (#592)", async () => {
    // Re-picking the ALREADY-effective runtime moves no namespace, so the
    // drift effect never fires (same kind, same data) -- the switch's own
    // ledger token replacement is the only guard, including the same-task
    // window before any effect flush could re-mask the token.
    let rejectClear: ((reason: unknown) => void) | undefined;
    vi.mocked(clearLastModelPosture).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectClear = reject;
        }),
    );
    const { result } = renderColdStart();
    let clearSettled: Promise<unknown> | undefined;
    act(() => {
      clearSettled = result.current.channel.port.writePosture(CLEAR, {
        clearsBackfill: true,
        rollbackTo: POSTURE,
      });
    });
    // The user re-picks the runtime already displayed; the clear rejects
    // inside the same task, before any effect flush.
    await act(async () => {
      await result.current.channel.port.writeRuntime(EXTERNAL_QWEN);
      rejectClear?.(new Error("config write failed"));
      await clearSettled;
    });
    // No rollback: the token stands even though the runtime never moved.
    expect(result.current.pendingModelPosture).toBeNull();
  });

  it("does not roll back when the mint consumed the pending pair in the IPC window (#592)", async () => {
    // The mint's consume resets both pending facets; a clear rejecting
    // after that point must not resurrect the consumed pair as an
    // explicit pending selection -- the ledger token goes with it, or
    // the next cold start would apply a posture the user cleared.
    let rejectClear: ((reason: unknown) => void) | undefined;
    vi.mocked(clearLastModelPosture).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectClear = reject;
        }),
    );
    const { result } = renderColdStart();
    let clearSettled: Promise<unknown> | undefined;
    act(() => {
      clearSettled = result.current.channel.port.writePosture(CLEAR, {
        clearsBackfill: true,
        rollbackTo: POSTURE,
      });
    });
    // The submit mints the session and consumes the pending pair inside
    // the IPC window (App calls consume on mint success). The effective
    // runtime never moved, so the drift reset cannot mask this arm --
    // the consume's own token replacement is the only guard.
    act(() => {
      result.current.consume();
    });
    expect(result.current.pendingModelPosture).toBeNull();
    await act(async () => {
      rejectClear?.(new Error("config write failed"));
      await clearSettled;
    });
    // No rollback: the consumed pair stays consumed.
    expect(result.current.pendingModelPosture).toBeNull();
  });

  it("resets the pending posture when the effective runtime drifts without a pick (ADR-0100 D2)", async () => {
    let rejectClear: ((reason: unknown) => void) | undefined;
    vi.mocked(clearLastModelPosture).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectClear = reject;
        }),
    );
    const { result, rerender } = renderColdStart();
    let clearSettled: Promise<unknown> | undefined;
    act(() => {
      clearSettled = result.current.channel.port.writePosture(CLEAR, {
        clearsBackfill: true,
        rollbackTo: POSTURE,
      });
    });
    // default_runtime changed in Settings / an adapter-table refetch moved
    // the startup resolution -- no explicit picker pick, same namespacing.
    rerender({ runtime: EXTERNAL_CODEX });
    await waitFor(() =>
      expect(result.current.pendingModelPosture).toBeNull(),
    );
    await act(async () => {
      rejectClear?.(new Error("config write failed"));
      await clearSettled;
    });
    expect(result.current.pendingModelPosture).toBeNull();
  });

  it("keeps the pending posture across an effective-runtime refetch that lands on the same adapter", () => {
    const { result, rerender } = renderColdStart();
    act(() => {
      result.current.channel.port.writePosture(POSTURE, {
        clearsBackfill: false,
        rollbackTo: POSTURE,
      });
    });
    // A new object with the same identity is not a namespace change.
    rerender({ runtime: { kind: "external", data: "qwen-code" } });
    expect(result.current.pendingModelPosture).toEqual(POSTURE);
  });

  it("consumes the pending facets on mint (both reset to untouched)", async () => {
    const { result } = renderColdStart();
    await act(async () => {
      await result.current.channel.port.writeRuntime(EXTERNAL_CODEX);
      await result.current.channel.port.writePosture(POSTURE, {
        clearsBackfill: false,
        rollbackTo: POSTURE,
      });
    });
    act(() => {
      result.current.consume();
    });
    expect(result.current.pendingRuntime).toBeNull();
    expect(result.current.pendingModelPosture).toBeNull();
  });
});
