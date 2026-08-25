import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntlShape } from "react-intl";
import { sessionKeys } from "../queryKeys";
import {
  buildLiveRounds,
  liveRoundsToTrace,
  mergeLiveTrace,
  useTurnFlow,
  type LiveCall,
  type LiveRound,
  type LiveTraceRow,
} from "../useTurnFlow";
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
      const { deps, setError, queryClient } = setup();
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
      // Issue #620: the failure path tears the exchange down too -- no live
      // residue, and no optimistic record lands on the thread cache.
      expect(result.current.liveTurn).toBeNull();
      const thread = queryClient.getQueryData<ThreadEntry[]>(sessionKeys.thread(SID));
      expect(thread ?? []).toHaveLength(0);
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
      // askedAt is the client's submit stamp (#610): the live bubble's
      // asked_at source, present before any progress event lands.
      expect(result.current.liveTurn).toMatchObject({
        question: "多少行？",
        step: null,
        rounds: [],
      });
      expect(typeof result.current.liveTurn?.askedAt).toBe("number");
    });

    it("attaches RoundText to the current round (issue #608)", async () => {
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
      emitProgress(SID, { RoundText: { text: "先看一眼数据。" } });
      expect(result.current.liveTurn?.rounds).toEqual([{ text: "先看一眼数据。", rows: [] }]);
      // A second round without prose pads nothing; a started call there
      // lands on round 2.
      emitProgress(SID, { Thinking: { attempt: 2 } });
      emitProgress(SID, {
        ToolCallStarted: { name: "explore", operation_kind: "read", summary: "SELECT 1" },
      });
      expect(result.current.liveTurn?.rounds[0]?.text).toBe("先看一眼数据。");
      // Round membership is positional (the row carries no step): the call
      // lands inside round 2's block, round 1 keeps no row.
      expect(result.current.liveTurn?.rounds[0]?.rows).toEqual([]);
      expect(result.current.liveTurn?.rounds[1]?.rows[0]?.key).toBe("call-0");
    });

    it("keeps the round's thinking on the live state (issues #608/#610)", async () => {
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
        ThinkingCompleted: { duration_ms: 900, text: "reasoning" },
      });
      // Observable as the latest phase; the round carries the block, no row.
      expect(result.current.phase).toEqual({
        ThinkingCompleted: { duration_ms: 900, text: "reasoning" },
      });
      // The thinking block rides the rounds (#610): the live fold renders
      // from it, so it must not be dropped.
      expect(result.current.liveTurn?.rounds).toEqual([
        { thinking: { duration_ms: 900, text: "reasoning" }, rows: [] },
      ]);
      // A second round's thinking slots by round, padding the round that
      // emitted none.
      emitProgress(SID, { Thinking: { attempt: 2 } });
      emitProgress(SID, { ThinkingCompleted: { duration_ms: 1200, text: "more" } });
      expect(result.current.liveTurn?.rounds).toEqual([
        { thinking: { duration_ms: 900, text: "reasoning" }, rows: [] },
        { thinking: { duration_ms: 1200, text: "more" }, rows: [] },
      ]);
      // A repeated completion for the same round is last-wins (the slot is
      // overwritten in place, the array does not grow).
      emitProgress(SID, { ThinkingCompleted: { duration_ms: 1500, text: "revised" } });
      expect(result.current.liveTurn?.rounds).toEqual([
        { thinking: { duration_ms: 900, text: "reasoning" }, rows: [] },
        { thinking: { duration_ms: 1500, text: "revised" }, rows: [] },
      ]);
    });

    it("falls a ThinkingCompleted that precedes any Thinking back to round 1", async () => {
      // Same ordering fallback the call-event handlers use (step ?? 1):
      // structurally unreachable from the loop (Thinking opens the round),
      // but the state layer stays total rather than dropping the block.
      const { deps } = setup();
      vi.mocked(askQuestion).mockImplementation(
        () => new Promise<TurnOutcome>(() => {}),
      );
      const { result } = renderHook(() => useTurnFlow(SID, deps));
      await waitFor(() => expect(turnProgressCb.current).not.toBeNull());
      act(() => {
        void result.current.handleAsk("q");
      });
      emitProgress(SID, { ThinkingCompleted: { duration_ms: 300, text: "early" } });
      expect(result.current.liveTurn?.rounds).toEqual([
        { thinking: { duration_ms: 300, text: "early" }, rows: [] },
      ]);
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
      expect(result.current.liveTurn?.rounds).toEqual([
        {
          rows: [
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
          ],
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
      const row = result.current.liveTurn?.rounds[0]?.rows[0];
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
      expect(result.current.liveTurn?.rounds[0]?.rows).toHaveLength(1);
      expect(result.current.liveTurn?.rounds[0]?.rows[0]).toMatchObject({
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
      expect(result.current.liveTurn?.rounds).toEqual([
        {
          rows: [
            expect.objectContaining({ key: "req-1", approval: { requestId: "req-1", response: "allow_once" }, success: null }),
          ],
        },
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
      expect(result.current.liveTurn?.rounds[0]?.rows).toHaveLength(1);
      expect(result.current.liveTurn?.rounds[0]?.rows[0]).toMatchObject({
        key: "req-1",
        server: "acme",
        approval: { requestId: "req-1", response: "allow_once" },
        success: true,
      });
    });

    it("stamps a round-2 gate wait's pending card with round 2 (hook wiring, issue #610)", async () => {
      // The hook passes live.step into the merge (not a constant): after
      // round 1 completes its call and round 2's Thinking opens, a pending
      // approval must trail at step 2 -- the live grouping renders its card
      // inside round 2's block. A wiring regression to a constant null/1
      // keeps every other test green while stranding the card in round 1.
      const approval: ApprovalEntry = {
        requestId: "req-1",
        server: "acme",
        tool: "fetch",
        operationKind: "network",
        summary: "GET /x",
        status: { kind: "pending" },
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
      emitProgress(SID, { Thinking: { attempt: 1 } });
      emitProgress(SID, {
        ToolCallStarted: { name: "explore", operation_kind: "read", summary: "SELECT 1" },
      });
      emitProgress(SID, {
        ToolCallCompleted: {
          name: "explore",
          operation_kind: "read",
          summary: "SELECT 1",
          success: true,
          result_excerpt: "",
        },
      });
      emitProgress(SID, { Thinking: { attempt: 2 } });
      // Round 1's completed call, then the round-2 gate wait trailing in
      // place -- each inside its own round's block.
      expect(result.current.liveTurn?.rounds).toHaveLength(2);
      expect(result.current.liveTurn?.rounds[0]?.rows[0]).toMatchObject({
        key: "call-0",
        success: true,
      });
      expect(result.current.liveTurn?.rounds[1]?.rows[0]).toMatchObject({
        key: "req-1",
        approval: { requestId: "req-1", response: null },
        success: null,
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
      emitProgress(SID, { Thinking: { attempt: 1 } });
      emitProgress(SID, {
        ThinkingCompleted: { duration_ms: 500, text: "hmm" },
      });
      emitProgress(SID, { RoundText: { text: "先看一眼数据。" } });
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
      // #610: the fold carries thinking + prose + calls onto the optimistic
      // record's round, so the settled round renders exactly what the live
      // exchange showed (the no-jump settle swap).
      expect(entry.data.trace).toEqual([
        {
          thinking: { duration_ms: 500, text: "hmm" },
          text: "先看一眼数据。",
          calls: [
            {
              name: "explore",
              operation_kind: "read",
              summary: "SELECT 1",
              success: false,
              result_excerpt: "no such table",
            },
          ],
        },
      ]);
      // The optimistic record carries client-clock timestamps (the ask
      // read at submit, the settle at fold time) until the refetch
      // replaces them with the backend's stamps.
      expect(typeof entry.data.asked_at).toBe("number");
      expect(typeof entry.data.settled_at).toBe("number");
      expect(entry.data.asked_at).toBeLessThanOrEqual(entry.data.settled_at!);
    });
  });

  describe("mergeLiveTrace + buildLiveRounds + liveRoundsToTrace (pure helpers)", () => {
    const call = (over: Partial<LiveCall> = {}): LiveCall => ({
      key: "call-0",
      step: 1,
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
      expect(mergeLiveTrace([call()], [], null)).toEqual([
        expect.objectContaining({ key: "call-0", approval: null, success: true }),
      ]);
    });

    it("trails unmatched approvals (still pending at the gate)", () => {
      const rows = mergeLiveTrace([call()], [approval()], null);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        key: "req-1",
        approval: { requestId: "req-1", response: null },
        success: null,
      });
    });

    it("carries the fileAttachments snapshot onto the approval card row (issue #672)", () => {
      // The pending card is the snapshot's only surface: the approver
      // expands it against a value whose temp file is deleted when the call
      // ends, so the merge must not drop it on the way to the row.
      const files = [{ param: "code", content: "print(1)" }];
      const rows = mergeLiveTrace([], [approval({ fileAttachments: files })], 1);
      expect(rows[0]?.approval).toMatchObject({
        requestId: "req-1",
        response: null,
        fileAttachments: files,
      });
    });

    it("stamps a trailing approval row with the current round (issue #610)", () => {
      // The trailing card belongs to the round whose gate holds the turn:
      // the live round grouping reads the step, so a round-2 gate wait must
      // not strand the card in round 1's block.
      const rows = mergeLiveTrace([], [approval()], 2);
      expect(rows[0]?.step).toBe(2);
      // No Thinking yet (step null): falls back to round 1, matching the
      // event handlers' own fallback.
      expect(mergeLiveTrace([], [approval()], null)[0]?.step).toBe(1);
    });

    it("merges by tool name + summary, consuming each approval once", () => {
      const a = approval();
      const rows = mergeLiveTrace(
        [
          call({ key: "call-0", name: "fetch", operationKind: "network", summary: "GET /x" }),
          call({ key: "call-1", name: "fetch", operationKind: "network", summary: "GET /x" }),
        ],
        [a, approval({ requestId: "req-2" })],
        1,
      );
      // Two calls + two approvals -> two merged rows (no trailing card).
      expect(rows.map((r) => r.key)).toEqual(["req-1", "req-2"]);
    });

    it("liveRoundsToTrace keeps completed calls, drops unsettled rows, groups by round", () => {
      const row = (over: Partial<LiveTraceRow> = {}): LiveTraceRow => ({
        key: "call-0",
        step: 1,
        name: "explore",
        server: null,
        operationKind: "read",
        summary: "SELECT 1",
        approval: null,
        running: false,
        success: false,
        resultExcerpt: "boom",
        ...over,
      });
      const rounds: LiveRound[] = [
        { rows: [row()] },
        {
          text: "先看一眼数据。",
          rows: [
            // gate-cancelled: no backend trace entry
            row({ key: "req-1", step: 2, name: "fetch", server: "acme", operationKind: "network", summary: "GET /x", approval: { requestId: "req-1", response: "deny" }, success: null }),
            row({ key: "call-2", step: 2, name: "materialize", operationKind: "write", summary: "SELECT 1", success: true, resultExcerpt: "" }),
          ],
        },
      ];
      // Round 2 emitted prose (the RoundText event); round 1 emitted none.
      expect(liveRoundsToTrace(rounds)).toEqual([
        {
          calls: [
            {
              name: "explore",
              operation_kind: "read",
              summary: "SELECT 1",
              success: false,
              result_excerpt: "boom",
            },
          ],
        },
        {
          text: "先看一眼数据。",
          calls: [
            {
              name: "materialize",
              operation_kind: "write",
              summary: "SELECT 1",
              success: true,
              result_excerpt: "",
            },
          ],
        },
      ]);
    });

    it("liveRoundsToTrace keeps a prose-only round (a cancel mid-batch)", () => {
      // A round that emitted prose but completed no calls still records as a
      // round carrying the text -- matching the backend, which opens the
      // round when the tool-call reply arrives, not when a call completes.
      expect(liveRoundsToTrace([{ text: "先看一眼数据。", rows: [] }])).toEqual([
        { text: "先看一眼数据。", calls: [] },
      ]);
    });

    it("buildLiveRounds turns padded null slots into absent members (a round that emitted none)", () => {
      // withRoundSlot pads skipped rounds with null (round 1 emitted nothing
      // when round 2's event lands first); the derivation converts the
      // padding to absent members -- round 1's round carries neither prose
      // nor thinking, not null placeholders.
      const rounds = buildLiveRounds(
        { step: 2, calls: [], roundTexts: [null, "第二轮散文。"], roundThinkings: [null, null] },
        [],
      );
      expect(rounds).toHaveLength(2);
      expect(rounds[0]?.text).toBeUndefined();
      expect(rounds[0]?.thinking).toBeUndefined();
      expect(rounds[0]?.rows).toEqual([]);
      expect(rounds[1]?.text).toBe("第二轮散文。");
    });

    it("liveRoundsToTrace attaches per-round thinking to its round (issue #610)", () => {
      // The live thinking fold survives the settle swap: the round's thinking
      // block lands on the optimistic record's round, not dropped at fold
      // time. Rounds without thinking stay thinking-free (honest degrade).
      const thinking = { duration_ms: 900, text: "reasoning" };
      const trace = liveRoundsToTrace([
        { text: "先看一眼数据。", rows: [] },
        { thinking, rows: [] },
      ]);
      expect(trace).toEqual([
        { text: "先看一眼数据。", calls: [] },
        { thinking: { duration_ms: 900, text: "reasoning" }, calls: [] },
      ]);
      // Identity, not just structure (issue #620): the settle seed keys on
      // the thinking block's REFERENCE, so the projection must carry the
      // same object -- a structurally-equal clone would break the seed while
      // this toEqual above stays green.
      expect(trace[1]?.thinking).toBe(thinking);
    });

    it("buildLiveRounds spans rows leading the slot arrays; the projection preserves the round order (issue #620)", () => {
      // A call can land in round 3 while only round 1 emitted prose (the
      // slot arrays lag the dispatch stream): the single derivation spans by
      // step, and the settle projection walks the rounds in order -- the
      // settled trace reads the same round sequence the exchange rendered,
      // with the empty middle round dropped and no arrival-order artifacts.
      const rounds = buildLiveRounds(
        // The grouping inputs only (the derivation's Pick): no question /
        // askedAt -- the turn identity is not the derivation's concern.
        {
          step: 3,
          calls: [
            call({
              key: "call-2",
              step: 3,
              name: "materialize",
              operationKind: "write",
              summary: "SELECT 3",
            }),
          ],
          roundTexts: ["先看一眼数据。"],
          roundThinkings: [],
        },
        [],
      );
      expect(rounds.map((r) => [r.text, r.rows.map((row) => row.key)])).toEqual([
        ["先看一眼数据。", []],
        [undefined, []],
        [undefined, ["call-2"]],
      ]);
      expect(liveRoundsToTrace(rounds)).toEqual([
        { text: "先看一眼数据。", calls: [] },
        {
          calls: [
            {
              name: "materialize",
              operation_kind: "write",
              summary: "SELECT 3",
              success: true,
              result_excerpt: "",
            },
          ],
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
