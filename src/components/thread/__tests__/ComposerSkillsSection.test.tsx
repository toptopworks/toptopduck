import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";

import { ComposerSkillsSection } from "../ComposerSkillsSection";
import {
  activateSkill,
  conversation,
  listActivatedSkills,
  listMountedSkills,
  listSkills,
  unmountSkill,
} from "../../../api";
import { sessionKeys } from "../../../session/queryKeys";
import { TooltipProvider } from "../../ui/tooltip";
import type { SkillEntry } from "../../../types/skills";

// The user activation affordance (issue #699, ADR-0110 Decision 5): a mounted
// unactivated row carries a row-tail activate action; an activated row carries
// the Active badge instead. The checkbox's mount semantics are untouched, the
// action shares the loading + pendingNames gate, unmount cascades the
// activation cache, and draft mode (null sessionId) renders no activation
// affordance at all (no pre-activation concept). Session-mode pins; the draft
// pins live in ComposerSkillsTrigger.test.tsx. Rendered inside an empty-catalog
// English IntlProvider (defaultMessage is the canonical source, ADR-0052).
vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    listSkills: vi.fn(),
    listMountedSkills: vi.fn(),
    listActivatedSkills: vi.fn(),
    conversation: vi.fn(),
    unmountSkill: vi.fn(async () => {}),
    activateSkill: vi.fn(async () => {}),
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

describe("ComposerSkillsSection activation affordance (issue #699)", () => {
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

  it("activates a mounted unactivated row and shows the Active badge on success", async () => {
    // Mutable backend state: the invalidate's reconciliation refetch must see
    // the post-mutation truth, or it would overwrite the optimistic delta
    // (static mockResolvedValue pins the pre-state and un-renders the badge).
    const state = { activated: [] as string[] };
    vi.mocked(listMountedSkills).mockResolvedValue(["charting"]);
    vi.mocked(listActivatedSkills).mockImplementation(async () => [
      ...state.activated,
    ]);
    vi.mocked(activateSkill).mockImplementation(async (_sid, name) => {
      state.activated = [...state.activated, name];
    });
    renderSection(
      <ComposerSkillsSection sessionId="sess-1" {...PROPS} />,
    );
    const action = await screen.findByRole("button", {
      name: "Activate skill charting",
    });
    fireEvent.click(action);
    await waitFor(() =>
      expect(activateSkill).toHaveBeenCalledWith("sess-1", "charting"),
    );
    // The badge lands via the synchronous cache delta (applyActivationDelta)
    // and survives the reconciliation refetch.
    await screen.findByText("Active");
  });

  it("gates the activate action mid-turn and while the row mutation is pending", async () => {
    vi.mocked(listMountedSkills).mockResolvedValue(["charting"]);
    // The in-flight activation never settles, pinning the row in pendingNames.
    vi.mocked(activateSkill).mockImplementation(() => new Promise(() => {}));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const ui = (loading: boolean) => (
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={{}} onError={() => {}}>
          <TooltipProvider delayDuration={0}>
            <ComposerSkillsSection
              sessionId="sess-1"
              {...PROPS}
              loading={loading}
            />
          </TooltipProvider>
        </IntlProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(ui(true));
    // Mid-turn gate: loading disables the action before any click.
    const gated = await screen.findByRole("button", {
      name: "Activate skill charting",
    });
    expect(gated).toBeDisabled();
    // Row-mutation gate: with loading lifted, an in-flight activation pins
    // the row in pendingNames and the action stays disabled.
    rerender(ui(false));
    const live = screen.getByRole("button", {
      name: "Activate skill charting",
    });
    expect(live).toBeEnabled();
    fireEvent.click(live);
    await waitFor(() => expect(live).toBeDisabled());
  });

  it("shows no deactivation control on an activated row (unmount is the sole exit)", async () => {
    vi.mocked(listMountedSkills).mockResolvedValue(["charting"]);
    vi.mocked(listActivatedSkills).mockResolvedValue(["charting"]);
    renderSection(
      <ComposerSkillsSection sessionId="sess-1" {...PROPS} />,
    );
    await screen.findByText("Active");
    // No activate action, no deactivate action -- the only controls left are
    // the mount checkbox and the add-skill footer.
    expect(
      screen.queryByRole("button", { name: /skill charting/i }),
    ).not.toBeInTheDocument();
  });

  it("cascades on unmount: the badge disappears with the mount checkbox", async () => {
    // Mutable backend state (same reason as the activation test): the
    // reconciliation refetch must agree that the unmount removed the name
    // from BOTH sets.
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

  it("renders no activation affordance on unmounted rows", async () => {
    renderSection(
      <ComposerSkillsSection sessionId="sess-1" {...PROPS} />,
    );
    await screen.findByRole("checkbox", { name: "Mount skill charting" });
    expect(
      screen.queryByRole("button", { name: /Activate skill/ }),
    ).not.toBeInTheDocument();
  });

  it("renders no activation affordance in draft mode and reads no activation IPC", async () => {
    renderSection(
      <ComposerSkillsSection
        sessionId={null}
        {...PROPS}
        pendingSkills={["charting"]}
        onPendingSkillsChange={vi.fn()}
      />,
    );
    // The pending pick renders mounted (checked) yet carries no activate
    // action: activation is session-scoped, so draft mode has no face for it.
    await screen.findByRole("checkbox", { name: "Mount skill charting" });
    expect(
      screen.queryByRole("button", { name: /Activate skill/ }),
    ).not.toBeInTheDocument();
    expect(listActivatedSkills).not.toHaveBeenCalled();
  });

  it("surfaces an activation rejection through the alert slot", async () => {
    vi.mocked(listMountedSkills).mockResolvedValue(["charting"]);
    vi.mocked(activateSkill).mockRejectedValue(new Error("boom"));
    renderSection(
      <ComposerSkillsSection sessionId="sess-1" {...PROPS} />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Activate skill charting" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toBeInTheDocument(),
    );
  });

  it("refetches the thread after a skill mutation so the marker appears", async () => {
    // The mutation appends a lifecycle event to the SERVER timeline; the
    // thread cache is the marker's only channel and staleTime is Infinity,
    // so without an explicit invalidation the marker never shows. Pin the
    // refetch by mounting a real observer of the thread key next to the
    // section (an active observer turns the invalidation into a refetch).
    const state = {
      mounted: ["charting", "cleaning"],
      activated: [] as string[],
    };
    vi.mocked(listMountedSkills).mockImplementation(async () => [
      ...state.mounted,
    ]);
    vi.mocked(listActivatedSkills).mockImplementation(async () => [
      ...state.activated,
    ]);
    vi.mocked(activateSkill).mockImplementation(async (_sid, name) => {
      state.activated = [...state.activated, name];
    });
    vi.mocked(unmountSkill).mockImplementation(async (_sid, name) => {
      state.mounted = state.mounted.filter((n) => n !== name);
      state.activated = state.activated.filter((n) => n !== name);
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
    await screen.findByRole("button", { name: "Activate skill charting" });
    await waitFor(() => expect(conversation).toHaveBeenCalled());
    const beforeActivate = vi.mocked(conversation).mock.calls.length;
    fireEvent.click(
      screen.getByRole("button", { name: "Activate skill charting" }),
    );
    await screen.findByText("Active");
    await waitFor(() =>
      expect(vi.mocked(conversation).mock.calls.length).toBeGreaterThan(
        beforeActivate,
      ),
    );
    // The unmount cascade rides the same thread refresh (its Unmount marker
    // has the same channel).
    const beforeUnmount = vi.mocked(conversation).mock.calls.length;
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Mount skill cleaning" }),
    );
    await waitFor(() => expect(unmountSkill).toHaveBeenCalled());
    await waitFor(() =>
      expect(vi.mocked(conversation).mock.calls.length).toBeGreaterThan(
        beforeUnmount,
      ),
    );
  });
});
