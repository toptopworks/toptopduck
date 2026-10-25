import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as dialogPlugin from "@tauri-apps/plugin-dialog";

import {
  ComposerWorkspacePicker,
  type PendingWorkspace,
} from "../ComposerWorkspacePicker";
import { createWorkspace, listWorkspaces } from "../../../api";

// ComposerWorkspacePicker tests (issues #1384 + #1393): the session-creation
// selector's two-state pill + popover (recent list top 10, folder browse,
// the bound-only "No workspace" undo), then the floating layer's content
// expansion -- the search filter (full-registry hits while typing), the
// aligned row faces, and the naming subview for a new workspace. Rendered
// inside an English IntlProvider so assertions anchor on stable English
// strings; the IPC surfaces (listWorkspaces, createWorkspace) and the system
// dialog are mocked so the view never hits Tauri.

vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return { ...actual, listWorkspaces: vi.fn(), createWorkspace: vi.fn() };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

function renderPicker(
  value: PendingWorkspace | null,
  onChange: (next: PendingWorkspace | null) => void = vi.fn(),
  // The production client pins staleTime: Infinity (ADR-0051 explicit
  // invalidation); the refetch pin passes Infinity so the per-query opt-out
  // is the thing under test, not the test client's default.
  staleTime: number = 0,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime } },
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

  it("every popover open refetches under the production Infinity staleTime", async () => {
    // No mutation path knows to invalidate this key, so the app client's
    // ADR-0051 default (Infinity) would pin the first fetch for the rest
    // of the run; the query opts out itself. Riding the same Infinity
    // default here pins the opt-out: reopen must fetch again.
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/alpha", label: "alpha" },
    ]);
    renderPicker(null, vi.fn(), Infinity);
    openPopover();
    await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(1));
    // Commit a row: the layer closes. Reopening must refetch.
    fireEvent.click(await screen.findByRole("button", { name: "alpha" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Browse folders…" }),
      ).not.toBeInTheDocument(),
    );
    openPopover();
    await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(2));
  });
});

describe("search, row faces, and the naming subview (issue #1393)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("typing widens to the full registry, matching label or path tail case-insensitively", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      ...Array.from({ length: 12 }, (_, i) => ({
        path: `/w/ws-${i + 1}`,
        label: `ws-${i + 1}`,
      })),
      // A row whose label does not carry the term but whose path tail does.
      { path: "/w/somewhere/tail-hit", label: "Different Label" },
    ]);
    renderPicker(null);
    openPopover();
    await screen.findByRole("button", { name: "ws-1" });
    const search = screen.getByPlaceholderText("Search workspaces");
    // Beyond the top-10 cap and off-case: the typed view hits it anyway.
    fireEvent.change(search, { target: { value: "WS-11" } });
    expect(
      await screen.findByRole("button", { name: "ws-11" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "ws-1" }),
    ).not.toBeInTheDocument();
    // The path tail is a second match face when the label misses.
    fireEvent.change(search, { target: { value: "tail-hit" } });
    expect(
      await screen.findByRole("button", { name: "Different Label" }),
    ).toBeInTheDocument();
  });

  it("a zero-match term shows the empty state; clearing restores the cap", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/alpha", label: "alpha" },
    ]);
    renderPicker(null);
    openPopover();
    const search = await screen.findByPlaceholderText("Search workspaces");
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(
      await screen.findByText("No matching workspaces"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "alpha" }),
    ).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "" } });
    expect(
      await screen.findByRole("button", { name: "alpha" }),
    ).toBeInTheDocument();
  });

  it("a layer close resets the search term for the next open", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/alpha", label: "alpha" },
      { path: "/w/beta", label: "beta" },
    ]);
    renderPicker(null);
    openPopover();
    const search = await screen.findByPlaceholderText("Search workspaces");
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(
      await screen.findByText("No matching workspaces"),
    ).toBeInTheDocument();
    // Commit a row: the layer closes. Reopening starts unfiltered -- a
    // stale "alpha" term would keep beta hidden.
    fireEvent.change(search, { target: { value: "alpha" } });
    fireEvent.click(await screen.findByRole("button", { name: "alpha" }));
    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText("Search workspaces"),
      ).not.toBeInTheDocument(),
    );
    openPopover();
    expect(
      await screen.findByRole("button", { name: "alpha" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "beta" }),
    ).toBeInTheDocument();
  });

  it("an empty registry hides the search box but keeps the new-workspace entry", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([]);
    renderPicker(null);
    openPopover();
    expect(
      await screen.findByRole("button", { name: "New workspace" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("Search workspaces"),
    ).not.toBeInTheDocument();
  });

  it("the selected row rides the accent pair with the folder icon leading and the check trailing", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/alpha", label: "alpha" },
      { path: "/w/beta", label: "beta" },
    ]);
    renderPicker({ path: "/w/alpha", label: "alpha" });
    openPopover();
    const alpha = await screen.findByRole("button", { name: "alpha" });
    expect(alpha.className.split(/\s+/)).toContain("bg-accent");
    const kids = alpha.children;
    expect(kids.length).toBe(3);
    expect(kids[0]!.tagName.toLowerCase()).toBe("svg");
    expect(kids[1]!.textContent).toBe("alpha");
    expect(kids[2]!.tagName.toLowerCase()).toBe("svg");
    const beta = screen.getByRole("button", { name: "beta" });
    expect(beta.className.split(/\s+/)).not.toContain("bg-accent");
    expect(beta.children.length).toBe(2);
  });

  it("the naming modal guards the name and cancels without invoking", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/alpha", label: "alpha" },
    ]);
    renderPicker(null);
    openPopover();
    // The entry closes the layer and hands over to the naming modal.
    fireEvent.click(
      await screen.findByRole("button", { name: "New workspace" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "New workspace" }),
    ).toBeInTheDocument();
    const input = await screen.findByPlaceholderText("Workspace name");
    const create = screen.getByRole("button", { name: "Create" });
    // Empty after trimming: disabled, and no hint until something is typed.
    expect(create).toBeDisabled();
    expect(screen.queryByText(/1-64 characters/)).not.toBeInTheDocument();
    // An illegal character: still disabled, now with the inline hint.
    fireEvent.change(input, { target: { value: "a/b" } });
    expect(create).toBeDisabled();
    expect(screen.getByText(/1-64 characters/)).toBeInTheDocument();
    // Over the cap: disabled too.
    fireEvent.change(input, { target: { value: "x".repeat(65) } });
    expect(create).toBeDisabled();
    // A trailing dot: disabled (dot-only names resolve to an ancestor, and
    // Win32 strips the dot at create time); an interior dot stays legal.
    fireEvent.change(input, { target: { value: "report." } });
    expect(create).toBeDisabled();
    fireEvent.change(input, { target: { value: "my.report" } });
    expect(create).toBeEnabled();
    // A legal name enables; cancel closes the modal with nothing invoked.
    fireEvent.change(input, { target: { value: "My Analysis" } });
    expect(create).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText("Workspace name"),
      ).not.toBeInTheDocument(),
    );
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it("creating from the modal mints immediately and seats the reply as the pending selection", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/alpha", label: "alpha" },
    ]);
    vi.mocked(createWorkspace).mockResolvedValue({
      path: "/w/my-analysis",
      label: "my-analysis",
    });
    const onChange = vi.fn();
    renderPicker(null, onChange);
    openPopover();
    fireEvent.click(
      await screen.findByRole("button", { name: "New workspace" }),
    );
    const input = await screen.findByPlaceholderText("Workspace name");
    fireEvent.change(input, { target: { value: "  my-analysis " } });
    // Enter rides the form's submit path -- the modal's commit gesture.
    fireEvent.submit(input.closest("form")!);
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        path: "/w/my-analysis",
        label: "my-analysis",
      }),
    );
    // The trimmed spelling crosses IPC; the modal closes on the commit.
    expect(createWorkspace).toHaveBeenCalledWith("my-analysis");
    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText("Workspace name"),
      ).not.toBeInTheDocument(),
    );
  });

  it("a backend refusal surfaces inline and keeps the modal open", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/alpha", label: "alpha" },
    ]);
    vi.mocked(createWorkspace).mockRejectedValueOnce(
      new Error("workspace name contains a path-illegal character"),
    );
    const onChange = vi.fn();
    renderPicker(null, onChange);
    openPopover();
    fireEvent.click(
      await screen.findByRole("button", { name: "New workspace" }),
    );
    fireEvent.change(await screen.findByPlaceholderText("Workspace name"), {
      target: { value: "valid" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(
      await screen.findByText(
        "workspace name contains a path-illegal character",
      ),
    ).toBeInTheDocument();
    // The modal stays open for a retry; nothing was committed.
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
