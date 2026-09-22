import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";

import { SkillsSection } from "../SkillsSection";
import { TooltipProvider } from "../../ui/tooltip";
import { chooseOption, openSelect } from "./helpers";
import {
  deleteSkill,
  getSkillsDir,
  listSkills,
  listSkillSources,
  rescanBuiltinCliTools,
  setSkillEnabled,
} from "../../../api";
import type { AppConfig } from "../../../types/app-config";
import { baseAppConfig, scanResult, skillEntry } from "../../../test-fixtures";
import type { BuiltinScanResult } from "../../../types/cli-tool";

// The pane drives everything through IPC + the opener plugin; mock both so the
// test never touches Tauri. revealItemInDir is every row's external-edit
// channel (issue #1033); getSkillsDir supplies the local rows' reveal targets.
// listSkillSources feeds the import dialog's discovery read (issue #367).
vi.mock("../../../api", () => ({
  listSkills: vi.fn(),
  getSkillsDir: vi.fn(),
  deleteSkill: vi.fn(),
  listSkillSources: vi.fn(),
  importSkills: vi.fn(),
  setSkillEnabled: vi.fn(),
  rescanBuiltinCliTools: vi.fn(),
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

function renderPane() {
  return renderWithProviders(
    <SkillsSection
      onAppConfigSync={() => {}}
      onExitToWorkspace={() => {}}
    />,
  );
}

describe("SkillsSection (issue #362)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listSkills).mockResolvedValue({ skills: [], ignored: [], root_error: null });
    vi.mocked(getSkillsDir).mockResolvedValue("/roots/skills");
    vi.mocked(listSkillSources).mockResolvedValue([]);
    // The pane's mount rescan (issue #1016) resolves quietly by default:
    // no failure lane, no config churn beyond the wholesale sync.
    vi.mocked(rescanBuiltinCliTools).mockResolvedValue(scanResult());
  });

  it("skips the stale config sync when the mount rescan lands after a user write", async () => {
    // The write-generation guard (the CliSection #683 contract) on this
    // pane: the mount rescan read the config BEFORE the toggle's write,
    // so its late response would roll the user's change back. The stale
    // sync is skipped; the cache-scoped listing invalidate still runs.
    const staleConfig = baseAppConfig();
    const next = baseAppConfig({ disabled_skills: ["pdf-tools"] });
    let resolveMount: (result: BuiltinScanResult) => void = () => {};
    vi.mocked(rescanBuiltinCliTools).mockImplementationOnce(
      () =>
        new Promise<BuiltinScanResult>((resolve) => {
          resolveMount = resolve;
        }),
    );
    vi.mocked(setSkillEnabled).mockResolvedValue(next);
    vi.mocked(listSkills).mockResolvedValue({
      skills: [localSkill],
      ignored: [],
      root_error: null,
    });
    const onAppConfigSync = vi.fn();
    renderWithProviders(
      <SkillsSection
        onAppConfigSync={onAppConfigSync}
        onExitToWorkspace={() => {}}
      />,
    );
    // The user write lands while the mount rescan is still in flight.
    await screen.findByTestId("skill-row");
    fireEvent.click(screen.getByRole("switch", { name: "Enable skill pdf-tools" }));
    await waitFor(() =>
      expect(onAppConfigSync).toHaveBeenCalledWith(
        expect.objectContaining({ disabled_skills: ["pdf-tools"] }),
      ),
    );
    resolveMount(scanResult({ config: staleConfig }));
    // Only the user write's config ever syncs; the listing still
    // refetches (mount fetch + the toggle's invalidate + the rescan's
    // cache-scoped invalidate landing last).
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(3));
    expect(onAppConfigSync).toHaveBeenCalledTimes(1);
    expect(onAppConfigSync).not.toHaveBeenCalledWith(staleConfig);
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
        onAppConfigSync={onAppConfigSync}
        onExitToWorkspace={() => {}}
      />,
    );
    const row = await screen.findByTestId("skill-row");
    expect(row).not.toHaveAttribute("data-disabled");
    fireEvent.click(screen.getByRole("switch", { name: "Enable skill pdf-tools" }));
    await waitFor(() =>
      expect(setSkillEnabled).toHaveBeenCalledWith("pdf-tools", false),
    );
    await waitFor(() =>
      expect(onAppConfigSync).toHaveBeenCalledWith(
        expect.objectContaining({ disabled_skills: ["pdf-tools"] }),
      ),
    );
    // The switch sits outside the row's open-edit target (the text block):
    // toggling it must not open the drawer.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The refetch half: the listing is queried again and the row grays.
    // Two calls despite the mount rescan's invalidate (issue #1016): under
    // jsdom both mocks resolve on the same microtask flush, so the
    // invalidate dedupes into the still-in-flight mount fetch (TanStack's
    // in-flight dedupe) and only the toggle's refetch lands as a second
    // call -- the post-rescan refetch is pinned separately in
    // skills-builtin.test.tsx, where the rescan resolves late enough to
    // observe it.
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
    // row (data-disabled carries the state for tests + styling hooks) and
    // the switch reads unchecked; the text block keeps opening the edit
    // drawer (disabling hides from discovery, not from management).
    vi.mocked(listSkills).mockResolvedValue({
      skills: [{ ...localSkill, enabled: false }],
      ignored: [],
      root_error: null,
    });
    renderPane();
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
    renderPane();

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
    renderPane();
    await screen.findByText("pdf-tools");

    fireEvent.change(screen.getByPlaceholderText("Search skills…"), {
      target: { value: "pdf" },
    });

    expect(screen.getByText("pdf-tools")).toBeInTheDocument();
    expect(screen.queryByText("external-skill")).not.toBeInTheDocument();

    // The description half of the haystack and the field seam: "files"
    // matches no name (only pdf-tools' description carries it), while the
    // seam-spanning queries must stay misses -- the fields join on a
    // newline, so neither an empty join ("toolsw") nor a space join
    // ("tools work") may match across the boundary.
    fireEvent.change(screen.getByPlaceholderText("Search skills…"), {
      target: { value: "files" },
    });

    expect(screen.getByText("pdf-tools")).toBeInTheDocument();
    expect(screen.queryByText("external-skill")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search skills…"), {
      target: { value: "tools work" },
    });

    expect(screen.queryByText("pdf-tools")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search skills…"), {
      target: { value: "toolsw" },
    });

    expect(screen.queryByText("pdf-tools")).not.toBeInTheDocument();
  });

  it("filters local and linked rows through the acquired filter", async () => {
    // The Radix Select's local/linked arms (the AgentsSection filter
    // posture, driven through the shared pointer helpers): each arm hides
    // the other source's rows while the row under test stays visible. The
    // builtin arm is pinned separately in skills-builtin.
    vi.mocked(listSkills).mockResolvedValue({ skills: [localSkill, linkedSkill], ignored: [], root_error: null });
    renderPane();
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
    renderPane();
    await screen.findByText("pdf-tools");
    const callsBefore = vi.mocked(listSkills).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(vi.mocked(listSkills).mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it("reveals a linked row source folder from the row itself", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [linkedSkill], ignored: [], root_error: null });
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    renderPane();
    await screen.findByText("external-skill");

    // The reveal is a row action now (issue #1033): no drawer opens
    // first, and the text block stays plain text.
    fireEvent.click(
      screen.getByRole("button", { name: "Open skill folder external-skill" }),
    );
    await waitFor(() => {
      expect(revealItemInDir).toHaveBeenCalledWith(linkedSkill.link_target);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reveals a local row's own directory from the registry root", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [localSkill], ignored: [], root_error: null });
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    renderPane();
    await screen.findByText("pdf-tools");

    // A local skill has no link_target -- the reveal joins the backend's
    // registry root with the row's name (issue #1033), the path authority
    // staying on the Rust side.
    fireEvent.click(
      screen.getByRole("button", { name: "Open skill folder pdf-tools" }),
    );
    await waitFor(() => {
      expect(revealItemInDir).toHaveBeenCalledWith("/roots/skills/pdf-tools");
    });
  });

  it("shows the reveal path on the folder button's hover", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [localSkill], ignored: [], root_error: null });
    renderPane();
    await screen.findByText("pdf-tools");

    // The build item's "shows the skill directory path" clause: the hover
    // carries the absolute path the click reveals (the #1015 posture).
    // Radix Tooltip opens on pointermove with delayDuration 0 under the
    // test's TooltipProvider.
    fireEvent.pointerMove(
      screen.getByRole("button", { name: "Open skill folder pdf-tools" }),
    );
    expect(
      await screen.findByText("/roots/skills/pdf-tools"),
    ).toBeInTheDocument();
  });

  it("keeps a local row's reveal inert until the registry root resolves", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [localSkill], ignored: [], root_error: null });
    // The root fetch never settles: a local row asked in that window must
    // not synthesize a garbage "null/<name>" path.
    vi.mocked(getSkillsDir).mockReturnValue(new Promise(() => {}));
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    renderPane();
    await screen.findByText("pdf-tools");

    fireEvent.click(
      screen.getByRole("button", { name: "Open skill folder pdf-tools" }),
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Open skill folder pdf-tools" })).toBeInTheDocument();
    });
    expect(revealItemInDir).not.toHaveBeenCalled();
  });

  it("surfaces a reveal failure as a formatted error", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [localSkill], ignored: [], root_error: null });
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    vi.mocked(revealItemInDir).mockRejectedValueOnce(new Error("opener unavailable"));
    renderPane();
    await screen.findByText("pdf-tools");

    fireEvent.click(
      screen.getByRole("button", { name: "Open skill folder pdf-tools" }),
    );

    // The failure lands on the section-level error line (issue #1033): with
    // the drawer gone there is no modal face -- the visible alert is the
    // whole report.
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("opener unavailable");
  });

  it("routes the New button to the create guide and exits to the workspace", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [], ignored: [], root_error: null });
    const onExitToWorkspace = vi.fn();
    renderWithProviders(
      <SkillsSection
        onAppConfigSync={() => {}}
        onExitToWorkspace={onExitToWorkspace}
      />,
    );
    await screen.findByText("No skills yet. Create one in a chat, or import it.");

    // No form opens (issue #1033): creation rides the conversation channel,
    // so the guide explains where authoring lives and offers the exit.
    fireEvent.click(screen.getByRole("button", { name: /New/i }));
    expect(
      await screen.findByRole("heading", { name: "Create skills in chat" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to workspace" }));
    expect(onExitToWorkspace).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("deletes a skill after confirmation", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [localSkill], ignored: [], root_error: null });
    vi.mocked(deleteSkill).mockResolvedValue(undefined);
    renderPane();
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

  it("opens the import dialog when the Import button is clicked (issue #367)", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [], ignored: [], root_error: null });
    vi.mocked(listSkillSources).mockResolvedValue([]);
    renderPane();
    await screen.findByText("No skills yet. Create one in a chat, or import it.");

    // The Import button is now enabled (was disabled before #367); clicking it
    // opens the two-stage drill-down dialog, surfaced by its title.
    const importBtn = screen.getByRole("button", { name: /Import/i });
    expect(importBtn).not.toBeDisabled();
    fireEvent.click(importBtn);

    expect(await screen.findByText("Import skills")).toBeInTheDocument();
  });

  it("does not render the ignored section when the registry is clean", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [localSkill], ignored: [], root_error: null });
    renderPane();
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
    renderPane();
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
    renderPane();

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
    renderPane();

    // The locale-catalog prefix renders, and the dynamic root_error detail
    // rides verbatim so the user sees the OS-level reason.
    expect(await screen.findByText(/Couldn't load your skills/)).toBeInTheDocument();
    expect(
      screen.getByText(/Permission denied \(os error 13\)/),
    ).toBeInTheDocument();
  });
});
