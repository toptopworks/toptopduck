import { vi, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DatasetDescriptor } from "../types/dataset";
import type { ResumeProgress, TurnProgress } from "../types/session";
import type { DropCapture } from "./setup/shellFixtures";
import type { ThreadEntry, TurnOutcome } from "../types/thread";
import { activeDataset, askQuestion, conversation, createSession, getAppConfig, ingestFile, listSessions, listWorkingSet, readRows, setAppConfig } from "../api";
import { recordedTurn } from "../session/__tests__/fixtures";
import { buildTauriWindowMock } from "./setup/tauriWindowMock";
import { baseAppConfig, materializedTurn, openSession, ROW_PAGE, src, buildDropWindowMock } from "./setup/shellFixtures";
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

describe("App shell window collapse + drag-drop bisection (issue #84)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    state.thread = [];
    vi.mocked(readRows).mockResolvedValue(ROW_PAGE);
    vi.mocked(listSessions).mockResolvedValue([]);
    vi.mocked(activeDataset).mockResolvedValue(null);
    vi.mocked(listWorkingSet).mockResolvedValue([]);
    // mockImplementation (not mockResolvedValue) so state.thread mutations
    // within a test flow through to the rendered Thread (the truncation test
    // sets a long-question turn after beforeEach runs).
    vi.mocked(conversation).mockImplementation(async () => state.thread);
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("starts a session with the right sidebar collapsed (ADR-0083 cold start, issue #298)", async () => {
    // The right-sidebar panel defaults to COLLAPSED -- a fresh session (and every
    // pane mount: new / resume / app start) begins folded; the header toggle
    // is the manual open path.
    render(<App />);
    await openSession();
    const pane = document.querySelector(".session-pane");
    expect(pane?.classList.contains("right-sidebar-collapsed")).toBe(true);
    expect(screen.getByRole("button", { name: "展开右侧栏" })).toBeInTheDocument();
  });

  it("centers the thread content in a reading column when the right sidebar is folded (issue #833)", async () => {
    // The rail is the full-width scroll container in the folded state; the
    // thread content centers inside it via the .rail-reading-column wrapper
    // (capped by --reading-column-cap). jsdom has no layout engine, so the
    // pin is class-compositional: the pane carries the fold class, and the
    // wrapper is the rail's direct child. BOTH residency halves are pinned:
    // openSession rejects the creation turn, so the rail renders its empty
    // hint, and after a materialized turn populates the thread the question
    // itself must resolve inside the wrapper too -- a future edit that
    // scopes only one of the two into the reading column goes red here.
    // The wrapper is also the rail's only child, so a rail-level sibling
    // cannot silently opt out of the reading column.
    render(<App />);
    await openSession();
    expect(document.querySelector(".session-pane")?.classList.contains("right-sidebar-collapsed")).toBe(true);
    const wrapper = document.querySelector<HTMLElement>(".session-rail > .rail-reading-column");
    expect(wrapper).toBeInTheDocument();
    expect(within(wrapper!).getByText("尚无对话。在下方提问或加载数据开始。")).toBeInTheDocument();
    // Materialized turn (the suite's ADR-0083 idiom): auto-expands the
    // right sidebar, which does not matter here -- the wrapper is unconditional.
    const outcome833 = {
      kind: "Materialized",
      data: {
        promotions: [{ dataset: { ...src("result_1"), row_count: 1 }, sql: "SELECT 1" }],
        viz: null,
        body: null,
        assumption: null,
      },
    } satisfies TurnOutcome;
    vi.mocked(askQuestion).mockResolvedValueOnce(outcome833);
    state.thread = [recordedTurn("第一问", outcome833)];
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "第一问" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    // 2 asks total: the creation turn (rejected) + this one.
    await waitFor(() => expect(askQuestion).toHaveBeenCalledTimes(2));
    await within(wrapper!).findByText("第一问");
    const rail = document.querySelector(".session-rail")!;
    expect(Array.from(rail.children)).toHaveLength(1);
  });

  it("forwards wheel over the bar strip to the active pane's rail (issue #834)", async () => {
    // ADR-0092 lifted the QuestionBar to the shell level, outside the rail's
    // scroll container: a wheel over the bar has no scrollable ancestor and
    // dies (delta 0 live-verified; the caret rests there exactly while
    // reading the latest content, which reads as "cannot scroll further").
    // The slot forwards deltaY to the ACTIVE pane's rail -- scrollBy clamps
    // at the edges natively (edge wheel is a no-op -- platform behavior,
    // not pinned here; jsdom cannot scroll), and the rail's own wheel path
    // never enters the slot handler (flex-sibling subtrees).
    // jsdom has no layout engine, so the pin stubs scrollBy on the live rail
    // elements and asserts the forwarded (0, deltaY) pairs, not a scrollTop
    // change.
    vi.mocked(createSession)
      .mockResolvedValueOnce({ session_id: "sess-1", recipe_path: "/sessions/sess-1/recipe.json" })
      .mockResolvedValueOnce({ session_id: "sess-2", recipe_path: "/sessions/sess-2/recipe.json" });
    render(<App />);
    // Cold start: no pane layer exists yet (pinned), so the forward is a
    // structural no-op -- the centered bar has nothing to scroll.
    expect(document.querySelectorAll(".session-rail")).toHaveLength(0);
    fireEvent.wheel(document.querySelector<HTMLElement>(".shell-bar-slot")!, { deltaY: 100 });
    await openSession();
    // A second session via the bar-submit path: sess-1 keeps its keep-alive
    // layer (hidden), sess-2 becomes active -- the forward must track
    // .active, not pane order.
    await openSession();
    const layers = document.querySelectorAll(".session-pane-layer");
    expect(layers).toHaveLength(2);
    expect(layers[1].classList.contains("active")).toBe(true);
    const hiddenScrollBy = vi.fn();
    const activeScrollBy = vi.fn();
    layers[0].querySelector<HTMLElement>(".session-rail")!.scrollBy = hiddenScrollBy;
    layers[1].querySelector<HTMLElement>(".session-rail")!.scrollBy = activeScrollBy;
    const slot = document.querySelector<HTMLElement>(".shell-bar-slot")!;
    // Both directions forward.
    fireEvent.wheel(slot, { deltaY: 240 });
    fireEvent.wheel(slot, { deltaY: -120 });
    expect(activeScrollBy).toHaveBeenNthCalledWith(1, 0, 240);
    expect(activeScrollBy).toHaveBeenNthCalledWith(2, 0, -120);
    expect(hiddenScrollBy).not.toHaveBeenCalled();
    // Zoom gestures stay with the browser -- no forward.
    fireEvent.wheel(slot, { deltaY: 60, ctrlKey: true });
    expect(activeScrollBy).toHaveBeenCalledTimes(2);
    // Line-mode deltas normalize to pixels (3 lines x 16px) so the bar
    // never crawls against the rail's native path.
    fireEvent.wheel(slot, { deltaY: 3, deltaMode: 1 });
    expect(activeScrollBy).toHaveBeenNthCalledWith(3, 0, 48);
    // A rail-originated wheel never routes through the slot handler.
    fireEvent.wheel(layers[1].querySelector<HTMLElement>(".session-rail")!, { deltaY: 300 });
    expect(activeScrollBy).toHaveBeenCalledTimes(3);
    // A wheel on a scrollable inside the bar scrolls that element natively;
    // the forward must not double-scroll the rail behind it. The jsdom
    // textarea does not overflow, so the same wheel still forwards -- only
    // the overflow stub flips it to scroll-itself-only.
    const input = screen.getByLabelText("提问");
    fireEvent.wheel(input, { deltaY: 90 });
    expect(activeScrollBy).toHaveBeenNthCalledWith(4, 0, 90);
    input.style.overflowY = "auto";
    Object.defineProperty(input, "scrollHeight", { value: 300 });
    Object.defineProperty(input, "clientHeight", { value: 100 });
    // scrollTop sits at 0 -- the textarea can still consume the tick, so
    // the guard holds and the rail does not scroll behind.
    fireEvent.wheel(input, { deltaY: 240 });
    expect(activeScrollBy).toHaveBeenCalledTimes(4);
    // At the bottom edge the textarea cannot consume; with no scrollable
    // ancestor the delta has nowhere native to go, so it chains to the
    // rail -- the manual form of native scroll chaining.
    Object.defineProperty(input, "scrollTop", { value: 200, configurable: true });
    fireEvent.wheel(input, { deltaY: 240 });
    expect(activeScrollBy).toHaveBeenNthCalledWith(5, 0, 240);
    // The top edge mirrors it for the negative direction.
    Object.defineProperty(input, "scrollTop", { value: 0, configurable: true });
    fireEvent.wheel(input, { deltaY: -80 });
    expect(activeScrollBy).toHaveBeenNthCalledWith(6, 0, -80);
    // Active-vs-order disambiguation: re-activate the first session via its
    // sidebar entry (keep-alive keeps both layers mounted; no refetch), and
    // the forward must move to layers[0]'s rail -- a last-or-index lookup
    // would hit the hidden pane's rail instead.
    fireEvent.click(document.querySelectorAll(".session-entry-main")[0]);
    expect(layers[0].classList.contains("active")).toBe(true);
    fireEvent.wheel(slot, { deltaY: 150 });
    expect(hiddenScrollBy).toHaveBeenNthCalledWith(1, 0, 150);
    expect(activeScrollBy).toHaveBeenCalledTimes(6);
  });

  it("opens / closes the right sidebar via the header toggle (manual fold)", async () => {
    render(<App />);
    await openSession();
    fireEvent.click(screen.getByRole("button", { name: "展开右侧栏" }));
    expect(document.querySelector(".session-pane")?.classList.contains("right-sidebar-collapsed")).toBe(false);
    // The toggle flips to its close label once open.
    fireEvent.click(screen.getByRole("button", { name: "收起右侧栏" }));
    expect(document.querySelector(".session-pane")?.classList.contains("right-sidebar-collapsed")).toBe(true);
  });

  it("shields the strip behind the bar and keeps the scrollbar band open (issue #836)", async () => {
    // Two halves of the overlay's interaction model, pinned at the DOM
    // level (jsdom has no hit-testing): (a) an opaque backdrop rides the
    // track's conversation column so scrolling content never peeks around
    // the floating card -- it must be the track's FIRST child. That slot
    // is convention; the layering itself comes from the bar card's
    // position:relative, which paints above in-flow siblings regardless
    // of DOM order; (b) it exists only in the bottom posture -- every
    // backdrop rule is bottom-scoped, so rendering it in cold start would
    // be dead markup. The styles reserve the rail's scrollbar band
    // (measured scrollbar width plus the 1px column border) at the
    // column's right edge (visible + draggable via the slot's
    // pointer-events:none) -- CSS-only, unpinnable here.
    render(<App />);
    expect(document.querySelector(".shell-bar-backdrop")).toBeNull();
    await openSession();
    const backdrop = document.querySelector(".shell-bar-backdrop")!;
    expect(backdrop).toBeInTheDocument();
    expect(backdrop.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector(".shell-bar-track")!.firstElementChild).toBe(backdrop);
  });

  it("publishes the bar's live height as --shell-bar-h on the main area (issue #836)", () => {
    // The bar overlays the main area, so the rail's bottom padding must
    // follow the bar's live height (a growing draft, the picker opening)
    // to keep the thread's tail readable above it. App wires a
    // ResizeObserver on the slot that publishes the border-box height as
    // --shell-bar-h on .main-area; styles.css turns it into the rail's
    // padding-bottom. jsdom's global stub (test-setup) never fires, so
    // this spy class replaces it for the render and hands the test the
    // live callback.
    type ObserverSpy = {
      cb: ResizeObserverCallback;
      targets: Element[];
      disconnected: boolean;
    };
    const instances: ObserverSpy[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        cb: ResizeObserverCallback;
        targets: Element[] = [];
        disconnected = false;
        constructor(cb: ResizeObserverCallback) {
          this.cb = cb;
          instances.push(this);
        }

        observe(target: Element) {
          this.targets.push(target);
        }

        unobserve() {}
        disconnect() {
          this.disconnected = true;
        }
      },
    );
    const { unmount } = render(<App />);
    // The observed element is the slot itself: the card, its margins,
    // and the centered greeting all contribute to its height. Other
    // observers exist (useRailResize), so filter by target.
    const slot = document.querySelector<HTMLElement>(".shell-bar-slot")!;
    const observers = instances.filter((i) => i.targets.includes(slot));
    expect(observers).toHaveLength(1);
    const area = document.querySelector<HTMLElement>(".main-area")!;
    // borderBoxSize is the primary read (the border-box height is what
    // the rail must clear); contentRect.height is the legacy fallback.
    act(() => {
      observers[0].cb(
        [{ target: slot, borderBoxSize: [{ blockSize: 157 }] } as unknown as ResizeObserverEntry],
        observers[0] as unknown as ResizeObserver,
      );
    });
    expect(area.style.getPropertyValue("--shell-bar-h")).toBe("157px");
    act(() => {
      observers[0].cb(
        [{ target: slot, contentRect: { height: 121 } } as unknown as ResizeObserverEntry],
        observers[0] as unknown as ResizeObserver,
      );
    });
    expect(area.style.getPropertyValue("--shell-bar-h")).toBe("121px");
    // A hidden slot (settings-mode's display:none) reports height 0 --
    // the publish must keep the last real height instead of collapsing
    // the rail's bound.
    act(() => {
      observers[0].cb(
        [{ target: slot, borderBoxSize: [{ blockSize: 0 }] } as unknown as ResizeObserverEntry],
        observers[0] as unknown as ResizeObserver,
      );
    });
    expect(area.style.getPropertyValue("--shell-bar-h")).toBe("121px");
    // The same effect also measures the platform scrollbar width once
    // (hidden scrollable probe) and publishes it as --rail-sb-w -- the
    // backdrop's notch width so the strip covers everything except the
    // scrollbar itself. jsdom has no layout, so the probe reads 0.
    expect(area.style.getPropertyValue("--rail-sb-w")).toBe("0px");
    unmount();
    expect(observers[0].disconnected).toBe(true);
  });

  it("the first Materialized promotion auto-expands the right sidebar ONCE (ADR-0083)", async () => {
    render(<App />);
    await openSession();
    // Queue the test's own turns AFTER openSession so the creation turn consumes
    // the helper's one-time rejection, not these Materialized outcomes (which
    // would otherwise auto-expand the right sidebar during openSession).
    const outcome1 = {
      kind: "Materialized",
      data: {
        promotions: [{ dataset: { ...src("result_1"), row_count: 1 }, sql: "SELECT 1" }],
        viz: null,
        body: null,
        assumption: null,
      },
    } satisfies TurnOutcome;
    const outcome2 = {
      kind: "Materialized",
      data: {
        promotions: [{ dataset: { ...src("result_2"), row_count: 1 }, sql: "SELECT 2" }],
        viz: null,
        body: null,
        assumption: null,
      },
    } satisfies TurnOutcome;
    vi.mocked(askQuestion).mockResolvedValueOnce(outcome1).mockResolvedValueOnce(outcome2);
    // The recorded rows the turn-end refreshes return (mock parity, #1088).
    state.thread = [recordedTurn("第一问", outcome1), recordedTurn("第二问", outcome2)];
    expect(document.querySelector(".session-pane")?.classList.contains("right-sidebar-collapsed")).toBe(true);
    // First promotion -> the panel opens with the produced dataset.
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "第一问" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() =>
      expect(document.querySelector(".session-pane")?.classList.contains("right-sidebar-collapsed")).toBe(false),
    );
    // The user folds it back; the one-shot is spent.
    fireEvent.click(screen.getByRole("button", { name: "收起右侧栏" }));
    expect(document.querySelector(".session-pane")?.classList.contains("right-sidebar-collapsed")).toBe(true);
    // A SECOND promotion must not steal focus -- the fold stays.
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "第二问" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    // 3 asks total: the creation turn (rejected) + the two user turns.
    await waitFor(() => expect(askQuestion).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /结果：result_2/ })).toBeInTheDocument(),
    );
    expect(document.querySelector(".session-pane")?.classList.contains("right-sidebar-collapsed")).toBe(true);
  });

  it("on resume onto a materialized session, a new promotion never auto-expands (one-shot is session-scoped, issue #771)", async () => {
    // Resume lands viewedResult on the prior Materialized primary via the R5
    // init effect in useViewedResult -- NOT via markProduced. Issue #771
    // scopes the auto-expand one-shot to the session: a mount onto a thread
    // that already materialized a result treats the guidance as consumed, so
    // the fold remains for the user to open -- the first NEW promotion after
    // resume must not steal it (the view itself still follows the result;
    // markProduced is untouched by the fold).
    state.thread = [materializedTurn("result_1")];
    render(<App />);
    await openSession();
    // Queue the turn AFTER openSession so the creation turn consumes the
    // one-time rejection of the helper, not this Materialized outcome.
    const outcome771 = {
      kind: "Materialized",
      data: {
        promotions: [{ dataset: { ...src("result_2"), row_count: 1 }, sql: "SELECT 2" }],
        viz: null,
        body: null,
        assumption: null,
      },
    } satisfies TurnOutcome;
    vi.mocked(askQuestion).mockResolvedValueOnce(outcome771);
    // The recorded row the turn-end refresh returns (mock parity, #1088) --
    // appended AFTER the R5 landing assertions above ran against the resumed
    // thread, so the refetch sees both rows like the backend would.
    // Resume cold-start: folded, with the R5 landing visible on the rail
    // (result_1 is the viewed result) -- the landing moved no fold.
    expect(document.querySelector(".session-pane")?.classList.contains("right-sidebar-collapsed")).toBe(true);
    expect(await screen.findByRole("button", { name: /result_1 的预览/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    // The recorded row the turn-end refresh returns (mock parity, #1088),
    // appended AFTER the R5 landing assertions above -- the first NEW
    // promotion after resume: the view follows result_2 but the panel
    // stays folded (this session already showed results).
    state.thread = [...state.thread, recordedTurn("新问", outcome771)];
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "新问" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /结果：result_2/ })).toBeInTheDocument(),
    );
    expect(await screen.findByRole("button", { name: /result_2 的预览/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(document.querySelector(".session-pane")?.classList.contains("right-sidebar-collapsed")).toBe(true);
  });

  it("a rail preview-card click opens the right sidebar on the same dataset (dual view, issue #298)", async () => {
    // The rail preview card and the right-sidebar panel are dual views of the
    // same dataset: clicking the card selects its result AND unfolds the
    // right sidebar onto it (cold start is collapsed).
    state.thread = [materializedTurn("result_1")];
    render(<App />);
    await openSession();
    expect(document.querySelector(".session-pane")?.classList.contains("right-sidebar-collapsed")).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: /result_1 的预览/ }));
    // The fold opens and the right sidebar shows result_1's table (the viewed
    // selection landed -- the card reads back as active).
    expect(document.querySelector(".session-pane")?.classList.contains("right-sidebar-collapsed")).toBe(false);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /q:result_1/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /result_1 的预览/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("switching the viewed dataset with the panel already open (dual view, issue #298)", async () => {
    // Dual-view linkage is not only "collapsed -> click -> open": with the
    // panel already open, clicking another card swaps viewedResult and the
    // active marker follows. expandRightSidebar is a no-op when already open;
    // selectResult carries the switch.
    state.thread = [materializedTurn("result_1"), materializedTurn("result_2")];
    render(<App />);
    await openSession();
    // Open the right sidebar onto result_1.
    fireEvent.click(await screen.findByRole("button", { name: /result_1 的预览/ }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /q:result_1/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /result_1 的预览/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    // Click result_2's card: the right sidebar swaps + the active marker moves.
    fireEvent.click(screen.getByRole("button", { name: /result_2 的预览/ }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /q:result_2/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /result_2 的预览/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    // result_1's card drops the active marker (aria-current absent).
    expect(screen.getByRole("button", { name: /result_1 的预览/ })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("a rail result-link click also unfolds the right sidebar (issue #298)", async () => {
    state.thread = [materializedTurn("result_1")];
    render(<App />);
    await openSession();
    expect(document.querySelector(".session-pane")?.classList.contains("right-sidebar-collapsed")).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: /结果：result_1/ }));
    expect(document.querySelector(".session-pane")?.classList.contains("right-sidebar-collapsed")).toBe(false);
  });

  it("restores persisted collapse prefs from app-config on mount (ADR-0038/0054)", async () => {
    // A user who left the sidebar collapsed reopens to sidebar collapsed -- the
    // pref rides app-config (ADR-0038), restored once on the first resolve.
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: true }),
    );
    render(<App />);
    await waitFor(() => {
      const shell = document.querySelector(".shell");
      expect(shell?.classList.contains("sidebar-collapsed")).toBe(true);
    });
  });

  it("persists a sidebar collapse toggle into app-config (ADR-0038)", async () => {
    // Toggling a collapse level commits the new shell prefs to app-config so
    // the choice survives a restart (the toggle is not a transient UI flip).
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: false }),
    );
    render(<App />);
    // Wait for getAppConfig to resolve AND the mount effect's .then to set
    // appConfigRef.current (the collapse persist is a no-op until the ref
    // lands).
    await waitFor(() => expect(getAppConfig).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    fireEvent.click(screen.getByRole("button", { name: "收起会话栏" }));
    // setAppConfig receives a config whose shell reflects the toggle.
    await waitFor(() =>
      expect(setAppConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          shell: { sidebar_collapsed: true },
        }),
      ),
    );
  });

  it("collapses the settings overlay left nav via the top-bar toggle (issue #285)", async () => {
    // The settings overlay's left nav collapses from the SAME topbar slot as
    // the right-sidebar session-sidebar toggle (settings-mode swaps in the settings
    // kind). Unlike the right-sidebar collapse prefs this is a TEMP state -- it
    // never rides app-config, so this test asserts only the className flip, not
    // a setAppConfig commit.
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: false }),
    );
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    // Settings open: the topbar toggle now folds the settings nav. Default is
    // expanded, so the button offers the collapse action.
    const shell = document.querySelector(".shell");
    expect(shell?.classList.contains("settings-nav-collapsed")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "折叠设置导航" }));
    expect(shell?.classList.contains("settings-nav-collapsed")).toBe(true);
    // Toggle back expands.
    fireEvent.click(screen.getByRole("button", { name: "展开设置导航" }));
    expect(shell?.classList.contains("settings-nav-collapsed")).toBe(false);
  });

  it("resets the settings nav to expanded on each open (temp state, issue #285)", async () => {
    // The collapse is per-open temp state (not persisted): closing + reopening
    // settings always starts expanded, even if the user folded the nav on the
    // prior visit. openSettings resets the flag on every entry, so a folded nav
    // does not leak across a close/reopen. ESC closes the overlay (the folded
    // nav hides its own back button, so the window-level Escape listener is the
    // reachable close path in the collapsed state).
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: false }),
    );
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "折叠设置导航" }));
    expect(
      document.querySelector(".shell")?.classList.contains("settings-nav-collapsed"),
    ).toBe(true);
    // Close via ESC, then reopen -- the nav is expanded again (no persisted
    // collapse to recall).
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(
      document.querySelector(".shell")?.classList.contains("settings-nav-collapsed"),
    ).toBe(false);
  });

  it("drops a file onto an active session as an added source (ADR-0062 R3)", async () => {
    // The bisection's ACTIVE-session branch: with a session open, a drop adds
    // the file to that session's working set (ADR-0022 source event) -- it does
    // NOT mint a new session. createSession is called once (for openSession),
    // never again for the drop.
    vi.mocked(createSession).mockResolvedValueOnce({ session_id: "sess-1", recipe_path: "/sessions/sess-1/recipe.json" });
    vi.mocked(ingestFile).mockResolvedValue({ kind: "Loaded", data: src("dropped") });
    render(<App />);
    await openSession();
    // Simulate a webview drop while sess-1 is active. The position rides the
    // payload as Tauri always sends it (#501); the active-session route
    // ignores it (the bar-inert guard is cold-start only).
    dropEvent.handler!({ payload: { type: "drop", paths: ["/x/new.csv"], position: { x: 5, y: 5 } } });
    await waitFor(() =>
      expect(ingestFile).toHaveBeenCalledWith("sess-1", "/x/new.csv"),
    );
    // The drop did NOT mint a new session (only the openSession create fired).
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("renders the verbatim question in full inside the user bubble (ADR-0103, #609)", async () => {
    // ADR-0103 retires the ADR-0054 truncation posture: the chat projection
    // wraps the question in full (pre-wrap) inside the right-aligned bubble --
    // no tail-ellipsis span, no hover-recovery Tooltip. jsdom has no layout,
    // so the contract is asserted at the class level: the question carries
    // the pre-wrap utility and no truncate, the full text is the element's
    // own content, and hovering opens no recovery tooltip.
    const longQuestion = "前".repeat(120);
    state.thread = [
      {
        entry: "Turn",
        data: { question: longQuestion, outcome: { kind: "Cancelled", data: null }, trace: [], provenance: { skills: [] } },
      },
    ];
    render(<App />);
    await openSession();
    // The thread loads async (conversation IPC); wait for the turn card to
    // render before asserting the wrap contract on its question span.
    const q = await waitFor(() => {
      const el = document.querySelector(".turn-question");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    const classes = q.className.split(/\s+/);
    expect(classes).toContain("whitespace-pre-wrap");
    expect(classes).not.toContain("truncate");
    expect(q.textContent).toBe(longQuestion);
    // No truncation-recovery tooltip mounts for the question: the old
    // TruncatingTooltip wrapper opened one on hover (jsdom reports 0-width,
    // so the overflow gate always let it through); the bubble posture opens
    // none. A real-timer beat lets a would-be Radix open surface.
    fireEvent.pointerMove(q);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
