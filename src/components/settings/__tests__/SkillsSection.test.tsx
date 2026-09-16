import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";

import { SkillsSection } from "../SkillsSection";
import { TooltipProvider } from "../../ui/tooltip";
import { chooseOption, openSelect } from "./helpers";
import {
  createSkill,
  deleteSkill,
  listSkills,
  listSkillSources,
  setSkillEnabled,
  updateSkill,
} from "../../../api";
import type { SkillEntry } from "../../../types/skills";
import type { AppConfig } from "../../../types/app-config";
import { baseAppConfig, skillEntry } from "../../../test-fixtures";

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
  setSkillEnabled: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
}));

const localSkill = skillEntry("pdf-tools", {
  description: "Work with PDF files.",
  license: "MIT",
  compatibility: "requires network",
  body: "Use this skill when working with PDFs.\n",
  content_hash: "deadbeef",
});

const linkedSkill = skillEntry("external-skill", {
  description: "Imported from ~/.claude/skills.",
  acquired: "linked",
  body: "External body.\n",
  link_target: "/home/u/.claude/skills/external-skill",
  content_hash: "deadbeef",
});

// The sync-contract mock's AppConfig: the shared baseline plus the one field
// under test (the disabled_skills entry is the post-flip truth of the test
// below).
function syncedAppConfig(): AppConfig {
  return baseAppConfig({ disabled_skills: ["pdf-tools"] });
}

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

  it("flips a row's enablement through setSkillEnabled and syncs the config", async () => {
    // The enablement axis row Switch (issue #961): unchecking rides the
    // setSkillEnabled IPC and syncs the returned full app-config wholesale
    // (the restore command's state-only-sync contract). Two interaction
    // halves ride the same test: the switch click must NOT bubble into the
    // row's open-edit drawer, and the listing must refetch so the row's
    // enabled follows the flipped axis (the command returns the config
    // alone -- without the refetch the switch would visually snap back).
    const onAppConfigSync = vi.fn();
    const synced = syncedAppConfig();
    vi.mocked(setSkillEnabled).mockResolvedValue(synced);
    vi.mocked(listSkills)
      .mockResolvedValueOnce({
        skills: [localSkill],
        ignored: [],
        root_error: null,
      })
      .mockResolvedValue({
        skills: [{ ...localSkill, enabled: false }],
        ignored: [],
        root_error: null,
      });
    renderWithProviders(
      <SkillsSection
        builtinSkillBaselines={{}}
        onAppConfigSync={onAppConfigSync}
      />,
    );
    const row = await screen.findByTestId("skill-row");
    expect(row).not.toHaveAttribute("data-disabled");
    fireEvent.click(screen.getByRole("switch", { name: "Enable skill pdf-tools" }));
    await waitFor(() =>
      expect(setSkillEnabled).toHaveBeenCalledWith("pdf-tools", false),
    );
    await waitFor(() => expect(onAppConfigSync).toHaveBeenCalledWith(synced));
    // The bubble guard: the row is one big open-edit button; the switch
    // click must not ride the row's onClick up into the drawer.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The refetch half: the listing is queried again and the row grays.
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId("skill-row")).toHaveAttribute(
        "data-disabled",
        "true",
      ),
    );
  });

  it("marks a disabled row grayed out while its switch stays operable", async () => {
    // Dormant-on-disable (issue #961): a disabled skill renders as a grayed
    // row (data-disabled carries the state for tests + styling hooks), the
    // switch reads unchecked, and the row itself stays clickable (the
    // edit drawer still opens -- disabling hides from discovery, not from
    // management).
    vi.mocked(listSkills).mockResolvedValue({
      skills: [{ ...localSkill, enabled: false }],
      ignored: [],
      root_error: null,
    });
    renderWithProviders(
      <SkillsSection
        builtinSkillBaselines={{}}
        onAppConfigSync={() => {}}
      />,
    );
    const row = await screen.findByTestId("skill-row");
    expect(row).toHaveAttribute("data-disabled", "true");
    expect(
      screen.getByRole("switch", { name: "Enable skill pdf-tools" }),
    ).not.toBeChecked();
  });

  it("lists the skills returned by listSkills", async () => {
    vi.mocked(listSkills).mockResolvedValue({
      skills: [localSkill, linkedSkill],
      ignored: [],
      root_error: null,
    });
    renderWithProviders(
      <SkillsSection
        builtinSkillBaselines={{}}
        onAppConfigSync={() => {}}
      />,
    );

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
    renderWithProviders(
      <SkillsSection
        builtinSkillBaselines={{}}
        onAppConfigSync={() => {}}
      />,
    );
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
    renderWithProviders(
      <SkillsSection
        builtinSkillBaselines={{}}
        onAppConfigSync={() => {}}
      />,
    );
    await screen.findByText("No skills yet. Click New to create one.");

    fireEvent.click(screen.getByRole("button", { name: /New/i }));

    const nameInput = await screen.findByLabelText("Name");
    const descInput = screen.getByLabelText("Description");
    const bodyInput = screen.getByLabelText("Instructions");
    fireEvent.change(nameInput, { target: { value: "pdf-tools" } });
    fireEvent.change(descInput, { target: { value: "Work with PDF files." } });
    fireEvent.change(bodyInput, { target: { value: "Use when working with PDFs.\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(createSkill).toHaveBeenCalledWith(
        "pdf-tools",
        "Work with PDF files.",
        "Use when working with PDFs.\n",
      );
    });
  });

  it("keeps the create drawer quiet when pristine fields blur", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [], ignored: [], root_error: null });
    renderWithProviders(
      <SkillsSection
        builtinSkillBaselines={{}}
        onAppConfigSync={() => {}}
      />,
    );
    await screen.findByText("No skills yet. Click New to create one.");

    fireEvent.click(screen.getByRole("button", { name: /New/i }));
    const nameInput = await screen.findByLabelText("Name");

    // The dialog auto-focuses the name field, so a click-away blur lands
    // on pristine inputs; empty content must not surface any invalid hint.
    fireEvent.blur(nameInput);
    fireEvent.blur(screen.getByLabelText("Description"));
    fireEvent.blur(screen.getByLabelText("Instructions"));
    expect(
      screen.queryByText(/Use only lowercase letters/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Description is required."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Instructions can't be empty."),
    ).not.toBeInTheDocument();
  });

  it("arms the description hint once an edited field goes blank", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [], ignored: [], root_error: null });
    renderWithProviders(
      <SkillsSection
        builtinSkillBaselines={{}}
        onAppConfigSync={() => {}}
      />,
    );
    await screen.findByText("No skills yet. Click New to create one.");

    fireEvent.click(screen.getByRole("button", { name: /New/i }));

    // A valid edit + blur arms the field without surfacing the hint.
    fireEvent.change(await screen.findByLabelText("Description"), {
      target: { value: "Work with PDF files." },
    });
    fireEvent.blur(screen.getByLabelText("Description"));
    expect(
      screen.queryByText("Description is required."),
    ).not.toBeInTheDocument();

    // Blanking the armed field surfaces the rule immediately.
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "" },
    });
    expect(screen.getByText("Description is required.")).toBeInTheDocument();
  });

  it("surfaces the create-mode body hint once the armed field goes blank", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [], ignored: [], root_error: null });
    renderWithProviders(
      <SkillsSection
        builtinSkillBaselines={{}}
        onAppConfigSync={() => {}}
      />,
    );
    await screen.findByText("No skills yet. Click New to create one.");

    fireEvent.click(screen.getByRole("button", { name: /New/i }));

    // A valid edit + blur arms the field without surfacing the hint.
    fireEvent.change(await screen.findByLabelText("Instructions"), {
      target: { value: "Body text.\n" },
    });
    fireEvent.blur(screen.getByLabelText("Instructions"));
    expect(
      screen.queryByText("Instructions can't be empty."),
    ).not.toBeInTheDocument();

    // Blanking the armed field surfaces the rule immediately: create mode
    // owns the body field since the one-form fold.
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "" },
    });
    expect(screen.getByText("Instructions can't be empty.")).toBeInTheDocument();
  });

  it("closes the drawer after a one-form create", async () => {
    // The create dialog captures name + description + body in one pass, so
    // a successful mint closes it instead of stepping into an edit drawer.
    vi.mocked(listSkills).mockResolvedValue({ skills: [], ignored: [], root_error: null });
    vi.mocked(createSkill).mockResolvedValue(localSkill);
    renderWithProviders(
      <SkillsSection
        builtinSkillBaselines={{}}
        onAppConfigSync={() => {}}
      />,
    );
    await screen.findByText("No skills yet. Click New to create one.");

    fireEvent.click(screen.getByRole("button", { name: /New/i }));
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "pdf-tools" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Work with PDF files." },
    });
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "Body text.\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(createSkill).toHaveBeenCalledWith(
        "pdf-tools",
        "Work with PDF files.",
        "Body text.\n",
      );
    });
    // The mint closes the drawer: the list is the only face left.
    await waitFor(() => {
      expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    });
  });

  it("gates the create drawer's Save on a valid name, description, and body", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [], ignored: [], root_error: null });
    renderWithProviders(
      <SkillsSection
        builtinSkillBaselines={{}}
        onAppConfigSync={() => {}}
      />,
    );
    await screen.findByText("No skills yet. Click New to create one.");

    fireEvent.click(screen.getByRole("button", { name: /New/i }));
    const nameInput = await screen.findByLabelText("Name");
    const descInput = screen.getByLabelText("Description");
    const save = screen.getByRole("button", { name: "Save" });

    // Empty form: gated off before any IPC round-trip can reject it.
    expect(save).toBeDisabled();

    // An invalid name keeps the gate shut and surfaces the rule once the
    // field has been touched.
    fireEvent.change(nameInput, { target: { value: "Bad Name" } });
    fireEvent.blur(nameInput);
    expect(
      await screen.findByText(/Use only lowercase letters/),
    ).toBeInTheDocument();
    expect(save).toBeDisabled();

    // Valid name + description, still no body: gated off.
    fireEvent.change(nameInput, { target: { value: "pdf-tools" } });
    fireEvent.change(descInput, { target: { value: "Work with PDF files." } });
    expect(save).toBeDisabled();

    // All three fields valid: the gate opens.
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "Body text.\n" },
    });
    expect(save).toBeEnabled();
  });

  it("gates the edit drawer's Save on a non-blank body", async () => {
    // Clearing the body must gate Save behind the same client-side rule
    // the backend enforces (create and edit share it).
    vi.mocked(listSkills).mockResolvedValue({ skills: [localSkill], ignored: [], root_error: null });
    renderWithProviders(
      <SkillsSection
        builtinSkillBaselines={{}}
        onAppConfigSync={() => {}}
      />,
    );
    await screen.findByText("pdf-tools");
    fireEvent.click(screen.getByText("pdf-tools"));

    const bodyInput = await screen.findByLabelText("Instructions");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();

    fireEvent.change(bodyInput, { target: { value: "" } });
    fireEvent.blur(bodyInput);
    expect(save).toBeDisabled();
    expect(await screen.findByText(/can't be empty/)).toBeInTheDocument();

    // Re-filling re-opens the gate.
    fireEvent.change(bodyInput, { target: { value: "Restored body.\n" } });
    expect(save).toBeEnabled();
  });

  it("opens a local skill in the edit drawer and saves via updateSkill", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [localSkill], ignored: [], root_error: null });
    vi.mocked(updateSkill).mockResolvedValue(localSkill);
    renderWithProviders(
      <SkillsSection
        builtinSkillBaselines={{}}
        onAppConfigSync={() => {}}
      />,
    );
    await screen.findByText("pdf-tools");

    // Click the skill's name text -- it sits inside the row's click surface.
    fireEvent.click(screen.getByText("pdf-tools"));

    const bodyInput = await screen.findByLabelText("Instructions");
    fireEvent.change(bodyInput, { target: { value: "Updated body.\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateSkill).toHaveBeenCalledWith(
        "pdf-tools",
        expect.objectContaining({
          name: "pdf-tools",
          body: "Updated body.\n",
          // No edit surface for these: the original values must ride back
          // untouched (null is the wire's frontmatter-key removal signal).
          license: "MIT",
          compatibility: "requires network",
        }),
      );
    });
  });

  it("keeps the drawer open and Cancel disabled while a save is in flight", async () => {
    // The drawer cannot be dismissed mid-write: Escape, the close request,
    // and Cancel are all gated while the mutation is pending.
    vi.mocked(listSkills).mockResolvedValue({ skills: [localSkill], ignored: [], root_error: null });
    let resolveUpdate!: (entry: SkillEntry) => void;
    vi.mocked(updateSkill).mockImplementation(
      () => new Promise<SkillEntry>((resolve) => { resolveUpdate = resolve; }),
    );
    renderWithProviders(
      <SkillsSection
        builtinSkillBaselines={{}}
        onAppConfigSync={() => {}}
      />,
    );
    await screen.findByText("pdf-tools");
    fireEvent.click(screen.getByText("pdf-tools"));

    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByLabelText("Instructions")).toBeInTheDocument();

    resolveUpdate(localSkill);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("filters local and linked rows through the acquired filter", async () => {
    // The Radix Select's local/linked arms (the AgentsSection filter
    // posture, driven through the shared pointer helpers): each arm hides
    // the other source's rows while the row under test stays visible. The
    // builtin arm is pinned separately in skills-builtin.
    vi.mocked(listSkills).mockResolvedValue({ skills: [localSkill, linkedSkill], ignored: [], root_error: null });
    renderWithProviders(
      <SkillsSection
        builtinSkillBaselines={{}}
        onAppConfigSync={() => {}}
      />,
    );
    expect(await screen.findByText("pdf-tools")).toBeInTheDocument();
    expect(screen.getByText("external-skill")).toBeInTheDocument();

    const filter = screen.getByLabelText("Filter by skill type");
    openSelect(filter);
    chooseOption("Local");
    expect(screen.getByText("pdf-tools")).toBeInTheDocument();
    expect(screen.queryByText("external-skill")).toBeNull();

    openSelect(filter);
    chooseOption("Linked");
    expect(screen.queryByText("pdf-tools")).toBeNull();
    expect(screen.getByText("external-skill")).toBeInTheDocument();
  });

  it("rescans the listing from the header refresh button", async () => {
    // The icon-only header action's one seam: a click re-invokes the list
    // query. The aria-label carries the accessible name; the spin glyph is
    // presentational.
    vi.mocked(listSkills).mockResolvedValue({ skills: [localSkill], ignored: [], root_error: null });
    renderWithProviders(
      <SkillsSection
        builtinSkillBaselines={{}}
        onAppConfigSync={() => {}}
      />,
    );
    await screen.findByText("pdf-tools");
    const callsBefore = vi.mocked(listSkills).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(vi.mocked(listSkills).mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it("renders a linked skill read-only with an Open original folder button", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [linkedSkill], ignored: [], root_error: null });
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    renderWithProviders(
      <SkillsSection
        builtinSkillBaselines={{}}
        onAppConfigSync={() => {}}
      />,
    );
    await screen.findByText("external-skill");

    fireEvent.click(screen.getByText("external-skill"));

    expect(
      await screen.findByRole("button", { name: "Open original folder" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Open original folder" }));
    await waitFor(() => {
      expect(revealItemInDir).toHaveBeenCalledWith(linkedSkill.link_target);
    });
  });

  it("deletes a skill after confirmation", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [localSkill], ignored: [], root_error: null });
    vi.mocked(deleteSkill).mockResolvedValue(undefined);
    renderWithProviders(
      <SkillsSection
        builtinSkillBaselines={{}}
        onAppConfigSync={() => {}}
      />,
    );
    await screen.findByText("pdf-tools");

    // The delete icon button carries an action-verb aria-label naming the
    // skill (exact match disambiguates from the row, whose accessible name
    // is multi-word).
    fireEvent.click(screen.getByRole("button", { name: "Delete skill pdf-tools" }));
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
    renderWithProviders(
      <SkillsSection
        builtinSkillBaselines={{}}
        onAppConfigSync={() => {}}
      />,
    );
    await screen.findByText("No skills yet. Click New to create one.");

    fireEvent.click(screen.getByRole("button", { name: /New/i }));
    const nameInput = await screen.findByLabelText("Name");
    const descInput = screen.getByLabelText("Description");
    const bodyInput = screen.getByLabelText("Instructions");
    fireEvent.change(nameInput, { target: { value: "pdf-tools" } });
    fireEvent.change(descInput, { target: { value: "Work with PDF files." } });
    fireEvent.change(bodyInput, { target: { value: "Body text.\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(
        screen.getByText("A skill named \"pdf-tools\" already exists"),
      ).toBeInTheDocument();
    });
    // The drawer stays open and OWNS the error face while it is up (the
    // modal covers the section-level line), so the reject is visible where
    // the user is working -- as an alert, not only as text.
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // A retry that succeeds clears the stale reject: the alert must not
    // ride into a later drawer.
    vi.mocked(createSkill).mockResolvedValue(localSkill);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  it("opens the import dialog when the Import button is clicked (issue #367)", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [], ignored: [], root_error: null });
    vi.mocked(listSkillSources).mockResolvedValue([]);
    renderWithProviders(
      <SkillsSection
        builtinSkillBaselines={{}}
        onAppConfigSync={() => {}}
      />,
    );
    await screen.findByText("No skills yet. Click New to create one.");

    // The Import button is now enabled (was disabled before #367); clicking it
    // opens the two-stage drill-down dialog, surfaced by its title.
    const importBtn = screen.getByRole("button", { name: /Import/i });
    expect(importBtn).not.toBeDisabled();
    fireEvent.click(importBtn);

    expect(await screen.findByText("Import skills")).toBeInTheDocument();
  });

  it("does not render the ignored section when the registry is clean", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [localSkill], ignored: [], root_error: null });
    renderWithProviders(
      <SkillsSection
        builtinSkillBaselines={{}}
        onAppConfigSync={() => {}}
      />,
    );
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
    renderWithProviders(
      <SkillsSection
        builtinSkillBaselines={{}}
        onAppConfigSync={() => {}}
      />,
    );
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
    renderWithProviders(
      <SkillsSection
        builtinSkillBaselines={{}}
        onAppConfigSync={() => {}}
      />,
    );

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
    renderWithProviders(
      <SkillsSection
        builtinSkillBaselines={{}}
        onAppConfigSync={() => {}}
      />,
    );

    // The locale-catalog prefix renders, and the dynamic root_error detail
    // rides verbatim so the user sees the OS-level reason.
    expect(await screen.findByText(/Couldn't load your skills/)).toBeInTheDocument();
    expect(
      screen.getByText(/Permission denied \(os error 13\)/),
    ).toBeInTheDocument();
  });
});
