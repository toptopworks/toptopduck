// System tray event wiring (issue #1140, ADR-0125). Bridges the backend's
// two tray events to the shell's existing session actions -- the
// sidebar-parity rule (ADR-0125 Decision 5) means the tray NEVER introduces
// its own session semantics: an open-session click is exactly a sidebar
// click on the same entry, and a new-session click is exactly the sidebar
// "+" (ADR-0092 empty-state navigation). The window reveal itself is handled
// on the Rust side at click time, so this hook carries only the
// session-level consequence.
import { useEffect } from "react";
import { onTrayNewSession, onTrayOpenSession } from "../api";
import type { OpenSession } from "../session/sidebarModel";
import type { SessionMetadata } from "../types/session";

export interface UseTrayEventsDeps {
  /** From useShellSessions: the runtime OPEN set, read for the idempotent
   *  branch (an already-open session is only activated, never re-resumed). */
  openSessions: OpenSession[];
  /** From usePersistedSessions: the disk-derived list, read to resolve the
   *  open action's display name (the wire payload carries only the path). */
  sessions: SessionMetadata[];
  /** From useShellSessions: the sidebar-click activation. */
  activateSession: (sid: string) => void;
  /** From useShellSessions: the sidebar-click resume path (openDuck under
   *  the hood). */
  openPersisted: (path: string, name: string) => Promise<void>;
  /** From useShellSessions: the sidebar "+" navigation (ADR-0092). */
  goToEmptyState: () => void;
}

export function useTrayEvents({
  openSessions,
  sessions,
  activateSession,
  openPersisted,
  goToEmptyState,
}: UseTrayEventsDeps): void {
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const track = (unlisten: () => void) => {
      // A re-subscription raced the teardown: dispose immediately instead
      // of leaking the listener past unmount.
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    };
    void onTrayOpenSession((ev) => {
      // Sidebar parity, idempotent branch first: an already-open session is
      // only activated (keep-alive -- no second runtime instance, same as a
      // sidebar click on an open entry).
      const existing = openSessions.find((s) => s.path === ev.duck_path);
      if (existing) {
        activateSession(existing.sid);
        return;
      }
      // The wire payload carries only the path; the display name comes from
      // the same persisted list the sidebar renders (same scan, same
      // field). An unknown path (deleted between menu build and click)
      // opens with the empty name and honest-degrades through the open
      // error path.
      const name =
        sessions.find((s) => s.duck_path === ev.duck_path)?.display_name ?? "";
      void openPersisted(ev.duck_path, name);
    }).then(track);
    void onTrayNewSession(() => {
      goToEmptyState();
    }).then(track);
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
    // The deps are the closure inputs, not just the actions: openSessions
    // and sessions change identity exactly when their content changes, so
    // the listener re-subscribes only when the routing inputs actually
    // moved (the drop-router effect in useShellSessions uses the same
    // pattern).
  }, [openSessions, sessions, activateSession, openPersisted, goToEmptyState]);
}
