import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";

import { SkillsSection } from "../SkillsSection";
import {
  createSkill,
  deleteSkill,
  listSkills,
  updateSkill,
} from "../../../api";
import type { SkillEntry } from "../../../types/skills";

// The pane drives everything through IPC + the opener plugin; mock both so the
// test never touches Tauri. revealItemInDir is the "open source location" call
// for linked skills.
vi.mock("../../../api", () => ({
  listSkills: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
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
  body: "Use this skill when working with PDFs.\n",
  link_target: null,
};

const linkedSkill: SkillEntry = {
  name: "external-skill",
  description: "Imported from ~/.claude/skills.",
  acquired: "linked",
  license: null,
  compatibility: null,
  mcp_servers: [],
  body: "External body.\n",
  link_target: "/home/u/.claude/skills/external-skill",
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
        {ui}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe("SkillsSection (issue #362)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listSkills).mockResolvedValue([]);
  });

  it("lists the skills returned by listSkills", async () => {
    vi.mocked(listSkills).mockResolvedValue([localSkill, linkedSkill]);
    renderWithProviders(<SkillsSection configuredMcpIds={[]} />);

    expect(await screen.findByText("pdf-tools")).toBeInTheDocument();
    expect(screen.getByText("Work with PDF files.")).toBeInTheDocument();
    expect(screen.getByText("external-skill")).toBeInTheDocument();
    expect(screen.getAllByText("local").length).toBeGreaterThan(0);
    expect(screen.getAllByText("linked").length).toBeGreaterThan(0);
  });

  it("filters by search text across name and description", async () => {
    vi.mocked(listSkills).mockResolvedValue([localSkill, linkedSkill]);
    renderWithProviders(<SkillsSection configuredMcpIds={[]} />);
    await screen.findByText("pdf-tools");

    fireEvent.change(screen.getByPlaceholderText("Search skills…"), {
      target: { value: "pdf" },
    });

    expect(screen.getByText("pdf-tools")).toBeInTheDocument();
    expect(screen.queryByText("external-skill")).not.toBeInTheDocument();
  });

  it("creates a skill via the New drawer", async () => {
    vi.mocked(listSkills).mockResolvedValue([]);
    vi.mocked(createSkill).mockResolvedValue(localSkill);
    renderWithProviders(<SkillsSection configuredMcpIds={[]} />);
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
    vi.mocked(listSkills).mockResolvedValue([localSkill]);
    vi.mocked(updateSkill).mockResolvedValue(localSkill);
    renderWithProviders(<SkillsSection configuredMcpIds={[]} />);
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

  it("renders a linked skill read-only with an Open source location button", async () => {
    vi.mocked(listSkills).mockResolvedValue([linkedSkill]);
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    renderWithProviders(<SkillsSection configuredMcpIds={[]} />);
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
    vi.mocked(listSkills).mockResolvedValue([localSkill]);
    vi.mocked(deleteSkill).mockResolvedValue(undefined);
    renderWithProviders(<SkillsSection configuredMcpIds={[]} />);
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
    vi.mocked(listSkills).mockResolvedValue([]);
    vi.mocked(createSkill).mockRejectedValue({
      kind: "NameTaken",
      data: "pdf-tools",
    });
    renderWithProviders(<SkillsSection configuredMcpIds={[]} />);
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
});
