import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ComposerContextPanel } from "../ComposerContextPanel";
import { listMcpServerStatus } from "../../../api";
import type { McpServerStatusEntry } from "../../../types/mcp";

// ComposerContextPanel is the composer "+" shell (ADR-0083, issue #351):
// three-section context panel (files / skills / MCP) with a degraded
// pure-add-files mode and an enabled-count badge. Routes its chrome through
// react-intl (ADR-0052); rendered inside an empty-catalog English
// IntlProvider so assertions anchor on the canonical defaultMessage strings.
// listMcpServerStatus + the dialog plugin are mocked so the view never hits
// Tauri (ADR-0029).
vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    listMcpServerStatus: vi.fn(),
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
    connected: false,
    tool_count: 0,
    error: null,
  };
}

function renderPanel(
  props: Partial<{
    sessionId: string;
    onIngestFiles: (paths: string[]) => void;
    loading: boolean;
    mcpConfigured: boolean;
  }> = {},
) {
  const onIngestFiles = props.onIngestFiles ?? vi.fn();
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
        />
      </IntlProvider>
    </QueryClientProvider>
  );
  return { ...render(view), onIngestFiles };
}

describe("ComposerContextPanel (ADR-0083, issue #351)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listMcpServerStatus).mockResolvedValue([]);
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
      // Sections 2 + 3: skills / MCP -- disabled placeholders until #303 / #301
      // light them up.
      expect(screen.getByText("Skills")).toBeInTheDocument();
      expect(screen.getByText("MCP tools")).toBeInTheDocument();
      expect(screen.getAllByText("Not available yet")).toHaveLength(2);
    });

    it("marks the skills + MCP placeholder sections aria-disabled", async () => {
      renderPanel({ mcpConfigured: true });
      fireEvent.click(screen.getByRole("button", { name: "Add session context" }));
      await screen.findByRole("button", { name: "Select data files…" });

      // The popover content is portaled to document.body, outside the render
      // container, so query from the document.
      const disabledSections = document.querySelectorAll("[aria-disabled='true']");
      expect(disabledSections.length).toBe(2);
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
});
