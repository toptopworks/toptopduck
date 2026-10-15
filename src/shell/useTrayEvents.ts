// System tray event wiring (issue #1140, ADR-0125). Bridges the backend's
// two tray events to the shell's existing session actions -- the
// sidebar-parity rule (ADR-0125 Decision 5) means the tray NEVER introduces
// its own session semantics: an open-session click is exactly a sidebar
// click on the same entry (openPersisted's own open-or-activate branch is
// the idempotency -- an already-open session is switched to, never
// re-resumed), and a new-session click is exactly the sidebar "+"
// (ADR-0092 empty-state navigation). The window reveal itself is handled
// on the Rust side at click time, so this hook carries only the
// session-level consequence.
//
// The tray-ready handshake (issue #1142): a click before the listeners
// register is buffered on the Rust side, so once BOTH subscriptions
// resolve the hook fires tray_ready to release the replay. Gated by a ref
// (not the deps array): a re-subscription is not a page load -- the
// backend stayed ready -- so the handshake fires once per page load
// (cold start + each webview reload, which resets the ref with the whole
// page).
import { useEffect, useRef } from "react";
import { log } from "../lib/log";
import { onTrayNewSession, onTrayOpenSession, trayReady } from "../api";
import type { SessionMetadata } from "../types/session";

export interface UseTrayEventsDeps {
  /** From usePersistedSessions: the disk-derived list, read to resolve the
   *  open action's display name (the wire payload carries only the path). */
  sessions: SessionMetadata[];
  /** From useShellSessions: the sidebar-click resume path (openDuck under
   *  the hood). Its open-or-activate branch carries the already-open
   *  idempotency, so this hook routes every open click straight through. */
  openPersisted: (path: string, name: string) => Promise<void>;
  /** From useShellSessions: the sidebar "+" navigation (ADR-0092). */
  goToEmptyState: () => void;
}

export function useTrayEvents({
  sessions,
  openPersisted,
  goToEmptyState,
}: UseTrayEventsDeps): void {
  const handshookRef = useRef(false);
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const track = (unlisten: () => void) => {
      // A re-subscription raced the teardown: dispose immediately instead
      // of leaking the listener past unmount.
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    };
    const openPromise = onTrayOpenSession((ev) => {
      // The wire payload carries only the path; the display name comes from
      // the same persisted list the sidebar renders (same scan, same
      // field). An unknown path (deleted between menu build and click)
      // opens with the empty name and honest-degrades through the open
      // error path.
      const name =
        sessions.find((s) => s.duck_path === ev.duck_path)?.display_name ?? "";
      void openPersisted(ev.duck_path, name);
    });
    const newPromise = onTrayNewSession(() => {
      goToEmptyState();
    });
    // Both subscriptions must resolve before the handshake: replaying
    // after the first would deliver a buffered open/new into a page where
    // the other listener is still missing.
    Promise.all([openPromise, newPromise])
      .then((resolved) => {
        for (const unlisten of resolved) track(unlisten);
        if (disposed || handshookRef.current) return;
        handshookRef.current = true;
        trayReady().catch((e) => {
          // A rejected handshake leaves the backend buffering with no
          // replay for the rest of the page load; re-arm so the next
          // re-subscription retries (mark_ready is idempotent).
          handshookRef.current = false;
          log.warn("tray", "tray_ready handshake rejected", e);
        });
      })
      .catch((e) => {
        // A listener registration rejected: no handshake can fire on a
        // half-registered page. Log for parity with the handshake's own
        // catch rather than leaving the rejection unhandled.
        log.warn("tray", "tray listener registration failed", e);
      });
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
    // The deps are the closure inputs, not just the actions. openPersisted
    // re-identifies when the open set moves (its useCallback tracks
    // openSessions), and the persisted list re-identifies per refresh, so
    // the listener re-subscribes whenever the routing inputs can have
    // moved -- the same pattern as the drop-router effect in
    // useShellSessions.
  }, [sessions, openPersisted, goToEmptyState]);
}
