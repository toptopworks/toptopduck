import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SessionPane } from "../SessionPane";
import { useSessionState } from "../useSessionState";
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
function paneSessionState(): never {
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
    pendingActiveDelete: null,
    handleConfirmActiveDelete: vi.fn(),
    handleCancelActiveDelete: vi.fn(),
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
    workspaceContent: { kind: "hero" },
  } as never;
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
  const ui = (
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
            onExport={noop}
            onClose={noop}
            onDelete={noop}
          />
        </IntlProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
  return { ...render(ui), respond };
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
