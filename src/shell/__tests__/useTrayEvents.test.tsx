import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTrayEvents } from "../useTrayEvents";
import { onTrayNewSession, onTrayOpenSession, trayReady } from "../../api";
import type { SessionMetadata } from "../../types/session";

// Issue #1140 (ADR-0125): useTrayEvents routes the two tray events onto the
// shell's existing session actions. Sidebar parity is the whole contract --
// the tray introduces no session semantics of its own, and the already-open
// idempotency lives inside openPersisted (pinned in useShellSessions.test),
// so these tests pin the routing (open resolves the persisted display name,
// new navigates to the empty state) and the freshness: production mounts
// this hook at cold start and moves its inputs LATER, so a stale closure
// here is a real bug, not a style concern. The api mock stubs the two
// subscribe wrappers; the hoisted slots capture the registered callbacks so
// a test can fire a synthetic tray event payload.
const trayListeners = vi.hoisted(() => ({
  open: null as ((ev: { duck_path: string }) => void) | null,
  newSession: null as (() => void) | null,
}));

vi.mock("../../api", () => ({
  onTrayOpenSession: vi.fn(async (cb: (ev: { duck_path: string }) => void) => {
    trayListeners.open = cb;
    return () => {
      trayListeners.open = null;
    };
  }),
  onTrayNewSession: vi.fn(async (cb: () => void) => {
    trayListeners.newSession = cb;
    return () => {
      trayListeners.newSession = null;
    };
  }),
  trayReady: vi.fn(async () => {}),
}));

function persisted(path: string, displayName: string): SessionMetadata {
  return {
    duck_path: path,
    display_name: displayName,
    last_modified_at: 0,
    source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
    format_version: 1,
    pinned: false,
    archived: false,
  };
}

type Deps = Parameters<typeof useTrayEvents>[0];

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    sessions: [],
    openPersisted: vi.fn(async () => {}),
    goToEmptyState: vi.fn(),
    ...overrides,
  };
}

async function renderTray(deps: Deps) {
  const rendered = renderHook((d: Deps) => useTrayEvents(d), {
    initialProps: deps,
  });
  // The subscriptions register in the mount effect's async tail.
  await waitFor(() => {
    expect(trayListeners.open).not.toBeNull();
    expect(trayListeners.newSession).not.toBeNull();
  });
  return rendered;
}

/** Rerender with moved inputs and wait for the re-subscription the deps
 *  array must produce (the mount effect's async tail re-registers). */
async function rerenderTray(
  rendered: Awaited<ReturnType<typeof renderTray>>,
  deps: Deps,
  subscriptions: number,
) {
  await act(async () => {
    rendered.rerender(deps);
  });
  await waitFor(() => {
    expect(onTrayOpenSession).toHaveBeenCalledTimes(subscriptions);
    expect(trayListeners.open).not.toBeNull();
  });
}

beforeEach(() => {
  trayListeners.open = null;
  trayListeners.newSession = null;
  vi.mocked(onTrayOpenSession).mockClear();
  vi.mocked(trayReady).mockClear();
});

describe("useTrayEvents", () => {
  it("open: a session click routes through the sidebar path with the persisted display name", async () => {
    const deps = makeDeps({ sessions: [persisted("a.duck", "我的分析")] });
    await renderTray(deps);

    act(() => {
      trayListeners.open!({ duck_path: "a.duck" });
    });

    // The wire payload carries only the path; the name is derived from the
    // persisted list (same scan the sidebar renders). The already-open
    // idempotency is openPersisted's own branch, pinned in
    // useShellSessions.test.
    expect(deps.openPersisted).toHaveBeenCalledWith("a.duck", "我的分析");
  });

  it("open: a path missing from the persisted list opens with the empty name", async () => {
    const deps = makeDeps();
    await renderTray(deps);

    act(() => {
      trayListeners.open!({ duck_path: "gone.duck" });
    });

    expect(deps.openPersisted).toHaveBeenCalledWith("gone.duck", "");
  });

  it("new: navigates to the empty state (the sidebar + action)", async () => {
    const deps = makeDeps();
    await renderTray(deps);

    act(() => {
      trayListeners.newSession!();
    });

    expect(deps.goToEmptyState).toHaveBeenCalledTimes(1);
  });

  it("refresh: a post-mount persisted-list change resolves names from the CURRENT list", async () => {
    // Cold start mounts with an empty list; the disk scan lands later. The
    // listener must re-subscribe and read the refreshed list, or every
    // tray-open after the first sidebar refresh opens with the empty name.
    // Only `sessions` re-identifies across the rerender (the action props
    // are useCallback-stable in production) -- moving every dep at once
    // would re-run the effect regardless and discriminate nothing.
    const openPersisted = vi.fn(async () => {});
    const goToEmptyState = vi.fn();
    const mounted = makeDeps({ openPersisted, goToEmptyState });
    const rendered = await renderTray(mounted);

    act(() => {
      trayListeners.open!({ duck_path: "a.duck" });
    });
    expect(openPersisted).toHaveBeenCalledWith("a.duck", "");

    const refreshed = makeDeps({
      openPersisted,
      goToEmptyState,
      sessions: [persisted("a.duck", "我的分析")],
    });
    await rerenderTray(rendered, refreshed, 2);

    act(() => {
      trayListeners.open!({ duck_path: "a.duck" });
    });
    expect(openPersisted).toHaveBeenLastCalledWith("a.duck", "我的分析");
    expect(openPersisted).toHaveBeenCalledTimes(2);
  });

  it("refresh: a post-mount open-set change routes through the CURRENT openPersisted", async () => {
    // openPersisted re-identifies when the open set moves (its useCallback
    // tracks openSessions); the persisted list and the navigation action
    // stay put. If the listener kept the mount-time openPersisted, a tray
    // click on an already-open session would re-resume through the stale
    // open-set -- the duplicate runtime instance the idempotency exists
    // to prevent.
    const sessions: SessionMetadata[] = [];
    const goToEmptyState = vi.fn();
    const mountedOpen = vi.fn(async () => {});
    const mounted = makeDeps({
      sessions,
      goToEmptyState,
      openPersisted: mountedOpen,
    });
    const rendered = await renderTray(mounted);

    act(() => {
      trayListeners.open!({ duck_path: "a.duck" });
    });
    expect(mountedOpen).toHaveBeenCalledTimes(1);

    const movedOpen = vi.fn(async () => {});
    const moved = makeDeps({
      sessions,
      goToEmptyState,
      openPersisted: movedOpen,
    });
    await rerenderTray(rendered, moved, 2);

    act(() => {
      trayListeners.open!({ duck_path: "a.duck" });
    });
    expect(movedOpen).toHaveBeenCalledWith("a.duck", "");
    expect(mountedOpen).toHaveBeenCalledTimes(1);
  });

  it("handshake: tray_ready fires once both listeners are registered", async () => {
    // Issue #1142: a click before the listeners exist is buffered on the
    // Rust side; the handshake call is what releases it. It must fire
    // after BOTH subscriptions resolved, not after the first (a
    // first-listener-only handshake would replay into a half-registered
    // page).
    await renderTray(makeDeps());
    await waitFor(() => {
      expect(trayReady).toHaveBeenCalledTimes(1);
    });
  });

  it("handshake: a deps re-subscription does not re-fire tray_ready", async () => {
    // The backend never left the ready state during a re-subscription
    // (no page load happened), so re-firing the handshake would be
    // traffic without a cause -- the AC pins one shot per page load.
    const rendered = await renderTray(makeDeps());
    await waitFor(() => {
      expect(trayReady).toHaveBeenCalledTimes(1);
    });

    await rerenderTray(rendered, makeDeps({ sessions: [persisted("a.duck", "n")] }), 2);

    expect(trayReady).toHaveBeenCalledTimes(1);
  });

  it("handshake: no fire until the SECOND listener resolves", async () => {
    // The once-count pins cannot discriminate first-vs-both (both base
    // mocks resolve immediately), so this pin defers the second
    // listener's registration: after the first resolves, the handshake
    // must NOT have fired -- a first-listener-only handshake would
    // replay into a half-registered page, exactly the loss the
    // handshake exists to prevent.
    let releaseNewListener!: () => void;
    vi.mocked(onTrayNewSession).mockImplementationOnce(
      (cb: () => void) =>
        new Promise<() => void>((resolve) => {
          releaseNewListener = () => {
            trayListeners.newSession = cb;
            resolve(() => {
              trayListeners.newSession = null;
            });
          };
        }),
    );
    renderHook((d: Deps) => useTrayEvents(d), { initialProps: makeDeps() });
    await waitFor(() => {
      expect(trayListeners.open).not.toBeNull();
    });
    // First subscription resolved, second still pending: no handshake.
    expect(trayReady).not.toHaveBeenCalled();
    await act(async () => {
      releaseNewListener();
    });
    await waitFor(() => {
      expect(trayReady).toHaveBeenCalledTimes(1);
    });
  });

  it("unsubscribes on unmount", async () => {
    const deps = makeDeps();
    const rendered = await renderTray(deps);

    rendered.unmount();

    expect(trayListeners.open).toBeNull();
    expect(trayListeners.newSession).toBeNull();
  });
});
