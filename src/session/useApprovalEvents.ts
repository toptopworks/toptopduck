import { useCallback, useEffect, useMemo, useState } from "react";
import { onApprovalRequest, onApprovalResolved, respondToolApproval } from "../api";
import type { ApprovalResponse, FileAttachment, OperationKind } from "../types/approval";
import { log } from "../lib/log";

// App-level ownership of the tiered-approval side channel (ADR-0083, issue
// #297). ONE long-lived listener pair (approval-request + approval-resolved,
// mounted once at the shell root -- the ADR-0059 C-4 pattern the per-pane
// turn-progress listener uses) feeds a per-session entry map that TWO
// consumers read: the SessionPane of the suspended turn (the in-flow approval
// card inside the live trace) and the SessionSidebar (the unanswered-entry
// coloring, ADR-0083 "unanswered badge coloring carries forced visibility").
// The sidebar needs the CROSS-SESSION view, which is exactly the case the
// per-pane listener cannot serve -- so unlike turn-progress (pane-local by
// ADR-0059) the approval channel lives at the root and each pane receives its
// own session's slice.
//
// Entries are transient UI state (ADR-0051 client-side): the gateway is the
// authority, the cards are its projection. A turn settling folds its resolved
// cards into the optimistic thread record and clears them (the persisted trace
// carries the executed calls; the cards were the in-flight moment).

/** One approval card's lifecycle as the rail renders it (ADR-0083): pending
 *  (three live buttons) until the user answers or a cancel/close resolves it,
 *  then resolved in place (the response badge) until the turn settles. */
export interface ApprovalEntry {
  requestId: string;
  server: string;
  tool: string;
  operationKind: OperationKind;
  summary: string;
  /** File-delivery values for the card's expand-on-demand view (issue #672):
   * the approval-time snapshot of each file-delivered parameter. undefined
   * for calls without them (the backend omits the field). */
  fileAttachments?: FileAttachment[];
  status: { kind: "pending" } | { kind: "resolved"; response: ApprovalResponse };
}

export interface UseApprovalEvents {
  /** Approval entries keyed by the runtime session id the events carry
   *  (ADR-0056 addressing). Each pane reads its own slice; the sidebar reads
   *  the key set. Insertion order is arrival order (the rail renders cards in
   *  the order the gateway raised them). */
  approvalsBySession: ReadonlyMap<string, ApprovalEntry[]>;
  /** The subset of session ids with one or more PENDING approvals -- the
   *  sidebar coloring + collapsed-rail badge discriminant. Derived, never
   *  stored (single source of truth stays the entry map). */
  pendingApprovalSids: ReadonlySet<string>;
  /** Answer a pending request (the card's three buttons). Flips the entry
   *  optimistically and fires the respond command; reconciliation rides the
   *  approval-resolved event, not this promise. A reject rolls the optimistic
   *  flip back to pending so the card re-suspends (an IPC-level failure leaves
   *  no resolved event and TraceView hides the buttons once resolved); a later
   *  resolved event re-flips idempotently, cf. api.ts respondToolApproval. */
  respond: (sessionId: string, requestId: string, response: ApprovalResponse) => void;
  /** Drop every entry for a session: called when its turn settles (the
   *  resolved cards fold into the optimistic thread record) and when the
   *  session closes (its cards can never be answered). */
  clearSession: (sessionId: string) => void;
}

export function useApprovalEvents(): UseApprovalEvents {
  const [approvalsBySession, setApprovalsBySession] = useState<
    ReadonlyMap<string, ApprovalEntry[]>
  >(() => new Map());

  // ADR-0059 C-4 long-lived listeners: mount listen once, unmount unlisten.
  // The global broadcast is filtered per event by its addressing session_id
  // (ADR-0056) into the map. Orphan events post-unmount have no listener and
  // are harmlessly dropped; a pending card the unmount strands belongs to a
  // turn the teardown cancels anyway (the gateway resolves it to deny).
  useEffect(() => {
    let active = true;
    const unlistens: Array<() => void> = [];
    void onApprovalRequest((ev) => {
      if (!active) return;
      setApprovalsBySession((prev) => {
        const entry: ApprovalEntry = {
          requestId: ev.request_id,
          server: ev.server,
          tool: ev.tool,
          operationKind: ev.operation_kind,
          summary: ev.summary,
          fileAttachments: ev.file_attachments,
          status: { kind: "pending" },
        };
        const existing = prev.get(ev.session_id) ?? [];
        // De-dupe by requestId: a re-emitted request (emit retry) must not
        // double the card. The fresh payload wins (same fields in practice).
        const next = existing.filter((e) => e.requestId !== ev.request_id);
        const updated = new Map(prev);
        updated.set(ev.session_id, [...next, entry]);
        return updated;
      });
    }).then((un) => {
      if (!active) {
        un();
        return;
      }
      unlistens.push(un);
    });
    void onApprovalResolved((ev) => {
      if (!active) return;
      setApprovalsBySession((prev) => {
        const existing = prev.get(ev.session_id);
        // A resolved event for an unknown request (a request event lost to a
        // listener-less window, or a stray id) has no card to flip -- the
        // gateway's own state already advanced, so dropping the UI event is
        // the honest no-op.
        if (!existing?.some((e) => e.requestId === ev.request_id)) return prev;
        const updated = new Map(prev);
        updated.set(
          ev.session_id,
          existing.map((e) =>
            e.requestId === ev.request_id
              ? { ...e, status: { kind: "resolved", response: ev.response } }
              : e,
          ),
        );
        return updated;
      });
    }).then((un) => {
      if (!active) {
        un();
        return;
      }
      unlistens.push(un);
    });
    return () => {
      active = false;
      unlistens.forEach((un) => un());
    };
  }, []);

  const pendingApprovalSids = useMemo(() => {
    const sids = new Set<string>();
    for (const [sid, entries] of approvalsBySession) {
      if (entries.some((e) => e.status.kind === "pending")) sids.add(sid);
    }
    return sids;
  }, [approvalsBySession]);

  const respond = useCallback(
    (sessionId: string, requestId: string, response: ApprovalResponse) => {
      // Optimistic flip: the button response is immediate; the
      // approval-resolved event confirms it as a no-op re-flip (same value).
      setApprovalsBySession((prev) => {
        const existing = prev.get(sessionId);
        if (!existing?.some((e) => e.requestId === requestId)) return prev;
        const updated = new Map(prev);
        updated.set(
          sessionId,
          existing.map((e) =>
            e.requestId === requestId
              ? { ...e, status: { kind: "resolved", response } }
              : e,
          ),
        );
        return updated;
      });
      // Fire-and-forget by contract (api.ts): reconciliation rides the
      // approval-resolved event, not this promise. BUT a reject that leaves no
      // resolved event (an IPC-level failure -- command panic, serialization,
      // a torn-down webview -- where the gateway never heard the answer) would
      // strand the card on its optimistic resolved state, and TraceView hides
      // the buttons once resolved, so the user could not re-answer. Roll the
      // optimistic flip back to pending in that case so the card re-suspends
      // and the buttons re-render; a later resolved event (the gateway DID
      // hear it) re-flips idempotently. The `stillOurs` guard leaves a
      // concurrent reconciliation (a different response already landed) alone.
      void respondToolApproval(sessionId, requestId, response).catch((err) => {
        log.warn(
          "approval",
          "respond command rejected; rolling the optimistic flip back to pending",
          { sessionId, requestId, err },
        );
        setApprovalsBySession((prev) => {
          const existing = prev.get(sessionId);
          if (!existing) return prev;
          const stillOurs = existing.some(
            (e) =>
              e.requestId === requestId &&
              e.status.kind === "resolved" &&
              e.status.response === response,
          );
          if (!stillOurs) return prev;
          const updated = new Map(prev);
          updated.set(
            sessionId,
            existing.map((e) =>
              e.requestId === requestId ? { ...e, status: { kind: "pending" } } : e,
            ),
          );
          return updated;
        });
      });
    },
    [],
  );

  const clearSession = useCallback((sessionId: string) => {
    setApprovalsBySession((prev) => {
      if (!prev.has(sessionId)) return prev;
      const updated = new Map(prev);
      updated.delete(sessionId);
      return updated;
    });
  }, []);

  return { approvalsBySession, pendingApprovalSids, respond, clearSession };
}
