import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SessionPane } from "../SessionPane";
import { useSessionState } from "../useSessionState";
import { artifactKeys } from "../queryKeys";
import { getApprovalAttachments, listSkills } from "../../api";
import { TooltipProvider } from "../../components/ui/tooltip";
import type { LiveTurn } from "../useTurnFlow";

// The pane-level approval wiring pins (issue #1009 review, PR #1010): both
// approval callbacks live ONLY on the pane -- the respond callback binds the
// pane's sessionId onto the approval channel's respond, and the loader
// closes it over getApprovalAttachments. Thread-level tests hand the props
// in directly, so nothing else observed this pass-through: a dropped prop
// or a mis-bound id would silently degrade the card (the no-loader branch
// renders exactly the #672 capped behavior with no error note). The data
// layer (useSessionState) is mocked to one pending approval card -- the pin
// is the pane's own wiring, exercised through the real Thread surface.

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    getApprovalAttachments: vi.fn(),
    listSkills: vi.fn(),
  };
});

vi.mock("../useSessionState", () => ({
  useSessionState: vi.fn(),
}));

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

// One pending approval card riding the live turn (the same shape Thread's
// full-chain test uses): req-1 suspended on the gate with one capped
// broadcast attachment.
function liveTurnWithPendingApproval(): LiveTurn {
  return {
    question: "q",
    askedAt: 0,
    invocationNames: [],
    step: 1,
    rounds: [
      {
        rows: [
          {
            key: "req-1",
            name: "code-runner",
            server: "CLI",
            operationKind: "execute",
            summary: "run /tmp/x.py",
            approval: {
              requestId: "req-1",
              response: null,
              fileAttachments: [{ param: "code", content: "print(1)" }],
            },
            running: false,
            success: null,
            resultExcerpt: "",
          },
        ],
      },
    ],
  } as unknown as LiveTurn;
}

const noop = () => {};

// The full useSessionState return the pane consumes, minimized to the
// pending-approval posture: an empty recorded thread, the live card, and
// no-op handlers -- the pane's own callbacks are what is under test, and
// the never-rendered handlers (workspace tab, dialogs) are never invoked.
// The workspace content is parameterizable so the stage-face tests can
// select the file branch; the shared default mock stays zero-arg because
// the pane's real call passes the session id as the first argument.
function paneSessionStateWithWorkspace(workspaceContent: unknown): never {
  return {
    thread: [],
    liveTurn: liveTurnWithPendingApproval(),
    workspaceCollapsed: false,
    turnLoading: false,
    phase: "idle",
    handleAsk: vi.fn(),
    handleCancel: vi.fn(),
    handleIngestMany: vi.fn(),
    handleToggleWorkspace: vi.fn(),
    viewedResult: null,
    datasets: [],
    staleByReference: new Map(),
    activeName: null,
    loading: false,
    error: null,
    persistError: null,
    haltedRemaining: null,
    guidance: null,
    guidanceError: null,
    fetchGuidanceWindow: vi.fn(),
    handleGuidedSubmit: vi.fn(),
    handleGuidedCancel: vi.fn(),
    handleSelectResult: vi.fn(),
    handleJumpToLatest: vi.fn(),
    handleRetryQueries: vi.fn(),
    // ADR-0123: the working-set seam's reporting sinks, handed through the
    // pane to the tab. The `as never` cast bypasses type checking, so a
    // shape change here must be mirrored by hand.
    mutationSurfaces: {
      setError: vi.fn(),
      setMutationLoading: vi.fn(),
      pollPersistError: vi.fn(async () => {}),
    },
    queryErrors: [],
    workspaceContent,
  } as never;
}

function paneSessionState(): never {
  return paneSessionStateWithWorkspace({ kind: "hero" });
}

// Empty-catalog English IntlProvider (the TraceView test convention):
// FormattedMessage falls back to defaultMessage, so assertions anchor on
// stable English strings.
function renderPane() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const respond = vi.fn();
  const approvalEvents = {
    approvalsBySession: new Map(),
    pendingApprovalSids: new Set<string>(),
    respond,
    clearSession: vi.fn(),
  };
  // A factory, not an element: a rerender must hand React a FRESH element --
  // re-rendering the same element reference bails out at the root (identical
  // props), and the mocked useSessionState would never be re-consulted.
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
            onComposerFields={noop}
            onComposerFieldsUnmount={noop}
            sessionName=""
            onFirstTurnSettled={noop}
            approvalEvents={approvalEvents}
            duckPath="C:/sessions/sid-1.duck"
            onRename={noop}
            onClose={noop}
            onDelete={noop}
          />
        </IntlProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
  return { ...render(ui()), ui, queryClient, respond };
}

describe("SessionPane approval wiring", () => {
  beforeEach(() => {
    vi.mocked(useSessionState).mockImplementation(paneSessionState);
    vi.mocked(listSkills).mockResolvedValue({ skills: [] } as never);
  });

  it("threads the full-view loader to the pending card with the pane's session id", async () => {
    vi.mocked(getApprovalAttachments).mockResolvedValue([
      { param: "code", content: "print(1); print(2)" },
    ]);
    renderPane();
    fireEvent.click(screen.getByRole("button", { name: "View file values (1)" }));
    expect(getApprovalAttachments).toHaveBeenCalledWith(SID, "req-1");
    expect(await screen.findByText("print(1); print(2)")).toBeInTheDocument();
  });

  it("binds the respond callback to the pane's session id", () => {
    const { respond } = renderPane();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(respond).toHaveBeenCalledWith(SID, "req-1", "allow_once");
  });
});

// The artifact stage's render-crash partition (issue #1212): the file face
// carries its own ErrorBoundary so a crash inside the stage degrades ONLY
// that face, and the boundary rides the path key so switching files resets a
// crash degrade instead of pinning the next file to the previous one's card.
describe("SessionPane artifact stage boundary", () => {
  beforeEach(() => {
    vi.mocked(useSessionState).mockImplementation(paneSessionState);
    vi.mocked(listSkills).mockResolvedValue({ skills: [] } as never);
    artifactProbe.recovered = false;
  });

  const fileContent = (path: string, fileName: string) => ({
    kind: "file",
    path,
    fileName,
    render: "markdown",
  });

  it("degrades only the artifact face when its render crashes -- the thread rail keeps rendering", () => {
    vi.mocked(useSessionState).mockImplementation(() =>
      paneSessionStateWithWorkspace(fileContent(BAD_ARTIFACT_PATH, "bad.md")),
    );
    renderPane();

    const card = screen.getByRole("alert");
    expect(card).toHaveAttribute("data-region", "artifact");
    // The live card rides the same fixture: the crash did not reach the rail.
    expect(screen.getByRole("button", { name: "Allow once" })).toBeInTheDocument();
  });

  it("renders another artifact normally after a crash -- the path key resets the boundary", () => {
    vi.mocked(useSessionState).mockImplementation(() =>
      paneSessionStateWithWorkspace(fileContent(BAD_ARTIFACT_PATH, "bad.md")),
    );
    const view = renderPane();
    expect(screen.getByRole("alert")).toHaveAttribute("data-region", "artifact");

    // Switching the viewed file remounts the keyed boundary: file B renders
    // and file A's degrade card is gone (with the key left on the child, the
    // boundary's error state would survive the switch and pin B to A's card).
    vi.mocked(useSessionState).mockImplementation(() =>
      paneSessionStateWithWorkspace(fileContent("C:/artifacts/out/good.md", "good.md")),
    );
    view.rerender(view.ui());

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("artifact-stub")).toHaveTextContent("good.md");
  });

  it("drops the file's exists/text cache entries on retry and remounts clean", () => {
    vi.mocked(useSessionState).mockImplementation(() =>
      paneSessionStateWithWorkspace(fileContent(BAD_ARTIFACT_PATH, "bad.md")),
    );
    const { queryClient } = renderPane();
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
