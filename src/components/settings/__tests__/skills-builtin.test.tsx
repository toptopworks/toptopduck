import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IntlProvider } from "react-intl";

import { SkillsSection } from "../SkillsSection";
import { TooltipProvider } from "../../ui/tooltip";
import { listSkills, restoreBuiltinSkill } from "../../../api";
import type { AppConfig } from "../../../types/app-config";
import type { SkillEntry } from "../../../types/skills";

// The builtin-skill surface of the settings pane (issue #677): the built-in
// badge + no delete entry, the Edited derivation off the baseline side table,
// the restore confirmation lane, and the locked name in the edit drawer.
vi.mock("../../../api", () => ({
  listSkills: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
  restoreBuiltinSkill: vi.fn(),
  listSkillSources: vi.fn(),
  importSkills: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
}));

const builtinSkill: SkillEntry = {
  name: "pandoc",
  description: "Convert documents between formats.",
  acquired: "builtin",
  license: null,
  compatibility: null,
  mcp_servers: [],
  cli_tools: ["pandoc"],
  body: "Use the `pandoc` tool…\n",
  link_target: null,
  content_hash: "hash-of-shipped-body",
};

const restoredConfig = {
  format_version: 1,
  theme: "system",
  locale: "system",
  engine: {},
  privacy: {},
  provider: {},
  export: {},
  tunables: {},
  shell: {},
  mcp_servers: { servers: [] },
  cli_tools: { tools: [] },
  builtin_skill_baselines: {},
  sessions_dir: null,
  default_runtime: { kind: "builtin" },
  last_model_postures: {},
} as unknown as AppConfig;

// The pane under test, parameterized by the side table (the Edited
// derivation's anchor). Empty-catalog English IntlProvider: FormattedMessage
// falls back to defaultMessage (the canonical English source, ADR-0052).
function renderSection(baselines: Record<string, { hash: string; locale: string }>) {
  const onSync = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <TooltipProvider>
          <SkillsSection
            configuredMcpIds={[]}
            configuredCliIds={["pandoc"]}
            builtinSkillBaselines={baselines}
            onAppConfigSync={onSync}
          />
        </TooltipProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return onSync;
}

describe("SkillsSection builtin rows (issue #677)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listSkills).mockResolvedValue({
      skills: [builtinSkill],
      ignored: [],
      root_error: null,
    });
  });

  it("shows the system badge and no delete entry on a builtin row", async () => {
    renderSection({ pandoc: { hash: "hash-of-shipped-body", locale: "en-US" } });
    const row = await screen.findByTestId("skill-row");
    expect(row).toHaveTextContent("system");
    // Undeletable: the trash button does not render on a builtin row.
    expect(row.querySelector("button[aria-label='pandoc']")).toBeNull();
  });

  it("shows no Edited badge on a row agreeing with its recorded baseline", async () => {
    renderSection({ pandoc: { hash: "hash-of-shipped-body", locale: "en-US" } });
    const row = await screen.findByTestId("skill-row");
    expect(row).not.toHaveTextContent("Edited");
  });

  it("shows Edited + restore on a drifted hash and restores through the confirm lane", async () => {
    const onSync = renderSection({
      pandoc: { hash: "an-older-recorded-hash", locale: "en-US" },
    });
    const row = await screen.findByTestId("skill-row");
    expect(row).toHaveTextContent("Edited");
    vi.mocked(restoreBuiltinSkill).mockResolvedValue(restoredConfig);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Restore built-in definition for skill pandoc",
      }),
    );
    // The confirm-dialog gate: the IPC fires only after the action.
    expect(restoreBuiltinSkill).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => {
      expect(restoreBuiltinSkill).toHaveBeenCalledWith("pandoc");
    });
    await waitFor(() => {
      expect(onSync).toHaveBeenCalledWith(restoredConfig);
    });
  });

  it("locks the name input when editing a builtin skill", async () => {
    renderSection({ pandoc: { hash: "hash-of-shipped-body", locale: "en-US" } });
    fireEvent.click(await screen.findByTestId("skill-row"));
    const nameInput = await screen.findByLabelText("Name");
    expect(nameInput).toBeDisabled();
    expect(screen.getByText("Built-in skill names are locked")).toBeInTheDocument();
    // The rest of the drawer stays editable (save is present).
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("filters builtin rows through the acquired filter", async () => {
    renderSection({ pandoc: { hash: "hash-of-shipped-body", locale: "en-US" } });
    await screen.findByTestId("skill-row");
    const filter = document.getElementById("skills-acquired-filter") as HTMLSelectElement;
    fireEvent.change(filter, { target: { value: "builtin" } });
    expect(screen.getByTestId("skill-row")).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: "local" } });
    expect(screen.queryByTestId("skill-row")).toBeNull();
  });
});
