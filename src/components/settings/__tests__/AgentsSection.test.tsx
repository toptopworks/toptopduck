import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { IntlProvider } from "react-intl";

import { AgentsSection } from "../AgentsSection";
import {
  createAgent,
  deleteAgent,
  listAgents,
  setAgentEnabled,
  updateAgent,
} from "../../../api";
import type { AgentEntry, AgentListing } from "../../../types/agents";

// The pane drives everything through IPC; mock the API so the test never
// touches Tauri (the McpSection test posture).
vi.mock("../../../api", () => ({
  listAgents: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  setAgentEnabled: vi.fn(),
}));

const mockedList = vi.mocked(listAgents);
const mockedCreate = vi.mocked(createAgent);
const mockedUpdate = vi.mocked(updateAgent);
const mockedDelete = vi.mocked(deleteAgent);
const mockedSetEnabled = vi.mocked(setAgentEnabled);

function makeEntry(overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    name: "data-cleaner",
    description: "Cleans datasets.",
    preamble: "You clean data.\n",
    source: "user",
    enabled: true,
    link_target: null,
    skill_refs: [],
    dangling_skill_refs: [],
    dropped_axes: [],
    ...overrides,
  };
}

function makeListing(agents: AgentEntry[], overrides: Partial<AgentListing> = {}): AgentListing {
  return { agents, ignored: [], warnings: [], root_error: null, ...overrides };
}

// Empty-catalog English IntlProvider + QueryClient (retry: false) -- the
// defaultMessage literals carry the assertions (the McpSection posture).
function renderSection(onAppConfigSync = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <AgentsSection onAppConfigSync={onAppConfigSync} />
      </IntlProvider>
    </QueryClientProvider>,
  );
  return onAppConfigSync;
}

async function renderListed(
  agents: AgentEntry[],
  overrides: Partial<AgentListing> = {},
): Promise<ReturnType<typeof renderSection>> {
  mockedList.mockResolvedValue(makeListing(agents, overrides));
  const sync = renderSection();
  await screen.findByText(agents[0]?.name ?? "No agent definitions yet.");
  return sync;
}

describe("AgentsSection (issue #932)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the empty state when the registry lists nothing", async () => {
    mockedList.mockResolvedValue(makeListing([]));
    renderSection();
    expect(
      await screen.findByText("No agent definitions yet. Click New to create one."),
    ).toBeVisible();
  });

  it("renders rows with the source badge and dimming disabled rows", async () => {
    await renderListed([
      makeEntry(),
      makeEntry({ name: "general-purpose", description: "Fallback.", source: "builtin", enabled: false }),
    ]);
    expect(await screen.findByText("data-cleaner")).toBeVisible();
    expect(screen.getByText("Custom")).toBeVisible();
    expect(screen.getByText("Built-in")).toBeVisible();
    // A builtin row renders no delete affordance (disabling is the single
    // shutdown axis); a user row does.
    expect(
      screen.queryByRole("button", { name: "Delete agent general-purpose" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Delete agent data-cleaner" }),
    ).toBeVisible();
  });

  it("surfaces skipped files as a warning line", async () => {
    await renderListed([makeEntry()], {
      ignored: [{ file: "broken.md", reason: "invalid agent definition: no fence" }],
    });
    expect(
      screen.getByText("Some files in the agents registry could not be loaded:"),
    ).toBeVisible();
    expect(screen.getByText("broken.md")).toBeVisible();
  });

  it("renders each builtin degradation warning with its posture wording (issue #937)", async () => {
    await renderListed([makeEntry()], {
      warnings: [
        { state: "deferred", name: "general-purpose" },
        { state: "read_fault", name: "reviewer" },
        { state: "not_materialized", name: "writer" },
      ],
    });
    expect(screen.getByText("Built-in agents are in a degraded state:")).toBeVisible();
    expect(
      screen.getByText(
        "A built-in agent is waiting for the name general-purpose: it materializes " +
        "once the file is renamed or removed and the app restarts.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "The file holding the built-in agent reviewer could not be read (permissions or a lock).",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "The built-in agent writer failed to materialize (disk or permissions); the " +
        "next app start retries.",
      ),
    ).toBeVisible();
  });

  it("renders no degraded-builtin lane when the registry is healthy", async () => {
    await renderListed([makeEntry()]);
    expect(screen.queryByText("Built-in agents are in a degraded state:")).toBeNull();
  });

  it("creates a definition through the dialog", async () => {
    mockedCreate.mockResolvedValue(makeEntry());
    mockedList.mockResolvedValue(makeListing([]));
    renderSection();
    await screen.findByText("No agent definitions yet. Click New to create one.");

    fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "data-cleaner" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Cleans datasets." },
    });
    fireEvent.change(screen.getByLabelText("Preamble"), {
      target: { value: "You clean data." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith(
        "data-cleaner",
        "Cleans datasets.",
        "You clean data.",
      ),
    );
  });

  it("gates Save on the client-side name rule", async () => {
    mockedList.mockResolvedValue(makeListing([]));
    renderSection();
    await screen.findByText("No agent definitions yet. Click New to create one.");

    fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Bad_Name",
      },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "d" },
    });
    fireEvent.change(screen.getByLabelText("Preamble"), {
      target: { value: "p" },
    });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(
      screen.getByText("Lowercase letters, digits, and single hyphens (max 64 chars)"),
    ).toBeVisible();
  });

  it("gates Save on an empty name in create mode before any IPC round-trip", async () => {
    mockedList.mockResolvedValue(makeListing([]));
    renderSection();
    await screen.findByText("No agent definitions yet. Click New to create one.");

    fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    fireEvent.change(await screen.findByLabelText("Description"), {
      target: { value: "d" },
    });
    fireEvent.change(screen.getByLabelText("Preamble"), {
      target: { value: "p" },
    });
    // The untouched empty name never reaches the backend (the InvalidName
    // reject used to be the only gate for this shape).
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("edits a definition through the dialog", async () => {
    mockedUpdate.mockResolvedValue(makeEntry());
    await renderListed([makeEntry()]);

    fireEvent.click(screen.getByRole("button", { name: "Edit agent data-cleaner" }));
    fireEvent.change(await screen.findByLabelText("Description"), {
      target: { value: "Cleans everything." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockedUpdate).toHaveBeenCalledWith("data-cleaner", {
        name: "data-cleaner",
        description: "Cleans everything.",
        preamble: "You clean data.\n",
      }),
    );
  });

  it("locks the name field on a builtin edit", async () => {
    await renderListed([
      makeEntry({ name: "general-purpose", source: "builtin" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Edit agent general-purpose" }));
    expect(await screen.findByLabelText("Name")).toBeDisabled();
    expect(screen.getByText("A built-in agent keeps its name.")).toBeVisible();
  });

  it("renders the two warning lines inside an edit dialog", async () => {
    await renderListed([
      makeEntry({
        dangling_skill_refs: ["ghost-skill"],
        dropped_axes: ["tools", "model"],
      }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Edit agent data-cleaner" }));
    expect(await screen.findByText(/Unknown skill reference/)).toBeVisible();
    expect(screen.getByText(/Unknown skill reference/).textContent).toContain(
      "ghost-skill",
    );
    expect(screen.getByText("Ignored by this app: tools, model")).toBeVisible();
  });

  it("filters rows by the search box and shows the no-match line", async () => {
    await renderListed([
      makeEntry({ name: "data-cleaner", description: "Cleans datasets." }),
      makeEntry({ name: "sql-explorer", description: "Explores SQL." }),
    ]);
    fireEvent.change(screen.getByPlaceholderText("Search agents…"), {
      target: { value: "sql" },
    });
    expect(screen.getByText("sql-explorer")).toBeVisible();
    expect(screen.queryByText("data-cleaner")).toBeNull();
    // Narrow past everything: the no-match line replaces the list.
    fireEvent.change(screen.getByPlaceholderText("Search agents…"), {
      target: { value: "nope" },
    });
    expect(screen.getByText("No agents match your search.")).toBeVisible();
  });

  it("filters rows by enablement status", async () => {
    await renderListed([
      makeEntry({ name: "on-agent", enabled: true }),
      makeEntry({ name: "off-agent", enabled: false }),
    ]);
    const select = screen.getByLabelText("Filter by status");
    fireEvent.change(select, { target: { value: "enabled" } });
    expect(screen.getByText("on-agent")).toBeVisible();
    expect(screen.queryByText("off-agent")).toBeNull();
    fireEvent.change(select, { target: { value: "disabled" } });
    expect(screen.getByText("off-agent")).toBeVisible();
    expect(screen.queryByText("on-agent")).toBeNull();
    // Filtering to an empty slice shows the no-match line.
    fireEvent.change(select, { target: { value: "enabled" } });
    fireEvent.change(select, { target: { value: "disabled" } });
  });

  it("re-lists through the refresh button", async () => {
    mockedList.mockResolvedValue(makeListing([makeEntry()]));
    renderSection();
    await screen.findByText("data-cleaner");
    expect(mockedList).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
  });

  it("flips enablement and syncs the returned config", async () => {
    const sync = vi.fn();
    const cfg = { enabled_agents: [] } as never;
    mockedSetEnabled.mockResolvedValue(cfg);
    mockedList.mockResolvedValue(makeListing([makeEntry({ enabled: false })]));
    renderWithSync(sync);
    await screen.findByText("data-cleaner");
    fireEvent.click(screen.getByRole("switch", { name: "Enable agent data-cleaner" }));
    await waitFor(() => expect(mockedSetEnabled).toHaveBeenCalledWith("data-cleaner", true));
    await waitFor(() => expect(sync).toHaveBeenCalledWith(cfg));
  });

  it("deletes a user definition after confirmation and syncs the config", async () => {
    const sync = vi.fn();
    mockedDelete.mockResolvedValue({ enabled_agents: [] } as never);
    mockedList.mockResolvedValue(makeListing([makeEntry()]));
    renderWithSync(sync);
    await screen.findByText("data-cleaner");

    fireEvent.click(screen.getByRole("button", { name: "Delete agent data-cleaner" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith("data-cleaner"));
    await waitFor(() => expect(sync).toHaveBeenCalled());
  });

  it("renders a linked row's dialog read-only", async () => {
    await renderListed([
      makeEntry({ source: "linked", link_target: "/outside/external.md" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Edit agent data-cleaner" }));
    expect(await screen.findByLabelText("Name")).toBeDisabled();
    expect(screen.getByLabelText("Description")).toBeDisabled();
    expect(screen.getByLabelText("Preamble")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(
      screen.getByText(
        "This definition is linked from outside the app. Edits happen at the source.",
      ),
    ).toBeVisible();
  });
});

// A small render variant that captures the sync callback (the describe's
// enablement/delete cases need to assert on it).
function renderWithSync(sync: (cfg: unknown) => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <AgentsSection onAppConfigSync={sync as never} />
      </IntlProvider>
    </QueryClientProvider>,
  );
  return utils;
}
