import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";

import { ComposerSkillsSection } from "../ComposerSkillsSection";
import {
  conversation,
  listActivatedSkills,
  listMountedSkills,
  listSkills,
  mountSkill,
  unmountSkill,
} from "../../../api";
import { sessionKeys } from "../../../session/queryKeys";
import { TooltipProvider } from "../../ui/tooltip";
import type { SkillEntry } from "../../../types/skills";

// The mount trust gate under ADR-0112 (issue #716): the list keeps the
// checkbox authority (mount) and the Active badge (display only); the
// activation ENTRY is the input-bar picker, so no row-tail action exists
// anymore (the retired #699 Zap made way). A picker selection's intent
// unions into the checkbox display (activationIntents), and clearing a
// selection cascades the intent away with the mount (draft + session
// modes). The unmount cascade + thread-refetch pins carry over from #699.
// Rendered inside an empty-catalog English IntlProvider (defaultMessage is
// the canonical source, ADR-0052).
vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    listSkills: vi.fn(),
    listMountedSkills: vi.fn(),
    listActivatedSkills: vi.fn(),
    conversation: vi.fn(),
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

function renderSection(ui: ReactElement) {
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

const PROPS = {
  loading: false,
  onOpenSettingsSkills: vi.fn(),
};

describe("ComposerSkillsSection trust gate + intent union (ADR-0112)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listSkills).mockResolvedValue({
      skills: [skill("charting"), skill("cleaning")],
      ignored: [],
      root_error: null,
    });
    vi.mocked(listMountedSkills).mockResolvedValue([]);
    vi.mocked(listActivatedSkills).mockResolvedValue([]);
  });

  it("renders no activation action on any row -- the input-bar picker is the entry", async () => {
    vi.mocked(listMountedSkills).mockResolvedValue(["charting"]);
    renderSection(
      <ComposerSkillsSection sessionId="sess-1" {...PROPS} />,
    );
    await screen.findByRole("checkbox", { name: "Mount skill charting" });
    expect(
      screen.queryByRole("button", { name: /skill charting/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the Active badge on an activated row and no deactivation control (unmount is the sole exit)", async () => {
    vi.mocked(listMountedSkills).mockResolvedValue(["charting"]);
    vi.mocked(listActivatedSkills).mockResolvedValue(["charting"]);
    renderSection(
      <ComposerSkillsSection sessionId="sess-1" {...PROPS} />,
    );
    await screen.findByText("Active");
    expect(
      screen.queryByRole("button", { name: /skill charting/i }),
    ).not.toBeInTheDocument();
  });

  it("checks the box for a pre-activation intent without mounting (union display, no IPC)", async () => {
    renderSection(
      <ComposerSkillsSection
        sessionId="sess-1"
        {...PROPS}
        activationIntents={["charting"]}
        onActivationIntentsChange={vi.fn()}
      />,
    );
    // The intent unions into the checkbox display while the mount IPC never
    // fires -- the composite materializes at submit, not at selection.
    expect(
      await screen.findByRole("checkbox", { name: "Mount skill charting" }),
    ).toBeChecked();
    expect(mountSkill).not.toHaveBeenCalled();
  });

  it("unchecking an intent-only row removes the intent with no IPC", async () => {
    const onActivationIntentsChange = vi.fn();
    renderSection(
      <ComposerSkillsSection
        sessionId="sess-1"
        {...PROPS}
        activationIntents={["charting"]}
        onActivationIntentsChange={onActivationIntentsChange}
      />,
    );
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Mount skill charting" }),
    );
    expect(onActivationIntentsChange).toHaveBeenCalledWith([]);
    // The row never mounted, so the uncheck is pure intent removal -- no
    // unmount IPC to refuse with NotMounted.
    expect(unmountSkill).not.toHaveBeenCalled();
    expect(mountSkill).not.toHaveBeenCalled();
  });

  it("unchecking a mounted + intent row cascades both (intent + unmount IPC)", async () => {
    vi.mocked(listMountedSkills).mockResolvedValue(["charting"]);
    const onActivationIntentsChange = vi.fn();
    renderSection(
      <ComposerSkillsSection
        sessionId="sess-1"
        {...PROPS}
        activationIntents={["charting"]}
        onActivationIntentsChange={onActivationIntentsChange}
      />,
    );
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Mount skill charting" }),
    );
    expect(onActivationIntentsChange).toHaveBeenCalledWith([]);
    await waitFor(() =>
      expect(unmountSkill).toHaveBeenCalledWith("sess-1", "charting"),
    );
  });

  it("draft mode: unchecking drops the pending pick and the intent together", async () => {
    const onPendingSkillsChange = vi.fn();
    const onActivationIntentsChange = vi.fn();
    renderSection(
      <ComposerSkillsSection
        sessionId={null}
        {...PROPS}
        pendingSkills={["charting"]}
        onPendingSkillsChange={onPendingSkillsChange}
        activationIntents={["charting"]}
        onActivationIntentsChange={onActivationIntentsChange}
      />,
    );
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Mount skill charting" }),
    );
    expect(onPendingSkillsChange).toHaveBeenCalledWith([]);
    expect(onActivationIntentsChange).toHaveBeenCalledWith([]);
  });

  it("cascades on unmount: the badge disappears with the mount checkbox", async () => {
    // Mutable backend state: the invalidate's reconciliation refetch must
    // agree that the unmount removed the name from BOTH sets.
    const state = {
      mounted: ["charting"],
      activated: ["charting"],
    };
    vi.mocked(listMountedSkills).mockImplementation(async () => [
      ...state.mounted,
    ]);
    vi.mocked(listActivatedSkills).mockImplementation(async () => [
      ...state.activated,
    ]);
    vi.mocked(unmountSkill).mockImplementation(async (_sid, name) => {
      state.mounted = state.mounted.filter((n) => n !== name);
      state.activated = state.activated.filter((n) => n !== name);
    });
    renderSection(
      <ComposerSkillsSection sessionId="sess-1" {...PROPS} />,
    );
    await screen.findByText("Active");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Mount skill charting" }),
    );
    await waitFor(() =>
      expect(unmountSkill).toHaveBeenCalledWith("sess-1", "charting"),
    );
    // Both caches drop the name in the same synchronous delta -- the badge
    // and the checkbox converge without waiting for the refetch.
    await waitFor(() => {
      expect(screen.queryByText("Active")).not.toBeInTheDocument();
      expect(
        screen.getByRole("checkbox", { name: "Mount skill charting" }),
      ).not.toBeChecked();
    });
  });

  it("refetches the thread after mount/unmount mutations so the marker appears", async () => {
    // The mutation appends a lifecycle event to the SERVER timeline; the
    // thread cache is the marker's only channel and staleTime is Infinity,
    // so without an explicit invalidation the marker never shows. Pin the
    // refetch by mounting a real observer of the thread key next to the
    // section (an active observer turns the invalidation into a refetch).
    const state = { mounted: ["charting", "cleaning"] };
    vi.mocked(listMountedSkills).mockImplementation(async () => [
      ...state.mounted,
    ]);
    vi.mocked(unmountSkill).mockImplementation(async (_sid, name) => {
      state.mounted = state.mounted.filter((n) => n !== name);
    });
    vi.mocked(mountSkill).mockImplementation(async (_sid, name) => {
      state.mounted = [...state.mounted, name];
    });
    vi.mocked(conversation).mockResolvedValue([]);
    function ThreadObserver() {
      useQuery({
        queryKey: sessionKeys.thread("sess-1"),
        queryFn: () => conversation("sess-1"),
      });
      return null;
    }
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={{}} onError={() => {}}>
          <TooltipProvider delayDuration={0}>
            <ThreadObserver />
            <ComposerSkillsSection sessionId="sess-1" {...PROPS} />
          </TooltipProvider>
        </IntlProvider>
      </QueryClientProvider>,
    );
    await screen.findByRole("checkbox", { name: "Mount skill charting" });
    await waitFor(() => expect(conversation).toHaveBeenCalled());
    const beforeUnmount = vi.mocked(conversation).mock.calls.length;
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Mount skill cleaning" }),
    );
    await waitFor(() => expect(unmountSkill).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: "Mount skill cleaning" }),
      ).not.toBeChecked(),
    );
    // The unmount beat refreshes the thread (its Unmount marker has the
    // same channel).
    await waitFor(() =>
      expect(vi.mocked(conversation).mock.calls.length).toBeGreaterThan(
        beforeUnmount,
      ),
    );
    // The mount beat rides the same refresh -- the Mount marker shares the
    // channel, and it is this invalidation (not a turn) that surfaces it.
    const beforeMount = vi.mocked(conversation).mock.calls.length;
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Mount skill cleaning" }),
    );
    await waitFor(() => expect(mountSkill).toHaveBeenCalled());
    await waitFor(() =>
      expect(vi.mocked(conversation).mock.calls.length).toBeGreaterThan(
        beforeMount,
      ),
    );
  });
});
