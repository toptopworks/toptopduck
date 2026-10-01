// Persisted file-ops species (#1155): the five persisted-file actions split
// out of useShellSessions -- deletePersisted / renameEntry / handleOpenDuck /
// handleExportSession / syncSessionName -- plus their private persistenceBusy
// axis (save / open / delete wait), which lives HERE and is surfaced so the
// host can keep its merged `busy` gate semantics (resume OR persistence wait).
// The host (useShellSessions) composes this hook internally and re-exports the
// five members unchanged (nested facade), so App.tsx's consumption surface is
// untouched.
//
// Injection surface (UseSessionFileOpsDeps): intl / refreshSessions /
// setShellError are the same deps the host already takes (zero new coupling).
// unmountOpen / importAndOpen / patchOpenName are the NARROW open-set
// side-effect face: the species never touches the open-set state directly --
// teardown goes through unmountOpen, import resumes through importAndOpen,
// and in-memory name updates go through patchOpenName (the host's single
// mapSessions name-write, shared by renameEntry + syncSessionName). This
// keeps arbitrary open-set mutation rights with the host.
import { useCallback, useState } from "react";
import type { IntlShape } from "react-intl";
import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import {
  closeSessionAndWaitRelease,
  deleteSession,
  exportSession,
  getSessionName,
  renamePersistedSession,
  renameSession,
} from "../api";
import { fmtError, toAppError } from "../lib/error-presentation";
import { log } from "../lib/log";
import type { AppError } from "../types/error";

export interface UseSessionFileOpsDeps {
  intl: IntlShape;
  /** Bumps the sidebar's sessionsEpoch so list_sessions re-derives after a
   *  delete / rename / import lands on disk. */
  refreshSessions: () => void;
  /** Surfaces a shell-layer AppError (kind "shell") for a delete / rename /
   *  openDuck / export reject. */
  setShellError: (error: AppError | null) => void;
  /** Synchronous UI teardown of an open session (cache slice + open-set
   *  entry + active id). The delete path's ADR-0063 wait-release ordering
   *  funnels through it. */
  unmountOpen: (sid: string) => void;
  /** Import an external .duck into the managed sessions tree and resume it
   *  (the host's resume orchestration); handleOpenDuck rides it. */
  importAndOpen: (externalPath: string, name: string) => Promise<void>;
  /** The one in-memory open-set name-write (renameEntry's landed name +
   *  syncSessionName's auto-name both funnel here). */
  patchOpenName: (sid: string, name: string) => void;
}

/** Persisted file-ops species (#1155): five verbatim moves from
 *  useShellSessions + the persistenceBusy axis they privately own. */
export function useSessionFileOps({
  intl,
  refreshSessions,
  setShellError,
  unmountOpen,
  importAndOpen,
  patchOpenName,
}: UseSessionFileOpsDeps): {
  deletePersisted: (path: string, sid: string | null) => Promise<void>;
  renameEntry: (
    sid: string | null,
    path: string,
    newName: string,
  ) => Promise<void>;
  handleOpenDuck: () => Promise<void>;
  handleExportSession: (duckPath: string, displayName: string) => Promise<void>;
  syncSessionName: (sid: string) => Promise<void>;
  persistenceBusy: boolean;
} {
  const [persistenceBusy, setPersistenceBusy] = useState(false);

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

  // --- Import .duck (ADR-0089 Decision 5, issue #450) ----------------------
  // Open = import: copy the external .duck (+ companion assets/) into a fresh
  // per-session directory under the managed sessions root, then resume the
  // local copy. The original file is never modified.
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
        path
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.duck$/i, "") ?? "session";
      await importAndOpen(path, stem);
      refreshSessions();
    } catch (e) {
      setShellError(toAppError(e, intl, "shell"));
    } finally {
      setPersistenceBusy(false);
    }
  }, [intl, importAndOpen, refreshSessions, setShellError]);

  // --- Export session (ADR-0089 Decision 5, issue #449) -------------------
  // Export a copy of the per-session directory (session.duck + assets/) to a
  // user-chosen destination. The save dialog collects a directory name; the
  // backend copies the files. No rebind, no registry touch — pure file I/O.
  // Silent on success; errors go to setShellError.
  const handleExportSession = useCallback(
    async (duckPath: string, displayName: string) => {
      setPersistenceBusy(true);
      try {
        const dest = await saveDialog({
          defaultPath: displayName,
        });
        if (!dest) return;
        await exportSession(duckPath, dest);
      } catch (e) {
        setShellError(toAppError(e, intl, "shell"));
      } finally {
        setPersistenceBusy(false);
      }
    },
    [intl, setShellError],
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
    renameEntry,
    handleOpenDuck,
    handleExportSession,
    syncSessionName,
    persistenceBusy,
  };
}
