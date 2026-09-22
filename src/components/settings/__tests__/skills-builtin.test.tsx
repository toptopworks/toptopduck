import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IntlProvider } from "react-intl";

import { SkillsSection } from "../SkillsSection";
import { chooseOption, openSelect } from "./helpers";
import { TooltipProvider } from "../../ui/tooltip";
import { getSkillsDir, listSkills, rescanBuiltinCliTools } from "../../../api";
import { scanResult, skillEntry } from "../../../test-fixtures";

// The builtin-skill surface of the settings pane (issue #677; readonly
// posture since ADR-0121): the built-in badge + the inert delete entry, the
// builtin row's SKILL.md anchor in the detail dialog (the reserved subtree,
// issue #1033), and the covers-built-in badge on a shadowing local row.
vi.mock("../../../api", () => ({
  listSkills: vi.fn(),
  getSkillsDir: vi.fn(),
  deleteSkill: vi.fn(),
  listSkillSources: vi.fn(),
  importSkills: vi.fn(),
  rescanBuiltinCliTools: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
}));

const builtinSkill = skillEntry("pandoc", {
  description: "Convert documents between formats.",
  acquired: "builtin",
  body: "Use the `pandoc` tool…\n",
  content_hash: "hash-of-shipped-body",
  // The builtin row's reveal anchor: the reserved-subtree directory (the
  // fork channel's "open location" affordance, ADR-0121 Decision 4).
  link_target: "/app-data/skills/.system/pandoc",
});

const forkedSkill = skillEntry("vega-chart", {
  description: "My own charting fork.",
  acquired: "local",
  covers_builtin: true,
});

// The pane under test. Empty-catalog English IntlProvider: FormattedMessage
// falls back to defaultMessage (the canonical English source, ADR-0052).
function renderSection() {
  const onSync = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <TooltipProvider>
          <SkillsSection onAppConfigSync={onSync} onNewSkill={() => {}} />
        </TooltipProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return { onSync, unmount: view.unmount };
}

describe("SkillsSection builtin rows (issue #677, ADR-0121)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listSkills).mockResolvedValue({
      skills: [builtinSkill],
      ignored: [],
      root_error: null,
    });
    vi.mocked(getSkillsDir).mockResolvedValue("/roots/skills");
    // The pane's mount rescan (issue #1016) resolves quietly by default:
    // no failure lane, no config churn beyond the wholesale sync.
    vi.mocked(rescanBuiltinCliTools).mockResolvedValue(scanResult());
  });

  it("shows the system badge and an inert delete on a builtin row", async () => {
    renderSection();
    const row = await screen.findByTestId("skill-row");
    expect(row).toHaveTextContent("system");
    // Undeletable (issue #677): the trash renders inert via aria-disabled --
    // the hoverable form a tooltip can ride (#1015) -- so the row action
    // column stays aligned with deletable rows.
    expect(
      screen.getByRole("button", { name: "Delete skill pandoc" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("opens a read-only detail dialog over a builtin row", async () => {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    renderSection();
    fireEvent.click(await screen.findByText("pandoc"));
    // The detail dialog is a read-only face: name + description + scope /
    // status + the SKILL.md path bar (no form fields, no Save) -- the
    // reserved-subtree anchor surfaces as the file path the link opens in
    // the OS default editor (ADR-0121 Decision 4).
    expect(await screen.findByRole("heading", { name: "pandoc" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(
      screen.getByText(`${builtinSkill.link_target}/SKILL.md`),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Open file/ }));
    await waitFor(() => {
      expect(openPath).toHaveBeenCalledWith(
        `${builtinSkill.link_target}/SKILL.md`,
      );
    });
  });

  it("explains the disabled delete through the shutdown tooltip (#1015)", async () => {
    renderSection();
    const del = await screen.findByRole("button", {
      name: "Delete skill pandoc",
    });
    // The inert form is what makes the hover reachable: not natively
    // disabled, aria-disabled instead (the agents/CLI panes pin the same
    // pair inside their row tests).
    expect(del).toHaveAttribute("aria-disabled", "true");
    expect(del).not.toBeDisabled();
    // Radix Tooltip opens on pointermove (the trigger has no pointerenter
    // open path); delayDuration is 0 under the test's TooltipProvider.
    fireEvent.pointerMove(del);
    expect(
      await screen.findByText(
        "System skills cannot be deleted; disable the skill instead",
      ),
    ).toBeInTheDocument();
  });

  it("shows the covers badge on a local row shadowing a builtin", async () => {
    // ADR-0121 Decision 5's visibility half: a local fork owning a builtin's
    // name renders the covers badge -- the standing reminder that app-side
    // curation is invisible to this fork until it is deleted.
    vi.mocked(listSkills).mockResolvedValue({
      skills: [forkedSkill],
      ignored: [],
      root_error: null,
    });
    renderSection();
    const row = await screen.findByTestId("skill-row");
    expect(row).toHaveTextContent("local");
    expect(row).toHaveTextContent("covers built-in");
    // The fork is an ordinary local row: the delete stays live.
    expect(
      screen.getByRole("button", { name: "Delete skill vega-chart" }),
    ).not.toHaveAttribute("aria-disabled");
  });

  it("filters builtin rows through the acquired filter", async () => {
    renderSection();
    await screen.findByTestId("skill-row");
    // Radix Select opens on a pointer sequence and commits on an option
    // click (the AgentsSection filter posture) -- fireEvent.change is
    // inert on it.
    const filter = screen.getByLabelText("Filter by skill type");
    openSelect(filter);
    chooseOption("System");
    expect(screen.getByTestId("skill-row")).toBeInTheDocument();
    openSelect(filter);
    chooseOption("Local");
    expect(screen.queryByTestId("skill-row")).toBeNull();
  });
});

describe("SkillsSection materialization-failure lane (issue #1016)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listSkills).mockResolvedValue({
      skills: [],
      ignored: [],
      root_error: null,
    });
    vi.mocked(getSkillsDir).mockResolvedValue("/roots/skills");
    vi.mocked(rescanBuiltinCliTools).mockResolvedValue(
      scanResult({ skill_materialize_failures: ["vega-chart"] }),
    );
  });

  it("renders a row-level warning for a skill the window could not write", async () => {
    renderSection();
    const row = await screen.findByTestId(
      "skill-materialize-failure-row-vega-chart",
    );
    // The row carries the skill name (the identity the user would look
    // for), the failure category, and the self-heal contract.
    expect(row).toHaveTextContent("vega-chart");
    expect(row).toHaveTextContent("Write failed");
    expect(row).toHaveTextContent("next scan retries");
  });

  it("rides the acquired filter like the rows it stands in for", async () => {
    renderSection();
    await screen.findByTestId("skill-materialize-failure-row-vega-chart");
    const filter = screen.getByLabelText("Filter by skill type");
    // A failed skill is (would-be) builtin: the lane shows under "System"
    // and hides under "Local".
    openSelect(filter);
    chooseOption("System");
    expect(
      screen.getByTestId("skill-materialize-failure-row-vega-chart"),
    ).toBeInTheDocument();
    openSelect(filter);
    chooseOption("Local");
    expect(
      screen.queryByTestId("skill-materialize-failure-row-vega-chart"),
    ).toBeNull();
  });

  it("matches the lane against the search box", async () => {
    renderSection();
    await screen.findByTestId("skill-materialize-failure-row-vega-chart");
    fireEvent.change(screen.getByPlaceholderText("Search skills…"), {
      target: { value: "vega" },
    });
    expect(
      screen.getByTestId("skill-materialize-failure-row-vega-chart"),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Search skills…"), {
      target: { value: "pandoc" },
    });
    expect(
      screen.queryByTestId("skill-materialize-failure-row-vega-chart"),
    ).toBeNull();
  });

  it("stands in beside a real row for the same name (#1016, #1022)", async () => {
    // A failed write leaves the row on disk stale or absent -- the lane
    // always renders the stand-in, so the write-failure hint stays
    // visible beside a stale pre-upgrade row. (The #1022 ruling: a
    // blocked retirement is warn-only backend-side and never rides this
    // lane, so a name in the lane is always a write failure.)
    vi.mocked(listSkills).mockResolvedValue({
      skills: [builtinSkill],
      ignored: [],
      root_error: null,
    });
    vi.mocked(getSkillsDir).mockResolvedValue("/roots/skills");
    vi.mocked(rescanBuiltinCliTools).mockResolvedValue(
      scanResult({ skill_materialize_failures: ["pandoc", "vega-chart"] }),
    );
    renderSection();
    await screen.findByTestId("skill-materialize-failure-row-vega-chart");
    expect(
      screen.getByTestId("skill-materialize-failure-row-pandoc"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("skill-row")).toHaveTextContent("pandoc");
  });

  it("lets a matching failure row carry the frame without the no-matches caption", async () => {
    // The contradiction guard: with a skill on disk, a failed vega-chart,
    // and a search for "vega", the lane row matches while the listing
    // does not -- a "no matches" caption under the matching row would
    // deny the row right above it.
    vi.mocked(listSkills).mockResolvedValue({
      skills: [builtinSkill],
      ignored: [],
      root_error: null,
    });
    vi.mocked(getSkillsDir).mockResolvedValue("/roots/skills");
    renderSection();
    await screen.findByTestId("skill-materialize-failure-row-vega-chart");
    fireEvent.change(screen.getByPlaceholderText("Search skills…"), {
      target: { value: "vega" },
    });
    expect(
      screen.getByTestId("skill-materialize-failure-row-vega-chart"),
    ).toBeInTheDocument();
    expect(screen.queryByText("No skills match your search.")).toBeNull();
  });

  it("leaves no lane once a healed window reports no failures", async () => {
    const { unmount } = renderSection();
    await screen.findByTestId("skill-materialize-failure-row-vega-chart");
    // The lane is a per-window snapshot, never persisted: a remount over
    // a healed machine (the rescan reports no failures) renders nothing
    // -- the warning must not outlive the failure (issue #1016 AC).
    unmount();
    vi.mocked(rescanBuiltinCliTools).mockResolvedValue(scanResult());
    renderSection();
    await screen.findByText("No skills yet. Create one in a chat, or import it.");
    expect(screen.queryByTestId(/skill-materialize-failure-row/)).toBeNull();
    // The second window really ran (not just an unrendered lane): the
    // remount issued its own mount rescan.
    expect(rescanBuiltinCliTools).toHaveBeenCalledTimes(2);
  });

  it("refetches the listing after the mount rescan lands (issue #1016)", async () => {
    // The recovery path's listing freshness: the mount rescan can
    // materialize a skill in its window, and the listing query was
    // already in flight before that write -- the rescan's response
    // invalidates the listing so the fresh row appears. The rescan
    // resolves on a macrotask here (the production ordering: the IPC
    // round-trip outlasts the local fs scan), because under jsdom's
    // same-flush microtask timing the invalidation would dedupe into
    // the still-in-flight mount fetch instead of refetching.
    vi.mocked(listSkills)
      .mockResolvedValueOnce({ skills: [], ignored: [], root_error: null })
      .mockResolvedValue({
        skills: [builtinSkill],
        ignored: [],
        root_error: null,
      });
    vi.mocked(rescanBuiltinCliTools).mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(scanResult()),
            50,
          ),
        ),
    );
    renderSection();
    // The first listing (pre-rescan) shows nothing.
    await screen.findByText("No skills yet. Create one in a chat, or import it.");
    // The lane is structurally absent before any scan answer lands (the
    // null snapshot holds until the rescan resolves).
    expect(screen.queryByTestId(/skill-materialize-failure-row/)).toBeNull();
    // The rescan lands, the listing refetches, the materialized row
    // appears -- no failure lane (the window succeeded).
    const row = await screen.findByTestId("skill-row", undefined, { timeout: 2000 });
    expect(row).toHaveTextContent("pandoc");
    expect(screen.queryByTestId(/skill-materialize-failure-row/)).toBeNull();
  });

  it("stays silent on a mount-rescan IPC failure", async () => {
    vi.mocked(rescanBuiltinCliTools).mockRejectedValueOnce(
      new Error("ipc down"),
    );
    renderSection();
    // The CLI pane's silent-mount contract: a failed mount rescan leaves
    // no visible UI state (one log.warn), and the empty listing renders.
    await screen.findByText("No skills yet. Create one in a chat, or import it.");
    expect(screen.queryByTestId(/skill-materialize-failure-row/)).toBeNull();
  });
});
