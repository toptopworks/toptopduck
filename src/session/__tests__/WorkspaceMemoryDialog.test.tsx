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
  openPath: vi.fn(),
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
    createWorkspaceMemory: vi.fn(),
    openWorkspaceMemoryDir: vi.fn(),
  };
});

import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  createWorkspaceMemory,
  getWorkspaceAutoExtraction,
  getWorkspaceExtractionStatus,
  getWorkspaceMemoryEnabled,
  listWorkspaceMemory,
  openWorkspaceMemoryDir,
  setWorkspaceMemoryEnabled,
} from "../../api";
import { WorkspaceMemoryDialog } from "../WorkspaceMemoryDialog";
import { TooltipProvider } from "../../components/ui/tooltip";
import { withIntl } from "../../components/common/__tests__/helpers";
import type { WorkspaceTarget } from "../useWorkspaceDatasets";
import type { ListedMemory } from "../../types/workspace-memory";

const mockedList = vi.mocked(listWorkspaceMemory);
const mockedEnabled = vi.mocked(getWorkspaceMemoryEnabled);
const mockedSet = vi.mocked(setWorkspaceMemoryEnabled);
const mockedAutoExtraction = vi.mocked(getWorkspaceAutoExtraction);
const mockedExtractionStatus = vi.mocked(getWorkspaceExtractionStatus);
const mockedReveal = vi.mocked(revealItemInDir);
const mockedCreate = vi.mocked(createWorkspaceMemory);
const mockedOpenDir = vi.mocked(openWorkspaceMemoryDir);
const mockedOpenPath = vi.mocked(openPath);

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
      // TooltipProvider mirrors the App ancestor (the FieldHint info
      // button needs it).
      <TooltipProvider>
        <QueryClientProvider client={client}>
          <WorkspaceMemoryDialog
            workspace={{ path: "/ws", label: "Demo" }}
            onOpenChange={() => {}}
          />
        </QueryClientProvider>
      </TooltipProvider>,
    ),
  );
}

// The stay-mounted variant: the sidebar renders the dialog
// unconditionally, so a close + reopen rides prop swaps on ONE mounted
// component -- the shape the per-open resets are pinned against.
function renderMountedPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (ws: WorkspaceTarget | null) =>
    withIntl(
      <TooltipProvider>
        <QueryClientProvider client={client}>
          <WorkspaceMemoryDialog workspace={ws} onOpenChange={() => {}} />
        </QueryClientProvider>
      </TooltipProvider>,
    );
  const view = render(tree({ path: "/ws", label: "Demo" }));
  const closeAndReopen = () => {
    view.rerender(tree(null));
    view.rerender(tree({ path: "/ws", label: "Demo" }));
  };
  return { closeAndReopen };
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
    mockedCreate.mockResolvedValue(undefined);
    mockedOpenDir.mockResolvedValue("/ws/.toptopduck/memory");
    mockedOpenPath.mockResolvedValue(undefined);
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
    ], usage_percent: 0, unreadable: [] });
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
    mockedList.mockResolvedValue({ rows: [], usage_percent: 0, unreadable: [] });
    mockedAutoExtraction.mockResolvedValue(false);
    mockedExtractionStatus.mockResolvedValue({
      state: "skipped",
      reason: "no_provider",
    });
    renderPanel();
    // The cost note is STANDING copy riding the label itself -- present
    // even while off (#1538 layout: the switches live in the footer).
    const toggle = await screen.findByLabelText("自动提取");
    expect(toggle).toHaveAttribute("data-state", "unchecked");
    expect(
      await screen.findByText("未配置模型，暂不提取。"),
    ).toBeInTheDocument();
  });

  // The extracted status line + the red usage band (>=95 renders the
  // capacity note in the red tone's presence -- the text pins the face).
  // Two titles pin the locale list join (zh-CN narrow conjunction renders
  // the enumeration comma between them).
  it("renders the extracted status and the red usage band", async () => {
    mockedEnabled.mockResolvedValue(true);
    mockedList.mockResolvedValue({ rows: [memory()], usage_percent: 96, unreadable: [] });
    mockedAutoExtraction.mockResolvedValue(true);
    mockedExtractionStatus.mockResolvedValue({
      state: "extracted",
      titles: ["偏好中文回复", "季度聚合用 date_trunc"],
    });
    renderPanel();
    expect(
      await screen.findByText("上一轮已保存：偏好中文回复、季度聚合用 date_trunc"),
    ).toBeInTheDocument();
    expect(screen.getByText("已用 96%")).toBeInTheDocument();
  });

  // The failed face announces as an alert in the destructive tone -- the
  // failure carries the toggle banner's visual weight, never a quiet
  // muted "nothing happened" line.
  it("renders the failed extraction as a destructive alert", async () => {
    mockedEnabled.mockResolvedValue(true);
    mockedList.mockResolvedValue({ rows: [memory()], usage_percent: 0, unreadable: [] });
    mockedExtractionStatus.mockResolvedValue({
      state: "failed",
      detail: "provider offline",
    });
    renderPanel();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("提取失败：provider offline");
    expect(alert).toHaveClass("text-destructive");
  });

  // The remaining panel faces (issue #1530's spec trio + the yellow band):
  // running renders the live-region status, no-new-facts renders its line,
  // and the yellow band shows from 80% (the red test above pins >=95).
  it("renders the running face, the no-new-facts face, and the yellow band", async () => {
    mockedEnabled.mockResolvedValue(true);
    mockedList.mockResolvedValue({ rows: [memory()], usage_percent: 85, unreadable: [] });
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
    mockedList.mockResolvedValue({ rows: [memory()], usage_percent: 0, unreadable: [] });
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
    mockedList.mockResolvedValue({ rows: [], usage_percent: 0, unreadable: [] });
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
    mockedList.mockResolvedValue({ rows: [], usage_percent: 0, unreadable: [] });
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
    mockedList.mockResolvedValue({ rows: [], usage_percent: 0, unreadable: [] });
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

  // ---- The #1538 write-path faces. ----

  // The empty state: the primary action mounts the create form; the folder
  // button mints the directory family on demand (the zero-footprint fresh
  // workspace) and opens it. The form replaces the list face while mounted,
  // so the two actions ride separate mounts.
  it("mounts the create form and opens the folder from the empty state", async () => {
    mockedEnabled.mockResolvedValue(true);
    mockedList.mockResolvedValue({ rows: [], usage_percent: 0, unreadable: [] });
    const { unmount } = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "新建记忆" }));
    expect(await screen.findByLabelText("标题")).toBeInTheDocument();
    unmount();

    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: "打开文件夹" }),
    );
    await waitFor(() =>
      expect(mockedOpenPath).toHaveBeenCalledWith("/ws/.toptopduck/memory"),
    );
  });

  // The form's contract: the example prefill fills all three fields; a
  // blank title never reaches the backend (the local guard mirrors the
  // store's); a successful save collapses the form, flashes the
  // confirmation, and refreshes the listing.
  it("prefills the example, guards the blank title, and saves", async () => {
    mockedEnabled.mockResolvedValue(true);
    // Two staged reads: the empty face first, then the saved row -- the
    // invalidation is the ONLY refetch trigger (staleTime Infinity), so
    // the new row rendering without a reopen pins the refresh leg.
    mockedList
      .mockResolvedValueOnce({ rows: [], usage_percent: 0, unreadable: [] })
      .mockResolvedValueOnce({ rows: [memory()], usage_percent: 0, unreadable: [] });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "新建记忆" }));
    // The create face owns the bottom: the extraction switch is gone
    // while the form is mounted.
    expect(
      screen.queryByRole("switch", { name: /自动提取/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /数据口径以月度定义为准/ }));
    expect(screen.getByLabelText("标题")).toHaveValue("数据口径以月度定义为准");
    expect(screen.getByLabelText("说明")).toHaveValue(
      "所有报表引用同一份月度指标定义",
    );
    expect(screen.getByRole("radio", { name: "项目" })).toBeChecked();
    // Blank title: the local guard keeps the call from firing.
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "" } });
    fireEvent.submit(screen.getByLabelText("标题").closest("form")!);
    expect(mockedCreate).not.toHaveBeenCalled();
    // Fill + save.
    fireEvent.change(screen.getByLabelText("标题"), {
      target: { value: "偏好中文回复" },
    });
    // A multi-line description rides verbatim -- the textarea is the
    // point (the store folds only its frontmatter line).
    fireEvent.change(screen.getByLabelText("说明"), {
      target: { value: "始终用简体中文回复\n代码注释用英文" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "用户" }));
    fireEvent.submit(screen.getByLabelText("标题").closest("form")!);
    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith("/ws", {
        title: "偏好中文回复",
        description: "始终用简体中文回复\n代码注释用英文",
        type: "user",
      }),
    );
    expect(await screen.findByText("已保存。")).toBeInTheDocument();
    expect(screen.queryByLabelText("标题")).not.toBeInTheDocument();
    expect(await screen.findByText("季度报表走 DuckDB")).toBeInTheDocument();
  });

  // The refused create surfaces through the form's alert, never a silently
  // unmoved form.
  it("surfaces a refused create as the form's alert", async () => {
    mockedEnabled.mockResolvedValue(true);
    mockedList.mockResolvedValue({ rows: [], usage_percent: 0, unreadable: [] });
    mockedCreate.mockRejectedValueOnce("refused");
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "新建记忆" }));
    fireEvent.change(await screen.findByLabelText("标题"), {
      target: { value: "x" },
    });
    fireEvent.submit(screen.getByLabelText("标题").closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("refused");
  });

  // The create face is scoped to ONE panel open: closing the dialog while
  // the form is mounted (the workspace prop nulls, the component stays
  // mounted) resets it, so the next open starts at the list face -- never
  // a half-filled form from the previous open.
  it("resets a mounted create form when the dialog closes and reopens", async () => {
    mockedEnabled.mockResolvedValue(true);
    mockedList.mockResolvedValue({ rows: [], usage_percent: 0, unreadable: [] });
    const { closeAndReopen } = renderMountedPanel();
    fireEvent.click(await screen.findByRole("button", { name: "新建记忆" }));
    expect(await screen.findByLabelText("标题")).toBeInTheDocument();
    closeAndReopen();
    expect(await screen.findByText(/还没有记忆/)).toBeInTheDocument();
    expect(screen.queryByLabelText("标题")).not.toBeInTheDocument();
  });

  // The saved flash is scoped to ONE panel open too: closing after a
  // successful save clears it, so the next open carries no stale
  // confirmation line.
  it("clears the saved flash when the dialog closes and reopens", async () => {
    mockedEnabled.mockResolvedValue(true);
    mockedList.mockResolvedValue({ rows: [], usage_percent: 0, unreadable: [] });
    const { closeAndReopen } = renderMountedPanel();
    fireEvent.click(await screen.findByRole("button", { name: "新建记忆" }));
    fireEvent.change(await screen.findByLabelText("标题"), {
      target: { value: "偏好中文回复" },
    });
    fireEvent.submit(screen.getByLabelText("标题").closest("form")!);
    expect(await screen.findByText("已保存。")).toBeInTheDocument();
    closeAndReopen();
    expect(await screen.findByText(/还没有记忆/)).toBeInTheDocument();
    expect(screen.queryByText("已保存。")).not.toBeInTheDocument();
  });

  // The list header's secondary actions: open the folder (backend mints +
  // returns the path, front-end opens) and mount the create form.
  it("opens the folder and mounts the form from the list header", async () => {
    mockedEnabled.mockResolvedValue(true);
    mockedList.mockResolvedValue({ rows: [memory()], usage_percent: 0, unreadable: [] });
    renderPanel();
    const open = await screen.findByRole("button", { name: "打开文件夹" });
    fireEvent.click(open);
    await waitFor(() =>
      expect(mockedOpenPath).toHaveBeenCalledWith("/ws/.toptopduck/memory"),
    );
    fireEvent.click(screen.getByRole("button", { name: "新建记忆" }));
    expect(await screen.findByLabelText("标题")).toBeInTheDocument();
  });

  // The unreadable tail (#1538): fence-less .md files surface by name,
  // neutrally, after the healthy rows.
  it("surfaces unreadable files at the list tail", async () => {
    mockedEnabled.mockResolvedValue(true);
    mockedList.mockResolvedValue({
      rows: [memory()],
      usage_percent: 0,
      unreadable: ["broken.md"],
    });
    renderPanel();
    expect(
      await screen.findByText("无法识别的文件：broken.md"),
    ).toBeInTheDocument();
  });

  // A directory holding ONLY unreadable files renders the list face with
  // the unreadable tail -- never the empty guide (the files exist; the
  // user needs their names).
  it("surfaces an unreadable-only directory instead of the empty guide", async () => {
    mockedEnabled.mockResolvedValue(true);
    mockedList.mockResolvedValue({
      rows: [],
      usage_percent: 0,
      unreadable: ["broken.md"],
    });
    renderPanel();
    expect(
      await screen.findByText(/无法识别的文件：broken\.md/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/还没有记忆/)).not.toBeInTheDocument();
  });
});
