import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IntlProvider } from "react-intl";
import { StrictMode } from "react";
import type { ReactNode } from "react";
import type { DatasetDescriptor } from "../types/dataset";
import type { TurnOutcome } from "../types/thread";
import type { ComposerSessionFields } from "../session/useComposerState";

// The composer "+" context panel (the retired FileDropzone's successor, issue
// #351) touches Tauri APIs that don't exist under jsdom; stub them first.
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onDragDropEvent: () => Promise.resolve(() => {}),
  }),
}));

// Radix Select's portal + animation model does not cooperate with jsdom's
// synchronous fireEvent (the dropdown portal never mounts before findByRole
// times out). Mock the primitives as plain <select>s (same convention as
// GuidedLoadDialog.test.tsx). The composer's auth/runtime chips also ride
// these primitives and stay mounted in every App render, so the mock carries
// no shared data-testid -- flows scope the select they drive, e.g. via
// within(dialog).getByRole("combobox").
vi.mock("../components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    disabled?: boolean;
    children: ReactNode;
  }) => (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onValueChange(e.currentTarget.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectValue: () => null,
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
    closeSession: vi.fn(async () => false),
    createSession: vi.fn(async () => "sess-1"),
    ingestFile: vi.fn(),
    ingestFileGuided: vi.fn(),
    // The guided dialog cancel fires the retention discard + the pager fetches
    // windows (issue #750); no-op stubs keep jsdom off the real invoke.
    discardGuidedRetention: vi.fn(async () => {}),
    guidanceWindow: vi.fn(async () => []),
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
  conversation,
  ingestFile,
  ingestFileGuided,
  listWorkingSet,
  readRows,
  removeSource,
  removeActiveSource,
  renameDataset,
  setDatasetPrivacy,
} from "../api";
import { cancelled, failed, materialized } from "../session/__tests__/fixtures";
import { log } from "../lib/log";

// ADR-0093 (#512): the session-header management callback props are no-ops in
// every SessionPane render in this file (these tests exercise session-INTERNAL
// flows, not the shell management actions). Collected here so the three render
// sites share one source instead of repeating five identical lines each.
const HEADER_MGMT_PROPS = {
  duckPath: "/test/session.duck",
  onRename: () => {},
  onExport: () => {},
  onClose: () => {},
  onDelete: () => {},
} as const;

// Issue #81 cold start (ADR-0061): <App/> no longer auto-creates a session on
// mount, so these session-INTERNAL flows (guided load / rename / privacy / ask /
// delete-source) are driven through <SessionPane> directly -- the unit that owns
// them. The shell-level cold-start + multi-session behavior lives in
// Shell.test.tsx. Each render gets a fresh QueryClient (ADR-0051: test renders
// never share cache). zh-CN so the i18n'd chrome matches the assertions.
function renderPane(
  locale: EffectiveLocale = "zh-CN",
  sessionName = "Test session",
): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // TooltipProvider mirrors the App ancestor: the rail's turn cards carry the
  // TruncatingTooltip question recovery (ADR-0050), which crashes without the
  // provider context once a turn renders (an optimistic append or a thread
  // mock).
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <IntlProvider
        locale={locale}
        messages={catalogFor(locale)}
        defaultLocale="en-US"
      >
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
  // ADR-0092: SessionPane no longer renders QuestionBar. Capture the composer
  // fields (handleAsk etc.) so tests can trigger questions directly.
  capturedComposerFields = null;
  render(
    wrap(
      <SessionPane
        sessionId="sess-1"
        pendingIngestPaths={[]}
        onIngestConsumed={() => {}}
        pendingQuestion={null}
        onQuestionConsumed={() => {}}
        onSeedDraft={() => {}}
        onComposerFields={(_sid, fields) => {
          capturedComposerFields = fields;
        }}
        onComposerFieldsUnmount={() => {}}
        sessionName={sessionName}
        onFirstTurnSettled={() => {}}
        approvalEvents={approvalEvents}
        {...HEADER_MGMT_PROPS}
      />,
    ),
  );
}

// ADR-0092: captured composer fields from the last renderPane() call. Tests
// that need to submit a question wait for this to be non-null, then call
// handleAsk directly (the QuestionBar moved to the shell level).
let capturedComposerFields: ComposerSessionFields | null = null;

/** Wait for the SessionPane to report its composer fields, then call handleAsk. */
async function submitQuestion(question: string): Promise<void> {
  await waitFor(() => expect(capturedComposerFields).not.toBeNull());
  await act(async () => {
    await capturedComposerFields!.handleAsk(question);
  });
}

// Rail result-link click (findBy*: the thread query resolves async after the
// pane mounts, so the links appear a beat later than renderPane() returns).
// Shared by the #757 indicator flow and the #758 rerun provenance flow --
// both move the view onto an older result from the rail.
async function clickRailResultLink(name: string): Promise<void> {
  const rail = document.querySelector<HTMLElement>(".session-rail")!;
  fireEvent.click(await within(rail).findByRole("button", { name: `结果：${name}` }));
}

// The catalog key for an operation verb (issue #139). The negative prefix
// assertions below build the expected "{verb} failed"/"{verb}失败" text from
// the catalog so they track the verb wording instead of duplicating a hard-
// coded string, and the same helper serves the en-US locale test.
function verbKey(kind: SessionFlowKind): CatalogKey {
  switch (kind) {
    case "load":
      return "error.verb.load";
    case "rename":
      return "error.verb.rename";
    case "replace":
      return "error.verb.replace";
    case "delete":
      return "error.verb.delete";
    case "privacy":
      return "error.verb.privacy";
    case "ask":
      return "error.verb.ask";
    default: {
      // Exhaustiveness guard: mirrors errorVerb in lib/error-presentation/
      // app-error so a new SessionFlowKind member forces a test update here
      // too. The `default: never` throw enforces this regardless of tsconfig
      // flags.
      const unhandled: never = kind;
      throw new Error(
        `unhandled SessionFlowKind: ${JSON.stringify(unhandled)}`,
      );
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

// A single-promotion Materialized ask outcome derived from the guided source;
// the ask-flow tests differ only in the result name.
function materializedOutcome(referenceName: string): TurnOutcome {
  return {
    kind: "Materialized",
    data: {
      promotions: [
        {
          dataset: { ...guidedDataset, reference_name: referenceName, row_count: 1 },
          sql: "SELECT 1",
        },
      ],
      viz: null,
      assumption: null,
    },
  };
}

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
            total_rows: 3,
            state: { kind: "NeedsGuidance", data: { reason: "MultipleHeaderRows" } },
          },
        ],
      },
    });
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

    // ADR-0092: the composer "+" Files button moved to the shell-level bar.
    // Trigger ingest directly via the captured composer fields.
    await waitFor(() => expect(capturedComposerFields).not.toBeNull());
    act(() => {
      capturedComposerFields!.handleIngestFiles(["/x/m.xlsx"]);
    });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.getByText(/引导加载：m/)).toBeInTheDocument();

    // Choose the real header (row 2) and submit -> guided ingest (AC3/AC7 seam).
    // The mocked header-row Select is the only combobox INSIDE the dialog (the
    // composer's mocked selects live outside it).
    fireEvent.change(
      within(screen.getByRole("dialog")).getByRole("combobox"),
      { target: { value: "2" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "加载" }));

    await waitFor(() =>
      expect(ingestFileGuided).toHaveBeenCalledWith("sess-1", "/x/m.xlsx", [
        { name: "people", rectify: { header_row: 2, skip_rows: [] } },
      ]),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});

// Drive the in-app rename dialog (#759): open via the row trigger, set the
// draft, submit the form (jsdom does not dispatch submit on a Save click).
function submitRename(triggerName: RegExp, value: string) {
  fireEvent.click(screen.getByRole("button", { name: triggerName }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value } });
  fireEvent.submit(dialog.querySelector("form")!);
}

describe("App rename flow", () => {
  // Mocks (api rejections, prototype spies) must not leak between tests.
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
      expect(
        screen.getByRole("button", { name: /^people/ }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^people/ }));
    // The dataset's column type is shown (now in both the schema table and the
    // privacy-cols table, so BIGINT appears twice -- assert presence, not uniqueness).
    expect(screen.getAllByText("BIGINT").length).toBeGreaterThan(0);

    // Rename via the in-app dialog (#759); on refresh the working set carries
    // the new label.
    vi.mocked(renameDataset).mockImplementation(async (_sid, ref, display) => {
      state.workingSet = state.workingSet.map((d) =>
        d.reference_name === ref ? { ...d, display_name: display } : d,
      );
      return { ...guidedDataset, display_name: display };
    });
    submitRename(/重命名/, "员工表");

    // The rename carries the stable reference name + the new display label.
    await waitFor(() =>
      expect(renameDataset).toHaveBeenCalledWith("sess-1", "people", "员工表"),
    );

    // Selection survived (keyed by reference_name): the list now shows the new
    // label, yet the same dataset's columns are still in the detail pane.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^员工表/ }),
      ).toBeInTheDocument(),
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
      expect(
        screen.getByRole("button", { name: /^people/ }),
      ).toBeInTheDocument(),
    );

    vi.mocked(renameDataset).mockRejectedValueOnce({
      kind: "RenameDataset",
      data: { kind: "DisplayTaken", data: "员工表" },
    });
    // Open the rename dialog (#759) and submit the new label.
    submitRename(/重命名/, "员工表");

    await waitFor(() =>
      expect(
        screen.getByText(/显示名「员工表」已被其他数据集使用/),
      ).toBeInTheDocument(),
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
      expect(
        screen.getByRole("button", { name: /^people/ }),
      ).toBeInTheDocument(),
    );
    // Select the dataset to reveal PrivacyControls in the detail pane.
    fireEvent.click(screen.getByRole("button", { name: /^people/ }));

    vi.mocked(setDatasetPrivacy).mockRejectedValueOnce(
      "权限不足，无法修改隐私设置",
    );
    fireEvent.click(screen.getByLabelText(/向云端 LLM 发送样本值/));

    await waitFor(() =>
      expect(
        screen.getByText(/权限不足，无法修改隐私设置/),
      ).toBeInTheDocument(),
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
      expect(
        screen.getByRole("button", { name: /^people/ }),
      ).toBeInTheDocument(),
    );

    vi.mocked(renameDataset).mockRejectedValueOnce({
      kind: "RenameDataset",
      data: { kind: "DisplayTaken", data: "员工表" },
    });
    // Open the rename dialog (#759) and submit the new label.
    submitRename(/^Rename/, "员工表");

    // Both the prefix and the underlying refusal (en-US catalog
    // error.dataset.displayTaken) render in English -- locale consistent.
    await waitFor(() =>
      expect(
        screen.getByText(/Rename failed: Display label/),
      ).toBeInTheDocument(),
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
      expect(
        screen.getByRole("button", { name: /^people/ }),
      ).toBeInTheDocument(),
    );

    vi.mocked(renameDataset).mockResolvedValue({
      ...guidedDataset,
      display_name: "renamed",
    } as never);
    // Open the rename dialog (#759) and submit the new label.
    submitRename(/^Rename/, "renamed");

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
    vi.mocked(askQuestion).mockResolvedValue(materializedOutcome("result_1"));
    renderPane();
    await submitQuestion("总共几行");
    await waitFor(() =>
      expect(askQuestion).toHaveBeenCalledWith("sess-1", "总共几行"),
    );
    // the materialized result pane appears (ResultView heading, titled with
    // the producing question, issue #772). The rail's turn card also shows the
    // question text, so target the heading role to assert the workspace
    // ResultView specifically.
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /总共几行/ }),
      ).toBeInTheDocument(),
    );
  });

  it("labels an ask failure distinctly from a load failure", async () => {
    vi.mocked(askQuestion).mockRejectedValueOnce("未配置有效的 LLM 提供方");
    renderPane();
    await submitQuestion("x");
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
    // Mount refresh has settled; queue what the turn produces (asked after mount
    // so the mount's own conversation() call doesn't consume the once-mock).
    // No conversation once-mock: the turn flow appends optimistically and
    // never invalidates the thread (ADR-0051), so a queued thread mock would
    // go UNCONSUMED here and leak into the next test's mount query.
    vi.mocked(askQuestion).mockResolvedValueOnce({
      kind: "Textual",
      data: {
        text_kind: "Clarify",
        body: "按产品名还是客户名汇总？",
        assumption: null,
      },
    });
    await submitQuestion("哪个名字");

    // The clarify body is visible in the thread AND now also in the workspace
    // textual card, so assert at least one match rather than a unique one.
    await waitFor(() =>
      expect(
        screen.getAllByText("按产品名还是客户名汇总？").length,
      ).toBeGreaterThan(0),
    );
    // ...and no result pane opens for a non-result outcome.
    expect(screen.queryByText(/结果：result/)).not.toBeInTheDocument();
  });

  it("the rail empty hint yields to the live turn card on a first in-flight turn (issue #297)", async () => {
    // A brand-new session has an empty thread AND an in-flight first ask: the
    // live turn card occupies the rail, so the "尚无对话" hint must NOT render
    // alongside it (the two read as contradictory).
    renderPane();
    // The empty hint is up before any ask (the thread query settles empty).
    await waitFor(() =>
      expect(screen.getByText(/尚无对话/)).toBeInTheDocument(),
    );
    vi.mocked(askQuestion).mockImplementationOnce(
      () => new Promise<TurnOutcome>(() => {}), // stays in flight
    );
    // Fire handleAsk without awaiting — askQuestion never resolves (in-flight).
    await waitFor(() => expect(capturedComposerFields).not.toBeNull());
    act(() => {
      void capturedComposerFields!.handleAsk("第一问");
    });
    // The live card renders the asking question; the empty hint is gone.
    await waitFor(() =>
      expect(
        within(document.querySelector(".session-rail")!).getByText("第一问"),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/尚无对话/)).not.toBeInTheDocument();
  });
});

describe("App workspace history indicator (issue #757)", () => {
  // The zh-CN catalog strings for the indicator + its exit (renderPane's
  // default locale), resolved from the catalog so the assertions track the
  // wording instead of duplicating literals (issue #139 convention).
  const HISTORY_MESSAGE = catalogFor("zh-CN")["session.historyResult.message"];
  const BACK_TO_LATEST = catalogFor("zh-CN")["session.historyResult.backToLatest"];
  const EXPAND_WORKSPACE = catalogFor("zh-CN")["workspace.expand"];

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
    // A resumed session's thread: two Materialized turns (the session
    // fixtures mint them). R5 lands the view on the latest primary
    // (result_2); the workspace starts folded (ADR-0083), so each flow
    // opens it via the header toggle or a rail selection.
    vi.mocked(conversation).mockResolvedValue([
      materialized("result_1"),
      materialized("result_2"),
    ]);
  });

  it("shows no indicator when the viewed result is the latest one", async () => {
    renderPane();
    // Open the folded workspace (ADR-0083 cold-start posture) to reveal the R5
    // resume landing on the latest result.
    fireEvent.click(screen.getByRole("button", { name: EXPAND_WORKSPACE }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /q:result_2/ })).toBeInTheDocument(),
    );
    expect(screen.queryByText(HISTORY_MESSAGE)).not.toBeInTheDocument();
  });

  it("shows no indicator on the hero when there is no result", async () => {
    // AC "(no result)": the hero owns the workspace and the indicator has no
    // surface there (it rides the result branch of the derivation only).
    vi.mocked(conversation).mockResolvedValue([]);
    renderPane();
    fireEvent.click(screen.getByRole("button", { name: EXPAND_WORKSPACE }));
    await waitFor(() =>
      expect(
        screen.getByText(catalogFor("zh-CN")["session.hero.hasData"]),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(HISTORY_MESSAGE)).not.toBeInTheDocument();
  });

  it("flags a history selection and the exit returns to the latest primary", async () => {
    renderPane();
    // Rail result-link click: moves the view onto the older result and opens
    // the workspace (dual-view linkage, ADR-0083).
    await clickRailResultLink("result_1");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /q:result_1/ })).toBeInTheDocument(),
    );
    expect(screen.getByText(HISTORY_MESSAGE)).toBeInTheDocument();

    // "Back to latest" returns the view to the newest Materialized primary.
    fireEvent.click(screen.getByRole("button", { name: BACK_TO_LATEST }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /q:result_2/ })).toBeInTheDocument(),
    );
    expect(screen.queryByText(HISTORY_MESSAGE)).not.toBeInTheDocument();
  });

  it("the indicator yields when a new turn produces a result (produce = selected)", async () => {
    renderPane();
    await clickRailResultLink("result_1");
    await waitFor(() =>
      expect(screen.getByText(HISTORY_MESSAGE)).toBeInTheDocument(),
    );

    vi.mocked(askQuestion).mockResolvedValueOnce(materializedOutcome("result_3"));
    await submitQuestion("新一问");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /新一问/ })).toBeInTheDocument(),
    );
    expect(screen.queryByText(HISTORY_MESSAGE)).not.toBeInTheDocument();
  });
});

describe("App workspace rerun/retry actions (issue #758)", () => {
  // The zh-CN catalog accessible names for the three action buttons (issue
  // #139 convention: resolve from the catalog, never duplicate literals).
  const RERUN_LABEL = catalogFor("zh-CN")["disclosure.result.staleRerunLabel"];
  const RETRY_LABEL = catalogFor("zh-CN")["thread.outcome.retryLabel"];
  const EXPAND_WORKSPACE = catalogFor("zh-CN")["workspace.expand"];

  // A working-set result descriptor marked stale by a source deletion (the
  // stale cascade). The workspace's stale anchor derives from this runtime
  // truth (ADR-0051), never from the thread snapshot.
  function staleResult(referenceName: string): DatasetDescriptor {
    return {
      ...guidedDataset,
      reference_name: referenceName,
      stale: { reference_name: "people", display_name: "people", reason: "Deleted" },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readRows).mockResolvedValue({
      columns: [],
      rows: [],
      total: 0,
      offset: 0,
      limit: 100,
    });
    // The shared wiring, centralized like the #757 and delete-source
    // describes above: a loaded source, the working-set mocks reading
    // state.workingSet lazily (the stale tests override the assignment), and
    // a never-settling ask baseline so every fired turn stays in flight for
    // the busy assertions; the recovery test overrides the FIRST call with
    // a deferred settle (once-implementations consume ahead of this).
    state.workingSet = [guidedDataset];
    vi.mocked(listWorkingSet).mockImplementation(async () => state.workingSet);
    vi.mocked(activeDataset).mockImplementation(async () => guidedDataset);
    vi.mocked(askQuestion).mockImplementation(
      () => new Promise<TurnOutcome>(() => {}),
    );
  });

  it("the stale banner's rerun fires the producing question and recovers the busy gate", async () => {
    // The viewed result is stale, so the banner's "ask again" advice is an
    // action: one click fires the question that produced the result as a
    // fresh turn -- direct, never through the composer draft. A deferred
    // settle makes BOTH halves of the busy gate observable (disabled while
    // the turn runs, re-enabled after it lands) plus the handler-level
    // guard, in one cycle.
    vi.mocked(conversation).mockResolvedValue([materialized("result_1")]);
    state.workingSet = [guidedDataset, staleResult("result_1")];
    let settleAsk!: (outcome: TurnOutcome) => void;
    vi.mocked(askQuestion).mockImplementationOnce(
      () => new Promise<TurnOutcome>((resolve) => { settleAsk = resolve; }),
    );
    renderPane();
    fireEvent.click(screen.getByRole("button", { name: EXPAND_WORKSPACE }));
    const rerun = await screen.findByRole("button", { name: RERUN_LABEL });
    fireEvent.click(rerun);
    await waitFor(() => expect(askQuestion).toHaveBeenCalledWith("sess-1", "q:result_1"));
    // Busy gate: the fired turn is in flight, so the rerun disables until it
    // settles (the composer gate's mirror).
    expect(screen.getByRole("button", { name: RERUN_LABEL })).toBeDisabled();
    // Handler-level guard (belt-and-suspenders): no synthetic click pierces
    // a disabled button under React 19 (fireEvent and a native dispatchEvent
    // were both probed -- the framework drops both), so the guard is
    // verified at its own layer: a second direct handleAsk (the composer
    // path's fire, the same function ask-again funnels into) while the turn
    // is live is a no-op, not a double fire.
    await act(async () => {
      void capturedComposerFields!.handleAsk("q:result_1");
    });
    expect(askQuestion).toHaveBeenCalledTimes(1);
    // Settle as Textual (no working-set change, so the stale banner and its
    // rerun survive the landing) -- the gate reopens...
    await act(async () => {
      settleAsk({
        kind: "Textual",
        data: { text_kind: "Clarify", body: "done", assumption: null },
      });
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: RERUN_LABEL })).toBeEnabled(),
    );
    // ...and the full cycle repeats: a second rerun fires again (the gate
    // recovers, not latches).
    fireEvent.click(screen.getByRole("button", { name: RERUN_LABEL }));
    await waitFor(() => expect(askQuestion).toHaveBeenCalledTimes(2));
  });

  it("the history-viewed stale banner's rerun fires the VIEWED result's question", async () => {
    // #757 x #758: the two features interleave at WorkspaceResult -- viewing
    // an older (stale) result must rerun THAT result's producing question,
    // never the latest turn's. The single-thread test above cannot tell the
    // two apart; this pins the provenance.
    vi.mocked(conversation).mockResolvedValue([
      materialized("result_1"),
      materialized("result_2"),
    ]);
    state.workingSet = [guidedDataset, staleResult("result_1")];
    renderPane();
    await clickRailResultLink("result_1");
    const rerun = await screen.findByRole("button", { name: RERUN_LABEL });
    fireEvent.click(rerun);
    await waitFor(() => expect(askQuestion).toHaveBeenCalledWith("sess-1", "q:result_1"));
    expect(askQuestion).toHaveBeenCalledTimes(1);
  });

  it("the Failed card's retry fires that turn's question", async () => {
    vi.mocked(conversation).mockResolvedValue([failed("坏查询")]);
    renderPane();
    const retry = await screen.findByRole("button", { name: RETRY_LABEL });
    fireEvent.click(retry);
    await waitFor(() => expect(askQuestion).toHaveBeenCalledWith("sess-1", "坏查询"));
    // Busy gate mirrors the rerun's: disabled while the fired turn runs.
    expect(screen.getByRole("button", { name: RETRY_LABEL })).toBeDisabled();
  });

  it("the Cancelled card's retry fires that turn's question", async () => {
    vi.mocked(conversation).mockResolvedValue([cancelled("中途取消")]);
    renderPane();
    const retry = await screen.findByRole("button", { name: RETRY_LABEL });
    fireEvent.click(retry);
    await waitFor(() => expect(askQuestion).toHaveBeenCalledWith("sess-1", "中途取消"));
    // Busy gate mirrors the rerun/Failed siblings: disabled while in flight.
    expect(screen.getByRole("button", { name: RETRY_LABEL })).toBeDisabled();
  });
});

describe("App workspace tab keyboard contract (issue #760)", () => {
  // The zh-CN catalog accessible names (issue #139 convention: resolve from
  // the catalog, never duplicate literals).
  const EXPAND_WORKSPACE = catalogFor("zh-CN")["workspace.expand"];
  const RESULT_TAB = catalogFor("zh-CN")["session.tab.result"];
  const WORKING_SET_TAB = catalogFor("zh-CN")["session.tab.workingSet"];

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
    vi.mocked(conversation).mockResolvedValue([]);
  });

  /** Expand the folded workspace (ADR-0083 cold-start posture), await the tab row. */
  async function openWorkspaceTabs(): Promise<{
    resultTab: HTMLElement;
    workingSetTab: HTMLElement;
  }> {
    fireEvent.click(screen.getByRole("button", { name: EXPAND_WORKSPACE }));
    const resultTab = await screen.findByRole("tab", { name: RESULT_TAB });
    const workingSetTab = screen.getByRole("tab", { name: WORKING_SET_TAB });
    return { resultTab, workingSetTab };
  }

  /** The workspace-body panel the tabs' aria-controls points at. */
  function panelOf(tab: HTMLElement): HTMLElement {
    return document.getElementById(tab.getAttribute("aria-controls")!)!;
  }

  it("keeps only the selected tab in the tab sequence (roving tabindex)", async () => {
    renderPane();
    const { resultTab, workingSetTab } = await openWorkspaceTabs();
    // The active tab stays in the Tab sequence; the inactive one is skipped.
    expect(resultTab).toHaveAttribute("tabindex", "0");
    expect(workingSetTab).toHaveAttribute("tabindex", "-1");
  });

  it("ArrowRight activates the working-set tab, moves focus, and the content follows", async () => {
    renderPane();
    const { resultTab } = await openWorkspaceTabs();
    resultTab.focus();
    fireEvent.keyDown(resultTab, { key: "ArrowRight" });

    const workingSetTab = screen.getByRole("tab", { name: WORKING_SET_TAB });
    expect(workingSetTab).toHaveAttribute("aria-selected", "true");
    expect(workingSetTab).toHaveFocus();
    expect(resultTab).toHaveAttribute("tabindex", "-1");
    expect(workingSetTab).toHaveAttribute("tabindex", "0");
    // Content follows the activation: the loaded source surfaces in the panel.
    expect(
      within(panelOf(workingSetTab)).getByRole("button", { name: /^people/ }),
    ).toBeInTheDocument();
  });

  it("ArrowLeft wraps from the first tab back to the last", async () => {
    renderPane();
    const { resultTab } = await openWorkspaceTabs();
    resultTab.focus();
    fireEvent.keyDown(resultTab, { key: "ArrowLeft" });

    const workingSetTab = screen.getByRole("tab", { name: WORKING_SET_TAB });
    expect(workingSetTab).toHaveAttribute("aria-selected", "true");
    expect(workingSetTab).toHaveFocus();
  });

  it("ArrowRight wraps from the last tab back to the first", async () => {
    renderPane();
    const { resultTab, workingSetTab } = await openWorkspaceTabs();
    resultTab.focus();
    // Two consecutive ArrowRights: the first activates the working-set tab,
    // the second wraps from the last tab back to the first (a bare focus()
    // on the inactive tab would not -- the handler reads the tab state, so
    // the first press would just move to the working-set tab).
    fireEvent.keyDown(resultTab, { key: "ArrowRight" });
    fireEvent.keyDown(workingSetTab, { key: "ArrowRight" });

    expect(resultTab).toHaveAttribute("aria-selected", "true");
    expect(resultTab).toHaveFocus();
    // Pins the aria-selected toggle's inactive half on the keyboard path;
    // the mouse test carried it alone before.
    expect(workingSetTab).toHaveAttribute("aria-selected", "false");
  });

  it("Home and End jump to the first and last tab", async () => {
    renderPane();
    const { resultTab, workingSetTab } = await openWorkspaceTabs();
    workingSetTab.focus();
    fireEvent.keyDown(workingSetTab, { key: "Home" });
    expect(resultTab).toHaveAttribute("aria-selected", "true");
    expect(resultTab).toHaveFocus();

    fireEvent.keyDown(resultTab, { key: "End" });
    expect(screen.getByRole("tab", { name: WORKING_SET_TAB })).toHaveFocus();
  });

  it("the tab-panel association tracks the active tab", async () => {
    renderPane();
    const { resultTab, workingSetTab } = await openWorkspaceTabs();
    // Both tabs point at the one shared workspace-body panel; the panel's
    // label tracks whichever tab is active.
    const resultPanel = panelOf(resultTab);
    expect(resultPanel).toBe(panelOf(workingSetTab));
    expect(resultPanel).toHaveAttribute("role", "tabpanel");
    expect(resultPanel.getAttribute("aria-labelledby")).toBe(resultTab.id);

    fireEvent.click(workingSetTab);
    expect(resultPanel.getAttribute("aria-labelledby")).toBe(workingSetTab.id);
  });

  it("mouse clicks still switch tabs", async () => {
    renderPane();
    const { resultTab, workingSetTab } = await openWorkspaceTabs();
    fireEvent.click(workingSetTab);
    expect(workingSetTab).toHaveAttribute("aria-selected", "true");
    expect(resultTab).toHaveAttribute("aria-selected", "false");
    expect(
      within(panelOf(workingSetTab)).getByRole("button", { name: /^people/ }),
    ).toBeInTheDocument();
  });
});

describe("App delete-source flow (issue #38)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [guidedDataset];
    vi.mocked(listWorkingSet).mockImplementation(async () => state.workingSet);
  });

  it("titles the list panel with the dataset count (issue #790)", async () => {
    renderPane();
    fireEvent.click(await screen.findByRole("tab", { name: "工作集" }));
    // The h2 count form (Working set · N) tracks the working-set length once
    // the load settles.
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "工作集 · 1" }),
      ).toBeInTheDocument(),
    );
  });

  it("removes a source via removeSource then refreshes the working set", async () => {
    // AC: the per-row delete (after the in-app confirm gate, #759) calls
    // removeSource with the stable reference name, then refreshes so the list
    // no longer shows it.
    vi.mocked(removeSource).mockImplementation(async (_sid, ref) => {
      state.workingSet = state.workingSet.filter(
        (d) => d.reference_name !== ref,
      );
    });
    renderPane();
    fireEvent.click(await screen.findByRole("tab", { name: "工作集" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^people/ }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /删除/ }));
    // Confirm at the in-app AlertDialog (#759): its Action's accessible name is
    // the bare 删除 (the row trigger carries "删除 people").
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() =>
      expect(removeSource).toHaveBeenCalledWith("sess-1", "people"),
    );
    // The refresh after the delete drops the removed source from the list.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /^people/ }),
      ).not.toBeInTheDocument(),
    );
  });

  it("labels a delete failure distinctly from load/rename/replace/ask failures", async () => {
    // A typed RemoveSource refusal (issue #121) surfaces under the "删源失败："
    // prefix -- never mislabelled as another operation's failure.
    vi.mocked(removeSource).mockRejectedValueOnce({
      kind: "RemoveSource",
      data: { kind: "NotFound", data: "people" },
    });
    renderPane();
    fireEvent.click(await screen.findByRole("tab", { name: "工作集" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^people/ }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /删除/ }));
    // Confirm at the in-app AlertDialog (#759) so the removal reaches the
    // backend and its typed refusal can be labelled.
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(
        screen.getByText(/删源失败：找不到引用名为「people」的数据集/),
      ).toBeInTheDocument(),
    );
    // No other operation's prefix is used.
    expect(screen.queryByText(failedPrefix("load"))).not.toBeInTheDocument();
    expect(screen.queryByText(failedPrefix("rename"))).not.toBeInTheDocument();
    expect(screen.queryByText(failedPrefix("replace"))).not.toBeInTheDocument();
    // A RemoveSource reject is a command reject, not a turn outcome, so the
    // rail's Failed card (.turn-outcome.failed, issue #125) must not render.
    expect(
      document.querySelector(".turn-outcome.failed"),
    ).not.toBeInTheDocument();
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
  });

  // The per-row ✕ opens the in-app confirm AlertDialog (#759); the bare-删除
  // Action inside it is the gate the click must pass to reach the backend.
  function confirmWorkingSetDelete() {
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
  }

  it("opens a continuation dialog when deleting the active source with others remaining", async () => {
    // AC1 (issue #39): deleting the active source while others remain does NOT
    // silently fall back. The frontend opens a dialog (no IPC yet) collecting an
    // explicit continuation, then removeActiveSource carries both names (AC2).
    vi.mocked(removeActiveSource).mockImplementation(async (_sid, ref) => {
      state.workingSet = state.workingSet.filter(
        (d) => d.reference_name !== ref,
      );
      vi.mocked(activeDataset).mockResolvedValue(guidedDataset); // focus moved to people
    });
    renderPane();
    fireEvent.click(await screen.findByRole("tab", { name: "工作集" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^orders/ }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /删除 orders/ }));
    confirmWorkingSetDelete();

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
      expect(removeActiveSource).toHaveBeenCalledWith(
        "sess-1",
        "orders",
        "people",
      ),
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
      expect(
        screen.getByRole("button", { name: /^orders/ }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /删除 orders/ }));
    confirmWorkingSetDelete();
    await waitFor(() =>
      expect(screen.getByText(/删除焦点源/)).toBeInTheDocument(),
    );

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
      state.workingSet = state.workingSet.filter(
        (d) => d.reference_name !== ref,
      );
      vi.mocked(activeDataset).mockResolvedValue(null); // empty working set
    });
    renderPane();
    fireEvent.click(await screen.findByRole("tab", { name: "工作集" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^people/ }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /删除/ }));
    confirmWorkingSetDelete();

    // No continuation dialog (only one source); straight to removeSource.
    await waitFor(() =>
      expect(removeSource).toHaveBeenCalledWith("sess-1", "people"),
    );
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
      expect(
        screen.getByRole("button", { name: /^orders/ }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /删除 orders/ }));
    confirmWorkingSetDelete();
    await waitFor(() =>
      expect(screen.getByText(/删除焦点源/)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() =>
      expect(removeActiveSource).toHaveBeenCalledWith(
        "sess-1",
        "orders",
        "people",
      ),
    );
    // The typed refusal renders under the delete prefix with the locale message;
    // the dialog stays open for retry (closed inside fn, after the await).
    await waitFor(() =>
      expect(
        screen.getByText(/删源失败：「ghost」不是剩余可用源之一/),
      ).toBeInTheDocument(),
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

describe("SessionPane pending-payload consumption (#500)", () => {
  // The cold-start submit carries BOTH pending payloads onto the minted
  // session: pendingIngestPaths (the "+" file queue) + pendingQuestion. The
  // pane consumes them in ONE coordinated effect -- files first, question
  // second, and a halted batch hands the question back to the bar draft via
  // onSeedDraft instead of firing it underneath the guidance / error.

  const loadedDataset: DatasetDescriptor = {
    reference_name: "people",
    display_name: "people",
    source_path: "/x/a.csv",
    row_count: 1,
    fingerprint: "ff".repeat(32),
    columns: [{ name: "id", canonical_type: "BIGINT" }],
    sample: [["1"]],
    rectify: { kind: "NotApplicable" },
    privacy: { send_samples: true, type_only_columns: [] },
  };

  // The two park tests below start identically: first file loads, second needs
  // guidance, so the batch PARKS on the dialog (#748). One place builds the
  // mock chain so the payload can't drift between them.
  function mockBatchParksOnGuidance() {
    vi.mocked(ingestFile)
      .mockResolvedValueOnce({ kind: "Loaded", data: loadedDataset })
      .mockResolvedValueOnce({
        kind: "NeedsGuidance",
        data: {
          source_path: "/x/m.xlsx",
          workbook_name: "m.xlsx",
          sheets: [
            {
              name: "Sheet1",
              preview: [["a"]],
              total_rows: 1,
              state: { kind: "NeedsGuidance", data: { reason: "MultipleHeaderRows" } },
            },
          ],
        },
      });
  }

  interface PendingPayload {
    pendingIngestPaths?: string[];
    pendingQuestion?: string | null;
    strictMode?: boolean;
  }

  function renderPaneWithPending(payload: PendingPayload): {
    onIngestConsumed: ReturnType<typeof vi.fn>;
    onQuestionConsumed: ReturnType<typeof vi.fn>;
    onSeedDraft: ReturnType<typeof vi.fn>;
    rerender: (payload: PendingPayload) => void;
  } {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const onIngestConsumed = vi.fn();
    const onQuestionConsumed = vi.fn();
    const onSeedDraft = vi.fn();
    const approvalEvents: UseApprovalEvents = {
      approvalsBySession: new Map(),
      pendingApprovalSids: new Set(),
      respond: () => {},
      clearSession: () => {},
    };
    const pane = (
      <SessionPane
        sessionId="sess-1"
        pendingIngestPaths={payload.pendingIngestPaths ?? []}
        onIngestConsumed={onIngestConsumed}
        pendingQuestion={payload.pendingQuestion ?? null}
        onQuestionConsumed={onQuestionConsumed}
        onSeedDraft={onSeedDraft}
        onComposerFields={() => {}}
        onComposerFieldsUnmount={() => {}}
        sessionName="pending"
        onFirstTurnSettled={() => {}}
        approvalEvents={approvalEvents}
        {...HEADER_MGMT_PROPS}
      />
    );
    const tree = (
      <QueryClientProvider client={queryClient}>
        <IntlProvider
          locale="zh-CN"
          messages={catalogFor("zh-CN")}
          defaultLocale="en-US"
        >
          <TooltipProvider>{pane}</TooltipProvider>
        </IntlProvider>
      </QueryClientProvider>
    );
    const view = render(
      payload.strictMode ? <StrictMode>{tree}</StrictMode> : tree,
    );
    const rerender = (next: PendingPayload) => {
      const nextPane = (
        <SessionPane
          sessionId="sess-1"
          pendingIngestPaths={next.pendingIngestPaths ?? []}
          onIngestConsumed={onIngestConsumed}
          pendingQuestion={next.pendingQuestion ?? null}
          onQuestionConsumed={onQuestionConsumed}
          onSeedDraft={onSeedDraft}
          onComposerFields={() => {}}
          onComposerFieldsUnmount={() => {}}
          sessionName="pending"
          onFirstTurnSettled={() => {}}
          approvalEvents={approvalEvents}
          {...HEADER_MGMT_PROPS}
        />
      );
      const nextTree = (
        <QueryClientProvider client={queryClient}>
          <IntlProvider
            locale="zh-CN"
            messages={catalogFor("zh-CN")}
            defaultLocale="en-US"
          >
            <TooltipProvider>{nextPane}</TooltipProvider>
          </IntlProvider>
        </QueryClientProvider>
      );
      view.rerender(
        next.strictMode ? <StrictMode>{nextTree}</StrictMode> : nextTree,
      );
    };
    return { onIngestConsumed, onQuestionConsumed, onSeedDraft, rerender };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    vi.mocked(listWorkingSet).mockResolvedValue([]);
    vi.mocked(activeDataset).mockResolvedValue(null);
    // The question fires through handleAsk; reject the turn so it settles
    // without appending a thread entry (the assertion targets the call order,
    // not the outcome).
    vi.mocked(askQuestion).mockRejectedValue(new Error("settle the turn"));
  });

  it("ingests the pending file list BEFORE firing the pending question", async () => {
    vi.mocked(ingestFile).mockResolvedValue({
      kind: "Loaded",
      data: loadedDataset,
    });
    const { onIngestConsumed, onQuestionConsumed } = renderPaneWithPending({
      pendingIngestPaths: ["/x/a.csv", "/x/b.csv"],
      pendingQuestion: "how many rows?",
    });

    await waitFor(() =>
      expect(askQuestion).toHaveBeenCalledWith("sess-1", "how many rows?"),
    );
    expect(ingestFile).toHaveBeenCalledTimes(2);
    expect(ingestFile).toHaveBeenNthCalledWith(1, "sess-1", "/x/a.csv");
    expect(ingestFile).toHaveBeenNthCalledWith(2, "sess-1", "/x/b.csv");
    // Files landed strictly before the question fired.
    expect(vi.mocked(ingestFile).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(askQuestion).mock.invocationCallOrder[0],
    );
    // Both payloads clear upfront so a remount cannot re-fire either.
    expect(onIngestConsumed).toHaveBeenCalledTimes(1);
    expect(onQuestionConsumed).toHaveBeenCalledTimes(1);
  });

  it("fires the pending question alone when no files are pending", async () => {
    renderPaneWithPending({ pendingQuestion: "bare question" });
    await waitFor(() =>
      expect(askQuestion).toHaveBeenCalledWith("sess-1", "bare question"),
    );
    expect(ingestFile).not.toHaveBeenCalled();
  });

  it("ingests a drop-to-create file without a question", async () => {
    vi.mocked(ingestFile).mockResolvedValue({
      kind: "Loaded",
      data: loadedDataset,
    });
    const { onIngestConsumed } = renderPaneWithPending({
      pendingIngestPaths: ["/x/drop.csv"],
    });
    await waitFor(() =>
      expect(ingestFile).toHaveBeenCalledWith("sess-1", "/x/drop.csv"),
    );
    expect(onIngestConsumed).toHaveBeenCalledTimes(1);
    expect(askQuestion).not.toHaveBeenCalled();
  });

  it("holds the question fully pending while the batch parks on guidance, seeding the draft on cancel-halt (#500, #748)", async () => {
    // First file loads, second needs guidance -> the batch PARKS (#748): the
    // handleIngestMany Promise stays pending while the dialog is open, so the
    // auto-ask neither fires NOR seeds the draft underneath the dialog.
    // Cancelling the dialog cancel-halts the batch -- the question is then
    // seeded back into the session's draft so it is never silently lost.
    mockBatchParksOnGuidance();
    const { onSeedDraft } = renderPaneWithPending({
      pendingIngestPaths: ["/x/a.csv", "/x/m.xlsx"],
      pendingQuestion: "how many rows?",
    });

    // The guidance dialog owns the user's attention; the question is held
    // back entirely until the park resolves.
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(onSeedDraft).not.toHaveBeenCalled();
    expect(askQuestion).not.toHaveBeenCalled();

    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /取消/ }),
    );
    await waitFor(() =>
      expect(onSeedDraft).toHaveBeenCalledWith("sess-1", "how many rows?"),
    );
    expect(askQuestion).not.toHaveBeenCalled();
  });

  it("fires the pending question after a guided load drains the parked batch (#500, #748)", async () => {
    // Same park, but the user resolves the guidance: the guided file loads,
    // the queued remainder drains, and the #500 gate releases the auto-ask.
    mockBatchParksOnGuidance();
    vi.mocked(ingestFileGuided).mockResolvedValueOnce({
      kind: "Loaded",
      data: loadedDataset,
    });
    renderPaneWithPending({
      pendingIngestPaths: ["/x/a.csv", "/x/m.xlsx"],
      pendingQuestion: "how many rows?",
    });

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(askQuestion).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "加载" }),
    );

    await waitFor(() =>
      expect(askQuestion).toHaveBeenCalledWith("sess-1", "how many rows?"),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("holds the question back when the first file errors", async () => {
    vi.mocked(ingestFile).mockResolvedValue({
      kind: "Error",
      data: { kind: "Parse", data: { detail: "bad csv" } },
    });
    const { onSeedDraft } = renderPaneWithPending({
      pendingIngestPaths: ["/x/bad.csv"],
      pendingQuestion: "how many rows?",
    });

    await waitFor(() =>
      expect(onSeedDraft).toHaveBeenCalledWith("sess-1", "how many rows?"),
    );
    expect(askQuestion).not.toHaveBeenCalled();
  });

  it("consumes each payload exactly once under React.StrictMode (dev remount)", async () => {
    // StrictMode dev double-invokes effects on mount; the payload-key dedup
    // must hold so the files ingest + the question fires exactly once.
    vi.mocked(ingestFile).mockResolvedValue({
      kind: "Loaded",
      data: loadedDataset,
    });
    renderPaneWithPending({
      pendingIngestPaths: ["/x/a.csv"],
      pendingQuestion: "once only",
      strictMode: true,
    });

    await waitFor(() => expect(askQuestion).toHaveBeenCalledTimes(1));
    expect(ingestFile).toHaveBeenCalledTimes(1);
  });

  it("re-arms for a different pending payload on an already-mounted pane (#500)", async () => {
    // consumedPendingRef dedups by payload KEY (JSON.stringify of the
    // paths+question pair). A DIFFERENT payload on the same mounted pane must
    // produce a different key and consume again — a second drop onto an active
    // session must not be silently dropped by stale dedup.
    vi.mocked(ingestFile).mockResolvedValue({
      kind: "Loaded",
      data: loadedDataset,
    });
    const { rerender, onIngestConsumed } = renderPaneWithPending({
      pendingIngestPaths: ["/x/a.csv"],
    });

    // First payload consumed.
    await waitFor(() =>
      expect(ingestFile).toHaveBeenCalledWith("sess-1", "/x/a.csv"),
    );
    expect(onIngestConsumed).toHaveBeenCalledTimes(1);

    // Simulate the shell clearing the prop then a new drop landing.
    rerender({ pendingIngestPaths: [] });
    rerender({ pendingIngestPaths: ["/x/b.csv"] });

    // Second distinct payload consumed again — not blocked by stale dedup.
    await waitFor(() =>
      expect(ingestFile).toHaveBeenCalledWith("sess-1", "/x/b.csv"),
    );
    expect(onIngestConsumed).toHaveBeenCalledTimes(2);
    expect(ingestFile).toHaveBeenCalledTimes(2);
  });
});

describe("SessionPane session-query error banner (#763)", () => {
  // The three session queries (working set / active / thread) coalesce through
  // `data ??` empty fallbacks, so a fetch or refetch failure used to render as
  // a pristine empty session -- indistinguishable from a fresh one. The banner
  // is the shared error face for all three; it is a non-blocking disclosure
  // (derivations keep rendering, the composer stays live) with a retry that
  // refetches only the errored queries.
  const BANNER_TITLE = catalogFor("zh-CN")["session.queries.errorTitle"];
  const RETRY_LABEL = catalogFor("zh-CN")["session.queries.retry"];
  const RAIL_EMPTY = catalogFor("zh-CN")["session.rail.empty"];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listWorkingSet).mockResolvedValue([]);
    vi.mocked(activeDataset).mockResolvedValue(null);
    vi.mocked(conversation).mockResolvedValue([]);
  });

  it("renders no banner and logs nothing while all session queries are healthy", async () => {
    const warnSpy = vi.spyOn(log, "warn");
    renderPane();

    await waitFor(() => expect(conversation).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // The warn belongs to the error-set effect, not to rendering: a healthy
    // pane stays silent.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("renders one destructive banner with a retry when the thread query fails", async () => {
    vi.mocked(conversation).mockRejectedValue(new Error("ipc down"));
    renderPane();

    // The banner replaces the silent empty-session degradation.
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(BANNER_TITLE);
    expect(document.querySelectorAll("[data-slot=\"alert\"]")).toHaveLength(1);
    expect(screen.getByRole("button", { name: RETRY_LABEL })).toBeEnabled();
    // The disclosure's slot and severity: between the session header and the
    // session body (the pane column's conditional banner slot), in the
    // destructive variant.
    const header = document.querySelector(".session-header")!;
    const body = document.querySelector(".session-body")!;
    expect(
      banner.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    expect(
      body.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    expect(banner.className).toContain("border-destructive/40");
    // Non-blocking: the thread fell back to EMPTY_THREAD, so the rail keeps
    // its fresh-session hint -- the error state does not blank the pane.
    expect(screen.getByText(RAIL_EMPTY)).toBeInTheDocument();
  });

  it("shows the same banner for a working-set failure (shared error face)", async () => {
    vi.mocked(listWorkingSet).mockRejectedValue(new Error("ws down"));
    renderPane();

    expect(await screen.findByText(BANNER_TITLE)).toBeInTheDocument();
  });

  it("shows the same banner for an active-dataset failure (shared error face)", async () => {
    // Each query's error branch feeds the aggregate independently; pin the
    // active branch too so a future narrowing of the memo cannot silently
    // drop it.
    vi.mocked(activeDataset).mockRejectedValue(new Error("active down"));
    renderPane();

    expect(await screen.findByText(BANNER_TITLE)).toBeInTheDocument();
  });

  it("renders exactly one banner when all three session queries fail, and Retry refetches every errored slice", async () => {
    const warnSpy = vi.spyOn(log, "warn");
    // The retry below fails again with FRESH Error identities (mockRejected
    // Value reuses one instance, which the error state holds across the
    // refetch, so the memo deps would never move): that is the identity
    // change the log's re-fire rides on.
    vi.mocked(listWorkingSet)
      .mockRejectedValueOnce(new Error("ws down"))
      .mockRejectedValueOnce(new Error("ws down again"));
    vi.mocked(activeDataset)
      .mockRejectedValueOnce(new Error("active down"))
      .mockRejectedValueOnce(new Error("active down again"));
    vi.mocked(conversation)
      .mockRejectedValueOnce(new Error("thread down"))
      .mockRejectedValueOnce(new Error("thread down again"));
    renderPane();

    await screen.findByRole("alert");
    expect(document.querySelectorAll("[data-slot=\"alert\"]")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: RETRY_LABEL }));

    // Every errored branch refetches -- working set, active, AND thread: the
    // plural half of the retry contract, with no branch left unexecuted.
    await waitFor(() => expect(listWorkingSet).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(activeDataset).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(conversation).toHaveBeenCalledTimes(2));
    // The rejections land back in error state: the banner is not
    // optimistically cleared, and the log re-fires for the new error-set
    // identity.
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(2));
  });

  it("keeps rendering thread-derived content alongside the banner (cached, non-blocking)", async () => {
    // The invalidate/refetch failure path can leave OTHER queries healthy:
    // a failed working-set read must not degrade the rail's thread view.
    vi.mocked(listWorkingSet).mockRejectedValue(new Error("ws down"));
    vi.mocked(conversation).mockResolvedValue([materialized("result_1")]);
    renderPane();

    await screen.findByText(BANNER_TITLE);
    const rail = document.querySelector<HTMLElement>(".session-rail")!;
    expect(
      await within(rail).findByRole("button", { name: "结果：result_1" }),
    ).toBeInTheDocument();
  });

  it("retry refetches the errored query only and clears the banner once healthy", async () => {
    vi.mocked(conversation)
      .mockRejectedValueOnce(new Error("ipc down"))
      .mockResolvedValueOnce([]);
    renderPane();

    fireEvent.click(await screen.findByRole("button", { name: RETRY_LABEL }));

    await waitFor(() => expect(conversation).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    // Only the errored slice refetches: the healthy working-set + active
    // queries stay at their mount-time call counts.
    expect(listWorkingSet).toHaveBeenCalledTimes(1);
    expect(activeDataset).toHaveBeenCalledTimes(1);
  });

  it("logs a warning when a session query fails", async () => {
    const warnSpy = vi.spyOn(log, "warn");
    vi.mocked(conversation).mockRejectedValue(new Error("ipc down"));
    renderPane();

    // The visible banner carries the disclosure; log.warn carries the durable
    // trace (the skill-registry warn above is the log-only precedent). Each
    // Error arrives as its own extra -- the sink takes the stack branch only
    // for a bare Error, while an array extra stringifies to [{}].
    await waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith(
        "SessionPane",
        "session query failed",
        expect.any(Error),
      ),
    );
    // Once per error-set change, not per render: the pane re-renders several
    // times while settling, and the memo identity must absorb all of them.
    await waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1));
  });
});
