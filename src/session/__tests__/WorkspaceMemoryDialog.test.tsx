// The memory panel's render contract (issue #1529): the read-only list
// (title + category badge + hook), the reveal wiring, the empty guide, the
// toggle-off deactivated face, and the listing error banner. The suite
// mocks the api module (the IPC boundary) and the opener plugin; the
// component owns no mutation machine beyond the toggle boolean, so there
// is no seam module to stub.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    getWorkspaceAutoExtraction: vi.fn(),
    setWorkspaceAutoExtraction: vi.fn(),
    getWorkspaceExtractionStatus: vi.fn(),
  };
});

import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  getWorkspaceAutoExtraction,
  getWorkspaceExtractionStatus,
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
const mockedAutoExtraction = vi.mocked(getWorkspaceAutoExtraction);
const mockedExtractionStatus = vi.mocked(getWorkspaceExtractionStatus);
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
  // The #1530 faces' defaults: extraction off + no status ever recorded.
  // TanStack rejects an undefined query result, so every suite seeds these
  // even when it does not assert them.
  beforeEach(() => {
    mockedAutoExtraction.mockResolvedValue(false);
    mockedExtractionStatus.mockResolvedValue(null);
  });

  it("renders the rows with title, badge, and hook", async () => {
    mockedEnabled.mockResolvedValue(true);
    mockedList.mockResolvedValue({ rows: [
      memory(),
      memory({
        title: "偏好中文回复",
        file: "feedback-language.md",
        hook: "始终用简体中文回复",
        type: "feedback",
        file_path: "/ws/.toptopduck/memory/feedback-language.md",
      }),
    ], usage_percent: 0 });
    renderPanel();
    expect(await screen.findByText("季度报表走 DuckDB")).toBeInTheDocument();
    expect(screen.getByText("偏好中文回复")).toBeInTheDocument();
    expect(screen.getByText("季度聚合用 date_trunc")).toBeInTheDocument();
    // The category badges render localized (zh-CN test locale).
    expect(screen.getByText("项目")).toBeInTheDocument();
    expect(screen.getByText("反馈")).toBeInTheDocument();
  });

  // The #1530 faces: the extraction toggle renders with the STANDING cost
  // note (cost follows the switch), and the latest status line shows the
  // no-provider skip.
  it("shows the extraction toggle with the standing cost note and the skip face", async () => {
    mockedEnabled.mockResolvedValue(true);
    mockedList.mockResolvedValue({ rows: [], usage_percent: 0 });
    mockedAutoExtraction.mockResolvedValue(false);
    mockedExtractionStatus.mockResolvedValue({
      state: "skipped",
      reason: "no_provider",
    });
    renderPanel();
    const toggle = await screen.findByLabelText("自动提取记忆");
    expect(toggle).toHaveAttribute("data-state", "unchecked");
    // The cost note is standing copy -- present even while off.
    expect(
      screen.getByText(
        "每轮回复后一次模型调用。",
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("未配置模型，暂不提取。"),
    ).toBeInTheDocument();
  });

  // The extracted status line + the red usage band (>=95 renders the
  // capacity note in the red tone's presence -- the text pins the face).
  it("renders the extracted status and the red usage band", async () => {
    mockedEnabled.mockResolvedValue(true);
    mockedList.mockResolvedValue({ rows: [memory()], usage_percent: 96 });
    mockedAutoExtraction.mockResolvedValue(true);
    mockedExtractionStatus.mockResolvedValue({
      state: "extracted",
      titles: ["偏好中文回复"],
    });
    renderPanel();
    expect(
      await screen.findByText("上一轮已保存：偏好中文回复"),
    ).toBeInTheDocument();
    expect(screen.getByText("已用 96%")).toBeInTheDocument();
  });

  // The remaining panel faces (issue #1530's spec trio + the yellow band):
  // running renders the live-region status, no-new-facts renders its line,
  // and the yellow band shows from 80% (the red test above pins >=95).
  it("renders the running face, the no-new-facts face, and the yellow band", async () => {
    mockedEnabled.mockResolvedValue(true);
    mockedList.mockResolvedValue({ rows: [memory()], usage_percent: 85 });
    mockedAutoExtraction.mockResolvedValue(true);
    mockedExtractionStatus.mockResolvedValue({ state: "running" });
    const { unmount } = renderPanel();
    expect(
      await screen.findByText("正在从上一轮对话提取记忆…"),
    ).toBeInTheDocument();
    expect(screen.getByText("已用 85%")).toBeInTheDocument();
    unmount();

    mockedExtractionStatus.mockResolvedValue({ state: "no_new_facts" });
    renderPanel();
    expect(
      await screen.findByText("上一轮没有新记忆。"),
    ).toBeInTheDocument();
  });

  it("reveals the row's memory file in the folder", async () => {
    mockedEnabled.mockResolvedValue(true);
    mockedList.mockResolvedValue({ rows: [memory()], usage_percent: 0 });
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
    mockedList.mockResolvedValue({ rows: [], usage_percent: 0 });
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
    mockedList.mockResolvedValue({ rows: [], usage_percent: 0 });
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
    mockedList.mockResolvedValue({ rows: [], usage_percent: 0 });
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
