import { vi, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DatasetDescriptor } from "../types/dataset";
import type { ResumeProgress, TurnProgress } from "../types/session";
import type { DropCapture } from "./setup/shellFixtures";
import type { ThreadEntry, TurnOutcome } from "../types/thread";
import embed from "vega-embed";
import { activeDataset, askQuestion, closeSession, conversation, createSession, listSessions, listWorkingSet, openRecipe, readRows } from "../api";
import { artifactTurn, textual } from "../session/__tests__/fixtures";
import { embedOk } from "../components/common/__tests__/helpers";
import { buildTauriWindowMock } from "./setup/tauriWindowMock";
import { materializedTurn, openSession, ROW_PAGE, src, buildDropWindowMock } from "./setup/shellFixtures";
import App from "../App";

// Black-box shell tests. Drives the rendered three-column App
// like a user and asserts VISIBLE DOM / structure signals -- never the Query
// cache internals. Mirrors the App black-box pattern (mock api + stub the Tauri
// bridge) so the shell renders offline. Shared mocks and helpers live in
// ./setup/shellFixtures.

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
// The viz suites' posture: jsdom has no canvas, so every chart render in
// this file draws through the mocked embed.
vi.mock("vega-embed", () => ({ default: vi.fn() }));

// ArtifactView's HTML branch rides convertFileSrc (the asset protocol); the
// real transform reads window.__TAURI_INTERNALS__ (absent in jsdom), so a
// pure stand-in keeps the iframe's src observable (issue #1088). Partial:
// api.ts's invoke keeps the real binding via importOriginal spreads.
vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, convertFileSrc: (p: string) => "asset://mock/" + p };
});
const dropEvent = vi.hoisted(() => ({
  handler: null as DropCapture["handler"],
}));
vi.mock("@tauri-apps/api/webviewWindow", () => buildDropWindowMock(dropEvent));

// WindowsWindowControls (custom titlebar, ADR-0074) is the sole remaining
// consumer of getCurrentWindow. The shared stub keeps jsdom off the real
// runtime (which reads window.__TAURI metadata and crashes the shell-level
// boundary).
vi.mock("@tauri-apps/api/window", () => buildTauriWindowMock().module);

const state = vi.hoisted(() => ({
  workingSet: [] as DatasetDescriptor[],
  thread: [] as ThreadEntry[],
}));

// ADR-0059 turn-progress capture: the SessionPane mounts a long-lived listener
// on mount. Capturing the callback here lets a test emit a turn-progress event
// (Thinking / the tool-call stream, ADR-0078) and assert the QuestionBar
// renders the discrete feedback, then assert it clears when the ask resolves.
const turnProgressCb = vi.hoisted(() => ({
  current: null as null | ((ev: TurnProgress) => void),
}));

// #83 R5: capture the resume-progress listener so a test can emit Source/Replay
// events -- addressed to THIS session vs a stranger -- and assert the
// multi-session filter (ADR-0056) discards the stranger before it can move the
// opener's progress strip.
const resumeProgressCb = vi.hoisted(() => ({
  current: null as null | ((ev: ResumeProgress) => void),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  // Dynamic import: the factory runs lazily, and a static import of the
  // harness would re-enter this factory while the harness module is still
  // initializing (the harness never statically depends on the api).
  const { buildShellApiMocks } = await import("./setup/shellFixtures");
  return {
    ...actual,
    ...buildShellApiMocks({ state, turnProgressCb, resumeProgressCb }),
  };
});

describe("App resume + close-in-flight seams (issue #83)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    state.thread = [];
    vi.mocked(readRows).mockResolvedValue(ROW_PAGE);
    // Defaults: each test overrides the IPC it needs. Reset implementations
    // so a prior test's mockImplementation (e.g. closeSession never-resolve)
    // does not leak across describe boundaries.
    vi.mocked(listSessions).mockResolvedValue([]);
    vi.mocked(activeDataset).mockResolvedValue(null);
    vi.mocked(listWorkingSet).mockResolvedValue([]);
    vi.mocked(conversation).mockResolvedValue([]);
    vi.mocked(closeSession).mockResolvedValue(false);
    vi.mocked(openRecipe).mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("resume lands viewedResult on the last Materialized and shows the stale disclosure (ADR-0062 R5 / 0047)", async () => {
    // A persisted session with two Materialized turns; result_2 is the last ->
    // R5 points viewedResult at it on resume. result_2's source was replaced
    // after materialization, so the right sidebar shows the old table + the
    // stage-stale disclosure banner (ADR-0047 honest wording).
    vi.mocked(listSessions).mockResolvedValue([
      {
        recipe_path: "/x/persisted.json",
        display_name: "季报",
        last_modified_at: Date.now(),
        source_summary: { first_source_name: "people", source_count: 1, turn_count: 2 },
        format_version: 1,
        pinned: false,
        archived: false,
        workspace: null,
      },
    ]);
    const r1 = src("result_1");
    const r2: DatasetDescriptor = {
      ...src("result_2"),
      stale: { reference_name: "result_2", display_name: "result_2", reason: "Replaced" },
    };
    vi.mocked(createSession).mockResolvedValue({ session_id: "sess-resume", recipe_path: "/sessions/sess-resume/recipe.json" });
    vi.mocked(openRecipe).mockResolvedValue(undefined);
    vi.mocked(listWorkingSet).mockResolvedValue([r1, r2]);
    vi.mocked(activeDataset).mockResolvedValue(r2);
    vi.mocked(conversation).mockResolvedValue([
      materializedTurn("result_1"),
      materializedTurn("result_2"),
    ]);

    render(<App />);
    await waitFor(() => expect(screen.getByText("季报")).toBeInTheDocument());
    fireEvent.click(screen.getByText("季报"));
    // R5: viewedResult lands on the LAST Materialized (result_2), not result_1.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /q:result_2/ })).toBeInTheDocument(),
    );
    // ADR-0047 stage-stale: the right sidebar shows the old table + disclosure.
    expect(screen.getByText(/此结果已失效/)).toBeInTheDocument();
  });

  it("filters resume-progress events by sessionId (ADR-0056 / #76, #83 R5)", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      {
        recipe_path: "/x/persisted.json",
        display_name: "季报",
        last_modified_at: Date.now(),
        source_summary: { first_source_name: "people", source_count: 1, turn_count: 1 },
        format_version: 1,
        pinned: false,
        archived: false,
        workspace: null,
      },
    ]);
    // Hold openRecipe pending so resumeStatus stays visible for assertions.
    let resolveOpenDuck: () => void = () => {};
    vi.mocked(openRecipe).mockImplementation(
      () => new Promise<void>((r) => { resolveOpenDuck = r; }),
    );
    vi.mocked(createSession).mockResolvedValue({ session_id: "sess-resume", recipe_path: "/sessions/sess-resume/recipe.json" });

    render(<App />);
    await waitFor(() => expect(screen.getByText("季报")).toBeInTheDocument());
    fireEvent.click(screen.getByText("季报"));
    // openRecipe is called AFTER `targetSid = sid`, so once it fires the filter
    // is armed.
    await waitFor(() =>
      expect(openRecipe).toHaveBeenCalledWith("sess-resume", "/x/persisted.json"),
    );

    // Event for a DIFFERENT session: filtered -> status stays "正在打开…".
    resumeProgressCb.current!({
      session_id: "other-sid",
      event: { Source: { index: 1, total: 2, reference_name: "X" } },
    });
    expect(screen.queryByText(/校验源/)).not.toBeInTheDocument();

    // Event for THIS session: status updates to source.
    resumeProgressCb.current!({
      session_id: "sess-resume",
      event: { Source: { index: 1, total: 2, reference_name: "people" } },
    });
    await waitFor(() => expect(screen.getByText(/校验源/)).toBeInTheDocument());

    // ADR-0067 (issue #182): the strip migrated from a bespoke <p> tint to a
    // shadcn Alert default variant, with role="status" + aria-live="polite"
    // OVERRIDING the Alert's role="alert" assertive default (alert.tsx sets
    // role before spreading props, so the caller override wins). A regression
    // that drops either attribute lets a screen reader interrupt the user on
    // every resume tick. Pin the override so the a11y contract is guarded.
    const resumeAlert = document.querySelector(".resume-progress") as HTMLElement;
    expect(resumeAlert).not.toBeNull();
    expect(resumeAlert.getAttribute("role")).toBe("status");
    expect(resumeAlert.getAttribute("aria-live")).toBe("polite");
    expect(resumeAlert.getAttribute("data-slot")).toBe("alert");

    // Layout regression guard: the strip must render as an absolutely-
    // positioned overlay INSIDE .main-area, NOT as an in-flow child of the
    // .shell grid. An in-flow grid row shifted the whole main area down on
    // mount and back up on unmount, so the visible session header bounced on
    // every open/resume (the title position flicker). Pin the overlay parent
    // so a revert to the grid-flow placement fails here.
    expect(resumeAlert.parentElement?.classList.contains("main-area")).toBe(true);
    expect(resumeAlert.parentElement?.classList.contains("shell")).toBe(false);
    // The status text must ride a col-start-2 slot (AlertTitle): the Alert
    // base grid reserves col 1 (width 0) for an icon, and a bare text child
    // wraps one character per line there, turning the strip into a tall box.
    expect(
      resumeAlert.querySelector("[data-slot=alert-title]")?.textContent,
    ).toMatch(/校验源/);

    // Cleanup: let openRecipe resolve and AWAIT openPersisted finishing (invalidate
    // + registerOpen + setResumeStatus(null) + finally unlisten) so no orphan
    // resume-progress listener leaks into the next test.
    resolveOpenDuck();
    await waitFor(() =>
      expect(screen.queryByText(/正在打开/)).not.toBeInTheDocument(),
    );
  });

  // ADR-0093 (issue #511): close-in-flight + close-reject tests retired —
  // the sidebar context menu trigger moved to .session-header (slice 2, #512).
});

describe("App artifact presentation (issue #1088, ADR-0124 Decision 3/4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    state.thread = [];
    vi.mocked(listSessions).mockResolvedValue([]);
    vi.mocked(activeDataset).mockResolvedValue(null);
    vi.mocked(listWorkingSet).mockResolvedValue([]);
    // mockImplementation so state.thread mutations within a test flow
    // through to the rendered Thread (the live-flow test seeds the recorded
    // row after the mount's initial load).
    vi.mocked(conversation).mockImplementation(async () => state.thread);
    // Re-establish the createSession default: clearAllMocks clears calls,
    // not implementations, and an earlier suite's persistent clobber would
    // leak a stale recipe_path into downstream assertions.
    vi.mocked(createSession).mockResolvedValue({
      session_id: "sess-1",
      recipe_path: "/sessions/sess-1/recipe.json",
    });
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("renders the rail card on a resumed manifest; a row click selects the file onto the stage", async () => {
    // The composition chain the issue is about, driven end to end: the
    // recorded turn already carries the settle-computed manifest (ADR-0124
    // Decision 2), TurnCard's render gate mounts the ArtifactCard, the
    // exists-checked row is clickable, handleSelectFile moves viewedResult
    // onto the file view AND expands the right sidebar, and the manifest-member HTML
    // renders the sandboxed iframe stage.
    state.workingSet = [src("people")];
    state.thread = [artifactTurn(["/sessions/sess-1/artifacts/page.html"])];
    render(<App />);
    await openSession();
    const row = await screen.findByRole("button", { name: /page\.html/ });
    expect(screen.getByText(/交付文件/)).toBeInTheDocument();
    // Resume posture (#771 mirror): no Materialized turn means nothing
    // auto-opens -- the one-shot spends silently on the init scan and the
    // the right sidebar stays folded until the user picks a row.
    expect(document.querySelector(".session-pane")?.classList.contains("right-sidebar-collapsed")).toBe(true);
    fireEvent.click(row);
    await waitFor(() =>
      expect(document.querySelector(".session-pane")?.classList.contains("right-sidebar-collapsed")).toBe(false),
    );
    const frame = document.querySelector("[data-testid=\"artifact-frame\"]");
    expect(frame?.getAttribute("src")).toContain("page.html");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    // The dual-view mirror: the clicked row carries the active marker.
    expect(row).toHaveAttribute("aria-current", "true");
  });

  it("resets the loading indicator when switching artifacts (the per-path remount, issue #1201)", async () => {
    // The frame's isLoaded state lives in ArtifactView, but its reset is
    // owned upstream: SessionPane keys the view by content.path (#1199's
    // openFailed scoping), so a rail switch remounts the stage and the
    // second document loads under its own indicator. The switch is
    // deliberately same-kind (html to html): a kind change remounts the
    // shell on its own, so only the same-kind switch discriminates the
    // key -- without it the view reconciles in place and the switched-to
    // document renders with no indicator while still fetching.
    state.workingSet = [src("people")];
    state.thread = [
      artifactTurn(["/sessions/sess-1/artifacts/page.html", "/sessions/sess-1/artifacts/report.html"]),
    ];
    render(<App />);
    await openSession();
    fireEvent.click(await screen.findByRole("button", { name: /page\.html/ }));
    const first = await waitFor(() => {
      const node = document.querySelector("[data-testid=\"artifact-frame\"]");
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    // jsdom never fires the frame's load: the manual event stands in for
    // the WebView's first paint and retires the first document's indicator.
    expect(screen.getByRole("status", { name: /正在加载|Loading/ })).toBeInTheDocument();
    fireEvent.load(first);
    expect(screen.queryByRole("status", { name: /正在加载|Loading/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /report\.html/ }));
    const second = await waitFor(() => {
      const node = document.querySelector("[data-testid=\"artifact-frame\"]");
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    // The remount is the contract under test: a fresh frame node carries
    // the second document, and its indicator is up again from mount.
    expect(second).not.toBe(first);
    expect(second.getAttribute("src")).toContain("report.html");
    expect(screen.getByRole("status", { name: /正在加载|Loading/ })).toBeInTheDocument();
  });

  it("auto-opens the primary when the turn-end refetch lands a manifest (live flow)", async () => {
    state.workingSet = [src("people")];
    const outcome = {
      kind: "Textual",
      data: { text_kind: "Agent", body: "report written", assumption: null },
    } satisfies TurnOutcome;
    // Persisting impl: the creation turn (openSession's one-time rejection)
    // consumes its queue slot first, this turn resolves textual.
    vi.mocked(askQuestion).mockResolvedValue(outcome);
    // The refetch must land AFTER the optimistic append's commit: the real
    // IPC round-trip separates the two thread writes into two renders, but
    // an instantly-resolving mock batches them into one -- the auto-open's
    // init scan would first see the manifest and spend silently. Gate the
    // second conversation call (the turn-end refetch) on a manual release.
    let releaseRefetch: (() => void) | null = null;
    let conversationCalls = 0;
    vi.mocked(conversation).mockImplementation(async () => {
      conversationCalls += 1;
      if (conversationCalls > 1) {
        await new Promise<void>((resolve) => {
          releaseRefetch = resolve;
        });
      }
      return state.thread;
    });
    render(<App />);
    await openSession();
    // The mount's initial conversation load saw the empty thread; the
    // optimistic append carries no manifest (settle-computed fields are
    // backend-only), so the right sidebar is still folded here.
    expect(document.querySelector(".session-pane")?.classList.contains("right-sidebar-collapsed")).toBe(true);
    // The recorded row the turn-end refetch returns (mock parity): the
    // same outcome plus the manifest.
    state.thread = [artifactTurn(["/sessions/sess-1/artifacts/report.pdf"], outcome)];
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "写个报告" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    // The optimistic append commits first -- the rail shows the question
    // from the append, before any refetched data exists.
    const rail = document.querySelector<HTMLElement>(".session-rail")!;
    await waitFor(() => expect(within(rail).getByText("写个报告")).toBeInTheDocument());
    // Release the refetch: the turn-end refresh refetches the thread, the
    // manifest lands, and
    expect(releaseRefetch).not.toBeNull();
    releaseRefetch!();
    // The manifest lands; the auto-open one-shot fires (no Materialized -> the artifact owns
    // the stage): the right sidebar expands and the primary renders in-page (pdf
    // -> the unsandboxed viewer frame, issue #1199).
    await waitFor(() =>
      expect(document.querySelector(".session-pane")?.classList.contains("right-sidebar-collapsed")).toBe(false),
    );
    const frame = await waitFor(() => {
      const node = document.querySelector("[data-testid=\"artifact-frame\"]");
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    // The viewer rides the asset protocol, deliberately unsandboxed.
    expect(frame).not.toHaveAttribute("sandbox");
    expect(frame.getAttribute("src")).toContain("report.pdf");
    // The header carries the name as the stage chrome.
    expect(document.querySelector("[data-testid=\"artifact-header\"]")).toHaveTextContent("report.pdf");
  });
});

describe("App viz stage presentation (issue #1093, ADR-0120 calibration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    state.thread = [];
    vi.mocked(listSessions).mockResolvedValue([]);
    vi.mocked(activeDataset).mockResolvedValue(null);
    vi.mocked(listWorkingSet).mockResolvedValue([]);
    vi.mocked(conversation).mockImplementation(async () => state.thread);
    vi.mocked(createSession).mockResolvedValue({
      session_id: "sess-1",
      recipe_path: "/sessions/sess-1/recipe.json",
    });
    vi.mocked(embed).mockResolvedValue(embedOk());
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("stages a settled fence body onto the right sidebar on click (the stream->stage link)", async () => {
    // The composition chain pinned end to end (the #1088 file-face twin):
    // the settled fence renders clickable through the context link,
    // handleSelectViz moves viewedResult onto the viz view AND expands the
    // right sidebar, the stage renders the export-bearing frame, and the
    // clicked fence lights the aria-current mirror.
    const body = "```vega-lite\n{\"mark\": \"bar\"}\n```";
    state.workingSet = [src("people")];
    state.thread = [textual(body)];
    render(<App />);
    await openSession();
    const fence = await screen.findByRole("button", { name: "在结果页查看图表" });
    // Resume posture mirror (#771): no Materialized turn auto-opens, so the
    // the right sidebar stays folded until the fence is clicked.
    expect(document.querySelector(".session-pane")?.classList.contains("right-sidebar-collapsed")).toBe(true);
    fireEvent.click(fence);
    await waitFor(() =>
      expect(document.querySelector(".session-pane")?.classList.contains("right-sidebar-collapsed")).toBe(false),
    );
    // The stage's third face: the export anchor on the viz view.
    expect(screen.getByRole("button", { name: "下载图表" })).toBeInTheDocument();
    // The in-stream selection mirror on the clicked fence.
    expect(fence).toHaveAttribute("aria-current", "true");
  });
});
