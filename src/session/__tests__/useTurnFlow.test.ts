import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntlShape } from "react-intl";
import { sessionKeys } from "../queryKeys";
import { useTurnFlow } from "../useTurnFlow";
import { materialized, textual } from "./fixtures";
import type { TurnOutcome, TurnRecord } from "../../types/thread";
import type { TurnProgress } from "../../types/session";

// Tests for useTurnFlow (issue #230) -- pins the three behaviors extracted
// from useSessionState: the long-lived turn-progress listener + phase
// lifecycle (ADR-0059), the optimistic thread append with selective invalidate
// (thread stays un-invalidated, ADR-0051), and the viewed method call timing
// (markProduced on Materialized, suppressInit on every outcome, issue #229).
// Drives the hook through stub deps + a captured onTurnProgress callback so it
// runs offline (jsdom has no Tauri event bus).

// Capture the onTurnProgress callback so a test can emit Thinking/Querying
// phases addressed to THIS session vs a stranger (the ADR-0056 multi-session
// filter inside the listener).
const turnProgressCb = vi.hoisted(() => ({
  current: null as null | ((ev: TurnProgress) => void),
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    askQuestion: vi.fn(),
    cancelQuery: vi.fn(async () => {}),
    // Capture the listener callback so a test can emit phases; the returned
    // unlisten is a no-op (jsdom has no real Tauri event bus).
    onTurnProgress: vi.fn(async (cb: (ev: TurnProgress) => void) => {
      turnProgressCb.current = cb;
      return () => {};
    }),
  };
});

import { askQuestion, cancelQuery } from "../../api";

const SID = "sess-1";
const STRANGER = "sess-other";

// Minimal-but-real outcome fixtures: reuse the shared thread fixtures and pull
// the `.data.outcome` (askQuestion returns a TurnOutcome, not a ThreadEntry).
// The fixtures always mint the Turn variant, so the cast to TurnRecord is safe
// (ThreadEntry.data is a TurnRecord | SourceLifecycleEvent union).
const materializedOutcome = (ref: string): TurnOutcome =>
  (materialized(ref).data as TurnRecord).outcome;
const textualOutcome = (body: string): TurnOutcome =>
  (textual(body).data as TurnRecord).outcome;

function setup() {
  // gcTime left at default (not 0): a 0 gcTime would GC the query immediately
  // after setQueryData (no observer mounts in a hook test), so getQueryData
  // would read undefined and the optimistic-append assertion would flake.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Spy invalidateQueries so a test can assert which keys were invalidated. The
  // spy passes through to the real method, but the queries have no observers /
  // queryFn (only setQueryData was used), so invalidation marks stale without
  // triggering a refetch.
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  const viewed = { markProduced: vi.fn(), suppressInit: vi.fn() };
  const setLoading = vi.fn();
  const setError = vi.fn();
  const pollPersistError = vi.fn(async () => {});
  const intl = { formatMessage: () => "err" } as unknown as IntlShape;
  const deps = {
    queryClient,
    intl,
    setLoading,
    setError,
    pollPersistError,
    viewed,
  };
  return { queryClient, invalidateSpy, viewed, setLoading, setError, pollPersistError, deps };
}

function emitProgress(sessionId: string, phase: TurnProgress["phase"]) {
  act(() => turnProgressCb.current!({ session_id: sessionId, phase }));
}

describe("useTurnFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    turnProgressCb.current = null;
  });

  describe("turn-progress listener + phase lifecycle (ADR-0059)", () => {
    it("mounts a LONG-LIVED listener once (reused across turns, ADR-0059 C-4)", () => {
      const { deps } = setup();
      renderHook(() => useTurnFlow(SID, deps));
      expect(turnProgressCb.current).not.toBeNull();
    });

    it("sets phase from a Thinking/Querying event addressed to this session", async () => {
      const { deps } = setup();
      const { result } = renderHook(() => useTurnFlow(SID, deps));
      await waitFor(() => expect(turnProgressCb.current).not.toBeNull());
      emitProgress(SID, { Thinking: { attempt: 1 } });
      expect(result.current.phase).toEqual({ Thinking: { attempt: 1 } });
      emitProgress(SID, { Querying: { attempt: 1 } });
      expect(result.current.phase).toEqual({ Querying: { attempt: 1 } });
    });

    it("filters out events addressed to ANOTHER session (ADR-0056 multi-session filter)", async () => {
      const { deps } = setup();
      const { result } = renderHook(() => useTurnFlow(SID, deps));
      await waitFor(() => expect(turnProgressCb.current).not.toBeNull());
      emitProgress(SID, { Thinking: { attempt: 1 } });
      expect(result.current.phase).toEqual({ Thinking: { attempt: 1 } });
      // A sibling pane's phase must never leak in.
      emitProgress(STRANGER, { Querying: { attempt: 2 } });
      expect(result.current.phase).toEqual({ Thinking: { attempt: 1 } });
    });

    it("clears phase to null on every ask end (finally, incl. a Cancelled outcome)", async () => {
      const { deps } = setup();
      vi.mocked(askQuestion).mockResolvedValue({ kind: "Cancelled" });
      const { result } = renderHook(() => useTurnFlow(SID, deps));
      await waitFor(() => expect(turnProgressCb.current).not.toBeNull());
      emitProgress(SID, { Thinking: { attempt: 1 } });
      expect(result.current.phase).toEqual({ Thinking: { attempt: 1 } });
      await act(async () => {
        await result.current.handleAsk("q");
      });
      expect(result.current.phase).toBeNull();
    });

    it("clears phase to null even when askQuestion rejects (IPC failure)", async () => {
      const { deps, setError } = setup();
      vi.mocked(askQuestion).mockRejectedValue(new Error("ipc down"));
      const { result } = renderHook(() => useTurnFlow(SID, deps));
      await waitFor(() => expect(turnProgressCb.current).not.toBeNull());
      emitProgress(SID, { Querying: { attempt: 1 } });
      await act(async () => {
        await result.current.handleAsk("q");
      });
      expect(result.current.phase).toBeNull();
      // Error + loading teardown on the failure path: setError(null) clears the
      // prior error at the ask start, then the reject sets a fresh AppError.
      expect(setError).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "ask" }));
    });
  });

  describe("optimistic thread append + selective invalidate (ADR-0051)", () => {
    it("appends the new turn to the thread cache via setQueryData", async () => {
      const { queryClient, deps } = setup();
      queryClient.setQueryData(sessionKeys.thread(SID), []);
      const { result } = renderHook(() => useTurnFlow(SID, deps));
      vi.mocked(askQuestion).mockResolvedValue(textualOutcome("answer"));

      await act(async () => {
        await result.current.handleAsk("why?");
      });

      const thread = queryClient.getQueryData<unknown[]>(sessionKeys.thread(SID));
      expect(thread).toHaveLength(1);
      expect(thread?.[0]).toMatchObject({
        entry: "Turn",
        data: { question: "why?", outcome: { kind: "Textual" } },
      });
    });

    it("invalidates workingSet + active on a Materialized outcome", async () => {
      const { invalidateSpy, deps } = setup();
      const { result } = renderHook(() => useTurnFlow(SID, deps));
      vi.mocked(askQuestion).mockResolvedValue(materializedOutcome("result_1"));

      await act(async () => {
        await result.current.handleAsk("build it");
      });

      const invalidatedKeys = invalidateSpy.mock.calls.map(
        (call) => (call[0] as { queryKey: unknown }).queryKey,
      );
      expect(invalidatedKeys).toContainEqual(sessionKeys.workingSet(SID));
      expect(invalidatedKeys).toContainEqual(sessionKeys.active(SID));
    });

    it("does NOT invalidate the thread on a Materialized outcome (optimistic append)", async () => {
      const { invalidateSpy, deps } = setup();
      const { result } = renderHook(() => useTurnFlow(SID, deps));
      vi.mocked(askQuestion).mockResolvedValue(materializedOutcome("result_1"));

      await act(async () => {
        await result.current.handleAsk("build it");
      });

      const invalidatedKeys = invalidateSpy.mock.calls.map(
        (call) => (call[0] as { queryKey: unknown }).queryKey,
      );
      // The core ADR-0051 invariant: invalidating thread would wipe the
      // optimistic append against a stale/empty refetch.
      expect(invalidatedKeys).not.toContainEqual(sessionKeys.thread(SID));
    });

    it("invalidates NOTHING on a non-Materialized outcome (Textual)", async () => {
      const { invalidateSpy, deps } = setup();
      const { result } = renderHook(() => useTurnFlow(SID, deps));
      vi.mocked(askQuestion).mockResolvedValue(textualOutcome("answer"));

      await act(async () => {
        await result.current.handleAsk("q");
      });

      expect(invalidateSpy).not.toHaveBeenCalled();
    });

    it("surfaces a refresh failure via setError without skipping setLoading(false)", async () => {
      const { queryClient, invalidateSpy, deps, setError, setLoading } = setup();
      const { result } = renderHook(() => useTurnFlow(SID, deps));
      vi.mocked(askQuestion).mockResolvedValue(materializedOutcome("result_1"));
      invalidateSpy.mockRejectedValueOnce(new Error("refresh failed"));

      await act(async () => {
        await result.current.handleAsk("build it");
      });

      // A refresh reject reaches setError (tagged ask) AND setLoading(false)
      // still runs -- QuestionBar is not left locked forever. setError(null)
      // ran at the ask start (clear), then the refresh reject set the error.
      expect(setError).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "ask" }));
      expect(setLoading).toHaveBeenLastCalledWith(false);
      // Thread cache holds the optimistic append (a refresh failure does not
      // wipe it; thread is never invalidated, ADR-0051).
      const thread = queryClient.getQueryData<unknown[]>(sessionKeys.thread(SID));
      expect(thread).toHaveLength(1);
      expect(thread?.[0]).toMatchObject({ entry: "Turn" });
    });
  });

  describe("viewed method timing (issue #229 -- auto-select + R5 suppress)", () => {
    it("calls suppressInit after the optimistic append on every outcome", async () => {
      const { viewed, deps } = setup();
      const { result } = renderHook(() => useTurnFlow(SID, deps));
      vi.mocked(askQuestion).mockResolvedValue(textualOutcome("answer"));

      await act(async () => {
        await result.current.handleAsk("q");
      });

      expect(viewed.suppressInit).toHaveBeenCalledTimes(1);
    });

    it("calls markProduced on a Materialized outcome (auto-select + pin reset)", async () => {
      const { viewed, deps } = setup();
      const { result } = renderHook(() => useTurnFlow(SID, deps));
      vi.mocked(askQuestion).mockResolvedValue(materializedOutcome("result_7"));

      await act(async () => {
        await result.current.handleAsk("build it");
      });

      expect(viewed.markProduced).toHaveBeenCalledTimes(1);
      expect(viewed.markProduced).toHaveBeenCalledWith("result_7");
    });

    it("does NOT call markProduced on a non-Materialized outcome", async () => {
      const { viewed, deps } = setup();
      const { result } = renderHook(() => useTurnFlow(SID, deps));
      vi.mocked(askQuestion).mockResolvedValue(textualOutcome("answer"));

      await act(async () => {
        await result.current.handleAsk("q");
      });

      expect(viewed.markProduced).not.toHaveBeenCalled();
    });
  });

  describe("handleCancel", () => {
    it("calls cancelQuery with the session id", async () => {
      const { deps } = setup();
      const { result } = renderHook(() => useTurnFlow(SID, deps));
      await act(async () => {
        await result.current.handleCancel();
      });
      expect(cancelQuery).toHaveBeenCalledWith(SID);
    });

    it("surfaces a cancel failure via setError (tagged ask)", async () => {
      const { deps, setError } = setup();
      vi.mocked(cancelQuery).mockRejectedValueOnce(new Error("cancel failed"));
      const { result } = renderHook(() => useTurnFlow(SID, deps));
      await act(async () => {
        await result.current.handleCancel();
      });
      expect(setError).toHaveBeenCalledTimes(1);
    });
  });
});
