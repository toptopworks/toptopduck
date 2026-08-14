import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntlShape } from "react-intl";
import { sessionKeys } from "../queryKeys";
import { mergeLiveTrace, rowsToTrace, useTurnFlow, type LiveCall, type LiveTraceRow } from "../useTurnFlow";
import { materialized, textual } from "./fixtures";
import type { ApprovalEntry } from "../useApprovalEvents";
import type { ThreadEntry, TurnOutcome, TurnRecord } from "../../types/thread";
import type { TurnProgress } from "../../types/session";

// Tests for useTurnFlow (issue #230, evolved by issue #297) -- pins the
// behaviors extracted from useSessionState: the long-lived turn-progress
// listener + event lifecycle (ADR-0059, calibrated to the tool-call event
// stream by ADR-0078), the in-flight LIVE TRACE (Thinking step + started/
// completed call rows merged with approval entries), the optimistic thread
// append carrying the settled trace with selective invalidate (thread stays
// un-invalidated, ADR-0051), and the viewed method call timing (markProduced
// on Materialized, suppressInit on every outcome, issue #229). Drives the
// hook through stub deps + a captured onTurnProgress callback so it runs
// offline (jsdom has no Tauri event bus).

// Capture the onTurnProgress callback so a test can emit Thinking / tool-call
// events addressed to THIS session vs a stranger (the ADR-0056 multi-session
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

    it("sets phase from a Thinking / tool-call event addressed to this session", async () => {
      const { deps } = setup();
      const { result } = renderHook(() => useTurnFlow(SID, deps));
      await waitFor(() => expect(turnProgressCb.current).not.toBeNull());
      emitProgress(SID, { Thinking: { attempt: 1 } });
      expect(result.current.phase).toEqual({ Thinking: { attempt: 1 } });
      // ADR-0078: the tool-call event stream replaces the retired Querying
      // marker; the latest event rides `phase` for the QuestionBar label.
      emitProgress(SID, {
        ToolCallStarted: { name: "explore", operation_kind: "read", summary: "SELECT 1" },
      });
      expect(result.current.phase).toEqual({
        ToolCallStarted: { name: "explore", operation_kind: "read", summary: "SELECT 1" },
      });
    });

    it("filters out events addressed to ANOTHER session (ADR-0056 multi-session filter)", async () => {
      const { deps } = setup();
      const { result } = renderHook(() => useTurnFlow(SID, deps));
      await waitFor(() => expect(turnProgressCb.current).not.toBeNull());
      emitProgress(SID, { Thinking: { attempt: 1 } });
      expect(result.current.phase).toEqual({ Thinking: { attempt: 1 } });
      // A sibling pane's event must never leak in.
      emitProgress(STRANGER, {
        ToolCallStarted: { name: "explore", operation_kind: "read", summary: "SELECT 1" },
      });
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
      emitProgress(SID, {
        ToolCallStarted: { name: "explore", operation_kind: "read", summary: "SELECT 1" },
      });
      expect(result.current.phase).toEqual({
        ToolCallStarted: { name: "explore", operation_kind: "read", summary: "SELECT 1" },
      });
      await act(async () => {
        await result.current.handleAsk("q");
      });
      // The reject's finally clears the phase the mid-turn event set.
      expect(result.current.phase).toBeNull();
      // Error + loading teardown on the failure path: setError(null) clears the
      // prior error at the ask start, then the reject sets a fresh AppError.
      expect(setError).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "ask" }));
    });
  });

  describe("in-flight live trace (ADR-0078, issue #297)", () => {
    it("renders null before any ask and mounts the live card on ask start", async () => {
      const { deps } = setup();
      vi.mocked(askQuestion).mockImplementation(
        () => new Promise<TurnOutcome>(() => {}), // stays in flight
      );
      const { result } = renderHook(() => useTurnFlow(SID, deps));
      expect(result.current.liveTurn).toBeNull();
      act(() => {
        void result.current.handleAsk("多少行？");
      });
      expect(result.current.liveTurn).toEqual({ question: "多少行？", step: null, rows: [] });
    });

    it("grows rows from the tool-call event stream (started -> completed)", async () => {
      const { deps } = setup();
      vi.mocked(askQuestion).mockImplementation(
        () => new Promise<TurnOutcome>(() => {}),
      );
      const { result } = renderHook(() => useTurnFlow(SID, deps));
      await waitFor(() => expect(turnProgressCb.current).not.toBeNull());
      act(() => {
        void result.current.handleAsk("q");
      });
      emitProgress(SID, { Thinking: { attempt: 1 } });
      emitProgress(SID, {
        ToolCallStarted: { name: "explore", operation_kind: "read", summary: "SELECT 1" },
      });
      expect(result.current.liveTurn?.step).toBe(1);
      expect(result.current.liveTurn?.rows).toEqual([
        {
          key: "call-0",
          name: "explore",
          server: null,
          operationKind: "read",
          summary: "SELECT 1",
          approval: null,
          running: true,
          success: null,
          resultExcerpt: "",
        },
      ]);
      emitProgress(SID, {
        ToolCallCompleted: {
          name: "explore",
          operation_kind: "read",
          summary: "SELECT 1",
          success: true,
          result_excerpt: "",
        },
      });
      const row = result.current.liveTurn?.rows[0];
      expect(row).toMatchObject({ running: false, success: true, key: "call-0" });
    });

    it("appends a completed row for a gate-denied call (no started event)", async () => {
      const { deps } = setup();
      vi.mocked(askQuestion).mockImplementation(
        () => new Promise<TurnOutcome>(() => {}),
      );
      const { result } = renderHook(() => useTurnFlow(SID, deps));
      await waitFor(() => expect(turnProgressCb.current).not.toBeNull());
      act(() => {
        void result.current.handleAsk("q");
      });
      emitProgress(SID, {
        ToolCallCompleted: {
          name: "fetch",
          operation_kind: "network",
          summary: "GET /x",
          success: false,
          result_excerpt: "denied by approval gateway",
        },
      });
      expect(result.current.liveTurn?.rows).toHaveLength(1);
      expect(result.current.liveTurn?.rows[0]).toMatchObject({
        name: "fetch",
        success: false,
        resultExcerpt: "denied by approval gateway",
        running: false,
      });
    });

    it("merges approval entries into the matching call row (one row per call)", async () => {
      const approval: ApprovalEntry = {
        requestId: "req-1",
        server: "acme",
        tool: "fetch",
        operationKind: "network",
        summary: "GET /x",
        status: { kind: "resolved", response: "allow_once" },
      };
      const { deps } = setup();
      vi.mocked(askQuestion).mockImplementation(
        () => new Promise<TurnOutcome>(() => {}),
      );
      const { result } = renderHook(() =>
        useTurnFlow(SID, { ...deps, approvals: [approval] }),
      );
      await waitFor(() => expect(turnProgressCb.current).not.toBeNull());
      act(() => {
        void result.current.handleAsk("q");
      });
      // Pending card row before any tool event (the gate suspends dispatch).
      expect(result.current.liveTurn?.rows).toEqual([
        expect.objectContaining({ key: "req-1", approval: { requestId: "req-1", response: "allow_once" }, success: null }),
      ]);
      emitProgress(SID, {
        ToolCallStarted: { name: "fetch", operation_kind: "network", summary: "GET /x" },
      });
      emitProgress(SID, {
        ToolCallCompleted: {
          name: "fetch",
          operation_kind: "network",
          summary: "GET /x",
          success: true,
          result_excerpt: "",
        },
      });
      // ONE merged row: the card's identity + the call's outcome.
      expect(result.current.liveTurn?.rows).toHaveLength(1);
      expect(result.current.liveTurn?.rows[0]).toMatchObject({
        key: "req-1",
        server: "acme",
        approval: { requestId: "req-1", response: "allow_once" },
        success: true,
      });
    });

    it("clears the live card on ask end and calls onApprovalsSettled", async () => {
      const { deps } = setup();
      let resolveAsk!: (o: TurnOutcome) => void;
      vi.mocked(askQuestion).mockImplementation(
        () => new Promise<TurnOutcome>((res) => (resolveAsk = res)),
      );
      const onApprovalsSettled = vi.fn();
      const { result } = renderHook(() =>
        useTurnFlow(SID, { ...deps, onApprovalsSettled }),
      );
      await waitFor(() => expect(turnProgressCb.current).not.toBeNull());
      let askDone!: Promise<void>;
      act(() => {
        askDone = result.current.handleAsk("q");
      });
      expect(result.current.liveTurn).not.toBeNull();
      await act(async () => {
        resolveAsk({ kind: "Cancelled" });
        await askDone;
      });
      expect(result.current.liveTurn).toBeNull();
      expect(onApprovalsSettled).toHaveBeenCalledTimes(1);
    });

    it("folds the settled rows into the optimistic TurnRecord.trace", async () => {
      const { queryClient, deps } = setup();
      queryClient.setQueryData(sessionKeys.thread(SID), []);
      const { result } = renderHook(() => useTurnFlow(SID, deps));
      await waitFor(() => expect(turnProgressCb.current).not.toBeNull());
      // The ask promise resolves on our signal so events can land mid-turn.
      let resolveAsk!: (o: TurnOutcome) => void;
      vi.mocked(askQuestion).mockImplementation(
        () => new Promise<TurnOutcome>((res) => (resolveAsk = res)),
      );
      let askDone!: Promise<void>;
      act(() => {
        askDone = result.current.handleAsk("q");
      });
      emitProgress(SID, {
        ToolCallStarted: { name: "explore", operation_kind: "read", summary: "SELECT 1" },
      });
      emitProgress(SID, {
        ToolCallCompleted: {
          name: "explore",
          operation_kind: "read",
          summary: "SELECT 1",
          success: false,
          result_excerpt: "no such table",
        },
      });
      await act(async () => {
        resolveAsk({ kind: "Cancelled" });
        await askDone;
      });
      const thread = queryClient.getQueryData<ThreadEntry[]>(sessionKeys.thread(SID));
      expect(thread).toHaveLength(1);
      const entry = thread?.[0];
      if (entry?.entry !== "Turn") throw new Error("expected a Turn entry");
      expect(entry.data.trace).toEqual([
        {
          name: "explore",
          operation_kind: "read",
          summary: "SELECT 1",
          success: false,
          result_excerpt: "no such table",
        },
      ]);
    });
  });

  describe("mergeLiveTrace + rowsToTrace (pure helpers)", () => {
    const call = (over: Partial<LiveCall> = {}): LiveCall => ({
      key: "call-0",
      name: "explore",
      operationKind: "read",
      summary: "SELECT 1",
      running: false,
      success: true,
      resultExcerpt: "",
      ...over,
    });
    const approval = (over: Partial<ApprovalEntry> = {}): ApprovalEntry => ({
      requestId: "req-1",
      server: "acme",
      tool: "fetch",
      operationKind: "network",
      summary: "GET /x",
      status: { kind: "pending" },
      ...over,
    });

    it("passes plain calls through as ungated rows", () => {
      expect(mergeLiveTrace([call()], [])).toEqual([
        expect.objectContaining({ key: "call-0", approval: null, success: true }),
      ]);
    });

    it("trails unmatched approvals (still pending at the gate)", () => {
      const rows = mergeLiveTrace([call()], [approval()]);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        key: "req-1",
        approval: { requestId: "req-1", response: null },
        success: null,
      });
    });

    it("merges by tool name + summary, consuming each approval once", () => {
      const a = approval();
      const rows = mergeLiveTrace(
        [
          call({ key: "call-0", name: "fetch", operationKind: "network", summary: "GET /x" }),
          call({ key: "call-1", name: "fetch", operationKind: "network", summary: "GET /x" }),
        ],
        [a, approval({ requestId: "req-2" })],
      );
      // Two calls + two approvals -> two merged rows (no trailing card).
      expect(rows.map((r) => r.key)).toEqual(["req-1", "req-2"]);
    });

    it("rowsToTrace keeps completed calls and drops unsettled rows", () => {
      const rows: LiveTraceRow[] = [
        {
          key: "call-0",
          name: "explore",
          server: null,
          operationKind: "read",
          summary: "SELECT 1",
          approval: null,
          running: false,
          success: false,
          resultExcerpt: "boom",
        },
        {
          key: "req-1",
          name: "fetch",
          server: "acme",
          operationKind: "network",
          summary: "GET /x",
          approval: { requestId: "req-1", response: "deny" },
          running: false,
          success: null, // gate-cancelled: no backend trace entry
          resultExcerpt: "",
        },
      ];
      expect(rowsToTrace(rows)).toEqual([
        {
          name: "explore",
          operation_kind: "read",
          summary: "SELECT 1",
          success: false,
          result_excerpt: "boom",
        },
      ]);
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

    it("appends even when the thread cache has no prior entry (first ask, old===undefined)", async () => {
      const { queryClient, deps } = setup();
      // No setQueryData seed: the thread query has not resolved yet (first ask
      // on a cold session), so setQueryData's updater receives undefined. The
      // append must mint the initial [newEntry] array via the `old ? ... :`
      // branch, not crash reading old.length.
      const { result } = renderHook(() => useTurnFlow(SID, deps));
      vi.mocked(askQuestion).mockResolvedValue(textualOutcome("answer"));

      await act(async () => {
        await result.current.handleAsk("q");
      });

      const thread = queryClient.getQueryData<unknown[]>(sessionKeys.thread(SID));
      expect(thread).toHaveLength(1);
      expect(thread?.[0]).toMatchObject({ entry: "Turn" });
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

    it("invalidates ONLY the model config on a non-Materialized outcome (Textual)", async () => {
      // ADR-0051 rule (no workingSet/active/thread invalidation) still holds;
      // ADR-0095 adds ONE exception: the model-config read refreshes on every
      // outcome kind, because an external-runtime turn's discovered catalog
      // lands on the backend handle cache regardless of how the turn ended.
      const { invalidateSpy, deps } = setup();
      const { result } = renderHook(() => useTurnFlow(SID, deps));
      vi.mocked(askQuestion).mockResolvedValue(textualOutcome("answer"));

      await act(async () => {
        await result.current.handleAsk("q");
      });

      expect(invalidateSpy).toHaveBeenCalledTimes(1);
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: sessionKeys.modelConfig(SID),
      });
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
