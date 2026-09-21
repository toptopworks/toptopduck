import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { AgentsSection } from "../AgentsSection";
import { chooseOption, openSelect, renderSettings } from "./helpers";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  createAgent,
  deleteAgent,
  getAgentsDir,
  listAgents,
  setAgentEnabled,
  updateAgent,
} from "../../../api";
import type { AgentEntry, AgentListing } from "../../../types/agents";
import type { AppConfig } from "../../../types/app-config";
import { baseAppConfig } from "../../../test-fixtures";

// The pane drives everything through IPC; mock the API so the test never
// touches Tauri (the McpSection test posture).
vi.mock("../../../api", () => ({
  listAgents: vi.fn(),
  getAgentsDir: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(async () => baseAppConfig()),
  setAgentEnabled: vi.fn(async () => baseAppConfig()),
}));

// The opener plugin is Tauri-gated; the reveal pin lives here.
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
}));

const mockedList = vi.mocked(listAgents);
const mockedAgentsDir = vi.mocked(getAgentsDir);
const mockedReveal = vi.mocked(revealItemInDir);
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

// The shared helpers stack (empty-catalog English + retry:false + the App
// ancestor's TooltipProvider); the defaultMessage literals carry the
// assertions (the McpSection posture).
function renderSection(onAppConfigSync = vi.fn()) {
  renderSettings(<AgentsSection onAppConfigSync={onAppConfigSync} />);
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
    // A builtin row's delete affordance renders disabled (disabling is the
    // single shutdown axis; the button keeps every row's columns aligned);
    // a user row's delete stays visible.
    expect(
      screen.getByRole("button", { name: "Delete agent general-purpose" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete agent data-cleaner" }),
    ).toBeVisible();
    // The shutdown guidance (#1015): the disabled builtin delete explains
    // itself -- the reachable off-action is the row's enablement switch.
    fireEvent.pointerMove(
      screen.getByRole("button", { name: "Delete agent general-purpose" }),
    );
    expect(
      await screen.findByText(
        "Built-in agents cannot be deleted; disable the agent instead",
      ),
    ).toBeInTheDocument();
    // The Disabled badge rides the disabled row and its name dims (the
    // legibility pair); the enabled row carries neither.
    expect(screen.getByText("Disabled")).toBeVisible();
    expect(screen.getByText("general-purpose").className).toContain(
      "text-muted-foreground/60",
    );
    expect(screen.getByText("data-cleaner").className).not.toContain(
      "text-muted-foreground/60",
    );
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
      root_error: "read root failed",
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
      screen.getByText("The file holding the built-in agent reviewer could not be read."),
    ).toBeVisible();
    expect(
      screen.getByText(
        "The built-in agent writer has not materialized yet; the next app start retries.",
      ),
    ).toBeVisible();
    // The root scan error and the degradation rows coexist: the audit runs
    // even under a root fault, and each lane states its own surface.
    expect(
      screen.getByText("Couldn't load your agents: read root failed"),
    ).toBeVisible();
  });

  it("renders no degraded-builtin lane when the registry is healthy", async () => {
    await renderListed([makeEntry()]);
    expect(screen.queryByText("Built-in agents are in a degraded state:")).toBeNull();
  });

  it("creates a definition through the form", async () => {
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

  it("keeps a fresh create form free of validation red until a field is edited", async () => {
    mockedList.mockResolvedValue(makeListing([]));
    renderSection();
    await screen.findByText("No agent definitions yet. Click New to create one.");

    fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    const name = await screen.findByLabelText("Name");
    // A freshly opened create form shows no invalid marks at all.
    expect(name).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Description")).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Preamble")).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    // The first edit of a field surfaces that field's error immediately.
    fireEvent.change(name, { target: { value: "Bad Name!" } });
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/Lowercase letters, digits/)).toBeVisible();

    // The same positive half for the other two fields: a whitespace-only
    // value is invalid and flags once touched.
    const description = screen.getByLabelText("Description");
    fireEvent.change(description, { target: { value: " " } });
    expect(description).toHaveAttribute("aria-invalid", "true");
    const preamble = screen.getByLabelText("Preamble");
    fireEvent.change(preamble, { target: { value: " " } });
    expect(preamble).toHaveAttribute("aria-invalid", "true");
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

  it("returns to the list through the link in the form header", async () => {
    mockedList.mockResolvedValue(makeListing([]));
    renderSection();
    await screen.findByText("No agent definitions yet. Click New to create one.");

    fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    expect(await screen.findByLabelText("Name")).toBeVisible();
    // The form page keeps the section's navigation name above it; the list
    // header's New button does not follow (list-only).
    expect(screen.getByText("Subagents")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New agent" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to agent list" }));
    expect(await screen.findByText("No agent definitions yet. Click New to create one.")).toBeVisible();
    expect(screen.queryByLabelText("Name")).toBeNull();
  });

  it("shows the saving state and locks the back link while a save is pending", async () => {
    mockedList.mockResolvedValue(makeListing([]));
    renderSection();
    await screen.findByText("No agent definitions yet. Click New to create one.");

    // Hold the create IPC pending so the saving state is observable.
    mockedCreate.mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "data-cleaner" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Cleans data" } });
    fireEvent.change(screen.getByLabelText("Preamble"), { target: { value: "You clean data." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saving…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Back to agent list" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("edits a definition through the form", async () => {
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
  });

  it("renders the two warning lines inside the edit form", async () => {
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
    // Radix Select opens on a pointer sequence and commits on an option
    // click (the helpers posture) -- fireEvent.change is inert on it.
    const select = screen.getByLabelText("Filter by status");
    openSelect(select);
    chooseOption("Enabled");
    expect(screen.getByText("on-agent")).toBeVisible();
    expect(screen.queryByText("off-agent")).toBeNull();
    openSelect(select);
    chooseOption("Disabled");
    expect(screen.getByText("off-agent")).toBeVisible();
    expect(screen.queryByText("on-agent")).toBeNull();
  });

  it("re-lists through the refresh button", async () => {
    mockedList.mockResolvedValue(makeListing([makeEntry()]));
    renderSection();
    await screen.findByText("data-cleaner");
    expect(mockedList).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
  });

  it("reveals the backend-resolved agents directory through the opener", async () => {
    await renderListed([makeEntry()]);
    mockedAgentsDir.mockResolvedValue("C:\\app\\agents");
    mockedReveal.mockResolvedValue();
    fireEvent.click(screen.getByRole("button", { name: "Open agents folder" }));
    await waitFor(() => expect(mockedReveal).toHaveBeenCalledWith("C:\\app\\agents"));
  });

  it("surfaces a failed folder reveal on the pane error face", async () => {
    await renderListed([makeEntry()]);
    mockedAgentsDir.mockResolvedValue("C:\\app\\agents");
    // One rejection, then the default mock arm resolves -- so the recovery
    // click below also pins that the pane error face clears.
    mockedReveal.mockRejectedValueOnce(new Error("reveal boom"));
    fireEvent.click(screen.getByRole("button", { name: "Open agents folder" }));
    expect(await screen.findByText(/reveal boom/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open agents folder" }));
    await waitFor(() => expect(screen.queryByText(/reveal boom/)).toBeNull());
  });

  it("keeps a reveal failure out of an open form and back on the pane", async () => {
    await renderListed([makeEntry()]);
    mockedAgentsDir.mockResolvedValue("C:\\app\\agents");
    mockedReveal.mockRejectedValueOnce(new Error("reveal boom"));
    fireEvent.click(screen.getByRole("button", { name: "Open agents folder" }));
    expect(await screen.findByText(/reveal boom/)).toBeVisible();
    // The failure stays on the pane's own error face: opening the edit form
    // must not adopt it as a save error...
    fireEvent.click(screen.getByRole("button", { name: "Edit agent data-cleaner" }));
    expect(await screen.findByLabelText("Name")).toBeVisible();
    expect(screen.queryByText(/reveal boom/)).toBeNull();
    // ...and it is still waiting when the form closes.
    fireEvent.click(screen.getByRole("button", { name: "Back to agent list" }));
    expect(await screen.findByText(/reveal boom/)).toBeVisible();
  });

  it("flips enablement and syncs the returned config", async () => {
    const sync = vi.fn();
    const cfg = baseAppConfig({ enabled_agents: [] });
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
    mockedDelete.mockResolvedValue(baseAppConfig({ enabled_agents: [] }));
    mockedList.mockResolvedValue(makeListing([makeEntry()]));
    renderWithSync(sync);
    await screen.findByText("data-cleaner");

    fireEvent.click(screen.getByRole("button", { name: "Delete agent data-cleaner" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith("data-cleaner"));
    await waitFor(() => expect(sync).toHaveBeenCalled());
  });

  it("renders a linked row's form read-only", async () => {
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
function renderWithSync(sync: (cfg: AppConfig) => void) {
  renderSettings(<AgentsSection onAppConfigSync={sync} />);
}
