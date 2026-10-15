import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

// ADR-0074 (issue #263): WindowControls is a platform dispatcher --
// usePlatform() routes to MacOSWindowControls (left traffic lights) or
// WindowsWindowControls (right min/max/close). The dispatch must be unit-
// testable, so the underlying @tauri-apps/plugin-os + window + log deps are
// mocked and each platform scenario re-imports the dispatcher fresh (the
// module-level platform cache in use-platform.ts would otherwise latch the
// first scenario's value across tests).
//
// Visual-only gap (not covered here): the macOS dot glyph opacity transition
// (opacity-60 → group-hover:opacity-100) is CSS-driven and cannot be asserted
// in jsdom (no computed styles, no :hover pseudo). The F2 fidelity cue +
// WCAG 1.4.1 default-visible glyph are verified by visual / manual review.

// Hoisted mock state survives vi.resetModules (the factory re-runs on each
// re-import but returns the same hoisted fn), mirroring use-platform.test.ts.
const pluginOs = vi.hoisted(() => ({ platform: vi.fn<() => string>() }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: pluginOs.platform }));

// getCurrentWindow returns a fresh object literal each call in production, so
// the mock returns a stable shape bound to hoisted fns -- both the dispatcher
// and the per-platform child components reach the same call spies.
const windowApi = vi.hoisted(() => ({
  close: vi.fn(),
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  isMaximized: vi.fn(),
  onResized: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: windowApi.close,
    minimize: windowApi.minimize,
    toggleMaximize: windowApi.toggleMaximize,
    isMaximized: windowApi.isMaximized,
    onResized: windowApi.onResized,
  }),
}));

// The shared fireWindowAction helper routes close failures to log.error and
// minimize/toggleMaximize to log.warn; both spies are asserted in the click
// failure-path tests below.
const { logWarn, logError } = vi.hoisted(() => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("../../lib/log", () => ({
  log: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: logWarn,
    error: logError,
  },
}));

beforeEach(() => {
  pluginOs.platform.mockReset();
  windowApi.close.mockReset();
  windowApi.minimize.mockReset();
  windowApi.toggleMaximize.mockReset();
  windowApi.isMaximized.mockReset();
  windowApi.onResized.mockReset();
  logWarn.mockReset();
  logError.mockReset();
  // WindowsWindowControls' useEffect seeds maximize state from isMaximized()
  // and subscribes to onResized; both resolve to a benign default so the
  // windows/linux scenarios mount without dangling promises.
  windowApi.isMaximized.mockResolvedValue(false);
  windowApi.onResized.mockResolvedValue(vi.fn());
  // The production fireWindowAction chain calls .catch on the action promise;
  // the mock fns default to returning undefined, which would throw inside
  // .catch and surface as an uncaught exception. Resolve to undefined so the
  // chain holds for the success-path tests (failure-path tests override with
  // mockRejectedValueOnce).
  windowApi.close.mockResolvedValue(undefined);
  windowApi.minimize.mockResolvedValue(undefined);
  windowApi.toggleMaximize.mockResolvedValue(undefined);
  vi.resetModules();
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

// Empty-catalog English IntlProvider so aria-labels resolve to defaultMessage
// (the canonical English source, ADR-0052).
async function renderWithPlatform<T extends ReactElement>(
  platform: string,
  ui: T,
) {
  pluginOs.platform.mockReturnValue(platform);
  const { render } = await import("@testing-library/react");
  const { IntlProvider } = await import("react-intl");
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      {ui}
    </IntlProvider>,
  );
}

async function renderDispatcher(platform: string) {
  const { WindowControls } = await import("../WindowControls");
  return renderWithPlatform(platform, <WindowControls />);
}

describe("WindowControls platform dispatch", () => {
  it("renders the three traffic-light buttons on macOS", async () => {
    const { screen } = await import("@testing-library/react");
    await renderDispatcher("macos");

    // macOS traffic lights: red close / yellow minimize / green maximize, in
    // that left-to-right order. The green button is maximize semantics (no
    // restore variant -- ADR-0074 green = toggleMaximize, no glyph swap).
    const close = screen.getByRole("button", { name: "Close" });
    const minimize = screen.getByRole("button", { name: "Minimize" });
    const maximize = screen.getByRole("button", { name: "Maximize" });

    // DOM order is red → yellow → green (left to right, macOS convention).
    expect(
      close.compareDocumentPosition(minimize) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      minimize.compareDocumentPosition(maximize) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // No restore button ever on macOS (green is always maximize, not a toggle
    // glyph that swaps to restore).
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("renders the Windows-style min/max/close buttons on Windows", async () => {
    const { screen } = await import("@testing-library/react");
    await renderDispatcher("windows");

    expect(screen.getByRole("button", { name: "Minimize" })).toBeInTheDocument();
    // Default (non-maximized) state shows Maximize, not Restore.
    expect(screen.getByRole("button", { name: "Maximize" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("falls back to the Windows-style layout on Linux", async () => {
    const { screen } = await import("@testing-library/react");
    await renderDispatcher("linux");

    // ADR-0074: Linux never returns null under global decorations:false; it
    // reuses WindowsWindowControls so the desktop always has window controls.
    expect(screen.getByRole("button", { name: "Minimize" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Maximize" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });
});

describe("MacOSWindowControls click behavior", () => {
  async function renderMac() {
    const { MacOSWindowControls } = await import("../MacOSWindowControls");
    return renderWithPlatform("macos", <MacOSWindowControls />);
  }

  it("red button closes the window", async () => {
    const { screen, fireEvent } = await import("@testing-library/react");
    await renderMac();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(windowApi.close).toHaveBeenCalledTimes(1);
    expect(windowApi.minimize).not.toHaveBeenCalled();
    expect(windowApi.toggleMaximize).not.toHaveBeenCalled();
  });

  it("yellow button minimizes the window", async () => {
    const { screen, fireEvent } = await import("@testing-library/react");
    await renderMac();
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(windowApi.minimize).toHaveBeenCalledTimes(1);
    expect(windowApi.close).not.toHaveBeenCalled();
    expect(windowApi.toggleMaximize).not.toHaveBeenCalled();
  });

  it("green button calls toggleMaximize (NOT fullscreen)", async () => {
    const { screen, fireEvent } = await import("@testing-library/react");
    await renderMac();
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    expect(windowApi.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(windowApi.close).not.toHaveBeenCalled();
    expect(windowApi.minimize).not.toHaveBeenCalled();
  });

  it("routes a close rejection to log.error (most severe — user cannot dismiss)", async () => {
    const { screen, fireEvent, waitFor } = await import("@testing-library/react");
    await renderMac();
    windowApi.close.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(logError).toHaveBeenCalledWith("window", "close failed", expect.any(Error)),
    );
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("routes a minimize rejection to log.warn (recoverable)", async () => {
    const { screen, fireEvent, waitFor } = await import("@testing-library/react");
    await renderMac();
    windowApi.minimize.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    await waitFor(() =>
      expect(logWarn).toHaveBeenCalledWith("window", "minimize failed", expect.any(Error)),
    );
    expect(logError).not.toHaveBeenCalled();
  });
});

describe("WindowsWindowControls click behavior", () => {
  async function renderWindows() {
    const { WindowsWindowControls } = await import("../WindowsWindowControls");
    return renderWithPlatform("windows", <WindowsWindowControls />);
  }

  it("minimize / maximize / close buttons each fire their action", async () => {
    const { screen, fireEvent } = await import("@testing-library/react");
    await renderWindows();

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(windowApi.minimize).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    expect(windowApi.toggleMaximize).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(windowApi.close).toHaveBeenCalledTimes(1);
  });
});
