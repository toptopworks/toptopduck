// App-level wiring pin for the cold-start guidance banner (issue #1337): the
// derivation consumes App-owned feeds (appConfig default_runtime, the
// startup adapter table, useProfileKeys) and the banner mounts ONLY on the
// cold-start branch of the shell bar slot. The hook/component bodies each
// carry their own dense surfaces (ColdStartGuideBanner.test.tsx); this file
// pins the connection tissue -- the degrade wall (cli-missing, root cause
// over the key posture) surfaces on the empty state and vanishes entirely
// once a session is active.
//
// Harness note: unlike App.test.tsx (whose unstubbed getAppConfig keeps
// appConfig null and the banner behind its loading gate), this file stubs
// the config + adapter + key IPCs so the derivation actually resolves.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import type { AppConfig } from "../types/app-config";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onDragDropEvent: () => Promise.resolve(() => {}),
  }),
}));

const { platformMock } = vi.hoisted(() => ({ platformMock: vi.fn<() => string>() }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: platformMock }));

// The QueryClient instances App mints, one per mount -- the poke handle for
// the adapter re-detection disappearance proof (same capture as #1007).
const { mintedClients } = vi.hoisted(() => ({
  mintedClients: { current: [] as QueryClient[] },
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

import { buildTauriWindowMock } from "./setup/tauriWindowMock";

vi.mock("@tauri-apps/api/window", () => {
  const { module } = buildTauriWindowMock();
  return module;
});

// Hand-rolled literal (the hoisted api mock factory cannot reach the shared
// baseAppConfig factory import, same constraint as App.i18n.test.tsx): one
// profile WITHOUT a key. The default_runtime rides a mutable holder so each
// test picks its wall: the undetected-CLI degrade (external) or the built-in
// key posture.
const { appConfigWith, configHolder } = vi.hoisted(() => {
  const configHolder: {
    current: AppConfig["default_runtime"];
  } = { current: { kind: "external", data: "qwen-code" } };
  function appConfigWith(): AppConfig {
    return {
      format_version: 2,
      theme: "system" as const,
      locale: "en-US",
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
      default_runtime: configHolder.current,
      last_model_postures: {},
      enabled_agents: [],
      materialized_builtin_agents: [],
      disabled_skills: [],
    };
  }
  return { appConfigWith, configHolder };
});

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    listLiveSessions: vi.fn(async () => []),
    closeSession: vi.fn(async () => false),
    createSession: vi.fn(async () => "sess-1"),
    listWorkingSet: vi.fn(async () => []),
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
    getAppConfig: vi.fn(async () => appConfigWith()),
    setAppConfig: vi.fn(async (cfg: AppConfig) => cfg),
    listAdapters: vi.fn(async () => [
      {
        id: "qwen-code",
        display_name: "Qwen Code",
        detected: false,
        binary_path: null,
        stream_format: "acp" as const,
      },
    ]),
    listProviderProfiles: vi.fn(async () => [
      { profile_id: "default", has_key: false, keychain_fault: null },
    ]),
    // The app-level approval channel mounts with every App render
    // (useApprovalEvents); inert no-op listeners keep jsdom off the real
    // Tauri event bridge.
    onApprovalRequest: vi.fn(async () => () => {}),
    onApprovalResolved: vi.fn(async () => () => {}),
    onApprovalAbandoned: vi.fn(async () => () => {}),
    respondToolApproval: vi.fn(async () => {}),
    onTrayOpenSession: vi.fn(async () => () => {}),
    onTrayNewSession: vi.fn(async () => () => {}),
  };
});

import App from "../App";
import { listLiveSessions, listProviderProfiles } from "../api";
import { adapterKeys } from "../session/queryKeys";
import type { LiveSessionEntry } from "../api";

// Call counter for the key-side test: TWO mount-time consumers ride the same
// IPC (the picker's overlay fetch + App's useProfileKeys), and child effects
// run before parent effects -- a Once queue would hand the first answer to
// the picker. Calls 1-2 answer keyless; later calls (the post-close epoch
// refetch) answer keyed.
let profileKeyCalls: number;

function idleLive(id: string, name: string): LiveSessionEntry {
  return {
    session_id: id,
    duck_path: `/x/${id}.duck`,
    session_name: name,
    in_flight: false,
  };
}

describe("App cold-start guidance banner wiring (issue #1337)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps the LAST implementation (not the factory's): test 1
    // overrides listLiveSessions for its active-session phase, so restore the
    // cold-start default explicitly.
    vi.mocked(listLiveSessions).mockResolvedValue([]);
    platformMock.mockReturnValue("windows");
    mintedClients.current = [];
    configHolder.current = { kind: "external", data: "qwen-code" };
    vi.stubGlobal("navigator", { language: "en-US" });
  });

  it("surfaces the degrade wall on the empty state, clears on adapter re-detection, and never renders with an active session", async () => {
    // Cold start: the default names an undetected CLI, so the startup
    // resolution degraded to built-in -- the banner must name the CLI (root
    // cause), not the key, even though the profile is keyless too.
    render(<App />);
    const status = await screen.findByRole("status");
    expect(within(status).getByText(/was not detected/i)).toBeInTheDocument();

    // The CLI side of the disappearance chain: the adapter cache updating to
    // a detected row re-derives the gap through the startup subscription and
    // unmounts the banner -- no settings round-trip involved.
    const client = mintedClients.current.at(-1);
    expect(client).toBeDefined();
    await act(async () => {
      client!.setQueryData(adapterKeys.all(), [
        {
          id: "qwen-code",
          display_name: "Qwen Code",
          detected: true,
          binary_path: "/bin/qwen-code",
          stream_format: "acp",
        },
      ]);
    });
    await waitFor(() =>
      expect(screen.queryByRole("status")).not.toBeInTheDocument(),
    );

    cleanup();
    // Active session (the #842 re-adoption sweep activates the open set):
    // the banner is cold-start-only and must not render at all.
    vi.mocked(listLiveSessions).mockResolvedValue([
      idleLive("sess-1", "Busy one"),
    ]);
    render(<App />);
    await screen.findAllByText("Busy one");
    expect(screen.queryByText(/was not detected/i)).not.toBeInTheDocument();
  });

  it("clears the key wall when a settings close bumps the epoch and the refetch lands keyed", async () => {
    // Built-in default over a keyless profile: the key-missing wall. The key
    // overlay's first fetch reports no key; the POST-close refetch (the
    // settings-close epoch bump) reports one -- the banner must vanish.
    configHolder.current = { kind: "built_in" };
    profileKeyCalls = 0;
    vi.mocked(listProviderProfiles).mockImplementation(async () => {
      profileKeyCalls += 1;
      return profileKeyCalls <= 2
        ? [{ profile_id: "default", has_key: false, keychain_fault: null }]
        : [{ profile_id: "default", has_key: true, keychain_fault: null }];
    });
    render(<App />);
    const status = await screen.findByRole("status");
    expect(within(status).getByText(/has no API key/i)).toBeInTheDocument();

    // The CTA opens the Settings overlay on the runtime section's API
    // Access sub-tab (the honest gate's destination); its close path bumps
    // the epoch.
    fireEvent.click(
      within(status).getByRole("button", { name: "Open Settings" }),
    );
    await screen.findByText("Back to workspace");
    expect(screen.getByRole("tab", { name: "API Access" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.click(document.querySelector(".settings-back")!);

    // The bump re-ran useProfileKeys; the keyed answer empties the gap and
    // the banner unmounts.
    await waitFor(() =>
      expect(screen.queryByText(/has no API key/i)).not.toBeInTheDocument(),
    );
  });
});
