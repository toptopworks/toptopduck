import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useApprovalEvents } from "../useApprovalEvents";
import type {
  ApprovalRequestPayload,
  ApprovalResolvedPayload,
} from "../../types/approval";

// Tests for useApprovalEvents (issue #297) -- the app-level owner of the
// approval side channel (ADR-0083): the long-lived request/resolved listeners
// feeding a per-session entry map (pending card -> resolved in place), the
// optimistic respond (fire-and-forget, reconciliation rides the resolved
// event), and the derived pending-sid set the sidebar colors from. Drives the
// hook through captured listener callbacks (jsdom has no Tauri event bus).

const approvalCbs = vi.hoisted(() => ({
  request: null as null | ((ev: ApprovalRequestPayload) => void),
  resolved: null as null | ((ev: ApprovalResolvedPayload) => void),
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    respondToolApproval: vi.fn(async () => {}),
    onApprovalRequest: vi.fn(async (cb: (ev: ApprovalRequestPayload) => void) => {
      approvalCbs.request = cb;
      return () => {};
    }),
    onApprovalResolved: vi.fn(async (cb: (ev: ApprovalResolvedPayload) => void) => {
      approvalCbs.resolved = cb;
      return () => {};
    }),
  };
});

import { respondToolApproval } from "../../api";

const SID = "sess-1";

function requestEvent(over: Partial<ApprovalRequestPayload> = {}): ApprovalRequestPayload {
  return {
    session_id: SID,
    request_id: "req-1",
    server: "acme",
    tool: "fetch",
    operation_kind: "network",
    summary: "GET /x",
    ...over,
  };
}

describe("useApprovalEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    approvalCbs.request = null;
    approvalCbs.resolved = null;
  });

  it("mounts BOTH listeners once (long-lived, ADR-0059 C-4 pattern)", async () => {
    renderHook(() => useApprovalEvents());
    await waitFor(() => {
      expect(approvalCbs.request).not.toBeNull();
      expect(approvalCbs.resolved).not.toBeNull();
    });
  });

  it("appends a PENDING entry per approval-request event", async () => {
    const { result } = renderHook(() => useApprovalEvents());
    await waitFor(() => expect(approvalCbs.request).not.toBeNull());
    act(() => approvalCbs.request!(requestEvent()));
    const entries = result.current.approvalsBySession.get(SID);
    expect(entries).toEqual([
      {
        requestId: "req-1",
        server: "acme",
        tool: "fetch",
        operationKind: "network",
        summary: "GET /x",
        status: { kind: "pending" },
      },
    ]);
    expect(result.current.pendingApprovalSids.has(SID)).toBe(true);
  });

  it("flips the matching entry to RESOLVED in place on approval-resolved", async () => {
    const { result } = renderHook(() => useApprovalEvents());
    await waitFor(() => expect(approvalCbs.request).not.toBeNull());
    act(() => approvalCbs.request!(requestEvent()));
    act(() =>
      approvalCbs.resolved!({
        session_id: SID,
        request_id: "req-1",
        response: "always_allow",
      }),
    );
    const entries = result.current.approvalsBySession.get(SID);
    expect(entries?.[0].status).toEqual({ kind: "resolved", response: "always_allow" });
    // No pending left -> the sid drops out of the coloring set.
    expect(result.current.pendingApprovalSids.has(SID)).toBe(false);
  });

  it("ignores a resolved event for an unknown request (no card to flip)", async () => {
    const { result } = renderHook(() => useApprovalEvents());
    await waitFor(() => expect(approvalCbs.resolved).not.toBeNull());
    const before = result.current.approvalsBySession;
    act(() =>
      approvalCbs.resolved!({ session_id: SID, request_id: "ghost", response: "deny" }),
    );
    expect(result.current.approvalsBySession).toBe(before); // unchanged ref
  });

  it("keeps multiple pendings across sessions apart (multi-session shell)", async () => {
    const { result } = renderHook(() => useApprovalEvents());
    await waitFor(() => expect(approvalCbs.request).not.toBeNull());
    act(() => approvalCbs.request!(requestEvent({ session_id: "sess-1", request_id: "r1" })));
    act(() => approvalCbs.request!(requestEvent({ session_id: "sess-2", request_id: "r2" })));
    expect(result.current.approvalsBySession.get("sess-1")).toHaveLength(1);
    expect(result.current.approvalsBySession.get("sess-2")).toHaveLength(1);
    expect([...result.current.pendingApprovalSids].sort()).toEqual(["sess-1", "sess-2"]);
  });

  it("respond flips optimistically and fires the respond command", async () => {
    const { result } = renderHook(() => useApprovalEvents());
    await waitFor(() => expect(approvalCbs.request).not.toBeNull());
    act(() => approvalCbs.request!(requestEvent()));
    act(() => result.current.respond(SID, "req-1", "allow_once"));
    expect(result.current.approvalsBySession.get(SID)?.[0].status).toEqual({
      kind: "resolved",
      response: "allow_once",
    });
    expect(respondToolApproval).toHaveBeenCalledWith(SID, "req-1", "allow_once");
  });

  it("respond keeps the optimistic flip when the command rejects (event reconciles)", async () => {
    vi.mocked(respondToolApproval).mockRejectedValueOnce(new Error("already answered"));
    const { result } = renderHook(() => useApprovalEvents());
    await waitFor(() => expect(approvalCbs.request).not.toBeNull());
    act(() => approvalCbs.request!(requestEvent()));
    act(() => result.current.respond(SID, "req-1", "deny"));
    // The rejection is swallowed by contract (api.ts): the resolved event is
    // the reconciliation channel, so the card stays flipped, not reverted.
    await waitFor(() => expect(respondToolApproval).toHaveBeenCalled());
    expect(result.current.approvalsBySession.get(SID)?.[0].status).toEqual({
      kind: "resolved",
      response: "deny",
    });
  });

  it("clearSession drops every entry for the settled session only", async () => {
    const { result } = renderHook(() => useApprovalEvents());
    await waitFor(() => expect(approvalCbs.request).not.toBeNull());
    act(() => approvalCbs.request!(requestEvent({ session_id: "sess-1", request_id: "r1" })));
    act(() => approvalCbs.request!(requestEvent({ session_id: "sess-2", request_id: "r2" })));
    act(() => result.current.clearSession("sess-1"));
    expect(result.current.approvalsBySession.has("sess-1")).toBe(false);
    expect(result.current.approvalsBySession.get("sess-2")).toHaveLength(1);
    expect([...result.current.pendingApprovalSids]).toEqual(["sess-2"]);
  });
});
