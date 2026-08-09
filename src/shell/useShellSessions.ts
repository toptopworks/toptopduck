// Runtime open-session state (issue #195). Owns the in-memory OPEN session set
// + active id (ADR-0060 multi-session) + every action that mutates them:
// register / openNew / openPersisted / dropFile / onWebviewDrop /
// clearPendingIngest / activateSession / closeOpen / deletePersisted / renameEntry /
// handleOpenDuck. The resume + persistence-busy indicators live
// here too -- they drive the shell `busy` flag that gates the webview drop
// listener + the sidebar / topbar / hero disabled states.
//
// ADR-0068: this is advisory state held in React (NOT TanStack Query) -- the
// open set is the shell's in-memory bookkeeping, and resumeStatus /
// persistenceBusy are UI gates. The queryClient passed in is the SEAM to the
// session-level Query cache (ADR-0051/0055): unmountOpen drops a session's
// cache slice (ADR-0058 retry / ADR-0055 close / ADR-0063 delete), and
// openPersisted invalidates after a resume replay.
//
// Single webview-level drop router (#81): Tauri's onDragDropEvent is a
// window-level signal with no hit-test, so exactly one listener (here, in the
// shell) routes each drop -- cold start mints a new session, otherwise the file
// lands on the ACTIVE session's ingest via the pendingIngestPath pipe (#81 A1).
// This replaces the per-SessionPane FileDropzone listeners, which stacked 1:1
// with keep-alive panes and fired N ingests per single drop.
import { useCallback, useEffect, useRef, useState } from "react";
import type { IntlShape } from "react-intl";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { QueryClient } from "@tanstack/react-query";
import {
  closeSession,
  closeSessionAndWaitRelease,
  createSession,
  deleteSession,
  getSessionName,
  onResumeProgress,
  openDuck,
  renamePersistedSession,
  renameSession,
} from "../api";
import { errorDetail, fmtError, toAppError } from "../lib/error-presentation";
import { log } from "../lib/log";
import type { AppError } from "../types/error";
import type { OpenSession } from "../session/sidebarModel";

/** Resume / open-busy status (ADR-0034). A structured discriminated union, not
 *  a pre-baked string: App sits above <IntlProvider> and cannot format messages
 *  itself, so the ResumeProgress child (inside the provider) renders the union
 *  into the active locale. Produced by openPersisted (Source / Replay events
 *  from onResumeProgress) and consumed by ResumeProgress in App.tsx.
 *
 *  `idle` is the first-class resting state (issue #205): it replaces the old
 *  `| null` escape hatch so `busy` and every consumer discriminate via `kind`
 *  inside the ADT instead of truthiness-coercing a nullable. openPersisted
 *  leaves `idle` on both its success and reject tails. */
export type ResumeStatus =
  | { kind: "idle" }
  | { kind: "opening" }
  | { kind: "source"; index: number; total: number; name: string }
  | { kind: "replay"; index: number; total: number; name: string };

export interface UseShellSessionsDeps {
  intl: IntlShape;
  queryClient: QueryClient;
  /** From usePersistedSessions: bumps sessionsEpoch to re-fetch list_sessions
   *  after a save / delete / rename lands on disk. */
  refreshSessions: () => void;
  /** From useShellError: surfaces a shell-layer AppError (kind "shell") for a
   *  createSession / openDuck / save / delete / rename reject. */
  setShellError: (error: AppError | null) => void;
}

/** Merged open-set state (issue #205): the session list + the active id move as
 *  one value so the invariant `activeId !== null => activeId ∈ sessions` is
 *  enforced at a single transition chokepoint (see `apply` in the hook) instead
 *  of re-derived across two independent useStates. */
type SessionsState = {
  sessions: OpenSession[];
  activeId: string | null;
};

export function useShellSessions({
  intl,
  queryClient,
  refreshSessions,
  setShellError,
}: UseShellSessionsDeps): {
  openSessions: OpenSession[];
  activeSessionId: string | null;
  activateSession: (sid: string) => void;
  /** Shell-wide busy gate: persistenceBusy (save / open / delete wait) OR a
   *  resume in flight. Drives the sidebar / topbar / hero disabled states and
   *  suspends the webview drop listener while busy. */
  busy: boolean;
  resumeStatus: ResumeStatus;
  openNew: () => Promise<void>;
  openPersisted: (path: string, name: string) => Promise<void>;
  dropFile: (path: string) => Promise<void>;
  onWebviewDrop: (path: string) => void;
  clearPendingIngest: (sid: string) => void;
  closeOpen: (sid: string) => Promise<void>;
  deletePersisted: (path: string, sid: string | null) => Promise<void>;
  renameEntry: (sid: string | null, path: string, newName: string) => Promise<void>;
  handleOpenDuck: () => Promise<void>;
  /** Sync an open session's display name after the backend auto-names it
   *  (ADR-0089 Decision 4: first terminal turn). Reads the live name from the
   *  backend, updates the in-memory open-session entry, and refreshes the
   *  sidebar so the persisted list matches. */
  syncSessionName: (sid: string) => Promise<void>;
} {
  // The open set + active id live in ONE state object (issue #205) so the
  // invariant "activeId !== null => activeId ∈ sessions" is enforced at a
  // single transition chokepoint (apply) instead of re-derived across two
  // separate useStates. sessions: every session with a live in-memory
  // instance, each rendered as a keep-alive SessionPane. activeId: the visible
  // one (null = cold hero). A close drops the entry + removeQueries its cache
  // (ADR-0055).
  const [state, setState] = useState<SessionsState>({
    sessions: [],
    activeId: null,
  });
  // Resume / open-busy indicator (ADR-0034). `idle` is the resting state
  // (issue #205); Resume blocks the open action + the indicator shows globally
  // while the clicked session is opening.
  const [resumeStatus, setResumeStatus] = useState<ResumeStatus>({
    kind: "idle",
  });
  const [persistenceBusy, setPersistenceBusy] = useState(false);

  const busy = persistenceBusy || resumeStatus.kind !== "idle";

  // Single pure transition into the merged open-set state (issue #205). Each
  // caller hands back the intended next { sessions, activeId }; apply() then
  // RECONCILES activeId against the resulting sessions so the invariant
  // (activeId !== null => activeId ∈ sessions) can never be broken -- a
  // transition that drops the active session without naming a successor falls
  // back to the first remaining entry, then null. This replaces unmountOpen's
  // old closure-write of `next` plus a separate setActiveId setter: nesting a
  // setter inside another's updater violates React's purity contract (updaters
  // may double-fire in StrictMode / concurrent mode), so both fields move as
  // one pure function of `prev`.
  const apply = useCallback(
    (transform: (prev: SessionsState) => SessionsState): void => {
      setState((prev) => {
        const next = transform(prev);
        const activeId =
          next.activeId !== null &&
          next.sessions.some((s) => s.sid === next.activeId)
            ? next.activeId
            : (next.sessions[0]?.sid ?? null);
        return { sessions: next.sessions, activeId };
      });
    },
    [],
  );

  // Pure list / field update that never touches activeId (issue #205). For
  // transitions that only mutate a session entry (rename / clear-pending /
  // save-as bind / drop-onto-active), the active id is unaffected, so there is
  // nothing to reconcile. Routing these through `apply` would redundantly
  // re-validate activeId and force each caller to echo `activeId: prev.activeId`
  // boilerplate. mapSessions takes only the sessions array and preserves
  // activeId verbatim, so reconciliation stays exclusive to the add / remove /
  // activate paths that can actually invalidate activeId.
  const mapSessions = useCallback(
    (fn: (prev: OpenSession[]) => OpenSession[]): void => {
      setState((prev) => ({ sessions: fn(prev.sessions), activeId: prev.activeId }));
    },
    [],
  );

  const openSessions = state.sessions;
  const activeSessionId = state.activeId;

  // Switch the active session by id (sidebar click). Semantic action -- there
  // is no standalone activeId setter: the merged open-set state moves only
  // through `apply`, and registerOpen / openPersisted / unmountOpen adjust the
  // active id as a side effect of their own transition. THIS is the only
  // public way to flip the active id standalone. The hook contract narrows the
  // arg to a non-null string so an outside caller cannot null-out the active
  // id from outside the open/close lifecycle; `apply` reconciles, so a stale
  // sid (not in sessions) falls back to the first entry rather than dangling.
  const activateSession = useCallback(
    (sid: string): void => {
      // A stale sid (not in sessions -- a sidebar click racing a close) is a
      // no-op: keep the current active id rather than silently jumping to the
      // first session, so a failed switch never activates a session the user
      // did not click (issue #205). `apply` still guarantees activeId ∈
      // sessions on the valid-sid path.
      apply((prev) =>
        prev.sessions.some((s) => s.sid === sid)
          ? { sessions: prev.sessions, activeId: sid }
          : prev,
      );
    },
    [apply],
  );

  /** Add a freshly-minted session to the open set and activate it. The caller
   *  hands the createSession result + an optional bound path/name (resume). */
  const registerOpen = useCallback(
    (entry: OpenSession) => {
      apply((prev) =>
        prev.sessions.some((s) => s.sid === entry.sid)
          ? { sessions: prev.sessions, activeId: entry.sid }
          : { sessions: [...prev.sessions, entry], activeId: entry.sid },
      );
    },
    [apply],
  );

  // "+ New session" (ADR-0061/0089): mint a session — the backend creates +
  // persists immediately, returning both the runtime id and the bound .duck
  // path. name starts empty; the display layer renders a localized "New
  // session" placeholder until the first turn auto-names or the user renames.
  const openNew = useCallback(async () => {
    try {
      const { session_id: sid, duck_path: path } = await createSession();
      registerOpen({ sid, name: "", path, pendingIngestPath: null });
      refreshSessions();
    } catch (e) {
      setShellError(toAppError(e, intl, "shell"));
    }
  }, [intl, registerOpen, refreshSessions, setShellError]);

  // Drop-to-create on the cold-start hero (ADR-0061/0089, #81 A1): mint a
  // persisted session and hand the dropped path to the new SessionPane as
  // pendingIngestPath. The pane consumes it via handleIngest (the only path
  // that can surface an xlsx NeedsGuidance dialog); the shell never ingests
  // directly. droppingRef guards a second drop landing while the first
  // createSession is still in flight.
  const droppingRef = useRef(false);
  const dropFile = useCallback(
    async (path: string) => {
      if (droppingRef.current) return;
      droppingRef.current = true;
      try {
        const { session_id: sid, duck_path: duckPath } = await createSession();
        registerOpen({ sid, name: "", path: duckPath, pendingIngestPath: path });
        refreshSessions();
      } catch (e) {
        setShellError(toAppError(e, intl, "shell"));
      } finally {
        droppingRef.current = false;
      }
    },
    [intl, registerOpen, refreshSessions, setShellError],
  );

  // Single webview-level drop router (#81): Tauri's onDragDropEvent is a
  // window-level signal with no hit-test, so exactly one listener (here) routes
  // each drop -- cold start mints a new session, otherwise the file lands on
  // the ACTIVE session's ingest via the pendingIngestPath pipe (#81 A1).
  const onWebviewDrop = useCallback(
    (path: string) => {
      if (activeSessionId === null) {
        void dropFile(path);
        return;
      }
      // Route onto the active session's ingest. The guard above and this body
      // both key off the same closure activeSessionId -- a single source of
      // truth for "which session is active right now". If a close races the drop
      // and the target sid is no longer in the set, the map matches nothing and
      // the drop is a no-op rather than landing on a different session
      // (issue #205).
      mapSessions((sessions) =>
        sessions.map((o) =>
          o.sid === activeSessionId ? { ...o, pendingIngestPath: path } : o,
        ),
      );
    },
    [activeSessionId, mapSessions, dropFile],
  );
  useEffect(() => {
    if (busy) return;
    const app = getCurrentWebviewWindow();
    const unlisten = app.onDragDropEvent((event) => {
      if (event.payload.type === "drop" && event.payload.paths.length > 0) {
        onWebviewDrop(event.payload.paths[0]);
      }
    });
    return () => {
      void unlisten.then((u) => u());
    };
  }, [busy, onWebviewDrop]);

  // Clear a consumed drop-on-cold-start path (#81 A1): once the SessionPane has
  // kicked off ingest, OpenSession.pendingIngestPath is dropped so a remount
  // cannot re-ingest.
  const clearPendingIngest = useCallback(
    (sid: string) => {
      mapSessions((sessions) =>
        sessions.map((o) => (o.sid === sid ? { ...o, pendingIngestPath: null } : o)),
      );
    },
    [mapSessions],
  );

  // Resume a persisted .duck into a fresh runtime instance (ADR-0061/0034).
  // open_duck reuses the id (ADR-0056), so createSession mints it first, then
  // openDuck loads the recipe + replays the chain into that id. If the same
  // path is already open, just switch to it (no second instance, keep-alive).
  const openPersisted = useCallback(
    async (path: string, name: string) => {
      const existing = openSessions.find((s) => s.path === path);
      if (existing) {
        apply((prev) => ({ sessions: prev.sessions, activeId: existing.sid }));
        return;
      }
      setResumeStatus({ kind: "opening" });
      // ADR-0056 / issue #76: resume-progress is a global Tauri broadcast keyed
      // by session_id. The listener registers BEFORE createSession mints the id,
      // so targetSid starts null and is assigned the instant the id lands; every
      // event is then filtered to the session THIS resume opened. An event for a
      // different session (a concurrent resume path, or a stray broadcast) is
      // dropped before it can move our status indicator. #83 R5: this filter is
      // the multi-session seam -- without it a sibling resume's Source/Replay
      // ticks would hijack this opener's progress strip.
      let targetSid: string | null = null;
      const unlisten = await onResumeProgress((ev) => {
        // Defensive try/catch: this callback runs on the Tauri event loop's
        // microtask, so a throw escapes PAST openPersisted's outer try/catch --
        // it surfaces as an unhandled rejection, busy sticks true (soft-lock),
        // and the listener leaks. Log and bail; the outer flow still clears
        // resumeStatus when openDuck resolves/rejects. #83 R5: the targetSid
        // filter below is the multi-session isolation seam and is unchanged
        // (issue #203).
        try {
          if (ev.session_id !== targetSid) return;
          const { event } = ev;
          if ("Source" in event) {
            setResumeStatus({
              kind: "source",
              index: event.Source.index,
              total: event.Source.total,
              name: event.Source.reference_name,
            });
          } else if ("Replay" in event) {
            setResumeStatus({
              kind: "replay",
              index: event.Replay.index,
              total: event.Replay.total,
              name: event.Replay.reference_name,
            });
          }
        } catch (e) {
          log.error("onResumeProgress", "listener threw", fmtError(e, intl));
        }
      });
      try {
        const { session_id: sid } = await createSession();
        targetSid = sid;
        await openDuck(sid, path);
        await queryClient.invalidateQueries({ queryKey: ["session", sid] });
        registerOpen({ sid, name, path, pendingIngestPath: null });
        setResumeStatus({ kind: "idle" });
      } catch (e) {
        // C2: if createSession succeeded but openDuck failed, the just-minted
        // session is persisted on disk (ADR-0089 auto-persist). Close it
        // best-effort so it does not linger as a ghost empty row in the
        // sidebar scan. The close IPC itself may fail (the session may have
        // been partially created); suppress that — the error toast is already
        // surfaced via setShellError.
        if (targetSid) {
          void closeSession(targetSid).catch(() => {});
          refreshSessions();
        }
        setShellError(toAppError(e, intl, "shell"));
        setResumeStatus({ kind: "idle" });
      } finally {
        void unlisten();
      }
    },
    [intl, openSessions, apply, queryClient, registerOpen, setShellError, refreshSessions],
  );

  // Synchronous UI teardown for an open session: drop the cache + open-set
  // entry + active id. Shared by closeOpen (ADR-0055, runs BEFORE the
  // background close fires) and deletePersisted (ADR-0063, runs AFTER the
  // wait-release variant resolves). Issue #205: the session filter + the
  // active-id fallback are now ONE pure transition through `apply` -- the old
  // shape read `next` out of an updater closure and ran a second setState for
  // the active id, nesting a setter inside another's updater (a React purity
  // violation: updaters may double-fire in StrictMode / concurrent mode).
  // Setting activeId to null when the removed sid was active lets `apply`'s
  // reconciler pick the first remaining entry (then null), matching the old
  // next[0]?.sid ?? null fallback.
  const unmountOpen = useCallback(
    (sid: string): void => {
      queryClient.removeQueries({ queryKey: ["session", sid] });
      apply((prev) => {
        const sessions = prev.sessions.filter((s) => s.sid !== sid);
        const activeId = prev.activeId === sid ? null : prev.activeId;
        return { sessions, activeId };
      });
    },
    [queryClient, apply],
  );

  // Close an open session (ADR-0055/0060). The user's view must disappear with
  // ZERO wait even when a turn is in-flight: unmount the pane SYNCHRONOUSLY,
  // THEN fire closeSession in the background. closeSession (cancel + mark
  // closing + drop the handle) returns immediately on the backend too -- it
  // does NOT wait for an in-flight ask; the ask's post-turn check sees closing
  // and discards (no thread append, no recipe entry). The orphan ask promise
  // resolves against an absent cache (TanStack setQueryData on a removed key
  // is a no-op) and the turn-progress listener cleanup runs in the pane's
  // unmount effect. The .duck stays on disk and remains in the sidebar
  // (re-openable). NOT delete -- the delete path uses the wait-release variant
  // (see deletePersisted), not this fire-and-forget close.
  const closeOpen = useCallback(
    (sid: string): Promise<void> => {
      unmountOpen(sid);
      // ADR-0055: the UI is already gone; cancel + mark closing only reaches
      // backend bookkeeping. The promise is RETURNED, not awaited here --
      // fire-cancel-don't-wait. Best-effort: NotFound is the expected idempotent
      // path (already dropped); other failures log to devtools so IPC/panic
      // stay observable. NOT a user toast -- pane is gone.
      return closeSession(sid).catch((e: unknown) => {
        // ADR-0055: the UI is already gone, so neither branch is a user toast.
        // Split by SessionError kind. NotFound is the expected idempotent path
        // (the session already dropped -- a double-close, or a close racing a
        // delete's wait-release); debug-level only. Everything else -- panic,
        // lock poison, IPC contract break, canonical single-writer leak -- is a
        // real failure that log.error keeps observable in devtools, so the cause
        // of a later deletePersisted try_acquire gate miss stays diagnosable. The
        // raw kind is logged so a non-SessionError panic (kind "unknown") is
        // distinguishable from a typed SessionError::Engine (issue #203).
        if (
          typeof e === "object" &&
          e !== null &&
          "kind" in e &&
          e.kind === "NotFound"
        ) {
          log.debug("closeSession", "background close: session already gone", sid);
          return;
        }
        const kind =
          typeof e === "object" && e !== null && "kind" in e
            ? String(e.kind)
            : "unknown";
        log.error(
          "closeSession",
          "background close failed",
          sid,
          kind,
          fmtError(e, intl),
          errorDetail(e),
        );
      });
    },
    [intl, unmountOpen],
  );

  // Delete a persisted .duck (ADR-0060/0063, irreversible). If the session is
  // open, close it via the WAIT-RELEASE variant: the UI pane STAYS mounted
  // during the wait (delete is an explicit user intent -- it does NOT get
  // close's zero-wait contract, ADR-0063 Decision 2), and only unmounts after
  // the canonical single-writer key is released. This guarantees deleteSession's
  // try_acquire gate sees the key free (no misleading "请先关闭" on an entry the
  // user is already deleting). On wait timeout the entry survives so the user
  // can retry. persistenceBusy gates the UI for the potentially long wait.
  const deletePersisted = useCallback(
    async (path: string, sid: string | null) => {
      setPersistenceBusy(true);
      try {
        if (sid) {
          try {
            await closeSessionAndWaitRelease(sid);
          } catch (e) {
            // Close-wait failed (timeout, or the backend already detached
            // the session). Unmount the pane so the entry falls back to the
            // cold sidebar (sid=null); a retry then takes the pure
            // deleteSession(path) path -- if the canonical key is now free
            // the gate succeeds, otherwise the user sees the real gate error.
            // Without this, the pane stays mounted on a sid the backend no
            // longer knows and every retry hits NotFound (dead loop).
            unmountOpen(sid);
            setShellError(toAppError(e, intl, "shell"));
            return;
          }
          // The wait resolved -- canonical key is free, Session::Drop ran.
          // NOW unmount the pane (ADR-0063: UI teardown after the wait, not
          // before).
          unmountOpen(sid);
        }
        try {
          await deleteSession(path);
        } catch (e) {
          setShellError(toAppError(e, intl, "shell"));
          return;
        }
        refreshSessions();
      } finally {
        setPersistenceBusy(false);
      }
    },
    [intl, unmountOpen, refreshSessions, setShellError],
  );

  // Rename a sidebar entry (ADR-0060, single entry point). An OPEN session
  // renames in-memory + re-persists via its sid; a CLOSED .duck rewrites the
  // recipe header in place by path. The bound path is untouched either way.
  const renameEntry = useCallback(
    async (sid: string | null, path: string, newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed) return;
      try {
        if (sid) {
          const landed = await renameSession(sid, trimmed);
          mapSessions((sessions) =>
            sessions.map((s) => (s.sid === sid ? { ...s, name: landed } : s)),
          );
        } else {
          await renamePersistedSession(path, trimmed);
        }
      } catch (e) {
        setShellError(toAppError(e, intl, "shell"));
        return;
      }
      refreshSessions();
    },
    [intl, mapSessions, refreshSessions, setShellError],
  );

  // --- Open .duck (ADR-0034/0036/0089) ------------------------------------
  // ADR-0089: sessions auto-persist from creation. The "Save as .duck" / export
  // feature (ADR-0089 Decision 5) is deferred — it will need a non-rebinding
  // export command (saveAsDuck rebinds, which is the retired first-bind path).
  const handleOpenDuck = useCallback(async () => {
    setPersistenceBusy(true);
    try {
      const selected = await openDialog({
        filters: [{ name: "toptopduck", extensions: ["duck"] }],
        multiple: false,
      });
      const path = typeof selected === "string" ? selected : null;
      if (!path) return;
      const stem =
        path.split(/[\\/]/).pop()?.replace(/\.duck$/i, "") ?? "session";
      await openPersisted(path, stem);
      refreshSessions();
    } catch (e) {
      setShellError(toAppError(e, intl, "shell"));
    } finally {
      setPersistenceBusy(false);
    }
  }, [intl, openPersisted, refreshSessions, setShellError]);

  // ADR-0089 Decision 4: after the first terminal turn, the backend auto-names
  // the session from the first question's bounded truncation. This syncs the
  // in-memory open-session entry + the persisted sidebar list so both surfaces
  // reflect the new name without a manual refresh.
  const syncSessionName = useCallback(
    async (sid: string) => {
      try {
        const name = await getSessionName(sid);
        mapSessions((sessions) =>
          sessions.map((s) => (s.sid === sid ? { ...s, name } : s)),
        );
      } catch (e) {
        // Best-effort: a failure here means the sidebar/header keep the old
        // name until the next refresh. The session itself is unaffected.
        log.warn("syncSessionName", "failed to sync auto-named session", fmtError(e, intl));
      }
      refreshSessions();
    },
    [intl, mapSessions, refreshSessions],
  );

  return {
    openSessions,
    activeSessionId,
    activateSession,
    busy,
    resumeStatus,
    openNew,
    openPersisted,
    dropFile,
    onWebviewDrop,
    clearPendingIngest,
    closeOpen,
    deletePersisted,
    renameEntry,
    handleOpenDuck,
    syncSessionName,
  };
}
