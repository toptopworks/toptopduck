// The memory panel's render contract (issue #1529): the read-only list
// (title + category badge + hook), the reveal wiring, the empty guide, the
// toggle-off deactivated face, and the listing error banner. The suite
// mocks the api module (the IPC boundary) and the opener plugin; the
// component owns no mutation machine beyond the toggle boolean, so there
// is no seam module to stub.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    listWorkspaceMemory: vi.fn(),
    getWorkspaceMemoryEnabled: vi.fn(),
    setWorkspaceMemoryEnabled: vi.fn(),
  };
});

import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  getWorkspaceMemoryEnabled,
  listWorkspaceMemory,
  setWorkspaceMemoryEnabled,
} from "../../api";
import { WorkspaceMemoryDialog } from "../WorkspaceMemoryDialog";
import { withIntl } from "../../components/common/__tests__/helpers";
import type { ListedMemory } from "../../types/workspace-memory";

const mockedList = vi.mocked(listWorkspaceMemory);
const mockedEnabled = vi.mocked(getWorkspaceMemoryEnabled);
const mockedSet = vi.mocked(setWorkspaceMemoryEnabled);
const mockedReveal = vi.mocked(revealItemInDir);

function memory(overrides: Partial<ListedMemory> = {}): ListedMemory {
  return {
    title: "季度报表走 DuckDB",
    file: "project-quarterly.md",
    hook: "季度聚合用 date_trunc",
    type: "project",
    file_path: "/ws/.toptopduck/memory/project-quarterly.md",
    ...overrides,
  };
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    withIntl(
      <QueryClientProvider client={client}>
        <WorkspaceMemoryDialog
          workspace={{ path: "/ws", label: "Demo" }}
          onOpenChange={() => {}}
        />
      </QueryClientProvider>,
    ),
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("WorkspaceMemoryDialog", () => {
  it("renders the rows with title, badge, and hook", async () => {
    mockedEnabled.mockResolvedValue(true);
    mockedList.mockResolvedValue([
      memory(),
      memory({
        title: "偏好中文回复",
        file: "feedback-language.md",
        hook: "始终用简体中文回复",
        type: "feedback",
        file_path: "/ws/.toptopduck/memory/feedback-language.md",
      }),
    ]);
    renderPanel();
    expect(await screen.findByText("季度报表走 DuckDB")).toBeInTheDocument();
    expect(screen.getByText("偏好中文回复")).toBeInTheDocument();
    expect(screen.getByText("季度聚合用 date_trunc")).toBeInTheDocument();
    // The category badges render localized (zh-CN test locale).
    expect(screen.getByText("项目")).toBeInTheDocument();
    expect(screen.getByText("反馈")).toBeInTheDocument();
  });

  it("reveals the row's memory file in the folder", async () => {
    mockedEnabled.mockResolvedValue(true);
    mockedList.mockResolvedValue([memory()]);
    mockedReveal.mockResolvedValue(undefined);
    renderPanel();
    const reveal = await screen.findByRole("button", { name: "在文件夹中显示" });
    fireEvent.click(reveal);
    await waitFor(() =>
      expect(mockedReveal).toHaveBeenCalledWith(
        "/ws/.toptopduck/memory/project-quarterly.md",
      ),
    );
  });

  it("renders the empty guide when the workspace has no memories", async () => {
    mockedEnabled.mockResolvedValue(true);
    mockedList.mockResolvedValue([]);
    renderPanel();
    expect(await screen.findByText(/还没有记忆/)).toBeInTheDocument();
  });

  it("renders the deactivated face when the toggle is off", async () => {
    mockedEnabled.mockResolvedValue(false);
    renderPanel();
    expect(await screen.findByText(/记忆已关闭/)).toBeInTheDocument();
    // The listing never fires while disabled.
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("flips the toggle through the set command", async () => {
    mockedEnabled.mockResolvedValue(true);
    mockedList.mockResolvedValue([]);
    mockedSet.mockResolvedValue(undefined);
    renderPanel();
    // Anchor on the settled face (the empty guide), not the switch alone --
    // the switch is disabled while the enabled query is pending.
    expect(await screen.findByText(/还没有记忆/)).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: /启用记忆/ });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    await waitFor(() => expect(mockedSet).toHaveBeenCalledWith("/ws", false));
  });

  it("surfaces a refused toggle write as the error banner", async () => {
    // The backend is strict (a missing record or refused write errors); the
    // failure must reach the user -- never a silently unmoved switch.
    mockedEnabled.mockResolvedValue(true);
    mockedList.mockResolvedValue([]);
    mockedSet.mockRejectedValue(new Error("no record"));
    renderPanel();
    expect(await screen.findByText(/还没有记忆/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: /启用记忆/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no record");
  });

  it("surfaces a listing failure as the error banner", async () => {
    mockedEnabled.mockResolvedValue(true);
    mockedList.mockRejectedValue(new Error("boom"));
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});
