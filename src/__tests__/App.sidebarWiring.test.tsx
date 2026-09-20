import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import type { AppConfig } from "../types/app-config";
import type { ApprovalRequestPayload } from "../types/approval";
import { sessionKeys } from "../session/queryKeys";
import { failed, materialized } from "../session/__tests__/fixtures";

// App-level wiring pins (issue #1007): the two shell-level cross-session reads
// that feed SessionSidebar -- useTurnFailureSids (thread-cache derived) and
// useApprovalEvents (event-channel derived) -- connect through two lines in
// App.tsx (one hook call + one prop pass each). The hook bodies and the
// sidebar's own rendering each carry dense test surfaces, but the connection
// tissue itself had zero observation points: PR #1006's mutation evidence
// showed both prop passes can be deleted with every App render test staying
// green. These tests pin the full chain (cache/event -> hook derive -> prop
// -> row data attribute + status dot) through the rendered shell.
//
// The App creates its QueryClient lazily in its own body (above the provider,
// the useShellSessions posture), so the test reaches it by wrapping the
// createQueryClient factory and collecting what App mints; seeding thread
// cache entries on that instance is exactly the channel the optimistic ask
// tail uses (ADR-0051). Open sessions come from the #842 re-adoption sweep:
// listLiveSessions returning idle rows registers + activates them without
// driving the cold-start UI.

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onDragDropEvent: () => Promise.resolve(() => {}),
  }),
}));

const { platformMock } = vi.hoisted(() => ({ platformMock: vi.fn<() => string>() }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: platformMock }));

import { buildTauriWindowMock } from "./setup/tauriWindowMock";

// The shell stub keeps jsdom off the real window bridge; no test here drives
// WindowControls clicks, so the bridge handle itself is not captured.
vi.mock("@tauri-apps/api/window", () => {
  const { module } = buildTauriWindowMock();
  return module;
});

// QueryClient instances App mints, one per mount -- the seeding handle for the
// turn-failure pin. Same vi.hoisted constraint as the api mock below: the
// factory runs above imports, so only hoisted containers are in scope.
const { mintedClients, approvalCaptor } = vi.hoisted(() => ({
  mintedClients: { current: [] as QueryClient[] },
  approvalCaptor: { current: null as null | ((ev: ApprovalRequestPayload) => void) },
}));

vi.mock("../lib/queryClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/queryClient")>();
  return {
    ...actual,
    createQueryClient: () => {
      const client = actual.createQueryClient();
      mintedClients.current.push(client);
      return client;
    },
  };
});

// Hand-rolled literal, same constraint as App.i18n.test.tsx: the hoisted api
// mock factory cannot reach the shared baseAppConfig factory import.
const { appConfigWith } = vi.hoisted(() => {
  function appConfigWith(locale: "system" | "zh-CN" | "en-US"): AppConfig {
    return {
      format_version: 2,
      theme: "system" as const,
      locale,
      engine: { memory_limit: "512MB", threads: 1, row_cap: 100 },
      privacy: { send_samples: true },
      provider: {
        profiles: [
          {
            id: "default",
            display_name: "Anthropic",
            protocol: "anthropic",
            base_url: "https://api.anthropic.com",
            model: "claude-sonnet-4-6",
          },
        ],
        active_profile: "default",
      },
      export: { last_dir: null, default_format: "csv" },
      tunables: { window_turns: 6, far_window: 12 },
      shell: { sidebar_collapsed: false, sidebar_grouping: "flat" },
      cli_tools: { tools: [] },
      mcp_servers: { servers: [] },
      sessions_dir: null,
      default_runtime: { kind: "built_in" },
      builtin_skill_baselines: {},
      last_model_postures: {},
      enabled_agents: [],
      materialized_builtin_agents: [],
      disabled_skills: [],
    };
  }
  return { appConfigWith };
});

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    listLiveSessions: vi.fn(async () => []),
    closeSession: vi.fn(async () => false),
    createSession: vi.fn(async () => "sess-1"),
    listWorkingSet: vi.fn(async () => []),
    // The re-adopted session mounts a SessionPane; its per-pane listeners and
    // composer reads must stay off the real Tauri bridge (same stubs as
    // App.test.tsx's pane-driving flows).
    onTurnProgress: vi.fn(async () => () => {}),
    getAuthorizationMode: vi.fn(async () => "per_call" as const),
    setAuthorizationMode: vi.fn(async () => {}),
    listSkills: vi.fn(async () => ({ skills: [], ignored: [] })),
    activeDataset: vi.fn(async () => null),
    conversation: vi.fn(async () => []),
    readRows: vi.fn(),
    getProviderConfig: vi.fn(async () => ({
      base_url: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
      has_key: false,
      keychain_fault: null,
    })),
    getAppConfig: vi.fn(async () => appConfigWith("en-US")),
    setAppConfig: vi.fn(async (cfg: AppConfig) => cfg),
    // The app-level approval channel (issue #297): capture the request
    // handler so the twin pin can drive an event through the real
    // useApprovalEvents listener instead of injecting a prop value.
    onApprovalRequest: vi.fn(async (cb: (ev: ApprovalRequestPayload) => void) => {
      approvalCaptor.current = cb;
      return () => {};
    }),
    onApprovalResolved: vi.fn(async () => () => {}),
    respondToolApproval: vi.fn(async () => {}),
  };
});

import App from "../App";
import { listLiveSessions } from "../api";
import type { LiveSessionEntry } from "../api";

function idleLive(id: string, name: string): LiveSessionEntry {
  return { session_id: id, duck_path: `/x/${id}.duck`, session_name: name, in_flight: false };
}

/** The sidebar row (`li.session-entry`) whose button carries the session's
 *  display name. getAllByText: the active session's pane header repeats the
 *  name outside the sidebar, so the match set spans both. */
function rowFor(name: string): HTMLElement | null {
  for (const el of screen.getAllByText(name)) {
    const row = el.closest(".session-entry");
    if (row) return row as HTMLElement;
  }
  return null;
}

describe("App shell-level sidebar wiring (issue #1007)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platformMock.mockReturnValue("windows");
    mintedClients.current = [];
    approvalCaptor.current = null;
    vi.stubGlobal("navigator", { language: "en-US" });
  });

  it("derives the sidebar turn-failure dot from each open session's thread cache", async () => {
    // Two re-adopted open sessions: one whose latest settled turn is Failed
    // (behind an earlier settled success, pinning the tail-scan verdict at
    // the shell level) and one whose latest turn succeeded.
    vi.mocked(listLiveSessions).mockResolvedValue([
      idleLive("sess-failed", "Failed one"),
      idleLive("sess-ok", "Just fine"),
    ]);
    render(<App />);

    // The re-adoption sweep landed both rows; the failure observers over
    // their thread cache entries are now subscribed.
    await waitFor(() => {
      expect(rowFor("Failed one")).not.toBeNull();
      expect(rowFor("Just fine")).not.toBeNull();
    });

    const client = mintedClients.current.at(-1);
    expect(client).toBeDefined();
    await act(async () => {
      client!.setQueryData(sessionKeys.thread("sess-failed"), [
        materialized("earlier_ok"),
        failed("boom"),
      ]);
      client!.setQueryData(sessionKeys.thread("sess-ok"), [materialized("fine_ds")]);
    });

    // Failed row: the data attribute AND the destructive status dot.
    await waitFor(() => {
      expect(rowFor("Failed one")!.getAttribute("data-turn-failed")).toBe("true");
    });
    const failedDot = rowFor("Failed one")!.querySelector(".sidebar-status-dot");
    expect(failedDot?.className.split(/\s+/)).toContain("bg-destructive");

    // The succeeded sibling stays dark: the derive is per-session, not a
    // blanket tint (catches a wiring that lights every row).
    const okRow = rowFor("Just fine")!;
    expect(okRow.getAttribute("data-turn-failed")).toBeNull();
    expect(okRow.querySelector(".sidebar-status-dot")?.className.split(/\s+/)).toContain(
      "bg-primary",
    );
  });

  it("derives the sidebar pending-approval tint through the app-level event channel", async () => {
    vi.mocked(listLiveSessions).mockResolvedValue([idleLive("sess-ap", "Awaiting one")]);
    render(<App />);
    await waitFor(() => expect(rowFor("Awaiting one")).not.toBeNull());

    // Seed a failed latest turn too: the approval tint must WIN the dot while
    // both row attributes coexist (the issue #1005 priority contract, pinned
    // here at the shell wiring level).
    const client = mintedClients.current.at(-1);
    await act(async () => {
      client!.setQueryData(sessionKeys.thread("sess-ap"), [failed("boom")]);
    });

    // Drive the captured approval-request handler -- the same listener
    // useApprovalEvents mounted on the real channel.
    expect(approvalCaptor.current).not.toBeNull();
    await act(async () => {
      approvalCaptor.current!({
        session_id: "sess-ap",
        request_id: "req-1",
        server: "fs",
        tool: "write_file",
        operation_kind: "write",
        summary: "wants to write",
      });
    });

    await waitFor(() => {
      expect(rowFor("Awaiting one")!.getAttribute("data-pending-approval")).toBe("true");
    });
    const row = rowFor("Awaiting one")!;
    // Both attributes coexist; the dot takes the approval (warning) tint.
    expect(row.getAttribute("data-turn-failed")).toBe("true");
    expect(row.querySelector(".sidebar-status-dot")?.className.split(/\s+/)).toContain(
      "bg-warning",
    );
  });
});
