import { expect, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { DatasetDescriptor, RowPage } from "../../types/dataset";
import type { ResumeProgress, TurnProgress } from "../../types/session";
import type { ThreadEntry, TurnOutcome } from "../../types/thread";
import type { AppConfig } from "../../types/app-config";
import type { McpServerConfig } from "../../types/mcp";
import type { AdapterEntry, SessionRuntimeChoice } from "../../types/runtime";
import type { SkillListing } from "../../types/skills";
// Type-only: erased at runtime, so it does not re-enter the suite files'
// vi.mock("../api") factories (the "without importing the api module" rule
// below targets runtime imports only).
import type * as Api from "../../api";
import { baseAppConfig as sharedBaseAppConfig } from "../../test-fixtures";

// Shared harness for the shell black-box suites (Shell.shellLayout /
// Shell.sessions / Shell.turnFlow / Shell.resultStage / Shell.windowDnd /
// Shell.composer / Shell.composerSubmit / Shell.chrome).
// Each suite drives the rendered three-column App like a user and asserts
// VISIBLE DOM / structure signals -- never the Query cache internals. The api
// mock factory + the listener captures live here; the vi.mock declarations
// stay in each suite file (vitest hoists them per file).

type ShellState = {
  workingSet: DatasetDescriptor[];
  thread: ThreadEntry[];
};

export type DropCapture = {
  handler: null | ((e: {
    payload: { type: string; paths: string[]; position?: { x: number; y: number } };
  }) => void);
};

type ShellCaptures = {
  state: ShellState;
  turnProgressCb: { current: null | ((ev: TurnProgress) => void) };
  resumeProgressCb: { current: null | ((ev: ResumeProgress) => void) };
};

// The webview drop router capture: the shell mounts a long-lived
// onDragDropEvent listener; tests emit payload events through the captured
// callback (issue #84 bisection / #501 empty-state drops).
// Deliberately NOT reconciled against the real webviewWindow module surface
// (unlike the api factory below): the real getCurrentWebviewWindow returns
// the full WebviewWindow class while this one-key fake only carries the
// drop listener, and the payload shape is already pinned by DropCapture.
export function buildDropWindowMock(dropEvent: DropCapture) {
  return {
    getCurrentWebviewWindow: () => ({
      onDragDropEvent: (
        cb: NonNullable<DropCapture["handler"]>,
      ) => {
        dropEvent.handler = cb;
        return Promise.resolve(() => {});
      },
    }),
  };
}

// The installed api mock fns (the same instances the suite file's vi.mock
// factory spreads into the mocked module), so harness helpers drive the exact
// mocks the App consumes without importing the api module here. Assumes
// vitest's per-file module isolation: one install per suite file, so the
// single slot always reflects the importing file's own mocks.
let installedApi: ReturnType<typeof buildShellApiMocks> | null = null;

// Helper precondition: the suite file's vi.mock("../api") factory must have
// run (i.e. the file imports the mocked ../api or renders App) before any
// harness helper is called.
function requireInstalledApi(): ReturnType<typeof buildShellApiMocks> {
  if (!installedApi) {
    throw new Error(
      "shellFixtures: no api mocks installed -- the suite file must import (a mock of) ../api first",
    );
  }
  return installedApi;
}

// The shell suite's api posture: everything the App calls on mount is mocked
// inert, and the state-backed reads (working set / thread) flow through the
// per-file hoisted `state` so a test seeds rows by assignment. Listener
// registrations capture their callbacks into the per-file hoisted slots.

// Type-level reconciliation with the real api export surface (issue #1581):
// the `satisfies` below requires every mocked key to exist on `Api` with an
// assignable signature, so a drifted mock (or a renamed api export) fails
// `npx tsc --noEmit` here instead of surfacing later as a confusing
// jsdom/Tauri error. api exports NOT mocked here intentionally pass through
// the real implementation (the suite factories spread these over
// importOriginal; settings/workspace/agent-panel reads are never touched by
// shell scenarios). When a NEW api export is consumed by a shell path, add a
// stub here or consciously accept the passthrough.
type ShellApiMocks = Partial<typeof Api>;

export function buildShellApiMocks({ state, turnProgressCb, resumeProgressCb }: ShellCaptures) {
  const mocks = {
    // Issue #842: the startup re-adoption sweep fires on mount; an empty
    // reply keeps it a no-op.
    listLiveSessions: vi.fn(async () => []),
    closeSession: vi.fn(async () => false),
    closeSessionAndWaitRelease: vi.fn(async () => {}),
    createSession: vi.fn(async () => ({ session_id: "sess-1", recipe_path: "/sessions/sess-1/recipe.json" })),
    deleteSession: vi.fn(async () => {}),
    // Issue #1631: the archive guard's confirm routes into the setArchived
    // chain, whose sidecar write must not hit the real Tauri invoke in jsdom.
    setSessionArchived: vi.fn(async () => {}),
    listSessions: vi.fn(async () => []),
    renameSession: vi.fn(async () => ""),
    ingestFile: vi.fn(),
    listWorkingSet: vi.fn(async () => state.workingSet),
    activeDataset: vi.fn(async () => null),
    // Default: never resolves — the pendingQuestion from openSession() fires
    // handleAsk, but the turn stays in-flight without processing a result,
    // avoiding state updates that could leak across the test cleanup boundary.
    // Tests that need a result override via mockResolvedValueOnce.
    askQuestion: vi.fn((): Promise<TurnOutcome> => new Promise(() => {})),
    cancelQuery: vi.fn(async () => {}),
    conversation: vi.fn(async () => state.thread),
    // ADR-0059: capture the listener callback so a test can emit phases; the
    // returned unlisten is a no-op (jsdom has no real Tauri event bus).
    onTurnProgress: vi.fn(async (cb: (ev: TurnProgress) => void) => {
      turnProgressCb.current = cb;
      return () => {};
    }),
    // #83 R5: capture the resume-progress listener so a test can emit events
    // addressed to a stranger vs this session (ADR-0056 multi-session filter).
    openRecipe: vi.fn(async () => {}),
    onResumeProgress: vi.fn(async (cb: (ev: ResumeProgress) => void) => {
      resumeProgressCb.current = cb;
      return () => {};
    }),
    // Issue #1353: the shell-level session-named listener mounts with App;
    // inert no-op keeps jsdom off the real Tauri listen.
    onSessionNamed: vi.fn(async () => () => {}),
    // The app-level approval channel (issue #297) mounts on App render; no
    // shell-suite scenario drives approvals, so inert no-op listeners keep the
    // real @tauri-apps/api/event listen (absent in jsdom) from firing.
    onApprovalRequest: vi.fn(async () => () => {}),
    onApprovalResolved: vi.fn(async () => () => {}),
    onApprovalAbandoned: vi.fn(async () => () => {}),
    respondToolApproval: vi.fn(async () => {}),
    // The tray channel (issue #1140) mounts on App render; no Shell.test
    // scenario drives tray events, so inert no-op listeners suffice.
    onTrayOpenSession: vi.fn(async () => () => {}),
    onTrayNewSession: vi.fn(async () => () => {}),
    readRows: vi.fn(),
    // The artifact surfaces' render-time facts (issue #1088): existence
    // defaults to true (openable rows/cards), the text read to empty.
    artifactExists: vi.fn(async () => true),
    readArtifactText: vi.fn(async () => ""),
    // listProviderProfiles feeds the per-profile has_key overlay consumed by
    // the shell-level bar: the composer picker's badge + the ADR-0092
    // submit-time honest gate (useProfileKeys). Default: the "default" profile
    // (baseAppConfig's active profile) HAS a key, so tests that resolve
    // app-config pass the gate and the centered bar's submit creates a
    // session. The gate tests override this to has_key:false.
    listProviderProfiles: vi.fn(async () => [
      { profile_id: "default", has_key: true, keychain_fault: null },
    ]),
    // The composer auth-mode chip reads / writes the session's authorization
    // posture (issue #352). Default per_call read + no-op write; the chip
    // tests override per scenario.
    getAuthorizationMode: vi.fn(async () => "per_call" as const),
    // Issue #1369: the auth chip's trust-management read + revoke; no Shell
    // scenario drives the trust set, so the empty list is the honest answer
    // (no badge, no panel section) and the revoke is a no-op.
    listSessionTrust: vi.fn(async () => []),
    revokeSessionTrust: vi.fn(async () => {}),
    setAuthorizationMode: vi.fn(async () => {}),
    // The composer runtime picker reads / writes the session's runtime choice
    // + the v1 adapter table (issue #353). Default built-in read + empty
    // adapter list + no-op write/rescan; no shell-suite scenario drives a
    // runtime switch, so the defaults keep the picker quiet.
    getSessionRuntime: vi.fn(async () => ({ kind: "built_in" }) as const),
    setSessionRuntime: vi.fn(async () => {}),
    listAdapters: vi.fn(async (): Promise<AdapterEntry[]> => []),
    rescanAdapters: vi.fn(async (): Promise<AdapterEntry[]> => []),
    // The null default is the "no persisted config yet" posture; the real
    // signature omits null, so the cast keeps the runtime behavior the
    // suites rely on while still reconciling the key against `Api`.
    getAppConfig: vi.fn(async (): Promise<AppConfig> => null as unknown as AppConfig),
    setAppConfig: vi.fn(async (cfg: AppConfig) => cfg),
    // The skill picker reads the registry (issue #365, ADR-0086); the
    // staged invocations ride the ask itself (ADR-0119). Defaults: an empty
    // registry keeps the picker quiet.
    listSkills: vi.fn(
      async (): Promise<SkillListing> => ({ skills: [], ignored: [], root_error: null }),
    ),
  } satisfies ShellApiMocks;
  installedApi = mocks;
  return mocks;
}

// ADR-0092: the sidebar "+" navigates to the centered empty state (no longer
// creates a session); a session is created by submitting from the shell-level
// bar. This helper clicks "+" (cold start), types + submits on the centered
// bar. Can be called multiple times: each call navigates to the empty state
// first, then creates.
export async function openSession(): Promise<void> {
  const { askQuestion } = requireInstalledApi();
  // Navigate to empty state (sidebar "+"). No-op on fresh render.
  fireEvent.click(document.querySelector(".sidebar-new-button") as HTMLButtonElement);
  // ADR-0092: submitting from the centered bar creates the session AND fires the
  // question as the first turn. The helper REJECTS that creation turn so it
  // settles immediately and the session is idle when we return: a resolved
  // outcome would APPEND a turn (hiding the hero / last-turn card many tests
  // assert) and a never-resolving one would leave the bar stuck on the stop
  // button. handleAsk's catch sets loading=false and appends nothing on reject,
  // so the thread stays exactly as `state.thread` provides. The reject surfaces
  // a session error banner, which these black-box assertions ignore. The
  // one-time rejection is queued ahead of any per-test mock so the creation turn
  // — not the test's own turn — consumes it.
  vi.mocked(askQuestion).mockRejectedValueOnce(
    new Error("openSession: discard the creation turn"),
  );
  // The centered bar is always rendered — type and submit to create a session.
  fireEvent.change(screen.getByLabelText("提问"), { target: { value: "test question" } });
  fireEvent.click(screen.getByRole("button", { name: "提问" }));
  await waitFor(() =>
    expect(document.querySelector(".session-rail")).toBeInTheDocument(),
  );
  // Wait for the creation turn to settle (reject) so the bar returns to idle
  // (submit button back) before the test drives its own interactions.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "提问" })).toBeInTheDocument(),
  );
}

export function src(name: string): DatasetDescriptor {
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
    size_bytes: 0,
    rectify: { kind: "NotApplicable" },
    privacy: { send_samples: true, type_only_columns: [] },
  };
}

export function materializedTurn(referenceName: string): ThreadEntry {
  return {
    entry: "Turn",
    data: {
      question: `q:${referenceName}`,
      outcome: {
        kind: "Materialized",
        data: {
          promotions: [{ dataset: src(referenceName), sql: "SELECT 1" }],
          viz: null,
          body: null,
          assumption: null,
        },
      },
      trace: [], provenance: { skills: [] },
    },
  };
}

export const ROW_PAGE: RowPage = {
  columns: [
    { name: "id", canonical_type: "BIGINT" },
    { name: "label", canonical_type: "VARCHAR" },
  ],
  rows: [["1", "a"]],
  total: 1,
  offset: 0,
  limit: 100,
};

// A helper that holds an in-flight ask open so a test can observe the loading
// window (phase feedback / cancel) then resolve it to let the turn finish.
// The resolver is read through a ref so the returned `resolve` always invokes
// the LATEST promise's resolver (not a stale copy captured before askQuestion
// was called).
export function pendingAsk(): { resolve: (o: TurnOutcome) => void } {
  const ref: { current: ((o: TurnOutcome) => void) | null } = { current: null };
  requireInstalledApi().askQuestion.mockImplementation(
    () =>
      new Promise<TurnOutcome>((r) => {
        ref.current = r;
      }),
  );
  // Throw rather than no-op when the ask never fired: a silent skip would let
  // negative assertions pass vacuously.
  return {
    resolve: (o) => {
      if (!ref.current) {
        throw new Error("pendingAsk: askQuestion was never called (no resolver captured)");
      }
      ref.current(o);
    },
  };
}

// A malformed turn (unknown outcome kind) for the ADR-0058 boundary tests:
// hardened with trace/provenance so the render crash reaches the exhaustive
// outcome switch, not the earlier provenance-badge / trace reads that would
// otherwise throw first.
export function bogusTurn(question = "x"): ThreadEntry {
  return {
    entry: "Turn",
    data: { question, outcome: { kind: "Bogus" }, trace: [], provenance: { skills: [] } },
  } as unknown as ThreadEntry;
}

// A minimal valid AppConfig for the persistence tests (the shell prefs are
// the only field under test; the rest are just-shape defaults).
export function baseAppConfig(
  shell: Pick<AppConfig["shell"], "sidebar_collapsed">,
): AppConfig {
  return sharedBaseAppConfig({
    format_version: 1,
    shell: { ...shell },
  });
}

// A minimal configured MCP server (issue #301 wire shape) so a composer "+"
// test can flip the registry non-empty and leave the degraded mode.
export function mcpServer(id: string): McpServerConfig {
  return {
    id,
    display_name: id,
    transport: { type: "stdio", command: "/bin/srv", args: [] },
    env: {},
    keychain_env_keys: [],
    keychain_header_keys: [],
    timeout_ms: null,
    enabled: true,
  };
}

// An unmapped wire shape: a choice kind choiceToTurnRuntime does not map, so
// both the live marker update and the success tail's stamp throw by design
// (#725 loud failure). The cast is deliberate -- SessionRuntimeChoice is the
// contract, the wire is the wild; #825 reproduces exactly the throw the fire
// path's defensive catch must log.
export const UNMAPPED_RUNTIME_CHOICE = {
  kind: "genuinely_unmapped",
} as unknown as SessionRuntimeChoice;

// Any resolved outcome reaches the success tail's stamp -- the throw site
// runs while the optimistic entry is being built, before any outcome.kind
// branch, so the kind here is incidental; it only has to resolve where the
// beforeEach default rejects.
export const STAMP_OUTCOME: TurnOutcome = {
  kind: "Materialized",
  data: {
    promotions: [{ dataset: src("r1"), sql: "SELECT 1" }],
    viz: null,
    body: null,
    assumption: null,
  },
};
