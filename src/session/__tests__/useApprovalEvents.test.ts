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

  it("maps file_attachments from the request event onto the entry (issue #672)", async () => {
    // The wire field is the only source of the pending card's expand-on-
    // demand snapshot; a rename or a dropped mapping line would silently
    // kill the feature (`?? []` downstream swallows undefined).
    const { result } = renderHook(() => useApprovalEvents());
    await waitFor(() => expect(approvalCbs.request).not.toBeNull());
    act(() =>
      approvalCbs.request!(
        requestEvent({
          file_attachments: [{ param: "code", content: "print(1)" }],
        }),
      ),
    );
    expect(result.current.approvalsBySession.get(SID)?.[0].fileAttachments).toEqual([
      { param: "code", content: "print(1)" },
    ]);
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

  it("respond rolls the optimistic flip back to pending when the command rejects (re-suspends the card)", async () => {
    // TraceView hides the action buttons once a card flips to resolved, so a
    // reject that leaves no approval-resolved event (an IPC-level failure)
    // would strand the card. The roll-back re-suspends it so the buttons
    // re-render; a later resolved event re-flips idempotently.
    vi.mocked(respondToolApproval).mockRejectedValueOnce(new Error("ipc gone"));
    const { result } = renderHook(() => useApprovalEvents());
    await waitFor(() => expect(approvalCbs.request).not.toBeNull());
    act(() => approvalCbs.request!(requestEvent()));
    act(() => result.current.respond(SID, "req-1", "deny"));
    // The optimistic flip lands first (resolved), then the reject rolls it back.
    await waitFor(() =>
      expect(result.current.approvalsBySession.get(SID)?.[0].status).toEqual({
        kind: "pending",
      }),
    );
    // The pending card re-enters the coloring set.
    expect(result.current.pendingApprovalSids.has(SID)).toBe(true);
  });

  it("respond leaves a concurrent reconciliation alone (a different response already landed)", async () => {
    // If the approval-resolved event reconciled to a DIFFERENT response between
    // the optimistic flip and the reject, the roll-back guard (`stillOurs`)
    // leaves it -- the gateway's answer is authoritative.
    vi.mocked(respondToolApproval).mockRejectedValueOnce(new Error("ipc gone"));
    const { result } = renderHook(() => useApprovalEvents());
    await waitFor(() => expect(approvalCbs.request).not.toBeNull());
    act(() => approvalCbs.request!(requestEvent()));
    act(() => result.current.respond(SID, "req-1", "allow_once"));
    // The gateway resolves to deny (a different response) before the reject lands.
    act(() =>
      approvalCbs.resolved!({ session_id: SID, request_id: "req-1", response: "deny" }),
    );
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
