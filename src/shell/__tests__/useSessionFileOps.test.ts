import { act, renderHook } from "@testing-library/react";
import { catalogIntl } from "../../components/common/__tests__/helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Issue #1155: useSessionFileOps owns the persisted file-ops species
// (delete / rename / import / export / auto-name sync) + its private
// persistenceBusy axis, extracted from useShellSessions. The open-set side
// effects are INJECTED (unmountOpen / importAndOpen / patchOpenName), so the
// arrange side mounts only this hook with callback mocks instead of the full
// host tree; cross-hook orchestration (import -> resume -> close-on-fail)
// stays covered by the two full-mount tests in useShellSessions.test.ts.
// The api mock stubs the Tauri invoke wrappers; the reject path runs the real
// toAppError + fmtError (lib/error-presentation, outside the api mock).

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    closeSessionAndWaitRelease: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    exportSession: vi.fn(async () => {}),
    getSessionName: vi.fn(async () => ""),
    renamePersistedSession: vi.fn(async () => {}),
    renameSession: vi.fn(async () => ""),
  };
});

vi.mock("../../lib/log", () => ({
  log: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  closeSessionAndWaitRelease,
  deleteSession,
  exportSession,
  getSessionName,
  renamePersistedSession,
  renameSession,
} from "../../api";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { log } from "../../lib/log";
import { useSessionFileOps } from "../useSessionFileOps";

const intl = catalogIntl("en-US");

/** Render the species hook with injected callback mocks. Every dep is a
 *  vi.fn so a test asserts on the narrow open-set seam (unmountOpen /
 *  importAndOpen / patchOpenName) rather than the host's open-set state. */
function renderFileOps() {
  const refreshSessions = vi.fn();
  const setShellError = vi.fn();
  const unmountOpen = vi.fn();
  const importAndOpen = vi.fn(async () => {});
  const patchOpenName = vi.fn();
  const helpers = renderHook(() =>
    useSessionFileOps({
      intl,
      refreshSessions,
      setShellError,
      unmountOpen,
      importAndOpen,
      patchOpenName,
    }),
  );
  return {
    ...helpers,
    refreshSessions,
    setShellError,
    unmountOpen,
    importAndOpen,
    patchOpenName,
  };
}

describe("useSessionFileOps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renameEntry rewrites a closed .duck header via renamePersistedSession + refreshes (closed branch, #204)", async () => {
    // The closed branch (sid=null, path set) rewrites the recipe header in place
    // by path, then refreshes the sidebar so list_sessions re-derives the name.
    vi.mocked(renamePersistedSession).mockResolvedValueOnce();
    const { result, refreshSessions, setShellError } = renderFileOps();
    await act(async () => {
      await result.current.renameEntry(null, "/x/foo.duck", "new");
    });
    expect(renamePersistedSession).toHaveBeenCalledWith("/x/foo.duck", "new");
    expect(refreshSessions).toHaveBeenCalledTimes(1);
    expect(setShellError).not.toHaveBeenCalled();
  });

  it("renameEntry surfaces a renamePersistedSession reject via setShellError and skips refresh (closed branch, #204)", async () => {
    // The catch returns BEFORE refreshSessions fires, so the sidebar never lists
    // a name the backend just rejected -- the next list_sessions re-derives the
    // on-disk truth instead.
    vi.mocked(renamePersistedSession).mockRejectedValueOnce(
      new Error("rename rejected"),
    );
    const { result, refreshSessions, setShellError } = renderFileOps();
    await act(async () => {
      await result.current.renameEntry(null, "/x/foo.duck", "new");
    });
    expect(renamePersistedSession).toHaveBeenCalledWith("/x/foo.duck", "new");
    expect(setShellError).toHaveBeenCalledTimes(1);
    expect(refreshSessions).not.toHaveBeenCalled();
  });

  it("renameEntry trims input and bails on whitespace-only (no IPC, no refresh, #204)", async () => {
    // The trim guard runs before either branch: a blank name skips
    // renameSession / renamePersistedSession AND refreshSessions, so an
    // accidental empty rename cannot trigger a spurious sidebar re-fetch.
    const { result, refreshSessions, setShellError } = renderFileOps();
    await act(async () => {
      await result.current.renameEntry("s1", "/sessions/s1/session.duck", "   ");
    });
    expect(renameSession).not.toHaveBeenCalled();
    expect(renamePersistedSession).not.toHaveBeenCalled();
    expect(refreshSessions).not.toHaveBeenCalled();
    expect(setShellError).not.toHaveBeenCalled();
  });

  it("handleOpenDuck bails on a cancelled open dialog (null path): no import, no refresh, busy clears (#204)", async () => {
    vi.mocked(openDialog).mockResolvedValueOnce(null);
    const { result, importAndOpen, refreshSessions } = renderFileOps();
    await act(async () => {
      await result.current.handleOpenDuck();
    });
    expect(importAndOpen).not.toHaveBeenCalled();
    expect(refreshSessions).not.toHaveBeenCalled();
    expect(result.current.persistenceBusy).toBe(false);
  });

  // --- handleExportSession (ADR-0089 Decision 5, issue #449) -----------------

  it("handleExportSession calls exportSession with duck path + save dialog result", async () => {
    vi.mocked(saveDialog).mockResolvedValueOnce("/dest/my-copy");
    vi.mocked(exportSession).mockResolvedValueOnce();
    const { result, setShellError } = renderFileOps();
    await act(async () => {
      await result.current.handleExportSession("/src/uuid/session.duck", "My Session");
    });
    expect(saveDialog).toHaveBeenCalledWith({ defaultPath: "My Session" });
    expect(exportSession).toHaveBeenCalledWith("/src/uuid/session.duck", "/dest/my-copy");
    expect(setShellError).not.toHaveBeenCalled();
    expect(result.current.persistenceBusy).toBe(false);
  });

  it("handleExportSession bails on a cancelled save dialog (null): no export, busy clears", async () => {
    vi.mocked(saveDialog).mockResolvedValueOnce(null);
    const { result, setShellError } = renderFileOps();
    await act(async () => {
      await result.current.handleExportSession("/src/uuid/session.duck", "S");
    });
    expect(exportSession).not.toHaveBeenCalled();
    expect(setShellError).not.toHaveBeenCalled();
    expect(result.current.persistenceBusy).toBe(false);
  });

  it("handleExportSession surfaces errors via setShellError", async () => {
    vi.mocked(saveDialog).mockResolvedValueOnce("/dest/copy");
    vi.mocked(exportSession).mockRejectedValueOnce(new Error("disk full"));
    const { result, setShellError } = renderFileOps();
    await act(async () => {
      await result.current.handleExportSession("/src/uuid/session.duck", "S");
    });
    expect(exportSession).toHaveBeenCalled();
    expect(setShellError).toHaveBeenCalledOnce();
    expect(result.current.persistenceBusy).toBe(false);
  });

  // ADR-0089 Decision 4: after the first terminal turn, the backend auto-names
  // the session. syncSessionName reads the live name and updates the in-memory
  // open-session entry (via the injected patchOpenName seam) + refreshes the
  // sidebar.
  describe("syncSessionName (ADR-0089 auto-name sync)", () => {
    it("reads the backend name, patches the open entry, and refreshes the sidebar", async () => {
      const { result, patchOpenName, refreshSessions } = renderFileOps();
      vi.mocked(getSessionName).mockResolvedValue("how many people?");

      await act(async () => {
        await result.current.syncSessionName("s1");
      });

      expect(getSessionName).toHaveBeenCalledWith("s1");
      expect(patchOpenName).toHaveBeenCalledWith("s1", "how many people?");
      expect(refreshSessions).toHaveBeenCalled();
    });

    it("logs a warning + still refreshes sidebar when getSessionName rejects", async () => {
      const { result, patchOpenName, refreshSessions } = renderFileOps();
      vi.mocked(getSessionName).mockRejectedValue(new Error("ipc down"));

      await act(async () => {
        await result.current.syncSessionName("s2");
      });

      // Best-effort: the open-session name is unchanged (the fetch failed),
      // but the sidebar still refreshes so a persisted re-read can catch up.
      expect(patchOpenName).not.toHaveBeenCalled();
      expect(refreshSessions).toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalled();
    });
  });

  // --- deletePersisted three-arm pin (ADR-0063, #1155) -----------------------
  // The delete path had zero direct coverage before extraction (the wait
  // variants only rode mock tables). Three arms pin the ordering + surfacing
  // contracts; deleting any assertion line below leaves its arm unverified.

  it("deletePersisted: wait-reject falls back cold / wait-resolve tears down after the wait / delete-reject surfaces without refresh (ADR-0063)", async () => {
    // Arm 1: the wait-release reject unmounts the pane + surfaces the fault,
    // and never reaches deleteSession or a sidebar refresh (the entry falls
    // back to the cold sidebar so a retry takes the pure deleteSession path).
    vi.mocked(closeSessionAndWaitRelease).mockRejectedValueOnce(
      new Error("wait timeout"),
    );
    const waitReject = renderFileOps();
    await act(async () => {
      await waitReject.result.current.deletePersisted("/x/a.duck", "s1");
    });
    expect(waitReject.unmountOpen).toHaveBeenCalledWith("s1");
    // Exactly once: the teardown happens in the catch arm only -- a teardown
    // that leaked ahead of the wait would double-fire here.
    expect(waitReject.unmountOpen).toHaveBeenCalledTimes(1);
    expect(waitReject.setShellError).toHaveBeenCalledTimes(1);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(waitReject.refreshSessions).not.toHaveBeenCalled();

    // Arm 2: the wait resolves -- the UI teardown lands AFTER the wait
    // (ADR-0063 Decision 2) and BEFORE deleteSession, then the sidebar
    // refreshes; no error surfaces.
    vi.mocked(closeSessionAndWaitRelease).mockResolvedValueOnce();
    vi.mocked(deleteSession).mockResolvedValueOnce();
    const waitResolve = renderFileOps();
    await act(async () => {
      await waitResolve.result.current.deletePersisted("/x/b.duck", "s2");
    });
    expect(waitResolve.unmountOpen).toHaveBeenCalledWith("s2");
    // ADR-0063 Decision 2 ordering: the wait-release resolves FIRST, and the
    // UI teardown lands only after it (not before the wait).
    expect(
      vi.mocked(closeSessionAndWaitRelease).mock.invocationCallOrder[0],
    ).toBeLessThan(waitResolve.unmountOpen.mock.invocationCallOrder[0]);
    expect(deleteSession).toHaveBeenCalledWith("/x/b.duck");
    expect(waitResolve.unmountOpen.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deleteSession).mock.invocationCallOrder[0],
    );
    expect(waitResolve.refreshSessions).toHaveBeenCalledTimes(1);
    expect(waitResolve.setShellError).not.toHaveBeenCalled();

    // Arm 3: deleteSession rejects (try_acquire gate, I/O) -- the fault
    // surfaces via setShellError and the sidebar never refreshes (the entry
    // still exists on disk).
    vi.mocked(deleteSession).mockRejectedValueOnce(new Error("gate busy"));
    const deleteReject = renderFileOps();
    await act(async () => {
      await deleteReject.result.current.deletePersisted("/x/c.duck", null);
    });
    expect(deleteReject.setShellError).toHaveBeenCalledTimes(1);
    expect(deleteReject.refreshSessions).not.toHaveBeenCalled();
    expect(deleteReject.result.current.persistenceBusy).toBe(false);
  });
});
