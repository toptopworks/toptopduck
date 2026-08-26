import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ComposerSkillsTrigger } from "../ComposerSkillsTrigger";
import { listMountedSkills, listSkills, mountSkill, unmountSkill } from "../../../api";
import { TooltipProvider } from "../../ui/tooltip";
import type { SkillEntry } from "../../../types/skills";

// The Skills trigger chip + its popover section (issue #365). The session
// mode pins live in the pane-level black box (Shell.test.tsx); these tests
// cover the ADR-0092 / #500 draft mode: a null sessionId reads the
// caller-held pending list (no per-session IPC) and routes toggles to
// onPendingSkillsChange instead of the mount IPC. Rendered inside an
// empty-catalog English IntlProvider (defaultMessage is the canonical
// source, ADR-0052) with the IPC pair mocked.
vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    listSkills: vi.fn(),
    listMountedSkills: vi.fn(),
    mountSkill: vi.fn(async () => {}),
    unmountSkill: vi.fn(async () => {}),
  };
});

function skill(name: string): SkillEntry {
  return {
    name,
    description: `${name} skill`,
    acquired: "local",
    license: null,
    compatibility: null,
    mcp_servers: [],
    cli_tools: [],
    body: "",
    link_target: null,
    content_hash: "ab".repeat(32),
  };
}

function renderTrigger(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const DRAFT_PROPS = {
  loading: false,
  onOpenSettingsSkills: vi.fn(),
};

describe("ComposerSkillsTrigger draft mode (ADR-0092 / #500)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listSkills).mockResolvedValue({ skills: [skill("charting"), skill("cleaning")], ignored: [], root_error: null });
    vi.mocked(listMountedSkills).mockResolvedValue([]);
  });

  it("does not call listMountedSkills when sessionId is null", async () => {
    renderTrigger(
      <ComposerSkillsTrigger
        sessionId={null}
        {...DRAFT_PROPS}
        pendingSkills={[]}
        onPendingSkillsChange={vi.fn()}
      />,
    );
    // The registry total is session-agnostic (it still loads for the count),
    // but the per-session mount query is disabled -- no IPC for a null session.
    await waitFor(() => expect(listSkills).toHaveBeenCalled());
    expect(listMountedSkills).not.toHaveBeenCalled();
  });

  it("shows the pending list's count as the mounted count (empty mount set initial)", async () => {
    renderTrigger(
      <ComposerSkillsTrigger
        sessionId={null}
        {...DRAFT_PROPS}
        pendingSkills={[]}
        onPendingSkillsChange={vi.fn()}
      />,
    );
    // 0 pending picks out of 2 registry skills.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Skills (0/2)" })).toBeInTheDocument(),
    );
  });

  it("shows a non-empty pending list in the chip count", async () => {
    renderTrigger(
      <ComposerSkillsTrigger
        sessionId={null}
        {...DRAFT_PROPS}
        pendingSkills={["charting"]}
        onPendingSkillsChange={vi.fn()}
      />,
    );
    // The registry total lands with the listSkills query; the pending count
    // (1) is synchronous caller state.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Skills (1/2)" })).toBeInTheDocument(),
    );
  });

  it("folds the auto-included builtin skills into the cold-start count (issue #677)", async () => {
    // The registry holds one builtin + one local skill; the CLI registry
    // carries an ENABLED builtin pandoc entry, so the next session starts
    // with pandoc auto-included regardless of the pending list.
    const builtin = { ...skill("pandoc"), acquired: "builtin" as const };
    vi.mocked(listSkills).mockResolvedValue({
      skills: [builtin, skill("charting")],
      ignored: [],
      root_error: null,
    });
    renderTrigger(
      <ComposerSkillsTrigger
        sessionId={null}
        {...DRAFT_PROPS}
        pendingSkills={["charting"]}
        onPendingSkillsChange={vi.fn()}
        cliTools={[
          {
            name: "pandoc",
            description: "",
            executable: "pandoc",
            argv_template: [],
            params: [],
            env: {},
            enabled: true,
            source: "builtin",
            baseline: "following",
          },
        ]}
      />,
    );
    // 1 pending pick + 1 auto-included builtin, deduped against the pending
    // list (charting is not builtin) -> 2 of 2.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Skills (2/2)" })).toBeInTheDocument(),
    );
  });

  it("excludes a disabled builtin entry's skill from the cold-start count", async () => {
    const builtin = { ...skill("pandoc"), acquired: "builtin" as const };
    vi.mocked(listSkills).mockResolvedValue({
      skills: [builtin, skill("charting")],
      ignored: [],
      root_error: null,
    });
    renderTrigger(
      <ComposerSkillsTrigger
        sessionId={null}
        {...DRAFT_PROPS}
        pendingSkills={[]}
        onPendingSkillsChange={vi.fn()}
        cliTools={[
          {
            name: "pandoc",
            description: "",
            executable: "pandoc",
            argv_template: [],
            params: [],
            env: {},
            enabled: false,
            source: "builtin",
            baseline: "following",
          },
        ]}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Skills (0/2)" })).toBeInTheDocument(),
    );
  });

  it("routes a pick to onPendingSkillsChange with the appended name (no mount IPC)", async () => {
    const onPendingSkillsChange = vi.fn();
    renderTrigger(
      <ComposerSkillsTrigger
        sessionId={null}
        {...DRAFT_PROPS}
        pendingSkills={[]}
        onPendingSkillsChange={onPendingSkillsChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Skills/ }));
    const checkbox = await screen.findByRole("checkbox", { name: "Mount skill charting" });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(onPendingSkillsChange).toHaveBeenCalledWith(["charting"]);
    expect(mountSkill).not.toHaveBeenCalled();
  });

  it("routes an unpick to onPendingSkillsChange with the name removed (no unmount IPC)", async () => {
    const onPendingSkillsChange = vi.fn();
    renderTrigger(
      <ComposerSkillsTrigger
        sessionId={null}
        {...DRAFT_PROPS}
        pendingSkills={["charting", "cleaning"]}
        onPendingSkillsChange={onPendingSkillsChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Skills/ }));
    const checkbox = await screen.findByRole("checkbox", { name: "Mount skill charting" });
    // The pending pick renders checked (the draft mount set).
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(onPendingSkillsChange).toHaveBeenCalledWith(["cleaning"]);
    expect(unmountSkill).not.toHaveBeenCalled();
  });

  it("pins pending picks to the top of the draft list", async () => {
    renderTrigger(
      <ComposerSkillsTrigger
        sessionId={null}
        {...DRAFT_PROPS}
        pendingSkills={["cleaning"]}
        onPendingSkillsChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Skills/ }));
    await screen.findByRole("checkbox", { name: "Mount skill charting" });
    const boxes = screen.getAllByRole("checkbox");
    // cleaning (pending) sorts ahead of charting (registry order otherwise).
    expect(boxes[0]).toHaveAttribute("aria-label", "Mount skill cleaning");
  });

  it("keeps the session-mode mount IPC when sessionId is non-null", async () => {
    renderTrigger(
      <ComposerSkillsTrigger sessionId="sess-1" {...DRAFT_PROPS} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Skills/ }));
    const checkbox = await screen.findByRole("checkbox", { name: "Mount skill charting" });
    fireEvent.click(checkbox);
    await waitFor(() => expect(mountSkill).toHaveBeenCalledWith("sess-1", "charting"));
  });
});
