import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as dialogPlugin from "@tauri-apps/plugin-dialog";

import {
  ComposerWorkspacePicker,
  type PendingWorkspace,
} from "../ComposerWorkspacePicker";
import { listWorkspaces } from "../../../api";

// ComposerWorkspacePicker tests (issue #1384): the session-creation
// selector's two-state pill + popover (recent list top 10, folder browse,
// the bound-only "No workspace" undo). Rendered inside an English
// IntlProvider so assertions anchor on stable English strings; the IPC
// surface (listWorkspaces) and the system dialog are mocked so the view
// never hits Tauri.

vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return { ...actual, listWorkspaces: vi.fn() };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

function renderPicker(
  value: PendingWorkspace | null,
  onChange: (next: PendingWorkspace | null) => void = vi.fn(),
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <IntlProvider locale="en">
      <QueryClientProvider client={queryClient}>
        <ComposerWorkspacePicker value={value} onChange={onChange} />
      </QueryClientProvider>
    </IntlProvider>,
  );
}

function openPopover() {
  fireEvent.click(screen.getByRole("button"));
}

describe("ComposerWorkspacePicker (issue #1384)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("the unbound face prompts and the popover offers recent + browse only", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/alpha", label: "alpha" },
      { path: "/w/beta", label: "beta" },
    ]);
    renderPicker(null);
    expect(
      screen.getByRole("button", { name: "Select workspace" }),
    ).toBeInTheDocument();
    openPopover();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "beta" })).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Browse folders…" }),
    ).toBeInTheDocument();
    // The undo row is bound-state-only.
    expect(
      screen.queryByRole("button", { name: "No workspace" }),
    ).not.toBeInTheDocument();
  });

  it("the bound face shows the label and the undo row clears the pending value", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([]);
    const onChange = vi.fn();
    renderPicker({ path: "/w/alpha", label: "alpha" }, onChange);
    expect(
      screen.getByRole("button", { name: "Workspace: alpha" }),
    ).toBeInTheDocument();
    openPopover();
    fireEvent.click(await screen.findByRole("button", { name: "No workspace" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("a recent row commits once and closes the popover", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/alpha", label: "alpha" },
      { path: "/w/beta", label: "beta" },
    ]);
    const onChange = vi.fn();
    renderPicker(null, onChange);
    openPopover();
    fireEvent.click(await screen.findByRole("button", { name: "beta" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ path: "/w/beta", label: "beta" });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Browse folders…" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("the recent list shows the freshest 10 only", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({
        path: `/w/ws-${i + 1}`,
        label: `ws-${i + 1}`,
      })),
    );
    renderPicker(null);
    openPopover();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "ws-10" })).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "ws-11" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "ws-12" }),
    ).not.toBeInTheDocument();
  });

  it("a browse pick binds with the derived tail; a cancel changes nothing", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([]);
    const onChange = vi.fn();
    renderPicker(null, onChange);
    openPopover();
    vi.mocked(dialogPlugin.open).mockResolvedValue(
      "C:\\Users\\me\\Projects\\demo",
    );
    fireEvent.click(await screen.findByRole("button", { name: "Browse folders…" }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange).toHaveBeenCalledWith({
      path: "C:\\Users\\me\\Projects\\demo",
      label: "demo",
    });
    // The system dialog cancelled: no commit, no state change.
    onChange.mockClear();
    openPopover();
    vi.mocked(dialogPlugin.open).mockResolvedValue(null);
    fireEvent.click(await screen.findByRole("button", { name: "Browse folders…" }));
    await waitFor(() => expect(dialogPlugin.open).toHaveBeenCalledTimes(2));
    expect(onChange).not.toHaveBeenCalled();
  });
});
