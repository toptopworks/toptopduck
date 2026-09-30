import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTrayEvents } from "../useTrayEvents";
import type { OpenSession } from "../../session/sidebarModel";
import type { SessionMetadata } from "../../types/session";

// Issue #1140 (ADR-0125): useTrayEvents routes the two tray events onto the
// shell's existing session actions. Sidebar parity is the whole contract --
// the tray introduces no session semantics of its own -- so these tests pin
// the three branches: open (closed session resumes), idempotent (open
// session only activates), and new (empty-state navigation). The api mock
// stubs the two subscribe wrappers; the hoisted slots capture the registered
// callbacks so a test can fire a synthetic tray event payload.
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
}));

function openSession(sid: string, path: string): OpenSession {
  return {
    sid,
    name: "",
    path,
    pendingIngestPaths: [],
    pendingQuestion: null,
    pendingSkillInvocations: [],
  };
}

function persisted(path: string, displayName: string): SessionMetadata {
  return {
    duck_path: path,
    display_name: displayName,
    last_modified_at: 0,
    source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
    format_version: 1,
  };
}

type Deps = Parameters<typeof useTrayEvents>[0];

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    openSessions: [],
    sessions: [],
    activateSession: vi.fn(),
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

beforeEach(() => {
  trayListeners.open = null;
  trayListeners.newSession = null;
});

describe("useTrayEvents", () => {
  it("open: a closed session resumes through the sidebar path with the persisted display name", async () => {
    const deps = makeDeps({ sessions: [persisted("a.duck", "我的分析")] });
    await renderTray(deps);

    act(() => {
      trayListeners.open!({ duck_path: "a.duck" });
    });

    // The wire payload carries only the path; the name is derived from the
    // persisted list (same scan the sidebar renders).
    expect(deps.openPersisted).toHaveBeenCalledWith("a.duck", "我的分析");
    expect(deps.activateSession).not.toHaveBeenCalled();
  });

  it("open: a path missing from the persisted list opens with the empty name", async () => {
    const deps = makeDeps();
    await renderTray(deps);

    act(() => {
      trayListeners.open!({ duck_path: "gone.duck" });
    });

    expect(deps.openPersisted).toHaveBeenCalledWith("gone.duck", "");
  });

  it("idempotent: an already-open session only activates, never re-resumes", async () => {
    const deps = makeDeps({
      openSessions: [openSession("s1", "a.duck")],
      sessions: [persisted("a.duck", "我的分析")],
    });
    await renderTray(deps);

    act(() => {
      trayListeners.open!({ duck_path: "a.duck" });
    });

    expect(deps.activateSession).toHaveBeenCalledWith("s1");
    expect(deps.openPersisted).not.toHaveBeenCalled();
  });

  it("new: navigates to the empty state (the sidebar + action)", async () => {
    const deps = makeDeps();
    await renderTray(deps);

    act(() => {
      trayListeners.newSession!();
    });

    expect(deps.goToEmptyState).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes on unmount", async () => {
    const deps = makeDeps();
    const rendered = await renderTray(deps);

    rendered.unmount();

    expect(trayListeners.open).toBeNull();
    expect(trayListeners.newSession).toBeNull();
  });
});
