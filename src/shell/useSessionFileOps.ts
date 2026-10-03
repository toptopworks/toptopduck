// Persisted file-ops species (#1155): the persisted-file actions split
// out of useShellSessions -- deletePersisted / renameEntry / syncSessionName,
// plus the ADR-0127 organization pair setPinned / setArchived -- plus their
// private persistenceBusy axis (delete / archive wait), which lives HERE and
// is surfaced so the host can keep its merged `busy` gate semantics (resume OR
// persistence wait). The host (useShellSessions) composes this hook internally
// and re-exports the members unchanged (nested facade), so App.tsx's
// consumption surface is untouched.
//
// Injection surface (UseSessionFileOpsDeps): intl / refreshSessions /
// setShellError are the same deps the host already takes (zero new coupling).
// unmountOpen / patchOpenName are the NARROW open-set side-effect face: the
// species never touches the open-set state directly -- teardown goes through
// unmountOpen, and in-memory name updates go through patchOpenName (the
// host's single mapSessions name-write, shared by renameEntry +
// syncSessionName). This keeps arbitrary open-set mutation rights with the
// host.
import { useCallback, useState } from "react";
import type { IntlShape } from "react-intl";
import {
  closeSessionAndWaitRelease,
  deleteSession,
  getSessionName,
  renamePersistedSession,
  renameSession,
  setSessionArchived,
  setSessionPinned,
} from "../api";
import { fmtError, toAppError } from "../lib/error-presentation";
import { log } from "../lib/log";
import type { AppError } from "../types/error";

export interface UseSessionFileOpsDeps {
  intl: IntlShape;
  /** Bumps the sidebar's sessionsEpoch so list_sessions re-derives after a
   *  delete / rename lands on disk. */
  refreshSessions: () => void;
  /** Surfaces a shell-layer AppError (kind "shell") for a delete / rename
   *  reject. */
  setShellError: (error: AppError | null) => void;
  /** Synchronous UI teardown of an open session (cache slice + open-set
   *  entry + active id). The delete path's ADR-0063 wait-release ordering
   *  funnels through it. */
  unmountOpen: (sid: string) => void;
  /** The one in-memory open-set name-write (renameEntry's landed name +
   *  syncSessionName's auto-name both funnel here). */
  patchOpenName: (sid: string, name: string) => void;
}

/** Persisted file-ops species (#1155): the file ops moved from
 *  useShellSessions -- renameEntry / syncSessionName land names via the
 *  injected patchOpenName seam, the others verbatim -- plus the
 *  persistenceBusy axis they privately own. */
export function useSessionFileOps({
  intl,
  refreshSessions,
  setShellError,
  unmountOpen,
  patchOpenName,
}: UseSessionFileOpsDeps): {
  deletePersisted: (path: string, sid: string | null) => Promise<void>;
  /** Pin or unpin a persisted session (ADR-0127, issue #1175). Pure sidecar
   *  write; a reject surfaces on the shell error surface, success bumps the
   *  epoch refetch. No optimistic update (local IPC is ms-roundtrip). */
  setPinned: (path: string, pinned: boolean) => Promise<void>;
  /** Archive or restore a persisted session (ADR-0127, issue #1175).
   *  Archiving an OPEN session closes it first via the wait-release variant
   *  (the delete contract, Decision 6 -- an archived-but-open session is the
   *  "active but invisible" contradiction Decision 4 rules out). Restore
   *  never closes: the archived row carries no sid. */
  setArchived: (path: string, archived: boolean, sid: string | null) => Promise<void>;
  renameEntry: (
    sid: string | null,
    path: string,
    newName: string,
  ) => Promise<void>;
  syncSessionName: (sid: string) => Promise<void>;
  persistenceBusy: boolean;
} {
  const [persistenceBusy, setPersistenceBusy] = useState(false);

  // Close an open session via the WAIT-RELEASE variant and tear the pane down
  // after the wait (ADR-0063 ordering: UI teardown AFTER the canonical key is
  // free, not before). Shared by deletePersisted and the archive face of
  // setArchived (ADR-0127 Decision 6 cites the delete contract). Returns
  // false when the wait rejected -- the pane is already unmounted and the
  // fault already surfaced on the shell error surface, so the caller stops
  // (the entry survives for a retry against the real backend state). The
  // caller owns the persistenceBusy window.
  const closeOpenAndWait = useCallback(
    async (sid: string): Promise<boolean> => {
      try {
        await closeSessionAndWaitRelease(sid);
      } catch (e) {
        // Close-wait failed (timeout, or the backend already detached the
        // session). Unmount the pane so the entry falls back to the cold
        // sidebar (sid=null); a retry then takes the pure path variant -- if
        // the canonical key is now free the gate succeeds, otherwise the user
        // sees the real gate error. Without this, the pane stays mounted on a
        // sid the backend no longer knows and every retry hits NotFound
        // (dead loop).
        unmountOpen(sid);
        setShellError(toAppError(e, intl, "shell"));
        return false;
      }
      // The wait resolved -- canonical key is free, Session::Drop ran. NOW
      // unmount the pane (ADR-0063: UI teardown after the wait, not before).
      unmountOpen(sid);
      return true;
    },
    [intl, unmountOpen, setShellError],
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
        if (sid && !(await closeOpenAndWait(sid))) return;
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
    [closeOpenAndWait, intl, refreshSessions, setShellError],
  );

  // Pin or unpin (ADR-0127, issue #1175). A pure sidecar write keyed by the
  // session-directory uuid -- no .duck rewrite, so no persistenceBusy wait
  // (contrast deletePersisted): the write is a single atomic JSON save.
  const setPinned = useCallback(
    async (path: string, pinned: boolean): Promise<void> => {
      try {
        await setSessionPinned(path, pinned);
      } catch (e) {
        setShellError(toAppError(e, intl, "shell"));
        return;
      }
      refreshSessions();
    },
    [intl, refreshSessions, setShellError],
  );

  // Archive or restore (ADR-0127, issue #1175). Archiving an OPEN session
  // closes it first through the shared closeOpenAndWait seam (Decision 6
  // cites the delete contract, ADR-0060; the wait-release variant itself is
  // ADR-0063, as above). The wait can be long, hence persistenceBusy.
  // Restore takes the pure sidecar path -- the archived row carries no sid.
  const setArchived = useCallback(
    async (path: string, archived: boolean, sid: string | null): Promise<void> => {
      if (archived && sid) {
        setPersistenceBusy(true);
        try {
          if (!(await closeOpenAndWait(sid))) return;
        } finally {
          setPersistenceBusy(false);
        }
      }
      try {
        await setSessionArchived(path, archived);
      } catch (e) {
        setShellError(toAppError(e, intl, "shell"));
        return;
      }
      refreshSessions();
    },
    [closeOpenAndWait, intl, refreshSessions, setShellError],
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
          patchOpenName(sid, landed);
        } else {
          await renamePersistedSession(path, trimmed);
        }
      } catch (e) {
        setShellError(toAppError(e, intl, "shell"));
        return;
      }
      refreshSessions();
    },
    [intl, patchOpenName, refreshSessions, setShellError],
  );

  // ADR-0089 Decision 4: after the first terminal turn, the backend auto-names
  // the session from the first question's bounded truncation. This syncs the
  // in-memory open-session entry + the persisted sidebar list so both surfaces
  // reflect the new name without a manual refresh.
  const syncSessionName = useCallback(
    async (sid: string) => {
      try {
        const name = await getSessionName(sid);
        patchOpenName(sid, name);
      } catch (e) {
        // Best-effort: a failure here means the sidebar/header keep the old
        // name until the next refresh. The session itself is unaffected.
        log.warn(
          "syncSessionName",
          "failed to sync auto-named session",
          fmtError(e, intl),
        );
      }
      refreshSessions();
    },
    [intl, patchOpenName, refreshSessions],
  );

  return {
    deletePersisted,
    setPinned,
    setArchived,
    renameEntry,
    syncSessionName,
    persistenceBusy,
  };
}
