import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";

import { SkillsSection } from "../SkillsSection";
import { TooltipProvider } from "../../ui/tooltip";
import {
  createSkill,
  deleteSkill,
  listSkills,
  listSkillSources,
  updateSkill,
} from "../../../api";
import type { SkillEntry } from "../../../types/skills";

// The pane drives everything through IPC + the opener plugin; mock both so the
// test never touches Tauri. revealItemInDir is the "open source location" call
// for linked skills. listSkillSources feeds the import dialog's discovery read
// (issue #367).
vi.mock("../../../api", () => ({
  listSkills: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
  listSkillSources: vi.fn(),
  importSkills: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
}));

const localSkill: SkillEntry = {
  name: "pdf-tools",
  description: "Work with PDF files.",
  acquired: "local",
  license: "MIT",
  compatibility: null,
  mcp_servers: [],
  cli_tools: [],
  body: "Use this skill when working with PDFs.\n",
  link_target: null,
  content_hash: "deadbeef",
};

const linkedSkill: SkillEntry = {
  name: "external-skill",
  description: "Imported from ~/.claude/skills.",
  acquired: "linked",
  license: null,
  compatibility: null,
  mcp_servers: [],
  cli_tools: [],
  body: "External body.\n",
  link_target: "/home/u/.claude/skills/external-skill",
  content_hash: "deadbeef",
};

// Empty-catalog English IntlProvider: FormattedMessage falls back to
// defaultMessage (the canonical English source, ADR-0052), so assertions anchor
// on stable English strings. A per-test QueryClient (retry: false) keeps
// reject-driven assertions off the retry path.
function renderWithProviders(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <TooltipProvider>{ui}</TooltipProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe("SkillsSection (issue #362)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listSkills).mockResolvedValue({ skills: [], ignored: [], root_error: null });
    vi.mocked(listSkillSources).mockResolvedValue([]);
  });

  it("lists the skills returned by listSkills", async () => {
    vi.mocked(listSkills).mockResolvedValue({
      skills: [localSkill, linkedSkill],
      ignored: [],
      root_error: null,
    });
    renderWithProviders(<SkillsSection configuredMcpIds={[]} configuredCliIds={[]} />);

    expect(await screen.findByText("pdf-tools")).toBeInTheDocument();
    expect(screen.getByText("Work with PDF files.")).toBeInTheDocument();
    expect(screen.getByText("external-skill")).toBeInTheDocument();
    expect(screen.getAllByText("local").length).toBeGreaterThan(0);
    expect(screen.getAllByText("linked").length).toBeGreaterThan(0);
  });

  it("filters by search text across name and description", async () => {
    vi.mocked(listSkills).mockResolvedValue({
      skills: [localSkill, linkedSkill],
      ignored: [],
      root_error: null,
    });
    renderWithProviders(<SkillsSection configuredMcpIds={[]} configuredCliIds={[]} />);
    await screen.findByText("pdf-tools");

    fireEvent.change(screen.getByPlaceholderText("Search skills…"), {
      target: { value: "pdf" },
    });

    expect(screen.getByText("pdf-tools")).toBeInTheDocument();
    expect(screen.queryByText("external-skill")).not.toBeInTheDocument();
  });

  it("creates a skill via the New drawer", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [], ignored: [], root_error: null });
    vi.mocked(createSkill).mockResolvedValue(localSkill);
    renderWithProviders(<SkillsSection configuredMcpIds={[]} configuredCliIds={[]} />);
    await screen.findByText("No skills yet. Click New to author one.");

    fireEvent.click(screen.getByRole("button", { name: /New/i }));

    const nameInput = await screen.findByLabelText("Name");
    const descInput = screen.getByLabelText("Description");
    fireEvent.change(nameInput, { target: { value: "pdf-tools" } });
    fireEvent.change(descInput, { target: { value: "Work with PDF files." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(createSkill).toHaveBeenCalledWith("pdf-tools", "Work with PDF files.");
    });
  });

  it("opens a local skill in the edit drawer and saves via updateSkill", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [localSkill], ignored: [], root_error: null });
    vi.mocked(updateSkill).mockResolvedValue(localSkill);
    renderWithProviders(<SkillsSection configuredMcpIds={[]} configuredCliIds={[]} />);
    await screen.findByText("pdf-tools");

    // Click the skill's name text -- it sits inside the row's click surface.
    fireEvent.click(screen.getByText("pdf-tools"));

    const bodyInput = await screen.findByLabelText("Body");
    fireEvent.change(bodyInput, { target: { value: "Updated body.\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateSkill).toHaveBeenCalledWith(
        "pdf-tools",
        expect.objectContaining({
          name: "pdf-tools",
          body: "Updated body.\n",
        }),
      );
    });
  });

  it("edits a skill's CLI tool references through the multi-select", async () => {
    // Issue #674: the drawer's CLI multi-select mirrors the MCP one. The
    // option list merges the registered names with the skill's existing
    // references, so a stale (unregistered) name stays visible + removable.
    vi.mocked(listSkills).mockResolvedValue({
      skills: [{ ...localSkill, cli_tools: ["stale-tool"] }],
      ignored: [],
      root_error: null,
    });
    vi.mocked(updateSkill).mockResolvedValue(localSkill);
    renderWithProviders(
      <SkillsSection configuredMcpIds={[]} configuredCliIds={["pandoc", "office-cli"]} />,
    );
    await screen.findByText("pdf-tools");
    fireEvent.click(screen.getByText("pdf-tools"));

    // The merged option list: both registered tools + the stale reference.
    expect(await screen.findByLabelText("pandoc")).toBeInTheDocument();
    expect(screen.getByLabelText("office-cli")).toBeInTheDocument();
    expect(screen.getByLabelText("stale-tool")).toBeInTheDocument();

    // Toggle one registered tool on, drop the stale reference, save.
    fireEvent.click(screen.getByLabelText("pandoc"));
    fireEvent.click(screen.getByLabelText("stale-tool"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateSkill).toHaveBeenCalledWith(
        "pdf-tools",
        expect.objectContaining({
          cli_tools: ["pandoc"],
        }),
      );
    });
  });

  it("renders a linked skill read-only with an Open source location button", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [linkedSkill], ignored: [], root_error: null });
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    renderWithProviders(<SkillsSection configuredMcpIds={[]} configuredCliIds={[]} />);
    await screen.findByText("external-skill");

    fireEvent.click(screen.getByText("external-skill"));

    expect(
      await screen.findByRole("button", { name: "Open source location" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Open source location" }));
    await waitFor(() => {
      expect(revealItemInDir).toHaveBeenCalledWith(linkedSkill.link_target);
    });
  });

  it("deletes a skill after confirmation", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [localSkill], ignored: [], root_error: null });
    vi.mocked(deleteSkill).mockResolvedValue(undefined);
    renderWithProviders(<SkillsSection configuredMcpIds={[]} configuredCliIds={[]} />);
    await screen.findByText("pdf-tools");

    // The delete icon button's aria-label is the skill name (exact match
    // disambiguates from the row, whose accessible name is multi-word).
    fireEvent.click(screen.getByRole("button", { name: "pdf-tools" }));
    // Confirm dialog opens; click its Delete action.
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(deleteSkill).toHaveBeenCalledWith("pdf-tools");
    });
  });

  it("surfaces a create failure as a formatted error", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [], ignored: [], root_error: null });
    vi.mocked(createSkill).mockRejectedValue({
      kind: "NameTaken",
      data: "pdf-tools",
    });
    renderWithProviders(<SkillsSection configuredMcpIds={[]} configuredCliIds={[]} />);
    await screen.findByText("No skills yet. Click New to author one.");

    fireEvent.click(screen.getByRole("button", { name: /New/i }));
    const nameInput = await screen.findByLabelText("Name");
    const descInput = screen.getByLabelText("Description");
    fireEvent.change(nameInput, { target: { value: "pdf-tools" } });
    fireEvent.change(descInput, { target: { value: "Work with PDF files." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(
        screen.getByText("A skill named \"pdf-tools\" already exists"),
      ).toBeInTheDocument();
    });
  });

  it("opens the import dialog when the Import button is clicked (issue #367)", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [], ignored: [], root_error: null });
    vi.mocked(listSkillSources).mockResolvedValue([]);
    renderWithProviders(<SkillsSection configuredMcpIds={[]} configuredCliIds={[]} />);
    await screen.findByText("No skills yet. Click New to author one.");

    // The Import button is now enabled (was disabled before #367); clicking it
    // opens the two-stage drill-down dialog, surfaced by its title.
    const importBtn = screen.getByRole("button", { name: /Import/i });
    expect(importBtn).not.toBeDisabled();
    fireEvent.click(importBtn);

    expect(await screen.findByText("Import skills")).toBeInTheDocument();
  });

  it("does not render the ignored section when the registry is clean", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [localSkill], ignored: [], root_error: null });
    renderWithProviders(<SkillsSection configuredMcpIds={[]} configuredCliIds={[]} />);
    await screen.findByText("pdf-tools");

    expect(screen.queryByTestId("skills-ignored-details")).not.toBeInTheDocument();
  });

  it("renders the ignored section with each skipped directory and its reason", async () => {
    vi.mocked(listSkills).mockResolvedValue({
      skills: [localSkill],
      ignored: [
        {
          dir: "mismatch-dir",
          reason:
            "frontmatter name `other` does not match its directory name `mismatch-dir`",
        },
        {
          dir: "no-skill-md",
          reason: "cannot read `no-skill-md/SKILL.md`: No such file or directory",
        },
      ],
      root_error: null,
    });
    renderWithProviders(<SkillsSection configuredMcpIds={[]} configuredCliIds={[]} />);
    await screen.findByText("pdf-tools");

    // The summary is always visible (the fold is closed by default); the
    // count badge mirrors the ignored array length.
    expect(screen.getByText("Ignored directories")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();

    // The reason text rides the rows verbatim -- the locale catalog owns the
    // title / intro only, NOT the per-row reason (ADR-0052 layer 4). Open
    // the fold so the rows are visible to user-driven queries.
    fireEvent.click(screen.getByText("Ignored directories"));
    expect(screen.getByText("mismatch-dir")).toBeInTheDocument();
    expect(screen.getByText("no-skill-md")).toBeInTheDocument();
    expect(
      screen.getByText(
        "frontmatter name `other` does not match its directory name `mismatch-dir`",
      ),
    ).toBeInTheDocument();
  });

  it("surfaces a listSkills IPC rejection as a formatted error (issue #375)", async () => {
    vi.mocked(listSkills).mockRejectedValue("IPC transport error");
    renderWithProviders(<SkillsSection configuredMcpIds={[]} configuredCliIds={[]} />);

    // A raw string reject falls through fmtError to the typeof === "string"
    // branch, rendered verbatim so the user sees the IPC failure rather than
    // a silent empty registry (listing stays undefined → empty skills list,
    // but the error face makes the root cause visible).
    expect(await screen.findByText("IPC transport error")).toBeInTheDocument();
  });

  it("surfaces a root_error from the scan as a diagnostic (issue #375)", async () => {
    vi.mocked(listSkills).mockResolvedValue({
      skills: [],
      ignored: [],
      root_error: "read skills root `/locked` failed: Permission denied (os error 13)",
    });
    renderWithProviders(<SkillsSection configuredMcpIds={[]} configuredCliIds={[]} />);

    // The locale-catalog prefix renders, and the dynamic root_error detail
    // rides verbatim so the user sees the OS-level reason.
    expect(await screen.findByText(/Failed to scan the skills registry/)).toBeInTheDocument();
    expect(
      screen.getByText(/Permission denied \(os error 13\)/),
    ).toBeInTheDocument();
  });
});
