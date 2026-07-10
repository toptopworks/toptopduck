import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DatasetDescriptor, RowPage, ThreadEntry } from "../types";

// Black-box shell tests (issue #79 ACs). Drives the rendered three-column App
// like a user and asserts VISIBLE DOM / structure signals -- never the Query
// cache internals. Mirrors the App black-box pattern (mock api + stub the Tauri
// bridge) so the shell renders offline.

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

const state = vi.hoisted(() => ({
  workingSet: [] as DatasetDescriptor[],
  thread: [] as ThreadEntry[],
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    closeSession: vi.fn(async () => {}),
    createSession: vi.fn(async () => "sess-1"),
    ingestFile: vi.fn(),
    listWorkingSet: vi.fn(async () => state.workingSet),
    activeDataset: vi.fn(async () => null),
    askQuestion: vi.fn(),
    cancelQuery: vi.fn(async () => {}),
    conversation: vi.fn(async () => state.thread),
    readRows: vi.fn(),
    getProviderConfig: vi.fn(async () => ({
      base_url: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
      has_key: true,
    })),
    getAppConfig: vi.fn(async () => null),
  };
});

import App from "../App";
import { askQuestion, conversation, readRows } from "../api";

function src(name: string): DatasetDescriptor {
  return {
    reference_name: name,
    display_name: name,
    source_path: `/x/${name}.csv`,
    columns: [
      { name: "id", canonical_type: "BIGINT" },
      { name: "label", canonical_type: "VARCHAR" },
    ],
    row_count: 1,
    sample: [["1", "a"]],
    fingerprint: "ff".repeat(32),
    rectify: { kind: "NotApplicable" },
    privacy: { send_samples: true, type_only_columns: [] },
  };
}

function materializedTurn(referenceName: string): ThreadEntry {
  return {
    entry: "Turn",
    data: {
      question: `q:${referenceName}`,
      outcome: {
        kind: "Materialized",
        data: { dataset: src(referenceName), viz: null, assumption: null, sql: null },
      },
    },
  };
}

const ROW_PAGE: RowPage = {
  columns: [
    { name: "id", canonical_type: "BIGINT" },
    { name: "label", canonical_type: "VARCHAR" },
  ],
  rows: [["1", "a"]],
  total: 1,
  offset: 0,
  limit: 100,
};

describe("App three-column shell (issue #79 ACs)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    state.thread = [];
    vi.mocked(readRows).mockResolvedValue(ROW_PAGE);
    // App resolves the "system" locale preference from navigator.language; pin
    // it to zh-CN so the Thread rail's i18n'd chrome (ADR-0052) renders in
    // Chinese alongside the still-hardcoded chrome of the other components these
    // assertions rely on. getAppConfig stays null (first-launch, no app-config).
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("renders the three-column grid + thin top bar (R1: session bar / rail / workspace)", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "提问" })).toBeInTheDocument(),
    );
    // Three columns + topbar + questionbar all render.
    expect(document.querySelector(".session-sidebar")).toBeInTheDocument();
    expect(document.querySelector(".session-rail")).toBeInTheDocument();
    expect(document.querySelector(".session-workspace")).toBeInTheDocument();
    expect(document.querySelector(".topbar")).toBeInTheDocument();
    expect(document.querySelector(".session-questionbar")).toBeInTheDocument();
  });

  it("collapses the session sidebar via the top-bar toggle", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "提问" })).toBeInTheDocument(),
    );
    const shell = document.querySelector(".shell");
    expect(shell?.classList.contains("sidebar-collapsed")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "收起会话栏" }));
    expect(shell?.classList.contains("sidebar-collapsed")).toBe(true);
    // Toggling back expands.
    fireEvent.click(screen.getByRole("button", { name: "展开会话栏" }));
    expect(shell?.classList.contains("sidebar-collapsed")).toBe(false);
  });

  it("shows the hero empty state when no result is viewed (ADR-0062 R2 hero)", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "提问" })).toBeInTheDocument(),
    );
    // Hero drop zone is visible in the default 结果 tab.
    expect(screen.getByText(/拖入或选择一个数据文件开始分析/)).toBeInTheDocument();
  });

  it("derives result content after a Materialized ask (R2 result state)", async () => {
    state.workingSet = [src("people")];
    vi.mocked(askQuestion).mockResolvedValue({
      kind: "Materialized",
      data: { dataset: { ...src("result_1"), row_count: 1 }, viz: null, assumption: null },
    });
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "提问" })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "总共几行" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    // The workspace ResultView heading appears (chart+table pane).
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /结果：result_1/ })).toBeInTheDocument(),
    );
  });

  it("separates active from viewed: clicking a rail result moves viewed, not active (ADR-0051)", async () => {
    // Two results in the thread; R5 init views the last (result_2). Clicking
    // result_1 in the rail moves viewedResult to result_1 with no backend
    // mutation -- active is server truth, untouched by the click.
    const r1 = src("result_1");
    const r2 = src("result_2");
    state.workingSet = [r1, r2];
    state.thread = [materializedTurn("result_1"), materializedTurn("result_2")];
    render(<App />);
    // R5 init: viewedResult <- last Materialized (result_2).
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /结果：result_2/ })).toBeInTheDocument(),
    );
    // Click result_1 in the rail (the Thread result-link button).
    fireEvent.click(screen.getByRole("button", { name: /结果：result_1/ }));
    // viewedResult moved to result_1; the workspace now shows result_1.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /结果：result_1/ })).toBeInTheDocument(),
    );
    // No ask / mutation IPC fired by the click -- active is untouched.
    expect(askQuestion).not.toHaveBeenCalled();
  });

  it("appends the new turn optimistically without a thread refetch (ADR-0051)", async () => {
    // The thread cache is the single truth; on a successful ask the new turn is
    // appended via setQueryData and the thread query is NEVER invalidated, so a
    // stale/empty refetch cannot wipe the turn the user just produced. The new
    // turn's question renders in the rail from the optimistic append, not from
    // a refetch -- conversation is called exactly once (the initial load).
    state.workingSet = [src("people")];
    vi.mocked(askQuestion).mockResolvedValue({
      kind: "Materialized",
      data: { dataset: { ...src("result_1"), row_count: 1 }, viz: null, assumption: null },
    });
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "提问" })).toBeInTheDocument(),
    );
    expect(conversation).toHaveBeenCalledTimes(1); // initial load only
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "总共几行" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    // The new turn's question lands in the rail from the optimistic append.
    await waitFor(() => expect(screen.getByText("总共几行")).toBeInTheDocument());
    // No refetch: conversation was not called again (thread never invalidated).
    expect(conversation).toHaveBeenCalledTimes(1);
  });

  it("pins to a history result so it overrides the last textual turn (ADR-0062 R2)", async () => {
    // End-to-end pin chain: the last turn is a Clarify (workspace would show the
    // textual card), but clicking an earlier Materialized result in the rail sets
    // pinnedToHistory so the viewed result overrides the last-turn text. This is
    // the full handleSelectResult -> deriveWorkspaceContent path the pure-function
    // unit test alone cannot cover.
    const r1 = src("result_1");
    state.workingSet = [r1];
    state.thread = [
      materializedTurn("result_1"),
      {
        entry: "Turn",
        data: {
          question: "哪个名字",
          outcome: {
            kind: "Textual",
            data: { text_kind: "Clarify", body: "请说明哪个名字", assumption: null },
          },
        },
      },
    ];
    render(<App />);
    // Last turn is Clarify -> workspace shows the textual card.
    await waitFor(() => expect(document.querySelector(".textual-card")).toBeInTheDocument());
    // Click result_1 in the rail -> pin -> workspace shows result_1's table.
    fireEvent.click(screen.getByRole("button", { name: /结果：result_1/ }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /结果：result_1/ })).toBeInTheDocument(),
    );
    // The workspace textual card is gone (the rail still renders the turn text,
    // but under a different class -- .turn-outcome, not .textual-card).
    expect(document.querySelector(".textual-card")).not.toBeInTheDocument();
  });
});
