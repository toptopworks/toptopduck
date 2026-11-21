import { vi, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { AppConfig } from "../types/app-config";
import type { DatasetDescriptor } from "../types/dataset";
import type { ResumeProgress, TurnProgress } from "../types/session";
import type { DropCapture } from "./setup/shellFixtures";
import type { ThreadEntry } from "../types/thread";
import { createSession, getAppConfig, listSessions, openRecipe, readRows } from "../api";
import { toast, useToast } from "../components/ui/use-toast";
import { catalogIntl } from "../components/common/__tests__/helpers";
import { flowFailedMessage } from "../lib/error-presentation";
import { buildTauriWindowMock } from "./setup/tauriWindowMock";
import { baseAppConfig, openSession, ROW_PAGE, buildDropWindowMock } from "./setup/shellFixtures";
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

describe("App topbar header actions + sidebar settings footer (issue #182 / #282)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    state.thread = [];
    vi.mocked(readRows).mockResolvedValue(ROW_PAGE);
    // clearAllMocks only clears call history, not implementations set by prior
    // describes.
    // The C1 guard test below needs appConfig=null (the cold-start default) so
    // the sidebar footer -- the settings entry since issue #282 -- stays
    // ABSENT (its render-when-ready replaces the retired topbar gear's
    // settingsDisabled gate). getAppConfig's real signature is
    // Promise<AppConfig> (null is an App-level state, not an IPC return), so
    // hold the mock pending -- the mount effect's .then never fires and
    // appConfig stays at its useState(null) initial.
    vi.mocked(getAppConfig).mockImplementation(
      () => new Promise<AppConfig>(() => {}),
    );
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("keeps the settings entry absent until appConfig resolves (C1 render-when-ready)", async () => {
    // C1: opening settings while appConfig is null white-screens the shell
    // (.settings-mode hides the shell but SettingsView does not render, no
    // ESC exit). The sidebar footer's render-when-ready keeps the state
    // unreachable -- the sidebar itself mounts (cold start) but carries no
    // gear while the config stays pending (the beforeEach holds getAppConfig
    // pending).
    render(<App />);
    await waitFor(() =>
      expect(document.querySelector(".session-sidebar")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "设置" })).toBeNull();
    expect(document.querySelector(".session-sidebar .sidebar-footer")).toBeNull();
  });

  it("mounts the sidebar settings gear once appConfig resolves", async () => {
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: false }),
    );
    render(<App />);
    // The settings gear lands at the sidebar bottom once app-config resolves
    // (the connection row + status dot were retired with ConnectionStatus).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument(),
    );
    expect(
      document.querySelector(".session-sidebar .sidebar-footer"),
    ).not.toBeNull();
  });
});

describe("App Ctrl/⌘+K session-search modal (ADR-0072, issue #252)", () => {
  // Two persisted sessions feed the modal: alpha (fresher) + beta. The default
  // listSessions mock returns []; these tests override per-render.
  function twoSessions() {
    return [
      {
        recipe_path: "/x/alpha.json",
        display_name: "alpha session",
        last_modified_at: 2000,
        source_summary: { first_source_name: "alpha_src", source_count: 1, turn_count: 3 },
        format_version: 2,
        pinned: false,
        archived: false,
        workspace: null,
      },
      {
        recipe_path: "/x/beta.json",
        display_name: "beta session",
        last_modified_at: 1000,
        source_summary: { first_source_name: "beta_src", source_count: 1, turn_count: 7 },
        format_version: 2,
        pinned: false,
        archived: false,
        workspace: null,
      },
    ];
  }

  it("does not render the search modal on cold start", () => {
    render(<App />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Ctrl+K opens the search modal (Win/Linux) + lists persisted sessions", async () => {
    vi.mocked(listSessions).mockResolvedValue(twoSessions());
    render(<App />);
    // Wait for the cold-start list_sessions fetch to land so the modal sees the
    // sessions on open.
    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    // jsdom does NOT bubble DOM keydown to window-level listeners, so dispatch
    // on window directly (wrapped in act for the state toggle).
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // Both persisted sessions render as options (alpha fresher -> first).
    const options = within(dialog).getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent("alpha session");
  });

  it("⌘+K opens the search modal (macOS metaKey)", async () => {
    vi.mocked(listSessions).mockResolvedValue(twoSessions());
    render(<App />);
    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("clicking the sidebar search button opens the same modal (issue #250 button)", async () => {
    vi.mocked(listSessions).mockResolvedValue(twoSessions());
    render(<App />);
    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    fireEvent.click(document.querySelector(".sidebar-search-button") as HTMLButtonElement);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("typing filters the result list (case-insensitive on name + source)", async () => {
    vi.mocked(listSessions).mockResolvedValue(twoSessions());
    render(<App />);
    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByRole("combobox");
    // "ALPHA_SRC" hits alpha via its first_source_name.
    fireEvent.change(input, { target: { value: "ALPHA_SRC" } });
    expect(within(dialog).getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("alpha session"),
    ]);
  });

  it("Enter on the highlighted option opens the persisted session", async () => {
    vi.mocked(listSessions).mockResolvedValue(twoSessions());
    render(<App />);
    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByRole("combobox");
    // Default selection is alpha (fresher); Enter resumes it via openPersisted
    // -> openRecipe(sid, path). The IPC hop is async, so waitFor for the call to
    // land. openRecipe takes the freshly-minted sid + the path; only the path
    // matters for this assertion (the sid is an internal correlation id).
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(openRecipe).toHaveBeenCalledWith(expect.any(String), "/x/alpha.json"),
    );
  });

  it("ESC closes the modal (Radix Dialog onOpenChange→false)", async () => {
    vi.mocked(listSessions).mockResolvedValue(twoSessions());
    render(<App />);
    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).toBeNull(),
    );
  });

  it("Ctrl/⌘+K does not reopen the modal while the shell is busy (resume in flight)", async () => {
    vi.mocked(listSessions).mockResolvedValue(twoSessions());
    // openRecipe never resolves -> resumeStatus sticks at "opening" -> busy=true,
    // which the App-level busyRef gate reads to drop the second Ctrl/⌘+K. This
    // is the keyboard-side mirror of the sidebar search button's disabled-when-
    // busy contract (SessionSidebar.shell.test.tsx); the two gates are independent.
    vi.mocked(openRecipe).mockReturnValue(new Promise(() => {}));
    render(<App />);
    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    // First Ctrl+K opens (busy still false); Enter on the default option kicks
    // openPersisted -> openRecipe (now pending) -> busy flips true.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(within(dialog).getByRole("combobox"), { key: "Enter" });
    // Wait for the dialog to close (choose -> onOpenChange(false)) AND busy to
    // flip (resumeStatus moved to "opening" by the pending openRecipe; busyRef
    // syncs via useEffect on the next commit).
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Now busy: a second Ctrl+K must NOT reopen the modal.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Ctrl/⌘+K toggles the modal closed when it is already open (not busy)", async () => {
    vi.mocked(listSessions).mockResolvedValue(twoSessions());
    render(<App />);
    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    // First Ctrl+K opens.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    // Second Ctrl+K (shell not busy) toggles it closed -- matches the Linear /
    // Raycast / VS Code ⌘K convention.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("App toast viewport mount (ADR-0142, issue #1494)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    state.thread = [];
    vi.mocked(readRows).mockResolvedValue(ROW_PAGE);
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("mounts the viewport outside the shell grid so the settings-mode swap cannot hide it", async () => {
    render(<App />);
    act(() => {
      toast({ title: "Shell mount pin" });
    });
    const vp = document.querySelector("[data-slot=\"toast-viewport\"]");
    expect(vp).toBeInTheDocument();
    // The settings-mode display rule (styles.css) hides every non-exempt
    // direct shell child; the viewport must not be one -- a failure toast
    // landing while settings is open still has to show.
    expect(vp!.closest(".shell")).toBeNull();
    expect(screen.getByText("Shell mount pin")).toBeInTheDocument();
    // Settle the module store for later suites: dismiss through the public
    // hook so no live toast outlives this test's DOM.
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.dismiss();
    });
  });
});

// Issue #1563: the shell banner's lifecycle. A shell-level reject mounts the
// banner with the neutral verb prefix ("{verb}失败：", the composer reuse from
// issue #139), and its close affordance clears it -- the only production clear,
// so a rejected action no longer pins the banner up until a webview reload.
describe("App shell error banner lifecycle (issue #1563)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    state.thread = [];
    vi.mocked(readRows).mockResolvedValue(ROW_PAGE);
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("a rejected bar creation mounts the shell banner with the verb prefix, and close clears it", async () => {
    // The "{verb}失败：" expectation composes through the production composer
    // (issue #1100 precedent): no mirrored verb map in the test.
    const bannerText = flowFailedMessage(catalogIntl("zh-CN"), "shell", "内部错误");
    vi.mocked(createSession).mockRejectedValueOnce({
      kind: "Engine",
      data: "close-wait timed out",
    });
    render(<App />);
    // Cold-start bar submit: the createSession reject surfaces through the
    // shell banner -- a shell-level refusal, attributed to no session (none
    // opened).
    fireEvent.change(screen.getByLabelText("提问"), {
      target: { value: "test question" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    expect(await screen.findByText(bannerText)).toBeInTheDocument();
    // Expanded posture (no session active): the track wrapper mirrors the
    // same activeRightSidebarCollapsed source as the session pane and the
    // bar slot, so the fold class is absent here.
    expect(
      document
        .querySelector(".shell-error-track")
        ?.classList.contains("right-sidebar-collapsed"),
    ).toBe(false);
    // The close affordance clears the banner: it leaves the grid entirely,
    // and the shell falls back to the plain cold-start face.
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(screen.queryByText(bannerText)).not.toBeInTheDocument(),
    );
    // Dismiss clears the slot, it does not retire the surface: a second
    // reject mounts a fresh banner through the same path.
    vi.mocked(createSession).mockRejectedValueOnce({
      kind: "Engine",
      data: "close-wait timed out",
    });
    fireEvent.change(screen.getByLabelText("提问"), {
      target: { value: "second question" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    expect(await screen.findByText(bannerText)).toBeInTheDocument();
  });

  it("mirrors the folded posture on the track wrapper while a session is active", async () => {
    // The wrapper's fold class rides the same activeRightSidebarCollapsed
    // source as the pane and the bar slot (#1563): with an active session and
    // nothing auto-opened the right sidebar is folded, so the banner track
    // must carry the collapsed class for the banner to ride the collapsed
    // grid. Without this pin, deleting the conditional in App passes the
    // whole suite green.
    const bannerText = flowFailedMessage(catalogIntl("zh-CN"), "shell", "内部错误");
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
    render(<App />);
    await openSession();
    // Posture precondition: an active session with nothing auto-opened keeps
    // the right sidebar folded (the #771 resume-posture mirror).
    expect(
      document
        .querySelector(".session-pane")
        ?.classList.contains("right-sidebar-collapsed"),
    ).toBe(true);
    // A shell-level reject while the session stays active: resuming the
    // persisted entry with its open rejecting surfaces the shell banner
    // without tearing the active session down.
    vi.mocked(openRecipe).mockRejectedValueOnce({
      kind: "Engine",
      data: "close-wait timed out",
    });
    fireEvent.click(screen.getByText("季报"));
    expect(await screen.findByText(bannerText)).toBeInTheDocument();
    expect(
      document
        .querySelector(".shell-error-track")
        ?.classList.contains("right-sidebar-collapsed"),
    ).toBe(true);
  });
});

describe("App context-menu policy mount (ADR-0149, issue #1570)", () => {
  it("keeps the native menu off non-editing surfaces once the shell mounts", () => {
    render(<App />);
    // A blank surface: the mounted policy's document listener must claim the
    // event (the WebView's reload / print items never surface in the shell).
    const plain = document.createElement("div");
    document.body.appendChild(plain);
    const onPlain = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    plain.dispatchEvent(onPlain);
    plain.remove();
    expect(onPlain.defaultPrevented).toBe(true);
    // The whitelist arm rides the same mounted listener: an editing surface
    // keeps the native menu, so a blanket-prevent regression also goes red.
    const field = document.createElement("input");
    document.body.appendChild(field);
    const onField = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    field.dispatchEvent(onField);
    field.remove();
    expect(onField.defaultPrevented).toBe(false);
  });
});
