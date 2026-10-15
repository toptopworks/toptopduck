import { vi } from "vitest";

// Shared Tauri window-bridge stub for the shell-level test files.
// WindowsWindowControls (custom titlebar maximize/restore glyph sync, ADR-0074)
// is the sole remaining consumer of getCurrentWindow. Stubbing the bridge keeps
// jsdom off the real runtime (which reads window.__TAURI metadata and crashes
// the shell-level ErrorBoundary).
//
// buildTauriWindowMock returns BOTH the module shape (for vi.mock) AND the
// bridge handle so a test can fire click -> IPC, emit onResized, flip
// isMaximized, and assert on the spies. The bridge identity is per call --
// vi.mock factories are file-scoped, so each test file gets its own spies
// when its factory runs on first import.

export interface WindowBridge {
  minimize: ReturnType<typeof vi.fn>;
  maximize: ReturnType<typeof vi.fn>;
  toggleMaximize: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  isMaximized: ReturnType<typeof vi.fn>;
  onResized: ReturnType<typeof vi.fn>;
}

export interface TauriWindowModule {
  getCurrentWindow: () => WindowBridge;
}

export function buildTauriWindowMock(): { module: TauriWindowModule; bridge: WindowBridge } {
  const bridge: WindowBridge = {
    minimize: vi.fn(async () => {}),
    maximize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    isMaximized: vi.fn(async () => false),
    onResized: vi.fn(async () => () => {}),
  };
  const module: TauriWindowModule = {
    getCurrentWindow: () => bridge,
  };
  return { module, bridge };
}
