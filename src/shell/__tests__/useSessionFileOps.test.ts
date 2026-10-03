import { act, renderHook } from "@testing-library/react";
import { catalogIntl } from "../../components/common/__tests__/helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Issue #1155: useSessionFileOps owns the persisted file-ops species
// (delete / rename / auto-name sync) + its private persistenceBusy axis,
// extracted from useShellSessions. The open-set side effects are INJECTED
// (unmountOpen / patchOpenName), so the arrange side mounts only this hook
// with callback mocks instead of the full host tree; cross-hook orchestration
// stays covered by the full-mount tests in useShellSessions.test.ts.
// The api mock stubs the Tauri invoke wrappers; the reject path runs the real
// toAppError + fmtError (lib/error-presentation, outside the api mock).

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    closeSessionAndWaitRelease: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    getSessionName: vi.fn(async () => ""),
    renamePersistedSession: vi.fn(async () => {}),
    renameSession: vi.fn(async () => ""),
    setSessionArchived: vi.fn(async () => {}),
    setSessionPinned: vi.fn(async () => {}),
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
  getSessionName,
  renamePersistedSession,
  renameSession,
  setSessionArchived,
  setSessionPinned,
} from "../../api";
import { log } from "../../lib/log";
import { useSessionFileOps } from "../useSessionFileOps";

const intl = catalogIntl("en-US");

/** Render the species hook with injected callback mocks. Every dep is a
 *  vi.fn so a test asserts on the narrow open-set seam (unmountOpen /
 *  patchOpenName) rather than the host's open-set state. */
function renderFileOps() {
  const refreshSessions = vi.fn();
  const setShellError = vi.fn();
  const unmountOpen = vi.fn();
  const patchOpenName = vi.fn();
  const helpers = renderHook(() =>
    useSessionFileOps({
      intl,
      refreshSessions,
      setShellError,
      unmountOpen,
      patchOpenName,
    }),
  );
  return {
    ...helpers,
    refreshSessions,
    setShellError,
    unmountOpen,
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

  it("renameEntry open branch lands the backend-trimmed name via patchOpenName (#204)", async () => {
    // OPEN branch: the backend owns trimming, so the entry lands whatever
    // renameSession returns (the landed name, not the raw input).
    vi.mocked(renameSession).mockResolvedValueOnce("Landed");
    const { result, patchOpenName, refreshSessions, setShellError } = renderFileOps();
    await act(async () => {
      await result.current.renameEntry("s1", "/sessions/s1/session.duck", "new");
    });
    expect(renameSession).toHaveBeenCalledWith("s1", "new");
    expect(patchOpenName).toHaveBeenCalledWith("s1", "Landed");
    expect(refreshSessions).toHaveBeenCalledTimes(1);
    expect(setShellError).not.toHaveBeenCalled();
  });

  // ADR-0089 Decision 4: after the first terminal turn, the backend auto-names
  // the session. syncSessionName reads the live name and updates the in-memory
  // open-session entry (via the injected patchOpenName seam) + refreshes the
  // sidebar.
  describe("syncSessionName (ADR-0089 auto-name sync)", () => {
    it("reads the backend name, patches the open entry, and refreshes the sidebar", async () => {
      const { result, patchOpenName, refreshSessions } = renderFileOps();
      vi.mocked(getSessionName).mockResolvedValueOnce("how many people?");

      await act(async () => {
        await result.current.syncSessionName("s1");
      });

      expect(getSessionName).toHaveBeenCalledWith("s1");
      expect(patchOpenName).toHaveBeenCalledWith("s1", "how many people?");
      expect(refreshSessions).toHaveBeenCalled();
    });

    it("logs a warning + still refreshes sidebar when getSessionName rejects", async () => {
      const { result, patchOpenName, refreshSessions } = renderFileOps();
      vi.mocked(getSessionName).mockRejectedValueOnce(new Error("ipc down"));

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
    // UI teardown lands only after it (not before the wait). at(-1), not
    // [0]: Arm 1 already consumed one call on this module-level mock, so
    // [0] is Arm 1's reject -- only the LATEST invocation is this arm's wait.
    expect(
      vi.mocked(closeSessionAndWaitRelease).mock.invocationCallOrder.at(-1),
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

  // --- ADR-0127 (issue #1175): pin / archive organization writes -------------

  describe("setPinned / setArchived (ADR-0127, issue #1175)", () => {
    it("setPinned: success refreshes; a reject surfaces on the shell error without a refresh", async () => {
      const ok = renderFileOps();
      await act(async () => {
        await ok.result.current.setPinned("/x/a.duck", true);
      });
      expect(setSessionPinned).toHaveBeenCalledWith("/x/a.duck", true);
      expect(ok.refreshSessions).toHaveBeenCalledTimes(1);
      expect(ok.setShellError).not.toHaveBeenCalled();
      // A pure sidecar write takes NO persistenceBusy wait (contrast delete).
      expect(ok.result.current.persistenceBusy).toBe(false);

      vi.mocked(setSessionPinned).mockRejectedValueOnce(new Error("io"));
      const bad = renderFileOps();
      await act(async () => {
        await bad.result.current.setPinned("/x/a.duck", false);
      });
      expect(bad.setShellError).toHaveBeenCalledTimes(1);
      expect(bad.refreshSessions).not.toHaveBeenCalled();
    });

    it("setArchived restore: pure sidecar path -- no close, no busy", async () => {
      const { result, unmountOpen, refreshSessions } = renderFileOps();
      await act(async () => {
        await result.current.setArchived("/x/a.duck", false, null);
      });
      expect(setSessionArchived).toHaveBeenCalledWith("/x/a.duck", false);
      expect(closeSessionAndWaitRelease).not.toHaveBeenCalled();
      expect(unmountOpen).not.toHaveBeenCalled();
      expect(refreshSessions).toHaveBeenCalledTimes(1);
      expect(result.current.persistenceBusy).toBe(false);
    });

    it("setArchived on an OPEN session closes it first via wait-release, then writes (Decision 6 delete contract)", async () => {
      const { result, unmountOpen, refreshSessions } = renderFileOps();
      await act(async () => {
        await result.current.setArchived("/x/a.duck", true, "s1");
      });
      // Ordering mirrors deletePersisted: wait-release resolves, THEN the
      // pane tears down, THEN the sidecar write, THEN the refetch.
      expect(closeSessionAndWaitRelease).toHaveBeenCalledWith("s1");
      expect(unmountOpen).toHaveBeenCalledWith("s1");
      expect(
        vi.mocked(closeSessionAndWaitRelease).mock.invocationCallOrder[0],
      ).toBeLessThan(unmountOpen.mock.invocationCallOrder[0]);
      expect(unmountOpen.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(setSessionArchived).mock.invocationCallOrder[0],
      );
      expect(refreshSessions).toHaveBeenCalledTimes(1);
      expect(result.current.persistenceBusy).toBe(false);
    });

    it("setArchived wait-reject: falls back cold (unmount + shell error), no archive write", async () => {
      vi.mocked(closeSessionAndWaitRelease).mockRejectedValueOnce(
        new Error("timeout"),
      );
      const { result, unmountOpen, setShellError, refreshSessions } =
        renderFileOps();
      await act(async () => {
        await result.current.setArchived("/x/a.duck", true, "s1");
      });
      expect(unmountOpen).toHaveBeenCalledWith("s1");
      expect(setShellError).toHaveBeenCalledTimes(1);
      // The session was NOT archived -- the row survives for a retry.
      expect(setSessionArchived).not.toHaveBeenCalled();
      expect(refreshSessions).not.toHaveBeenCalled();
      expect(result.current.persistenceBusy).toBe(false);
    });

    it("setArchived write-reject after a successful close: shell error, no refetch", async () => {
      // The close succeeded (pane torn down), but the sidecar write failed:
      // the reject surfaces and the list is NOT refetched -- the next epoch
      // keeps the truth from disk instead of a half-archived UI state.
      vi.mocked(setSessionArchived).mockRejectedValueOnce(new Error("io"));
      const { result, unmountOpen, setShellError, refreshSessions } =
        renderFileOps();
      await act(async () => {
        await result.current.setArchived("/x/a.duck", true, "s1");
      });
      expect(closeSessionAndWaitRelease).toHaveBeenCalledWith("s1");
      expect(unmountOpen).toHaveBeenCalledWith("s1");
      expect(setSessionArchived).toHaveBeenCalledWith("/x/a.duck", true);
      expect(setShellError).toHaveBeenCalledTimes(1);
      expect(refreshSessions).not.toHaveBeenCalled();
      expect(result.current.persistenceBusy).toBe(false);
    });

    it("setArchived gates busy ONLY over the close wait -- the sidecar write runs ungated", async () => {
      // The deliberate asymmetry (contrast deletePersisted, whose busy covers
      // the whole op): a pending wait-release holds persistenceBusy, and the
      // moment it resolves the busy window closes -- the pure sidecar write
      // needs no wait.
      let release!: () => void;
      vi.mocked(closeSessionAndWaitRelease).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const { result, unmountOpen } = renderFileOps();
      let pending: Promise<void> | undefined;
      act(() => {
        pending = result.current.setArchived("/x/a.duck", true, "s1");
      });
      // During the wait: busy. The write has not started.
      expect(result.current.persistenceBusy).toBe(true);
      expect(setSessionArchived).not.toHaveBeenCalled();
      await act(async () => {
        release();
        await pending;
      });
      expect(unmountOpen).toHaveBeenCalledWith("s1");
      // After the wait: busy closed, and the write ran to completion.
      expect(setSessionArchived).toHaveBeenCalledWith("/x/a.duck", true);
      expect(result.current.persistenceBusy).toBe(false);
    });
  });
});
