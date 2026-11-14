import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SessionPane } from "../SessionPane";
import { artifactKeys } from "../queryKeys";
import {
  artifactExists,
  askQuestion,
  activeDataset,
  conversation,
  getApprovalAttachments,
  ingestFile,
  listSkills,
  listWorkingSet,
  readRows,
  replaceSource,
  takeSourceNotices,
} from "../../api";
import { TooltipProvider } from "../../components/ui/tooltip";
import { pickDataFiles } from "../../components/dataset/pickDataFiles";
import { open } from "@tauri-apps/plugin-dialog";
import { artifactTurn, failed, textual } from "./fixtures";
import { log } from "../../lib/log";
import type { ComposerSessionFields } from "../useComposerState";
import type { ApprovalEntry } from "../useApprovalEvents";
import type { ThreadEntry } from "../../types/thread";
import type { DatasetDescriptor, LoadOutcome } from "../../types/dataset";

// The pane-level approval wiring pins (issue #1009 review, PR #1010): both
// approval callbacks live ONLY on the pane -- the respond callback binds the
// pane's sessionId onto the approval channel's respond, and the loader
// closes it over getApprovalAttachments. Thread-level tests hand the props
// in directly, so nothing else observed this pass-through: a dropped prop
// or a mis-bound id would silently degrade the card (the no-loader branch
// renders exactly the #672 capped behavior with no error note).
//
// Issue #1422: the suite runs the REAL useSessionState (Thread-suite
// posture -- the api layer is mocked, the hook is not). The pending card
// therefore rides the live turn the real useTurnFlow builds while an ask is
// in flight: askQuestion is mocked to a never-settling promise, the ask is
// fired through the pane's own reported handleAsk (the ADR-0092 composer
// fields), and the pane's approvals prop carries the pending entry the hook
// merges into the live rows.

// Capture-free onTurnProgress stub: jsdom has no Tauri event bus, and the
// never-settling ask alone keeps the live turn in flight -- no test needs to
// emit phases (the useTurnFlow suite owns the event-stream pins).
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    askQuestion: vi.fn(),
    replaceSource: vi.fn(),
    readRows: vi.fn(),
    // The runtime read defaults to the failed-read degrade (no marker
    // stamped) -- the same default the useTurnFlow suite pins against.
    getSessionRuntime: vi.fn(async () => undefined),
    cancelQuery: vi.fn(async () => {}),
    ingestFile: vi.fn(),
    conversation: vi.fn(),
    listWorkingSet: vi.fn(),
    activeDataset: vi.fn(),
    takeSourceNotices: vi.fn(),
    takePersistError: vi.fn(async () => null),
    getApprovalAttachments: vi.fn(),
    listSkills: vi.fn(),
    artifactExists: vi.fn(),
    onTurnProgress: vi.fn(async () => () => {}),
  };
});

// The OS file dialog never opens in jsdom: the picker is module-mocked so
// the working-set card's add path can arm a batch with chosen paths.
vi.mock("../../components/dataset/pickDataFiles", () => ({
  pickDataFiles: vi.fn(),
}));

// The row's replace path opens the plugin dialog directly (it never rides
// pickDataFiles), so the same stubbing applies to it (#1512).
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

// Hoisted so the ArtifactView mock factory below can read it at import time.
// The probe's recovered flag lets a test flip the crash off, so the
// post-retry remount renders the stub instead of re-throwing.
const { BAD_ARTIFACT_PATH, artifactProbe } = vi.hoisted(() => ({
  BAD_ARTIFACT_PATH: "C:/artifacts/out/bad.md",
  artifactProbe: { recovered: false },
}));

// The artifact stage is replaced with a crash probe (issue #1212): the real
// ArtifactView degrades every data-level failure internally (the render
// matrix's fallback face), so only a mocked render throw can exercise the
// pane's face boundary. The matching path throws until the probe recovers;
// every other file renders a stub the assertions can anchor on.
vi.mock("../../components/thread/ArtifactView", () => ({
  ArtifactView: function ArtifactView({
    artifact,
  }: {
    artifact: { path: string; file_name: string };
  }) {
    if (artifact.path === BAD_ARTIFACT_PATH && !artifactProbe.recovered) {
      throw new Error("artifact render crash");
    }
    return <div data-testid="artifact-stub">{artifact.file_name}</div>;
  },
}));

const SID = "sid-1";

// The pending approval entry riding the app-level approval channel (the map
// slice the pane hands the real hook as its approvals prop): req-1 suspended
// on the gate with one capped broadcast attachment. useTurnFlow merges it
// into the live turn's trailing rows, so the card renders inside the rail.
function pendingApprovalEntry(): ApprovalEntry {
  return {
    requestId: "req-1",
    server: "CLI",
    tool: "code-runner",
    operationKind: "execute",
    summary: "run /tmp/x.py",
    fileAttachments: [{ param: "code", content: "print(1)" }],
    receivedAt: 0,
    status: { kind: "pending" },
  };
}

const noop = () => {};

// The default session-api posture every describe re-stamps: an empty session
// (no thread, no working set, no notices, every artifact present) with an
// ask that never settles. Re-stamping in each beforeEach also drops a prior
// test's conversation override.
function stubSessionApis() {
  vi.mocked(conversation).mockResolvedValue([]);
  vi.mocked(listWorkingSet).mockResolvedValue([]);
  vi.mocked(activeDataset).mockResolvedValue(null);
  vi.mocked(takeSourceNotices).mockResolvedValue([]);
  vi.mocked(listSkills).mockResolvedValue({
    skills: [],
    ignored: [],
    root_error: null,
  });
  vi.mocked(artifactExists).mockResolvedValue(true);
  vi.mocked(getApprovalAttachments).mockResolvedValue([]);
  vi.mocked(askQuestion).mockImplementation(() => new Promise(() => {}));
}

// Empty-catalog English IntlProvider (the TraceView test convention):
// FormattedMessage falls back to defaultMessage, so assertions anchor on
// stable English strings.
function renderPane(opts?: {
  approvals?: ApprovalEntry[];
  thread?: ThreadEntry[];
  pendingIngestPaths?: string[];
  onSeedDraft?: (sid: string, question: string) => void;
  onSeedInvocations?: (sid: string, names: string[]) => void;
  onStageQuote?: (sid: string, text: string) => void;
}) {
  if (opts?.thread) {
    vi.mocked(conversation).mockResolvedValue(opts.thread);
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const respond = vi.fn();
  const approvalEvents = {
    approvalsBySession: new Map([[SID, opts?.approvals ?? []]]),
    pendingApprovalSids: new Set<string>(),
    respond,
    clearSession: vi.fn(),
    settleSession: vi.fn(),
  };
  // The ADR-0092 composer-fields report: capturing the reported handlers
  // lets a test fire the pane's OWN handleAsk (the bar's real fire path is
  // shell-level, out of this tree).
  let composerFields: ComposerSessionFields | null = null;
  // A factory, not an element: a rerender must hand React a FRESH element --
  // re-rendering the same element reference bails out at the root (identical
  // props), and the hook's state would never be re-consulted.
  const ui = () => (
    <QueryClientProvider client={queryClient}>
      {/* TooltipProvider mounts at the App level above the panes in the real
          tree (the rail card truncation sites use Radix Tooltip). */}
      <TooltipProvider>
        <IntlProvider locale="en" messages={{}} onError={() => {}}>
          <SessionPane
            sessionId={SID}
            isActive
            pendingIngestPaths={opts?.pendingIngestPaths ?? []}
            onIngestConsumed={noop}
            pendingQuestion={null}
            pendingSkillInvocations={[]}
            onQuestionConsumed={noop}
            onSeedDraft={opts?.onSeedDraft ?? noop}
            onSeedInvocations={opts?.onSeedInvocations ?? noop}
            onStageQuote={opts?.onStageQuote ?? noop}
            onComposerFields={(_sid, fields) => {
              composerFields = fields;
            }}
            onComposerFieldsUnmount={noop}
            sessionName=""
            onFirstTurnSettled={noop}
            approvalEvents={approvalEvents}
            recipePath="C:/sessions/sid-1.json"
            onRename={noop}
            onClose={noop}
            onDelete={noop}
          />
        </IntlProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
  // The ask fires the pane's reported handleAsk while askQuestion hangs, so
  // the live turn mounts and stays in flight (void: the promise never
  // settles; act flushes the synchronous commitLive render).
  const ask = () => {
    void composerFields!.handleAsk("q");
  };
  return { ...render(ui()), ui, queryClient, respond, ask, getComposerFields: () => composerFields };
}

// Open a delivered file through its rail artifact card (the real selection
// path: the click moves viewedResult + expands the right sidebar).
async function openArtifact(fileName: string) {
  const name = `Open ${fileName} in the right sidebar`;
  fireEvent.click(await screen.findByRole("button", { name }));
}

describe("SessionPane approval wiring", () => {
  beforeEach(stubSessionApis);

  it("threads the full-view loader to the pending card with the pane's session id", async () => {
    vi.mocked(getApprovalAttachments).mockResolvedValue([
      { param: "code", content: "print(1); print(2)" },
    ]);
    const view = renderPane({ approvals: [pendingApprovalEntry()] });
    await act(async () => {
      view.ask();
    });
    fireEvent.click(screen.getByRole("button", { name: "View file values (1)" }));
    expect(getApprovalAttachments).toHaveBeenCalledWith(SID, "req-1");
    expect(await screen.findByText("print(1); print(2)")).toBeInTheDocument();
  });

  it("binds the respond callback to the pane's session id", async () => {
    const view = renderPane({ approvals: [pendingApprovalEntry()] });
    await act(async () => {
      view.ask();
    });
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(view.respond).toHaveBeenCalledWith(SID, "req-1", "allow_once");
  });
});

// The artifact stage's render-crash partition (issue #1212): the file face
// carries its own ErrorBoundary so a crash inside the stage degrades ONLY
// that face, and the boundary rides the path key so switching files resets a
// crash degrade instead of pinning the next file to the previous one's card.
describe("SessionPane artifact stage boundary", () => {
  beforeEach(() => {
    stubSessionApis();
    artifactProbe.recovered = false;
  });

  it("degrades only the artifact face when its render crashes -- the thread rail keeps rendering", async () => {
    renderPane({
      thread: [artifactTurn([BAD_ARTIFACT_PATH])],
    });
    await openArtifact("bad.md");

    const card = screen.getByRole("alert");
    expect(card).toHaveAttribute("data-region", "artifact");
    // The artifact card rides the same rail: the crash did not reach it.
    expect(
      screen.getByRole("button", { name: "Open bad.md in the right sidebar" }),
    ).toBeInTheDocument();
  });

  it("renders another artifact normally after a crash -- the path key resets the boundary", async () => {
    renderPane({
      thread: [artifactTurn([BAD_ARTIFACT_PATH, "C:/artifacts/out/good.md"])],
    });
    await openArtifact("bad.md");
    expect(screen.getByRole("alert")).toHaveAttribute("data-region", "artifact");

    // Selecting the other delivered file remounts the keyed boundary: file
    // B renders and file A's degrade card is gone (with the key left on the
    // child, the boundary's error state would survive the switch and pin B
    // to A's card).
    await openArtifact("good.md");

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("artifact-stub")).toHaveTextContent("good.md");
  });

  it("drops the file's exists/text cache entries on retry and remounts clean", async () => {
    const { queryClient } = renderPane({
      thread: [artifactTurn([BAD_ARTIFACT_PATH])],
    });
    await openArtifact("bad.md");
    // Seed both per-path entries so the drop assertion discriminates: an
    // unseeded cache is already empty and the removal would pass vacuously.
    queryClient.setQueryData(artifactKeys.exists(BAD_ARTIFACT_PATH), true);
    queryClient.setQueryData(artifactKeys.text(BAD_ARTIFACT_PATH), "# poisoned");

    // Flip the probe BEFORE the click: the boundary's retry runs onReset
    // (the synchronous cache drop) before clearing the error, so the
    // remounted view must find the entries already gone and render.
    artifactProbe.recovered = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(
      queryClient.getQueryState(artifactKeys.exists(BAD_ARTIFACT_PATH)),
    ).toBeUndefined();
    expect(
      queryClient.getQueryState(artifactKeys.text(BAD_ARTIFACT_PATH)),
    ).toBeUndefined();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("artifact-stub")).toHaveTextContent("bad.md");
  });
});

// The follow pill's pane face (#1307): the paused posture's visible exit.
// The hook-level pins (useRailFollow suite) cover the machine's re-arm; here
// the pill's render gate rides the real rail element -- jsdom has no layout,
// so the pause is staged by stubbing the rail's geometry and dispatching the
// scroll event by hand (the same rig the hook suite uses).
describe("SessionPane right-sidebar panel postures", () => {
  beforeEach(stubSessionApis);

  // #1323: the file-kind panel retires as a scroll container (the stage
  // scrolls internally); every other kind keeps the edge-docked scrolling
  // posture. jsdom does no layout, so the pin is the class itself -- the
  // rendered-DOM utility convention, not the rejected CSS-rule seam.
  it("gives the file stage the overflow-hidden breakout posture", async () => {
    renderPane({
      thread: [artifactTurn(["C:/artifacts/out/report.md"])],
    });
    await openArtifact("report.md");

    expect(screen.getByRole("tabpanel").className).toContain("overflow-hidden");
  });

  it("keeps non-file content on the scrolling breakout posture", () => {
    renderPane();

    expect(screen.getByRole("tabpanel").className).toContain("overflow-y-auto");
  });
});

describe("SessionPane follow pill", () => {
  beforeEach(stubSessionApis);

  // The hook's align write lands inside a rAF callback; awaiting one frame
  // flushes every queued align deterministically (the hook suite stubs the
  // scheduler outright -- here the real jsdom timer is close enough, since
  // only ordering matters).
  async function flushAlign() {
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
  }

  function stageRailGeometry(rail: HTMLElement) {
    // scrollHeight=1000, clientHeight=300 -> maxScroll=700 (bottom).
    const geo = { scrollHeight: 1000, clientHeight: 300 };
    Object.defineProperty(rail, "scrollHeight", {
      configurable: true,
      get: () => geo.scrollHeight,
    });
    Object.defineProperty(rail, "clientHeight", {
      configurable: true,
      get: () => geo.clientHeight,
    });
    let top = 0;
    Object.defineProperty(rail, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
    return {
      userScrollTo: (v: number) => {
        top = v;
      },
      scrollTop: (): number => top,
    };
  }

  it("is absent while following and appears when the rail pauses", async () => {
    renderPane();
    const rail = document.querySelector(".session-rail") as HTMLElement;
    const rig = stageRailGeometry(rail);
    await flushAlign();

    const pill = screen.queryByRole("button", { name: "Jump to latest" });
    expect(pill).not.toBeInTheDocument();

    // Wheel up past the band: the machine pauses, the pill is the exit.
    rig.userScrollTo(100);
    act(() => {
      rail.dispatchEvent(new Event("scroll"));
    });
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();
  });

  it("lands the bottom on click and the machine resumes (the pill leaves)", async () => {
    renderPane();
    const rail = document.querySelector(".session-rail") as HTMLElement;
    const rig = stageRailGeometry(rail);
    await flushAlign();

    rig.userScrollTo(100);
    act(() => {
      rail.dispatchEvent(new Event("scroll"));
    });
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    await flushAlign();
    expect(rig.scrollTop()).toBe(700);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).not.toBeInTheDocument();
  });
});

// The #1485 pane-level regression: the rail's fresh-session hint gated only on
// thread/liveTurn, so a large file mid-import kept the hint under the
// executing import's progress card -- "load data to begin" while a load IS
// running. The same contradiction #297 fixed for the live turn; the hint now
// gates on the ingest block too.
describe("SessionPane rail hint vs an in-flight ingest", () => {
  const RAIL_EMPTY =
    "No conversations yet. Ask a question below or load data to begin.";
  const loadedDataset: DatasetDescriptor = {
    reference_name: "people",
    display_name: "people",
    source_path: "/x/big.csv",
    row_count: 1,
    fingerprint: "ff".repeat(32),
    size_bytes: 0,
    columns: [{ name: "id", canonical_type: "BIGINT" }],
    sample: [["1"]],
    rectify: { kind: "NotApplicable" },
    privacy: { send_samples: true, type_only_columns: [] },
  };

  beforeEach(() => {
    stubSessionApis();
    vi.mocked(ingestFile).mockResolvedValue({ kind: "Loaded", data: loadedDataset });
  });

  it("hides the hint while the import executes and restores it once the batch settles", async () => {
    // The executing window: a deferred ingestFile holds the batch in flight,
    // so the progress block is mounted with a still-empty thread.
    let resolveIngest!: (outcome: { kind: "Loaded"; data: DatasetDescriptor }) => void;
    vi.mocked(ingestFile).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveIngest = resolve;
        }),
    );
    renderPane({ pendingIngestPaths: ["/x/big.csv"] });

    const block = await screen.findByRole("status");
    expect(block).toHaveTextContent("big.csv");
    expect(screen.queryByText(RAIL_EMPTY)).not.toBeInTheDocument();

    // Settle the file: the block clears in the segment's exit path and the
    // hint legitimately returns -- the load finished, the thread is still
    // empty (the ingest never appends to it).
    await act(async () => {
      resolveIngest({ kind: "Loaded", data: loadedDataset });
    });
    expect(await screen.findByText(RAIL_EMPTY)).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

// Issue #1500: the composer question's queue behind an in-flight ingest
// batch, exercised through the real wiring -- the shell-reported fields
// (handleIngestFiles = the tracked ingestMany, handleAsk = the queue-aware
// fire) and the pane's own seed-back props.
describe("SessionPane composer queue behind an in-flight ingest (#1500)", () => {
  const heldQuestion = "queued while loading";
  const loadedDataset: DatasetDescriptor = {
    reference_name: "people",
    display_name: "people",
    source_path: "/x/big.csv",
    row_count: 1,
    fingerprint: "ff".repeat(32),
    size_bytes: 0,
    columns: [{ name: "id", canonical_type: "BIGINT" }],
    sample: [["1"]],
    rectify: { kind: "NotApplicable" },
    privacy: { send_samples: true, type_only_columns: [] },
  };

  beforeEach(() => {
    stubSessionApis();
    // The shared api mocks keep call history across this file's describes
    // (stubSessionApis re-stamps implementations, not the call log) -- drop
    // the earlier describes' askQuestion calls before the not-called asserts.
    vi.mocked(askQuestion).mockClear();
    vi.mocked(ingestFile).mockResolvedValue({ kind: "Loaded", data: loadedDataset });
  });

  it("queues the submit while the batch runs and auto-sends the held question on full load", async () => {
    // The executing window: a deferred ingestFile holds the batch in flight.
    let resolveIngest!: (outcome: { kind: "Loaded"; data: DatasetDescriptor }) => void;
    vi.mocked(ingestFile).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveIngest = resolve;
        }),
    );
    const view = renderPane();

    // Arm the batch through the shell-reported manual path, then submit
    // through the bar's fire.
    act(() => {
      void view.getComposerFields()!.handleIngestFiles(["/x/big.csv"]);
    });
    await act(async () => {
      void view.getComposerFields()!.handleAsk(heldQuestion);
    });

    // The queued posture rides the report; the ask has not fired.
    expect(view.getComposerFields()!.queued).toBe(true);
    expect(askQuestion).not.toHaveBeenCalled();

    // The batch fully loads -> the held question auto-sends as a turn.
    await act(async () => {
      resolveIngest({ kind: "Loaded", data: loadedDataset });
    });
    await waitFor(() => expect(askQuestion).toHaveBeenCalledWith(SID, heldQuestion, []));
    expect(view.getComposerFields()!.queued).toBe(false);
  });

  it("seeds the held question and invocations back when the batch halts", async () => {
    const onSeedDraft = vi.fn();
    const onSeedInvocations = vi.fn();
    // A deferred ingestFile holds the batch in flight across the submit --
    // an immediately-resolving mock would settle the batch inside the arming
    // act, before the submit could land in the slot.
    let rejectIngest!: (outcome: LoadOutcome) => void;
    vi.mocked(ingestFile).mockImplementation(
      () =>
        new Promise((resolve) => {
          rejectIngest = resolve;
        }),
    );
    const view = renderPane({ onSeedDraft, onSeedInvocations });

    act(() => {
      void view.getComposerFields()!.handleIngestFiles(["/x/bad.csv"]);
    });
    await act(async () => {
      void view.getComposerFields()!.handleAsk(heldQuestion, ["skill-a"]);
    });
    expect(view.getComposerFields()!.queued).toBe(true);

    // The file errors -> terminal halt -> the #991 atomic rollback channels:
    // the question AND the staged names return; nothing auto-sends.
    await act(async () => {
      rejectIngest({ kind: "Error", data: { kind: "Parse", data: { detail: "bad csv" } } });
    });
    await waitFor(() => expect(onSeedDraft).toHaveBeenCalledWith(SID, heldQuestion));
    expect(onSeedInvocations).toHaveBeenCalledWith(SID, ["skill-a"]);
    expect(askQuestion).not.toHaveBeenCalled();
    expect(view.getComposerFields()!.queued).toBe(false);
  });

  it("queues a submit behind a batch armed from the working-set tab's add entry", async () => {
    // Review Important 1 (#1500): the empty working-set card's add entry
    // must arm the TRACKED batch -- a submit during that window queues
    // visibly, never the pre-fix silent backend-lock queue.
    let resolveIngest!: (outcome: { kind: "Loaded"; data: DatasetDescriptor }) => void;
    vi.mocked(ingestFile).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveIngest = resolve;
        }),
    );
    vi.mocked(pickDataFiles).mockResolvedValue(["/x/big.csv"]);
    const view = renderPane();

    // Arm through the real card path: switch to the working-set tab (its
    // panel is hidden at mount) and pick through the empty card's button.
    fireEvent.click(screen.getByRole("tab", { name: "Working set" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add data file" }));
    });

    // The submit lands in the slot; the ask has not fired.
    await act(async () => {
      void view.getComposerFields()!.handleAsk(heldQuestion);
    });
    expect(view.getComposerFields()!.queued).toBe(true);
    expect(askQuestion).not.toHaveBeenCalled();

    // The batch fully loads -> the held question auto-sends as a turn.
    await act(async () => {
      resolveIngest({ kind: "Loaded", data: loadedDataset });
    });
    await waitFor(() => expect(askQuestion).toHaveBeenCalledWith(SID, heldQuestion, []));
    expect(view.getComposerFields()!.queued).toBe(false);
  });
});

// Issue #1512: a source replace is the other long IPC that holds the backend
// session lock, so its verdict flight arms the SAME queue window -- armed
// through the pane's armReplace composition when the working-set seam
// fires. The rail's replace progress line rides the same flight.
describe("SessionPane composer queue behind an in-flight replace (#1512)", () => {
  const heldQuestion = "queued while replacing";
  const replaceDataset: DatasetDescriptor = {
    reference_name: "people",
    display_name: "people",
    source_path: "/x/big.csv",
    row_count: 1,
    fingerprint: "ff".repeat(32),
    size_bytes: 0,
    columns: [{ name: "id", canonical_type: "BIGINT" }],
    sample: [["1"]],
    rectify: { kind: "NotApplicable" },
    privacy: { send_samples: true, type_only_columns: [] },
  };
  const EMPTY_PAGE = {
    columns: [{ name: "id", canonical_type: "BIGINT" }],
    rows: [],
    total: 0,
    offset: 0,
    limit: 20,
  };
  // The rail's empty-thread hint text: the tests below pin that the replace
  // line's conjunct hides it (the #297 contradiction, replace half of the
  // ingest twin's pin above). Same string as the ingest describe.
  const RAIL_EMPTY =
    "No conversations yet. Ask a question below or load data to begin.";

  beforeEach(() => {
    stubSessionApis();
    vi.mocked(askQuestion).mockClear();
    // The replace targets an EXISTING row, so the panel renders the working
    // set with it (and its preview query must answer instead of crashing on
    // the un-stubbed read).
    vi.mocked(listWorkingSet).mockResolvedValue([replaceDataset]);
    vi.mocked(activeDataset).mockResolvedValue(replaceDataset);
    vi.mocked(readRows).mockResolvedValue(EMPTY_PAGE);
  });

  it("queues the submit behind the replace flight, shows the rail line, and auto-sends on Loaded", async () => {
    let resolveReplace!: (outcome: LoadOutcome) => void;
    vi.mocked(replaceSource).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReplace = resolve;
        }),
    );
    vi.mocked(open).mockResolvedValue("/x/new.csv");
    const view = renderPane();

    // Positive control for the empty-rail assert below: the thread starts
    // empty, so the hint IS rendering before the replace arms.
    expect(await screen.findByText(RAIL_EMPTY)).toBeInTheDocument();

    // Arm through the real row path: switch to the working-set tab and fire
    // the row's replace action through the dialog stub.
    fireEvent.click(screen.getByRole("tab", { name: "Working set" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Replace source people" })),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Replace source people" }));
    });

    // The rail names the swap and the clock while the flight holds.
    expect(screen.getByRole("status")).toHaveTextContent(
      "Replacing people with new.csv…",
    );
    // The replace line's conjunct keeps the empty-thread hint hidden for its
    // whole flight (the #297 contradiction, pinned for the other long IPC at
    // the ingest describe above).
    expect(screen.queryByText(RAIL_EMPTY)).not.toBeInTheDocument();

    await act(async () => {
      void view.getComposerFields()!.handleAsk(heldQuestion);
    });
    expect(view.getComposerFields()!.queued).toBe(true);
    expect(askQuestion).not.toHaveBeenCalled();

    // The swap lands -> the flight verdict true -> auto-send, and the rail
    // line clears with the settle (asserted by text: the auto-sent turn's
    // own wait-status line is a second role="status" element, so the role
    // query never returns to null).
    await act(async () => {
      resolveReplace({ kind: "Loaded", data: replaceDataset });
    });
    await waitFor(() => expect(askQuestion).toHaveBeenCalledWith(SID, heldQuestion, []));
    expect(view.getComposerFields()!.queued).toBe(false);
    await waitFor(() =>
      expect(screen.queryByText("Replacing people with new.csv…")).toBeNull(),
    );
  });

  it("seeds the held question back when the replace errors", async () => {
    let resolveReplace!: (outcome: LoadOutcome) => void;
    const onSeedDraft = vi.fn();
    const onSeedInvocations = vi.fn();
    vi.mocked(replaceSource).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReplace = resolve;
        }),
    );
    vi.mocked(open).mockResolvedValue("/x/new.csv");
    const view = renderPane({ onSeedDraft, onSeedInvocations });

    fireEvent.click(screen.getByRole("tab", { name: "Working set" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Replace source people" })),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Replace source people" }));
    });
    await act(async () => {
      void view.getComposerFields()!.handleAsk(heldQuestion, ["skill-a"]);
    });
    expect(view.getComposerFields()!.queued).toBe(true);

    // The swap errors -> the verdict false -> the halt exit returns the
    // question AND the staged invocations; nothing auto-sends.
    await act(async () => {
      resolveReplace({ kind: "Error", data: { kind: "Parse", data: { detail: "bad csv" } } });
    });
    await waitFor(() => expect(onSeedDraft).toHaveBeenCalledWith(SID, heldQuestion));
    expect(onSeedInvocations).toHaveBeenCalledWith(SID, ["skill-a"]);
    expect(askQuestion).not.toHaveBeenCalled();
    expect(view.getComposerFields()!.queued).toBe(false);
    // The failure settle clears the rail line too (the failure-clear half of
    // the brief's settle-clear acceptance).
    await waitFor(() =>
      expect(screen.queryByText("Replacing people with new.csv…")).toBeNull(),
    );
    // And with the line cleared and the thread still empty, the hint
    // legitimately returns (the settle half of the empty-rail gate).
    expect(await screen.findByText(RAIL_EMPTY)).toBeInTheDocument();
  });
});

// Issue #1503: the ask-again sink (the rail's Failed/Cancelled retry, the
// stale banner's rerun) routes through the queue-aware fire. Outside a batch
// that IS the direct fire -- bit-identical to the pre-#1503 behavior
// (handleAsk normalizes the invocations to [] on both paths, so the
// askQuestion layer cannot tell them apart). Mid-batch the UI's busy gate
// holds the buttons, so the in-slot semantics live in the useComposerQueue
// suite; this pin keeps the pane's wiring on the queue-aware sink.
describe("SessionPane ask-again fire path (#1503)", () => {
  beforeEach(() => {
    stubSessionApis();
    vi.mocked(askQuestion).mockClear();
  });

  it("fires the rail retry as the direct fire when no batch is in flight", async () => {
    const view = renderPane({ thread: [failed("坏查询")] });

    // The thread query is async -- wait for the Failed card's retry action,
    // then fire: the ask carries the verbatim question, no slot engaged.
    fireEvent.click(await screen.findByRole("button", { name: "Retry this question" }));
    await waitFor(() => expect(askQuestion).toHaveBeenCalledWith(SID, "坏查询", []));
    expect(view.getComposerFields()!.queued).toBe(false);
  });
});

// The toggle's two posture mounts (the transit-shell PR's core conditional
// rendering): folded -> the session header's right edge; expanded -> the
// tab-row's right cluster. Exactly one instance exists at any time, and a
// keyboard toggle keeps focus across the swap (the focus hand-off to the
// surviving instance) -- the pre-calibration single mount never dropped it.
// Placement pins ride document order, the same shape as the error-banner
// relocation pin in App.test.tsx.
describe("right-sidebar toggle placement", () => {
  it("mounts in the session header while folded and moves into the tab row when expanded, exactly one at a time, keeping focus", async () => {
    const { container } = renderPane();
    const header = container.querySelector(".session-header");
    const tabRow = container.querySelector(".right-sidebar-tabs");
    expect(header).not.toBeNull();
    expect(tabRow).not.toBeNull();

    // Folded cold start: the toggle lives in the header.
    const foldedToggle = screen.getByRole("button", { name: "Expand right sidebar" });
    expect(header!.contains(foldedToggle)).toBe(true);
    expect(tabRow!.contains(foldedToggle)).toBe(false);

    // Expand: the fresh instance lands in the tab-row cluster.
    fireEvent.click(foldedToggle);
    const expandedToggle = await screen.findByRole("button", { name: "Collapse right sidebar" });
    expect(tabRow!.contains(expandedToggle)).toBe(true);
    expect(header!.contains(expandedToggle)).toBe(false);
    expect(container.querySelectorAll(".right-sidebar-toggle")).toHaveLength(1);

    // Fold back: the focus follows the surviving header instance.
    fireEvent.click(expandedToggle);
    const refoldedToggle = await screen.findByRole("button", { name: "Expand right sidebar" });
    await waitFor(() => expect(refoldedToggle).toHaveFocus());
    expect(container.querySelectorAll(".right-sidebar-toggle")).toHaveLength(1);
  });
});

describe("selection toolbar copy (#1573)", () => {
  beforeEach(stubSessionApis);

  afterEach(() => {
    document.getSelection()?.removeAllRanges();
  });

  // Stage a live selection over the thread's marked prose and release the
  // gesture (the release path requires the window to have seen a
  // selectionchange -- the machine harness's shape), then hand back the
  // toolbar.
  function appearToolbar(): HTMLElement | null {
    const prose = document.querySelector(".round-text");
    if (prose === null) return null;
    const range = document.createRange();
    range.selectNodeContents(prose);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const conversation = document.querySelector(".session-conversation");
    if (conversation === null) return null;
    fireEvent.pointerDown(conversation, { button: 0 });
    fireEvent(document, new Event("selectionchange"));
    fireEvent.pointerUp(conversation, { button: 0 });
    return document.querySelector("[data-selection-toolbar]");
  }

  function copyButton(toolbar: HTMLElement): HTMLElement {
    const button = [...toolbar.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Copy"),
    );
    return button as HTMLElement;
  }

  it("copies on success: writes, then dismisses and clears the selection", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderPane({ thread: [textual("copy this passage")] });
    await screen.findByText("copy this passage");
    const toolbar = appearToolbar();
    expect(toolbar).not.toBeNull();
    fireEvent.click(copyButton(toolbar as HTMLElement));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("copy this passage"));
    // The WorkBuddy shape rode the success leg: the toolbar leaves and the
    // selection clears.
    expect(document.querySelector("[data-selection-toolbar]")).toBeNull();
    expect(document.getSelection()?.isCollapsed ?? true).toBe(true);
  });

  it("keeps the toolbar when the clipboard write fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    renderPane({ thread: [textual("failing passage")] });
    await screen.findByText("failing passage");
    const toolbar = appearToolbar();
    expect(toolbar).not.toBeNull();
    fireEvent.click(copyButton(toolbar as HTMLElement));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("failing passage"));
    await waitFor(() => expect(warn).toHaveBeenCalled());
    // Nothing was copied, so nothing may close.
    expect(document.querySelector("[data-selection-toolbar]")).not.toBeNull();
    warn.mockRestore();
  });
});
