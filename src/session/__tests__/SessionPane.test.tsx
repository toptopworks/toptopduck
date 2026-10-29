import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
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
  listSkills,
  listWorkingSet,
  takeSourceNotices,
} from "../../api";
import { TooltipProvider } from "../../components/ui/tooltip";
import { textual } from "./fixtures";
import type { ComposerSessionFields } from "../useComposerState";
import type { ApprovalEntry } from "../useApprovalEvents";
import type { ThreadEntry, TurnRecord } from "../../types/thread";

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
    // The runtime read defaults to the failed-read degrade (no marker
    // stamped) -- the same default the useTurnFlow suite pins against.
    getSessionRuntime: vi.fn(async () => undefined),
    cancelQuery: vi.fn(async () => {}),
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

// A recorded turn whose outcome delivered an artifact manifest entry per
// file (ADR-0124): the rail renders one clickable artifact card per entry,
// and a click moves the real viewedResult onto the file view through the
// pane's handleSelectFile -- the same path a user takes.
function artifactThread(
  files: { path: string; fileName: string }[],
): ThreadEntry[] {
  const record = textual("files").data as TurnRecord;
  return [
    {
      entry: "Turn",
      data: {
        ...record,
        artifacts: files.map((f) => ({ path: f.path, file_name: f.fileName })),
      },
    },
  ];
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
  vi.mocked(listSkills).mockResolvedValue({ skills: [] } as never);
  vi.mocked(artifactExists).mockResolvedValue(true);
  vi.mocked(askQuestion).mockImplementation(() => new Promise(() => {}));
}

// Empty-catalog English IntlProvider (the TraceView test convention):
// FormattedMessage falls back to defaultMessage, so assertions anchor on
// stable English strings.
function renderPane(opts?: {
  approvals?: ApprovalEntry[];
  thread?: ThreadEntry[];
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
            pendingIngestPaths={[]}
            onIngestConsumed={noop}
            pendingQuestion={null}
            pendingSkillInvocations={[]}
            onQuestionConsumed={noop}
            onSeedDraft={noop}
            onSeedInvocations={noop}
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
  return { ...render(ui()), ui, queryClient, respond, ask };
}

// Open a delivered file through its rail artifact card (the real selection
// path: the click moves viewedResult + expands the workspace).
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
      thread: artifactThread([{ path: BAD_ARTIFACT_PATH, fileName: "bad.md" }]),
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
      thread: artifactThread([
        { path: BAD_ARTIFACT_PATH, fileName: "bad.md" },
        { path: "C:/artifacts/out/good.md", fileName: "good.md" },
      ]),
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
      thread: artifactThread([{ path: BAD_ARTIFACT_PATH, fileName: "bad.md" }]),
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
describe("SessionPane workspace panel postures", () => {
  beforeEach(stubSessionApis);

  // #1323: the file-kind panel retires as a scroll container (the stage
  // scrolls internally); every other kind keeps the edge-docked scrolling
  // posture. jsdom does no layout, so the pin is the class itself -- the
  // rendered-DOM utility convention, not the rejected CSS-rule seam.
  it("gives the file stage the overflow-hidden breakout posture", async () => {
    renderPane({
      thread: artifactThread([
        { path: "C:/artifacts/out/report.md", fileName: "report.md" },
      ]),
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
