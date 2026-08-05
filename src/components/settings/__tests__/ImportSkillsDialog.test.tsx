import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";

import { ImportSkillsDialog } from "../ImportSkillsDialog";
import { importSkills, listSkillSources } from "../../../api";
import * as dialogPlugin from "@tauri-apps/plugin-dialog";
import type { ImportOutcome, SkillSource } from "../../../types/skills";

// The dialog drives everything through IPC + the directory picker; mock both
// so the test never touches Tauri.
vi.mock("../../../api", () => ({
  listSkillSources: vi.fn(),
  importSkills: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

const importableSkill = {
  name: "alpha",
  description: "First skill.",
  source_dir: "/home/u/.claude/skills/alpha",
  status: "importable" as const,
  reason: null,
};

const alreadyExistsSkill = {
  name: "taken",
  description: "Already in registry.",
  source_dir: "/home/u/.claude/skills/taken",
  status: "already_exists" as const,
  reason: null,
};

const invalidSkill = {
  name: "bad",
  description: null,
  source_dir: "/home/u/.claude/skills/bad",
  status: "invalid" as const,
  reason: "cannot read `/home/u/.claude/skills/bad/SKILL.md`: No such file",
};

const claudeSource: SkillSource = {
  id: "claude-code",
  label: "Claude Code",
  path: "/home/u/.claude/skills",
  skills: [alreadyExistsSkill, invalidSkill, importableSkill],
};

// Empty-catalog English IntlProvider: FormattedMessage falls back to
// defaultMessage, so assertions anchor on stable English strings. A per-test
// QueryClient (retry: false) keeps reject-driven assertions off the retry path.
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

describe("ImportSkillsDialog (issue #367)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listSkillSources).mockResolvedValue([]);
    vi.mocked(importSkills).mockResolvedValue([]);
    vi.mocked(dialogPlugin.open).mockResolvedValue(null);
  });

  it("renders each discovered source collapsed with a count badge", async () => {
    vi.mocked(listSkillSources).mockResolvedValue([claudeSource]);
    renderWithProviders(<ImportSkillsDialog onClose={() => {}} />);

    // The source label + path + count badge render in the collapsed header.
    expect(await screen.findByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("/home/u/.claude/skills")).toBeInTheDocument();
    // 3 skills discovered -> the count badge.
    expect(screen.getByText("3")).toBeInTheDocument();
    // Skills are hidden until the source is expanded.
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
  });

  it("expands a source to reveal its skills with inline validation", async () => {
    vi.mocked(listSkillSources).mockResolvedValue([claudeSource]);
    renderWithProviders(<ImportSkillsDialog onClose={() => {}} />);
    await screen.findByText("Claude Code");

    // Click the expand toggle (aria-label "Expand {label}" via i18n).
    fireEvent.click(screen.getByRole("button", { name: /expand/i }));

    expect(await screen.findByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("First skill.")).toBeInTheDocument();
    // already_exists + invalid surface their badges.
    expect(screen.getByText("exists")).toBeInTheDocument();
    expect(screen.getByText("invalid")).toBeInTheDocument();
    // The invalid row carries its English reason as the tooltip on the row
    // wrapper div.
    expect(screen.getByText("bad").closest("[data-testid='import-skill-row']")).toHaveAttribute(
      "title",
      "cannot read `/home/u/.claude/skills/bad/SKILL.md`: No such file",
    );
  });

  it("selects and deselects an importable skill, gating the Import button", async () => {
    vi.mocked(listSkillSources).mockResolvedValue([claudeSource]);
    renderWithProviders(<ImportSkillsDialog onClose={() => {}} />);
    await screen.findByText("Claude Code");
    fireEvent.click(screen.getByRole("button", { name: /expand/i }));

    const alpha = await screen.findByText("alpha");
    // Import is gray at zero selections.
    const importBtn = screen.getByTestId("import-action") as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true);

    fireEvent.click(alpha);
    await waitFor(() => expect(importBtn.disabled).toBe(false));
    expect(importBtn.textContent).toContain("Import 1");

    fireEvent.click(alpha);
    await waitFor(() => expect(importBtn.disabled).toBe(true));
    expect(importBtn.textContent).toContain("Import 0");
  });

  it("excludes already-exists and invalid skills from selection", async () => {
    vi.mocked(listSkillSources).mockResolvedValue([claudeSource]);
    renderWithProviders(<ImportSkillsDialog onClose={() => {}} />);
    await screen.findByText("Claude Code");
    fireEvent.click(screen.getByRole("button", { name: /expand/i }));
    await screen.findByText("alpha");

    // The already-exists + invalid rows' checkboxes are disabled.
    const takenCheckbox = screen.getByLabelText("taken") as HTMLInputElement;
    const badCheckbox = screen.getByLabelText("bad") as HTMLInputElement;
    expect(takenCheckbox.disabled).toBe(true);
    expect(badCheckbox.disabled).toBe(true);
    // The alpha (importable) checkbox is enabled.
    expect((screen.getByLabelText("alpha") as HTMLInputElement).disabled).toBe(false);
  });

  it("select-all picks only the importable skills in a source", async () => {
    vi.mocked(listSkillSources).mockResolvedValue([claudeSource]);
    renderWithProviders(<ImportSkillsDialog onClose={() => {}} />);
    await screen.findByText("Claude Code");
    fireEvent.click(screen.getByRole("button", { name: /expand/i }));
    await screen.findByText("alpha");

    // The source-header select-all checkbox is labelled by the source label.
    fireEvent.click(screen.getByLabelText("Claude Code"));
    // Only alpha is importable -> 1 selected.
    expect(
      (screen.getByLabelText("alpha") as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.getByTestId("import-action").textContent).toContain("Import 1");

    // Toggling again clears the source.
    fireEvent.click(screen.getByLabelText("Claude Code"));
    expect(
      (screen.getByLabelText("alpha") as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("imports the selected skills in the chosen mode and closes on full success", async () => {
    vi.mocked(listSkillSources).mockResolvedValue([claudeSource]);
    const imported: ImportOutcome = {
      kind: "imported",
      data: {
        name: "alpha",
        description: "First skill.",
        acquired: "linked",
        license: null,
        compatibility: null,
        mcp_servers: [],
        body: "Body.\n",
        link_target: "/home/u/.claude/skills/alpha",
        content_hash: "abc",
      },
    };
    vi.mocked(importSkills).mockResolvedValue([imported]);
    const onClose = vi.fn();
    renderWithProviders(<ImportSkillsDialog onClose={onClose} />);
    await screen.findByText("Claude Code");
    fireEvent.click(screen.getByRole("button", { name: /expand/i }));
    fireEvent.click(await screen.findByText("alpha"));

    fireEvent.click(screen.getByTestId("import-action"));
    await waitFor(() => {
      expect(importSkills).toHaveBeenCalledWith(
        [{ source_dir: "/home/u/.claude/skills/alpha" }],
        "link",
      );
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("switches to copy mode in the bottom dropdown", async () => {
    vi.mocked(listSkillSources).mockResolvedValue([claudeSource]);
    vi.mocked(importSkills).mockResolvedValue([]);
    renderWithProviders(<ImportSkillsDialog onClose={() => {}} />);
    await screen.findByText("Claude Code");
    fireEvent.click(screen.getByRole("button", { name: /expand/i }));
    fireEvent.click(await screen.findByText("alpha"));

    fireEvent.change(screen.getByTestId("import-mode-select"), {
      target: { value: "copy" },
    });
    fireEvent.click(screen.getByTestId("import-action"));
    await waitFor(() => {
      expect(importSkills).toHaveBeenCalledWith(
        expect.anything(),
        "copy",
      );
    });
  });

  it("surfaces a partial-failure error and keeps the dialog open", async () => {
    vi.mocked(listSkillSources).mockResolvedValue([claudeSource]);
    vi.mocked(importSkills).mockResolvedValue([
      {
        kind: "failed",
        data: { kind: "NameTaken", data: "alpha" },
      },
    ]);
    const onClose = vi.fn();
    renderWithProviders(<ImportSkillsDialog onClose={onClose} />);
    await screen.findByText("Claude Code");
    fireEvent.click(screen.getByRole("button", { name: /expand/i }));
    fireEvent.click(await screen.findByText("alpha"));
    fireEvent.click(screen.getByTestId("import-action"));

    await waitFor(() =>
      expect(
        screen.getByText("A skill named \"alpha\" already exists"),
      ).toBeInTheDocument(),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("adds a custom path via the directory picker and re-discovers", async () => {
    // First call: no custom paths -> empty. Second call (after picking): the
    // custom source appears.
    vi.mocked(listSkillSources).mockImplementation(async (customPaths) => {
      if (customPaths.includes("/custom/lib")) {
        return [
          {
            id: "/custom/lib",
            label: "lib",
            path: "/custom/lib",
            skills: [
              {
                name: "custom-skill",
                description: "From custom path.",
                source_dir: "/custom/lib/custom-skill",
                status: "importable",
                reason: null,
              },
            ],
          },
        ];
      }
      return [];
    });
    vi.mocked(dialogPlugin.open).mockResolvedValue("/custom/lib");
    renderWithProviders(<ImportSkillsDialog onClose={() => {}} />);

    // Initially empty.
    expect(
      await screen.findByText(
        "No skill sources found. Click \"+ Add custom path\" to browse.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("import-add-custom-path"));
    // The custom source auto-expands and its skill shows.
    expect(await screen.findByText("custom-skill")).toBeInTheDocument();
    // The picker was invoked as a directory picker.
    expect(dialogPlugin.open).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
    });
  });

  it("renders an empty-state message when no sources are discovered", async () => {
    vi.mocked(listSkillSources).mockResolvedValue([]);
    renderWithProviders(<ImportSkillsDialog onClose={() => {}} />);
    expect(
      await screen.findByText(
        "No skill sources found. Click \"+ Add custom path\" to browse.",
      ),
    ).toBeInTheDocument();
  });
});
