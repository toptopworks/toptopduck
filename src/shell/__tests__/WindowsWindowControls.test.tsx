import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { WindowsWindowControls } from "../WindowsWindowControls";
import type { ReactElement } from "react";

// ADR-0074: WindowsWindowControls is the Windows/Linux min/max/close cluster;
// macOS window controls are native Overlay-titlebar traffic lights with no
// frontend path to test. The @tauri-apps/api/window + log deps are mocked so
// the IPC click routing and the fireWindowAction failure routing stay
// unit-testable.

// getCurrentWindow returns a fresh object literal each call in production, so
// the mock returns a stable shape bound to hoisted fns.
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
  windowApi.close.mockReset();
  windowApi.minimize.mockReset();
  windowApi.toggleMaximize.mockReset();
  windowApi.isMaximized.mockReset();
  windowApi.onResized.mockReset();
  logWarn.mockReset();
  logError.mockReset();
  // The maximize/restore glyph effect seeds state from isMaximized() and
  // subscribes to onResized; both resolve to a benign default so the cluster
  // mounts without dangling promises (the failure-path tests override the
  // action fns with mockRejectedValueOnce).
  windowApi.isMaximized.mockResolvedValue(false);
  windowApi.onResized.mockResolvedValue(vi.fn());
  windowApi.close.mockResolvedValue(undefined);
  windowApi.minimize.mockResolvedValue(undefined);
  windowApi.toggleMaximize.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

// Empty-catalog English IntlProvider so aria-labels resolve to defaultMessage
// (the canonical English source, ADR-0052).
function renderControls(ui: ReactElement) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      {ui}
    </IntlProvider>,
  );
}

describe("WindowsWindowControls", () => {
  it("renders minimize / maximize / close (no restore at rest)", () => {
    renderControls(<WindowsWindowControls />);

    expect(screen.getByRole("button", { name: "Minimize" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Maximize" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("flips to the Restore label when the window starts maximized", async () => {
    windowApi.isMaximized.mockResolvedValueOnce(true);
    renderControls(<WindowsWindowControls />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument(),
    );
  });

  it("minimize / maximize / close buttons each fire their action", () => {
    renderControls(<WindowsWindowControls />);

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(windowApi.minimize).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    expect(windowApi.toggleMaximize).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(windowApi.close).toHaveBeenCalledTimes(1);
  });

  it("routes a close rejection to log.error (most severe — user cannot dismiss)", async () => {
    renderControls(<WindowsWindowControls />);
    windowApi.close.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(logError).toHaveBeenCalledWith("window", "close failed", expect.any(Error)),
    );
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("routes a minimize rejection to log.warn (recoverable)", async () => {
    renderControls(<WindowsWindowControls />);
    windowApi.minimize.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    await waitFor(() =>
      expect(logWarn).toHaveBeenCalledWith("window", "minimize failed", expect.any(Error)),
    );
    expect(logError).not.toHaveBeenCalled();
  });
});
