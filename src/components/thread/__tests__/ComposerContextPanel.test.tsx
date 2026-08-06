import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ComposerContextPanel } from "../ComposerContextPanel";
import {
  listMountedSkills,
  listMcpServerStatus,
  listSkills,
  mountSkill,
  unmountSkill,
} from "../../../api";
import type { SkillEntry, SkillListing } from "../../../types/skills";
import type { McpServerStatusEntry } from "../../../types/mcp";

// ComposerContextPanel is the composer "+" shell (ADR-0083, issue #351):
// three-section context panel (files / skills / MCP). The skills section went
// live in issue #365; the MCP section went live in issue #369 (three-state
// server enablement). Routes its chrome through react-intl
// (ADR-0052); rendered inside an empty-catalog English IntlProvider so
// assertions anchor on the canonical defaultMessage strings. The skill + mount
// APIs + the dialog plugin are mocked so the view never hits Tauri (ADR-0029).
vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    listMcpServerStatus: vi.fn(),
    listSkills: vi.fn(),
    listMountedSkills: vi.fn(),
    mountSkill: vi.fn(),
    unmountSkill: vi.fn(),
  };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { open } from "@tauri-apps/plugin-dialog";

// A per-session MCP status row fixture (issue #301 slice D shape).
function status(id: string, enabled: boolean): McpServerStatusEntry {
  return {
    id,
    display_name: id,
    enabled,
    source: enabled ? { kind: "user" } : null,
    connected: false,
    tool_count: 0,
    tools: [],
    error: null,
  };
}

// A registry skill fixture (issue #362 wire shape). Defaults to a local skill
// with no MCP refs; tests override the bits they exercise.
function skill(
  name: string,
  overrides: Partial<SkillEntry> = {},
): SkillEntry {
  return {
    name,
    description: `${name} description`,
    acquired: "local",
    license: null,
    compatibility: null,
    mcp_servers: [],
    body: "body",
    link_target: null,
    content_hash: "deadbeef",
    ...overrides,
  };
}

function listing(skills: SkillEntry[]): SkillListing {
  return { skills, ignored: [] };
}

function renderPanel(
  props: Partial<{
    sessionId: string;
    onIngestFiles: (paths: string[]) => void;
    loading: boolean;
    mcpConfigured: boolean;
    onOpenSettingsSkills: () => void;
  }> = {},
) {
  const onIngestFiles = props.onIngestFiles ?? vi.fn();
  const onOpenSettingsSkills = props.onOpenSettingsSkills ?? vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view: ReactElement = (
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <ComposerContextPanel
          sessionId={props.sessionId ?? "sess-1"}
          onIngestFiles={onIngestFiles}
          loading={props.loading ?? false}
          mcpConfigured={props.mcpConfigured ?? false}
          onOpenSettingsSkills={onOpenSettingsSkills}
        />
      </IntlProvider>
    </QueryClientProvider>
  );
  return { ...render(view), onIngestFiles, onOpenSettingsSkills };
}

describe("ComposerContextPanel (ADR-0083, issue #351)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listMcpServerStatus).mockResolvedValue([]);
    // Default: an empty registry + an empty mount set. Individual tests
    // override to drive degraded vs panel mode + the skill section's content.
    vi.mocked(listSkills).mockResolvedValue(listing([]));
    vi.mocked(listMountedSkills).mockResolvedValue([]);
  });

  describe("degraded mode (no skills, no configured MCP)", () => {
    it("is a pure add-files button that opens the multi-select dialog", async () => {
      vi.mocked(open).mockResolvedValue(["/a.csv", "/b.csv"]);
      const { onIngestFiles } = renderPanel({ mcpConfigured: false });

      fireEvent.click(screen.getByRole("button", { name: "Add files" }));

      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({ multiple: true }),
      );
      await waitFor(() =>
        expect(onIngestFiles).toHaveBeenCalledWith(["/a.csv", "/b.csv"]),
      );
    });

    it("normalizes a single-string dialog result into a one-path batch", async () => {
      // The dialog plugin types allow a bare string return; the panel always
      // hands the ingest pipeline an array.
      vi.mocked(open).mockResolvedValue("/a.csv");
      const { onIngestFiles } = renderPanel({ mcpConfigured: false });

      fireEvent.click(screen.getByRole("button", { name: "Add files" }));

      await waitFor(() => expect(onIngestFiles).toHaveBeenCalledWith(["/a.csv"]));
    });

    it("does not ingest when the dialog is cancelled", async () => {
      vi.mocked(open).mockResolvedValue(null);
      const { onIngestFiles } = renderPanel({ mcpConfigured: false });

      fireEvent.click(screen.getByRole("button", { name: "Add files" }));

      await waitFor(() => expect(open).toHaveBeenCalled());
      expect(onIngestFiles).not.toHaveBeenCalled();
    });

    it("is disabled while the session is loading", () => {
      renderPanel({ mcpConfigured: false, loading: true });
      expect(screen.getByRole("button", { name: "Add files" })).toBeDisabled();
    });

    it("hides the badge even if a stray status read returns enabled servers", async () => {
      // Degraded means nothing can be attached; the badge must not render even
      // on an inconsistent status read (ADR-0083: hidden in degraded mode).
      vi.mocked(listMcpServerStatus).mockResolvedValue([status("srv", true)]);
      renderPanel({ mcpConfigured: false });

      // Let any stray query settle, then assert no badge digit rendered.
      await waitFor(() => expect(listMcpServerStatus).toHaveBeenCalled());
      expect(screen.queryByText("1")).not.toBeInTheDocument();
    });
  });

  describe("panel mode (MCP configured)", () => {
    it("opens the three-section panel shell on click", async () => {
      renderPanel({ mcpConfigured: true });

      fireEvent.click(screen.getByRole("button", { name: "Add session context" }));

      // Section 1: files -- live entry.
      expect(
        await screen.findByRole("button", { name: "Select data files…" }),
      ).toBeInTheDocument();
      // Section 2: skills -- live (issue #365). The compact list renders the
      // empty-state hint once the registry read resolves (no flicker during
      // the loading phase, issue #365 review A1).
      expect(screen.getByText("Skills")).toBeInTheDocument();
      expect(
        await screen.findByText("No skills yet. Add one in Settings."),
      ).toBeInTheDocument();
      // Section 3: MCP tools -- live (issue #369). The section renders only
      // when at least one server is configured; the default mock returns [],
      // so no MCP header appears in this test.
      expect(screen.queryByText("MCP tools")).not.toBeInTheDocument();
    });

    it("renders the MCP section when servers are configured", async () => {
      vi.mocked(listMcpServerStatus).mockResolvedValue([status("srv-a", false)]);
      renderPanel({ mcpConfigured: true });
      fireEvent.click(screen.getByRole("button", { name: "Add session context" }));
      await screen.findByRole("button", { name: "Select data files…" });

      expect(await screen.findByText("MCP tools")).toBeInTheDocument();
      expect(screen.getByText("srv-a")).toBeInTheDocument();
    });

    it("ingests the picked files and closes the panel", async () => {
      vi.mocked(open).mockResolvedValue(["/a.csv", "/b.parquet"]);
      const { onIngestFiles } = renderPanel({ mcpConfigured: true });

      fireEvent.click(screen.getByRole("button", { name: "Add session context" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Select data files…" }),
      );

      await waitFor(() =>
        expect(onIngestFiles).toHaveBeenCalledWith(["/a.csv", "/b.parquet"]),
      );
      // The panel closes once the batch is on its way.
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Select data files…" }),
        ).not.toBeInTheDocument(),
      );
    });

    it("keeps the panel open when the dialog is cancelled", async () => {
      vi.mocked(open).mockResolvedValue(null);
      const { onIngestFiles } = renderPanel({ mcpConfigured: true });

      fireEvent.click(screen.getByRole("button", { name: "Add session context" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Select data files…" }),
      );

      await waitFor(() => expect(open).toHaveBeenCalled());
      expect(onIngestFiles).not.toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: "Select data files…" }),
      ).toBeInTheDocument();
    });

    it("disables the file entry while the session is loading", async () => {
      renderPanel({ mcpConfigured: true, loading: true });
      fireEvent.click(screen.getByRole("button", { name: "Add session context" }));
      expect(
        await screen.findByRole("button", { name: "Select data files…" }),
      ).toBeDisabled();
    });

    it("badges the enabled-MCP count on the trigger", async () => {
      vi.mocked(listMcpServerStatus).mockResolvedValue([
        status("a", true),
        status("b", false),
        status("c", true),
      ]);
      renderPanel({ mcpConfigured: true });

      // Two of the three configured servers are enabled for this session.
      expect(await screen.findByText("2")).toBeInTheDocument();
    });

    it("includes the enabled count in the trigger's accessible name", async () => {
      vi.mocked(listMcpServerStatus).mockResolvedValue([status("a", true)]);
      renderPanel({ mcpConfigured: true });

      expect(
        await screen.findByRole("button", {
          name: "Add session context (1 attached)",
        }),
      ).toBeInTheDocument();
    });

    it("hides the badge when no MCP server is enabled", async () => {
      vi.mocked(listMcpServerStatus).mockResolvedValue([status("a", false)]);
      renderPanel({ mcpConfigured: true });

      await waitFor(() => expect(listMcpServerStatus).toHaveBeenCalled());
      expect(screen.getByRole("button", { name: "Add session context" })).toBeInTheDocument();
      expect(screen.queryByText("0")).not.toBeInTheDocument();
    });

    it("degrades to a zero badge when the status read rejects", async () => {
      // A session that closed mid-flight rejects the status query; the panel
      // still works, badge hidden (honest-degrade, never a user-facing error).
      vi.mocked(listMcpServerStatus).mockRejectedValue(new Error("session gone"));
      renderPanel({ mcpConfigured: true });

      await waitFor(() => expect(listMcpServerStatus).toHaveBeenCalled());
      expect(screen.getByRole("button", { name: "Add session context" })).toBeInTheDocument();
    });
  });

  describe("skill section (issue #365)", () => {
    it("opens the panel when the registry has skills even without MCP configured", async () => {
      // ADR-0083 degraded decision now also considers the skill registry: a
      // non-empty registry keeps the panel out of degraded mode even with no
      // configured MCP (issue #365).
      vi.mocked(listSkills).mockResolvedValue(listing([skill("alpha")]));
      renderPanel({ mcpConfigured: false });

      expect(
        await screen.findByRole("button", { name: "Add session context" }),
      ).toBeInTheDocument();
    });

    it("renders every registry skill as a checkbox row", async () => {
      vi.mocked(listSkills).mockResolvedValue(
        listing([skill("alpha"), skill("beta"), skill("gamma")]),
      );
      renderPanel({ mcpConfigured: true });

      fireEvent.click(screen.getByRole("button", { name: "Add session context" }));

      expect(
        await screen.findByRole("checkbox", { name: "Mount skill alpha" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: "Mount skill beta" })).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: "Mount skill gamma" })).toBeInTheDocument();
    });

    it("reflects the session's mounted set as checked", async () => {
      vi.mocked(listSkills).mockResolvedValue(
        listing([skill("alpha"), skill("beta")]),
      );
      vi.mocked(listMountedSkills).mockResolvedValue(["alpha"]);
      renderPanel({ mcpConfigured: true });

      fireEvent.click(screen.getByRole("button", { name: "Add session context" }));

      const alpha = await screen.findByRole("checkbox", { name: "Mount skill alpha" });
      const beta = screen.getByRole("checkbox", { name: "Mount skill beta" });
      expect(alpha).toBeChecked();
      expect(beta).not.toBeChecked();
    });

    it("mounts an unchecked skill on toggle", async () => {
      vi.mocked(listSkills).mockResolvedValue(listing([skill("alpha")]));
      renderPanel({ mcpConfigured: true });

      fireEvent.click(screen.getByRole("button", { name: "Add session context" }));
      fireEvent.click(
        await screen.findByRole("checkbox", { name: "Mount skill alpha" }),
      );

      await waitFor(() => expect(mountSkill).toHaveBeenCalledWith("sess-1", "alpha"));
    });

    it("unmounts a checked skill on toggle", async () => {
      vi.mocked(listSkills).mockResolvedValue(listing([skill("alpha")]));
      vi.mocked(listMountedSkills).mockResolvedValue(["alpha"]);
      renderPanel({ mcpConfigured: true });

      fireEvent.click(screen.getByRole("button", { name: "Add session context" }));
      fireEvent.click(
        await screen.findByRole("checkbox", { name: "Mount skill alpha" }),
      );

      await waitFor(() => expect(unmountSkill).toHaveBeenCalledWith("sess-1", "alpha"));
    });

    it("seeds the mounted cache so the checkbox flips on instantly after a mount", async () => {
      vi.mocked(listSkills).mockResolvedValue(listing([skill("alpha")]));
      // The backend truth arrives on the post-mount refetch: the seed holds
      // the checkbox on through the round-trip (without this the row would
      // flip back off until the refetch lands).
      vi.mocked(listMountedSkills).mockResolvedValueOnce([]).mockResolvedValue(["alpha"]);
      renderPanel({ mcpConfigured: true });

      fireEvent.click(screen.getByRole("button", { name: "Add session context" }));
      fireEvent.click(
        await screen.findByRole("checkbox", { name: "Mount skill alpha" }),
      );

      await waitFor(() =>
        expect(screen.getByRole("checkbox", { name: "Mount skill alpha" })).toBeChecked(),
      );
    });

    it("surfaces a rejected mount as an alert (no silent failure)", async () => {
      // AC#3 honest-degrade contract: a mount reject (AlreadyMounted on a stale
      // cache, SessionError::InFlight from a race, etc.) must reach the alert
      // slot, not vanish. fmtError renders the typed reject; the section's
      // `role="alert"` is the user-visible surface.
      vi.mocked(listSkills).mockResolvedValue(listing([skill("alpha")]));
      vi.mocked(mountSkill).mockRejectedValueOnce(new Error("AlreadyMounted"));
      renderPanel({ mcpConfigured: true });

      fireEvent.click(screen.getByRole("button", { name: "Add session context" }));
      fireEvent.click(
        await screen.findByRole("checkbox", { name: "Mount skill alpha" }),
      );

      expect(await screen.findByRole("alert")).toBeInTheDocument();
      // The row unlocks once the mutation settles (clearPending onSettled).
      await waitFor(() =>
        expect(
          screen.getByRole("checkbox", { name: "Mount skill alpha" }),
        ).not.toBeDisabled(),
      );
    });

    it("filters the list by name as the user types", async () => {
      vi.mocked(listSkills).mockResolvedValue(
        listing([skill("alpha"), skill("beta"), skill("gamma")]),
      );
      renderPanel({ mcpConfigured: true });

      fireEvent.click(screen.getByRole("button", { name: "Add session context" }));
      await screen.findByRole("checkbox", { name: "Mount skill alpha" });

      fireEvent.change(screen.getByPlaceholderText("Search skills…"), {
        target: { value: "bet" },
      });

      expect(screen.getByRole("checkbox", { name: "Mount skill beta" })).toBeInTheDocument();
      expect(screen.queryByRole("checkbox", { name: "Mount skill alpha" })).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox", { name: "Mount skill gamma" })).not.toBeInTheDocument();
    });

    it("disables every toggle while the session is loading", async () => {
      vi.mocked(listSkills).mockResolvedValue(listing([skill("alpha")]));
      renderPanel({ mcpConfigured: true, loading: true });

      fireEvent.click(screen.getByRole("button", { name: "Add session context" }));
      expect(
        await screen.findByRole("checkbox", { name: "Mount skill alpha" }),
      ).toBeDisabled();
    });

    it("does not call mount when a toggle is clicked under the loading gate", async () => {
      vi.mocked(listSkills).mockResolvedValue(listing([skill("alpha")]));
      renderPanel({ mcpConfigured: true, loading: true });

      fireEvent.click(screen.getByRole("button", { name: "Add session context" }));
      fireEvent.click(
        await screen.findByRole("checkbox", { name: "Mount skill alpha" }),
      );

      expect(mountSkill).not.toHaveBeenCalled();
    });

    it("does not enqueue a second mount on a rapid double-click", async () => {
      // The pending-name guard: a double-click on the SAME row cannot queue a
      // redundant IPC. The mount never resolves so pendingNames stays set; the
      // second click's `toggle` short-circuits on `pendingNames.has(name)`,
      // and the row's `disabled` attribute agrees.
      vi.mocked(listSkills).mockResolvedValue(listing([skill("alpha")]));
      vi.mocked(mountSkill).mockImplementationOnce(
        () => new Promise<void>(() => {}),
      );
      renderPanel({ mcpConfigured: true });

      fireEvent.click(screen.getByRole("button", { name: "Add session context" }));
      const checkbox = await screen.findByRole("checkbox", {
        name: "Mount skill alpha",
      });

      fireEvent.click(checkbox);
      // Let the first mutate + onMutate land (mutationFn invoked, the row's
      // pendingName set + `disabled` attribute applied).
      await waitFor(() => expect(mountSkill).toHaveBeenCalledTimes(1));

      fireEvent.click(checkbox);

      // The pending-name guard (and the row's now-disabled flag) keeps the
      // second click from queuing a redundant IPC.
      expect(mountSkill).toHaveBeenCalledTimes(1);
    });

    it("fires onOpenSettingsSkills when the Manage skills footer is clicked", async () => {
      vi.mocked(listSkills).mockResolvedValue(listing([skill("alpha")]));
      const { onOpenSettingsSkills } = renderPanel({ mcpConfigured: true });

      fireEvent.click(screen.getByRole("button", { name: "Add session context" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Manage skills" }),
      );

      expect(onOpenSettingsSkills).toHaveBeenCalledOnce();
    });

    it("counts mounted skills into the trigger badge", async () => {
      vi.mocked(listSkills).mockResolvedValue(
        listing([skill("alpha"), skill("beta")]),
      );
      vi.mocked(listMountedSkills).mockResolvedValue(["alpha", "beta"]);
      renderPanel({ mcpConfigured: true });

      expect(
        await screen.findByRole("button", {
          name: "Add session context (2 attached)",
        }),
      ).toBeInTheDocument();
    });

    it("coalesces a rejected mount-set read to a hidden badge (no user-facing error)", async () => {
      // A session that closed mid-flight rejects the mount-set query; the
      // panel keeps working, badge hidden (honest-degrade). The panel-mode
      // decision rides on the registry read, not the mount-set read, so the
      // registry must resolve first.
      vi.mocked(listMountedSkills).mockRejectedValue(new Error("session gone"));
      vi.mocked(listSkills).mockResolvedValue(listing([skill("alpha")]));
      renderPanel({ mcpConfigured: false });

      expect(
        await screen.findByRole("button", { name: "Add session context" }),
      ).toBeInTheDocument();
    });
  });
});
