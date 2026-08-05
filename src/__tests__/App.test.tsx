import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IntlProvider } from "react-intl";
import type { ReactNode } from "react";
import type { DatasetDescriptor } from "../types/dataset";
import type { TurnOutcome } from "../types/thread";

// The composer "+" context panel (the retired FileDropzone's successor, issue
// #351) touches Tauri APIs that don't exist under jsdom; stub them first.
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onDragDropEvent: () => Promise.resolve(() => {}),
  }),
}));

// Mutable working set the api mock reflects after a guided load (the dialog
// flow's end state). vi.hoisted keeps it alive across the hoisted vi.mock.
const state = vi.hoisted(() => ({ workingSet: [] as DatasetDescriptor[] }));
// importOriginal keeps the real fmtError (a pure helper) while the Tauri invoke
// wrappers are stubbed.
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    closeSession: vi.fn(async () => {}),
    createSession: vi.fn(async () => "sess-1"),
    ingestFile: vi.fn(),
    ingestFileGuided: vi.fn(),
    listWorkingSet: vi.fn(),
    activeDataset: vi.fn(async () => null),
    renameDataset: vi.fn(),
    replaceSource: vi.fn(),
    removeSource: vi.fn(),
    removeActiveSource: vi.fn(),
    setDatasetPrivacy: vi.fn(),
    askQuestion: vi.fn(),
    conversation: vi.fn(async () => []),
    // ADR-0059: the turn-progress listener mounts with every SessionPane.
    // Stub it (no-op unlisten) so jsdom doesn't hit the real Tauri listen.
    onTurnProgress: vi.fn(async () => () => {}),
    // The composer "+" panel queries the per-session MCP status on mount
    // (issue #351); no App.test flow exercises MCP, so an empty read keeps
    // jsdom off the real invoke.
    listMcpServerStatus: vi.fn(async () => []),
    // The composer auth-mode chip queries the session's authorization posture
    // on mount (issue #352); no App.test flow exercises the toggle, so a
    // per_call default read + no-op write keep jsdom off the real invoke.
    getAuthorizationMode: vi.fn(async () => "per_call" as const),
    setAuthorizationMode: vi.fn(async () => {}),
    // The composer "+" panel reads the skill registry + the session's mount set
    // on mount (issue #365); no App.test flow exercises a toggle, so empty
    // reads + no-op writes keep jsdom off the real invoke.
    listSkills: vi.fn(async () => ({ skills: [], ignored: [] })),
    listMountedSkills: vi.fn(async () => []),
    mountSkill: vi.fn(async () => {}),
    unmountSkill: vi.fn(async () => {}),
    readRows: vi.fn(),
    getProviderConfig: vi.fn(async () => ({
      base_url: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
      has_key: false,
      keychain_fault: null,
    })),
  };
});

import { open } from "@tauri-apps/plugin-dialog";
import { SessionPane } from "../session/SessionPane";
import { TooltipProvider } from "../components/ui/tooltip";
import type { UseApprovalEvents } from "../session/useApprovalEvents";
import type { SessionFlowKind } from "../types/error";
import { catalogFor, type CatalogKey, type EffectiveLocale } from "../i18n";
import {
  activeDataset,
  askQuestion,
  ingestFile,
  ingestFileGuided,
  listWorkingSet,
  readRows,
  removeSource,
  removeActiveSource,
  renameDataset,
  setDatasetPrivacy,
} from "../api";

// Issue #81 cold start (ADR-0061): <App/> no longer auto-creates a session on
// mount, so these session-INTERNAL flows (guided load / rename / privacy / ask /
// delete-source) are driven through <SessionPane> directly -- the unit that owns
// them. The shell-level cold-start + multi-session behavior lives in
// Shell.test.tsx. Each render gets a fresh QueryClient (ADR-0051: test renders
// never share cache). zh-CN so the i18n'd chrome matches the assertions.
function renderPane(locale: EffectiveLocale = "zh-CN", sessionName = "Test session"): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // TooltipProvider mirrors the App ancestor: the rail's turn cards carry the
  // TruncatingTooltip question recovery (ADR-0050), which crashes without the
  // provider context once a turn renders (an optimistic append or a thread
  // mock).
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale={locale} messages={catalogFor(locale)} defaultLocale="en-US">
        <TooltipProvider>{children}</TooltipProvider>
      </IntlProvider>
    </QueryClientProvider>
  );
  // An inert approval channel: these session-internal flows never exercise
  // approvals (the api mock has no approval listeners), so the pane reads an
  // empty map and the callbacks are no-ops.
  const approvalEvents: UseApprovalEvents = {
    approvalsBySession: new Map(),
    pendingApprovalSids: new Set(),
    respond: () => {},
    clearSession: () => {},
  };
  render(
    wrap(
      <SessionPane
        sessionId="sess-1"
        pendingIngestPath={null}
        onIngestConsumed={() => {}}
        railCollapsed={false}
        onToggleRail={() => {}}
        sessionName={sessionName}
        approvalEvents={approvalEvents}
        onOpenSettingsSkills={() => {}}
      />,
    ),
  );
}

// The catalog key for an operation verb (issue #139). The negative prefix
// assertions below build the expected "{verb} failed"/"{verb}失败" text from
// the catalog so they track the verb wording instead of duplicating a hard-
// coded string, and the same helper serves the en-US locale test.
function verbKey(kind: SessionFlowKind): CatalogKey {
  switch (kind) {
    case "load": return "error.verb.load";
    case "rename": return "error.verb.rename";
    case "replace": return "error.verb.replace";
    case "delete": return "error.verb.delete";
    case "privacy": return "error.verb.privacy";
    case "ask": return "error.verb.ask";
    default: {
      // Exhaustiveness guard: mirrors errorVerb in lib/error-presentation/
      // app-error so a new SessionFlowKind member forces a test update here
      // too. The `default: never` throw enforces this regardless of tsconfig
      // flags.
      const unhandled: never = kind;
      throw new Error(`unhandled SessionFlowKind: ${JSON.stringify(unhandled)}`);
    }
  }
}

// The "{verb}失败" prefix substring for the zh-CN test locale, built from the
// catalog so the assertion tracks the verb wording instead of duplicating a
// hard-coded string (issue #139 locale-aware closeout). Used only in the
// negative -- asserting an operation's failure banner does NOT carry another
// operation's prefix (a rename rejection is never mislabelled a load failure).
// The en-US locale is covered positively by the English-prefix assertion in
// the locale-consistency test below, so this helper stays zh-CN-scoped.
function failedPrefix(kind: SessionFlowKind): RegExp {
  return new RegExp(`${catalogFor("zh-CN")[verbKey(kind)]}失败`);
}

const guidedDataset: DatasetDescriptor = {
  reference_name: "people",
  display_name: "people",
  source_path: "/x/m.xlsx",
  row_count: 1,
  fingerprint: "ff".repeat(32),
  columns: [
    { name: "id", canonical_type: "BIGINT" },
    { name: "name", canonical_type: "VARCHAR" },
  ],
  sample: [["1", "Alice"]],
  rectify: { kind: "User", data: { header_row: 2, skip_rows: [] } },
  privacy: { send_samples: true, type_only_columns: [] },
};

describe("App guided-load flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    vi.mocked(open).mockResolvedValue("/x/m.xlsx");
    vi.mocked(listWorkingSet).mockImplementation(async () => state.workingSet);
    vi.mocked(ingestFile).mockResolvedValue({
      kind: "NeedsGuidance",
      data: {
        source_path: "/x/m.xlsx",
        workbook_name: "m",
        sheets: [
          {
            name: "people",
            preview: [
              ["meta", "info"],
              ["id", "name"],
              ["1", "Alice"],
            ],
          },
        ],
      },
      // A NeedsGuidance outcome is the only shape this flow exercises; the cast
      // keeps the mock terse without weakening the rest of the LoadOutcome union.
    } as never);
    vi.mocked(ingestFileGuided).mockImplementation(async () => {
      state.workingSet = [guidedDataset];
      return { kind: "Loaded", data: guidedDataset } as never;
    });
  });

  it("opens the guided dialog on NeedsGuidance, then closes it after a guided load", async () => {
    renderPane();

    // Mount-time refresh (empty working set) settles before the flow starts.
    await waitFor(() => expect(listWorkingSet).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Pick a file via the composer "+" (issue #351: the pane is app-config-less
    // here, so "+" is the degraded pure add-files button) -> ingestFile returns
    // NeedsGuidance -> dialog opens (AC2 seam).
    fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.getByText(/引导加载：m/)).toBeInTheDocument();

    // Choose the real header (row 2) and submit -> guided ingest (AC3/AC7 seam).
    fireEvent.change(screen.getByLabelText(/表头所在行/), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /按选择加载/ }));

    await waitFor(() =>
      expect(ingestFileGuided).toHaveBeenCalledWith("sess-1", "/x/m.xlsx", [
        { name: "people", rectify: { header_row: 2, skip_rows: [] } },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("App rename flow", () => {
  // prompt spies must not leak between tests (jsdom default returns null).
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    vi.mocked(listWorkingSet).mockImplementation(async () => state.workingSet);
  });

  it("keeps selection on the renamed dataset (ADR-0037 display/reference decoupling)", async () => {
    // One dataset loaded; selection keys off the stable reference name, so a
    // display rename must not drop the current selection.
    state.workingSet = [guidedDataset];
    renderPane();
    fireEvent.click(await screen.findByRole("tab", { name: "工作集" }));

    // Mount refresh settles, then select the dataset to show its detail.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^people/ })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^people/ }));
    // The dataset's column type is shown (now in both the schema table and the
    // privacy-cols table, so BIGINT appears twice -- assert presence, not uniqueness).
    expect(screen.getAllByText("BIGINT").length).toBeGreaterThan(0);

    // Rename via prompt; on refresh the working set carries the new label.
    vi.spyOn(window, "prompt").mockReturnValue("员工表");
    vi.mocked(renameDataset).mockImplementation(async (_sid, ref, display) => {
      state.workingSet = state.workingSet.map((d) =>
        d.reference_name === ref ? { ...d, display_name: display } : d,
      );
      return { ...guidedDataset, display_name: display };
    });
    fireEvent.click(screen.getByRole("button", { name: /重命名/ }));

    // The rename carries the stable reference name + the new display label.
    await waitFor(() => expect(renameDataset).toHaveBeenCalledWith("sess-1", "people", "员工表"));

    // Selection survived (keyed by reference_name): the list now shows the new
    // label, yet the same dataset's columns are still in the detail pane.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^员工表/ })).toBeInTheDocument(),
    );
    expect(screen.getAllByText("BIGINT").length).toBeGreaterThan(0);
  });

  it("labels a rename failure distinctly from a load failure (M2)", async () => {
    // A rejected rename surfaces the backend's message, but NOT under the
    // load-failure prefix -- the error context follows the operation that
    // produced it, so a rename rejection is never misread as a load failure.
    state.workingSet = [guidedDataset];
    renderPane();
    fireEvent.click(await screen.findByRole("tab", { name: "工作集" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^people/ })).toBeInTheDocument(),
    );

    vi.spyOn(window, "prompt").mockReturnValue("员工表");
    vi.mocked(renameDataset).mockRejectedValueOnce({
      kind: "RenameDataset",
      data: { kind: "DisplayTaken", data: "员工表" },
    });
    fireEvent.click(screen.getByRole("button", { name: /重命名/ }));

    await waitFor(() =>
      expect(screen.getByText(/显示名「员工表」已被其他数据集使用/)).toBeInTheDocument(),
    );
    // The rename rejection must not inherit the ingest flow's load prefix.
    expect(screen.queryByText(failedPrefix("load"))).not.toBeInTheDocument();
  });
});

describe("App privacy flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    vi.mocked(listWorkingSet).mockImplementation(async () => state.workingSet);
  });

  it("labels a privacy failure distinctly from load/rename/replace failures (issue #9)", async () => {
    // A rejected privacy change surfaces the backend's message with the
    // "隐私设置失败：" prefix -- distinct from "加载失败：" / "重命名失败：" /
    // "换源失败：", so a privacy rejection is never misattributed.
    state.workingSet = [guidedDataset];
    renderPane();
    fireEvent.click(await screen.findByRole("tab", { name: "工作集" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^people/ })).toBeInTheDocument(),
    );
    // Select the dataset to reveal PrivacyControls in the detail pane.
    fireEvent.click(screen.getByRole("button", { name: /^people/ }));

    vi.mocked(setDatasetPrivacy).mockRejectedValueOnce("权限不足，无法修改隐私设置");
    fireEvent.click(screen.getByLabelText(/向云端 LLM 发送样本值/));

    await waitFor(() =>
      expect(screen.getByText(/权限不足，无法修改隐私设置/)).toBeInTheDocument(),
    );
    // Positive pin on the privacy verb so a verb-swap regression (privacy/ask
    // exchanged, etc.) is caught, not just the cross-operation mismatch below.
    expect(screen.getByText(failedPrefix("privacy"))).toBeInTheDocument();
    // The privacy rejection must not carry any other operation's prefix.
    expect(screen.queryByText(failedPrefix("load"))).not.toBeInTheDocument();
    expect(screen.queryByText(failedPrefix("rename"))).not.toBeInTheDocument();
    expect(screen.queryByText(failedPrefix("replace"))).not.toBeInTheDocument();
  });
});

describe("App error-prefix locale consistency (issue #139)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [guidedDataset];
    vi.mocked(listWorkingSet).mockImplementation(async () => state.workingSet);
  });
  // The savedRefreshFailed test spies on QueryClient.prototype (below);
  // restoreAllMocks (not just clearAllMocks) so the spy cannot leak into a
  // sibling describe's QueryClient and turn its refresh green red.
  afterEach(() => vi.restoreAllMocks());

  it("renders the rename-failure prefix in English under en-US", async () => {
    // ADR-0052 / issue #139: the "{verb} failed:" prefix and the underlying
    // catalog message must render in the SAME locale. Under en-US a rename
    // rejection shows "Rename failed: <english message>" -- no Chinese leak
    // from the prior hard-coded verb table.
    renderPane("en-US");
    fireEvent.click(await screen.findByRole("tab", { name: "Working set" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^people/ })).toBeInTheDocument(),
    );

    vi.spyOn(window, "prompt").mockReturnValue("员工表");
    vi.mocked(renameDataset).mockRejectedValueOnce({
      kind: "RenameDataset",
      data: { kind: "DisplayTaken", data: "员工表" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Rename/ }));

    // Both the prefix and the underlying refusal (en-US catalog
    // error.dataset.displayTaken) render in English -- locale consistent.
    await waitFor(() =>
      expect(screen.getByText(/Rename failed: Display label/)).toBeInTheDocument(),
    );
  });

  it("renders the refresh-failure template in English under en-US (issue #139)", async () => {
    // ADR-0052 / issue #139: the "{verb} saved, but refreshing the working set
    // failed:" template (refreshFailedMessage) must render in the active locale
    // too -- not just the "{verb} failed:" reject template. A rename that
    // succeeds server-side but whose post-mutation cache refresh rejects
    // surfaces under the en-US savedRefreshFailed template with the Rename verb
    // and the refresh error's message (fmtError -> e.message for a plain Error).
    // Spy on the prototype so every QueryClient instance's invalidateQueries
    // rejects; refreshServerState awaits Promise.all over three of them.
    vi.spyOn(QueryClient.prototype, "invalidateQueries").mockRejectedValue(
      new Error("refresh boom"),
    );
    renderPane("en-US");
    fireEvent.click(await screen.findByRole("tab", { name: "Working set" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^people/ })).toBeInTheDocument(),
    );

    vi.spyOn(window, "prompt").mockReturnValue("renamed");
    vi.mocked(renameDataset).mockResolvedValue({
      ...guidedDataset,
      display_name: "renamed",
    } as never);
    fireEvent.click(screen.getByRole("button", { name: /^Rename/ }));

    // Rename persisted; only the cache refresh failed. The en-US
    // savedRefreshFailed template renders (Rename verb + refresh-error msg).
    await waitFor(() =>
      expect(
        screen.getByText(/Rename saved, but refreshing the working set failed/),
      ).toBeInTheDocument(),
    );
  });
});

describe("App ask flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [guidedDataset]; // a source is loaded
    vi.mocked(listWorkingSet).mockImplementation(async () => state.workingSet);
    vi.mocked(activeDataset).mockImplementation(async () => guidedDataset);
    vi.mocked(readRows).mockResolvedValue({
      columns: [],
      rows: [],
      total: 0,
      offset: 0,
      limit: 100,
    });
  });

  it("submits a question and shows the materialized result (issue #22)", async () => {
    vi.mocked(askQuestion).mockResolvedValue({
      kind: "Materialized",
      data: {
        promotions: [
          { dataset: { ...guidedDataset, reference_name: "result_1", row_count: 1 }, sql: "SELECT 1" },
        ],
        viz: null,
        assumption: null,
      },
    });
    renderPane();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "提问" })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "总共几行" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() => expect(askQuestion).toHaveBeenCalledWith("sess-1", "总共几行"));
    // the materialized result pane appears (ResultView heading). The thread
    // rail also shows a result link with the same text, so target the heading
    // role to assert the workspace ResultView specifically.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /结果：result_1/ })).toBeInTheDocument(),
    );
  });

  it("labels an ask failure distinctly from a load failure", async () => {
    vi.mocked(askQuestion).mockRejectedValueOnce("未配置有效的 LLM 提供方");
    renderPane();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "提问" })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() =>
      expect(screen.getByText(/未配置有效的 LLM 提供方/)).toBeInTheDocument(),
    );
    // an ask failure must not inherit the load-flow prefix.
    expect(screen.queryByText(failedPrefix("load"))).not.toBeInTheDocument();
  });

  it("shows a textual outcome in the thread and opens no result pane (issue #23)", async () => {
    // ADR-0028: a non-result outcome is still always visible (in the thread),
    // occupies a slot, but produces no result_N -- so no result pane opens.
    renderPane();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "提问" })).toBeInTheDocument(),
    );
    // Mount refresh has settled; queue what the turn produces (asked after mount
    // so the mount's own conversation() call doesn't consume the once-mock).
    // No conversation once-mock: the turn flow appends optimistically and
    // never invalidates the thread (ADR-0051), so a queued thread mock would
    // go UNCONSUMED here and leak into the next test's mount query.
    vi.mocked(askQuestion).mockResolvedValueOnce({
      kind: "Textual",
      data: { text_kind: "Clarify", body: "按产品名还是客户名汇总？", assumption: null },
    });
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "哪个名字" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));

    // The clarify body is visible in the thread AND now also in the workspace
    // textual card, so assert at least one match rather than a unique one.
    await waitFor(() =>
      expect(screen.getAllByText("按产品名还是客户名汇总？").length).toBeGreaterThan(0),
    );
    // ...and no result pane opens for a non-result outcome.
    expect(screen.queryByText(/结果：result/)).not.toBeInTheDocument();
  });

  it("the rail empty hint yields to the live turn card on a first in-flight turn (issue #297)", async () => {
    // A brand-new session has an empty thread AND an in-flight first ask: the
    // live turn card occupies the rail, so the "尚无对话" hint must NOT render
    // alongside it (the two read as contradictory).
    renderPane();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "提问" })).toBeInTheDocument(),
    );
    // The empty hint is up before any ask (the thread query settles empty).
    await waitFor(() => expect(screen.getByText(/尚无对话/)).toBeInTheDocument());
    vi.mocked(askQuestion).mockImplementationOnce(
      () => new Promise<TurnOutcome>(() => {}), // stays in flight
    );
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "第一问" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    // The live card renders the asking question; the empty hint is gone.
    await waitFor(() => expect(screen.getByText("第一问")).toBeInTheDocument());
    expect(screen.queryByText(/尚无对话/)).not.toBeInTheDocument();
  });
});

describe("App delete-source flow (issue #38)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [guidedDataset];
    vi.mocked(listWorkingSet).mockImplementation(async () => state.workingSet);
  });

  it("removes a source via removeSource then refreshes the working set", async () => {
    // AC: the per-row delete (after a confirm) calls removeSource with the
    // stable reference name, then refreshes so the list no longer shows it.
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(removeSource).mockImplementation(async (_sid, ref) => {
      state.workingSet = state.workingSet.filter((d) => d.reference_name !== ref);
    });
    renderPane();
    fireEvent.click(await screen.findByRole("tab", { name: "工作集" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^people/ })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /删除/ }));

    await waitFor(() => expect(removeSource).toHaveBeenCalledWith("sess-1", "people"));
    // The refresh after the delete drops the removed source from the list.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^people/ })).not.toBeInTheDocument(),
    );
  });

  it("labels a delete failure distinctly from load/rename/replace/ask failures", async () => {
    // A typed RemoveSource refusal (issue #121) surfaces under the "删源失败："
    // prefix -- never mislabelled as another operation's failure.
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(removeSource).mockRejectedValueOnce({
      kind: "RemoveSource",
      data: { kind: "NotFound", data: "people" },
    });
    renderPane();
    fireEvent.click(await screen.findByRole("tab", { name: "工作集" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^people/ })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /删除/ }));
    await waitFor(() =>
      expect(screen.getByText(/删源失败：找不到引用名为「people」的数据集/)).toBeInTheDocument(),
    );
    // No other operation's prefix is used.
    expect(screen.queryByText(failedPrefix("load"))).not.toBeInTheDocument();
    expect(screen.queryByText(failedPrefix("rename"))).not.toBeInTheDocument();
    expect(screen.queryByText(failedPrefix("replace"))).not.toBeInTheDocument();
    // A RemoveSource reject is a command reject, not a turn outcome, so the
    // ask-turn Failed card (.textual-card.failed, issue #125) must not render.
    expect(document.querySelector(".textual-card.failed")).not.toBeInTheDocument();
  });
});

describe("App delete-active-source flow (issue #39)", () => {
  // A second source distinct from `guidedDataset` (people) so the working set
  // holds more than one source and the active-source branch fires.
  const ordersSource: DatasetDescriptor = {
    ...guidedDataset,
    reference_name: "orders",
    display_name: "orders",
    source_path: "/x/orders.csv",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [guidedDataset, ordersSource];
    vi.mocked(listWorkingSet).mockImplementation(async () => state.workingSet);
    vi.mocked(activeDataset).mockResolvedValue(ordersSource); // active = orders
    // Pass the per-row "确定删除" confirm so the click reaches the backend.
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("opens a continuation dialog when deleting the active source with others remaining", async () => {
    // AC1 (issue #39): deleting the active source while others remain does NOT
    // silently fall back. The frontend opens a dialog (no IPC yet) collecting an
    // explicit continuation, then removeActiveSource carries both names (AC2).
    vi.mocked(removeActiveSource).mockImplementation(async (_sid, ref) => {
      state.workingSet = state.workingSet.filter((d) => d.reference_name !== ref);
      vi.mocked(activeDataset).mockResolvedValue(guidedDataset); // focus moved to people
    });
    renderPane();
    fireEvent.click(await screen.findByRole("tab", { name: "工作集" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^orders/ })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /删除 orders/ }));

    // Dialog open; no IPC crossed yet (the dialog is the gate, not the backend).
    await waitFor(() =>
      expect(screen.getByText(/删除焦点源「orders」/)).toBeInTheDocument(),
    );
    expect(removeActiveSource).not.toHaveBeenCalled();
    expect(removeSource).not.toHaveBeenCalled();

    // AC5: candidates = the full remaining set (people here), pre-selected.
    expect(screen.getByRole("radio", { name: "people" })).toBeChecked();

    // Confirm with the default-selected continuation (people).
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() =>
      expect(removeActiveSource).toHaveBeenCalledWith("sess-1", "orders", "people"),
    );
    // AC2: dialog closed after the commit.
    await waitFor(() =>
      expect(screen.queryByText(/删除焦点源/)).not.toBeInTheDocument(),
    );
  });

  it("cancel in the continuation dialog is a no-op (AC3)", async () => {
    // AC3: cancel leaves the working set untouched -- nothing crossed IPC while
    // the dialog was open, so there is nothing to undo.
    renderPane();
    fireEvent.click(await screen.findByRole("tab", { name: "工作集" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^orders/ })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /删除 orders/ }));
    await waitFor(() => expect(screen.getByText(/删除焦点源/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "中止" }));
    await waitFor(() =>
      expect(screen.queryByText(/删除焦点源/)).not.toBeInTheDocument(),
    );
    expect(removeActiveSource).not.toHaveBeenCalled();
    expect(removeSource).not.toHaveBeenCalled();
  });

  it("deletes the last active source straight through to removeSource (AC4)", async () => {
    // AC4: when the active source IS the last source, no continuation dialog --
    // removal goes straight to removeSource and the working set ends empty (the
    // UI then shows its upload prompt). No silent jump happens because there is
    // nothing left to jump to.
    state.workingSet = [guidedDataset];
    vi.mocked(activeDataset).mockResolvedValue(guidedDataset); // people active, last source
    vi.mocked(removeSource).mockImplementation(async (_sid, ref) => {
      state.workingSet = state.workingSet.filter((d) => d.reference_name !== ref);
      vi.mocked(activeDataset).mockResolvedValue(null); // empty working set
    });
    renderPane();
    fireEvent.click(await screen.findByRole("tab", { name: "工作集" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^people/ })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /删除/ }));

    // No continuation dialog (only one source); straight to removeSource.
    await waitFor(() => expect(removeSource).toHaveBeenCalledWith("sess-1", "people"));
    expect(removeActiveSource).not.toHaveBeenCalled();
    expect(screen.queryByText(/删除焦点源/)).not.toBeInTheDocument();
    // Empty working set -> the upload prompt renders.
    await waitFor(() =>
      expect(screen.getByText(/工作集为空/)).toBeInTheDocument(),
    );
  });

  it("labels an active-source delete refusal under the 删源失败 prefix (issue #121)", async () => {
    // remove_active_source rejects with a typed RemoveSourceError. NotActive /
    // InvalidContinueWith are unique to this path (plain removeSource cannot
    // produce them); the refusal surfaces under the same "删源失败：" prefix as
    // removeSource, never mislabelled as another operation's failure.
    vi.mocked(removeActiveSource).mockRejectedValueOnce({
      kind: "RemoveSource",
      data: { kind: "InvalidContinueWith", data: "ghost" },
    });
    renderPane();
    fireEvent.click(await screen.findByRole("tab", { name: "工作集" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^orders/ })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /删除 orders/ }));
    await waitFor(() => expect(screen.getByText(/删除焦点源/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() =>
      expect(removeActiveSource).toHaveBeenCalledWith("sess-1", "orders", "people"),
    );
    // The typed refusal renders under the delete prefix with the locale message;
    // the dialog stays open for retry (closed inside fn, after the await).
    await waitFor(() =>
      expect(screen.getByText(/删源失败：「ghost」不是剩余可用源之一/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(failedPrefix("load"))).not.toBeInTheDocument();
    expect(screen.queryByText(failedPrefix("rename"))).not.toBeInTheDocument();
  });
});

describe("App session-header name fallback (ADR-0060)", () => {
  // useShellSessions mints a new session with name "" until the backend's
  // display_name round-trip lands; the session-header must render the
  // localized "新会话" placeholder (zh-CN catalog) -- never an empty header
  // span. A regression that swaps `||` for `??` (which only catches null /
  // undefined) or drops the fallback leaves the header blank during the
  // new-session window.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the localized default name when sessionName is empty", async () => {
    renderPane("zh-CN", "");
    await waitFor(() => expect(screen.getByText("新会话")).toBeInTheDocument());
  });
});
