import { vi } from "vitest";

// Shared Tauri window-bridge stub for the shell-level test files.
// WindowControls (custom titlebar, decorations: false) and useAppConfigState
// (window-geometry persistence, ADR-0068) both reach through getCurrentWindow.
// Stubbing the bridge keeps jsdom off the real runtime (which reads
// window.__TAURI metadata and crashes the shell-level ErrorBoundary).
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
  setPosition: ReturnType<typeof vi.fn>;
  setSize: ReturnType<typeof vi.fn>;
  innerSize: ReturnType<typeof vi.fn>;
  outerPosition: ReturnType<typeof vi.fn>;
  isMaximized: ReturnType<typeof vi.fn>;
  onResized: ReturnType<typeof vi.fn>;
  onMoved: ReturnType<typeof vi.fn>;
}

export interface TauriWindowModule {
  getCurrentWindow: () => WindowBridge;
  // useAppConfigState imports LogicalPosition / LogicalSize as constructors
  // for setPosition; stub them so the import resolves under jsdom.
  LogicalPosition: new (x: number, y: number) => { x: number; y: number };
  LogicalSize: new (width: number, height: number) => { width: number; height: number };
}

export function buildTauriWindowMock(): { module: TauriWindowModule; bridge: WindowBridge } {
  const bridge: WindowBridge = {
    minimize: vi.fn(async () => {}),
    maximize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    setPosition: vi.fn(async () => {}),
    setSize: vi.fn(async () => {}),
    innerSize: vi.fn(async () => ({ width: 1024, height: 768 })),
    outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
    isMaximized: vi.fn(async () => false),
    onResized: vi.fn(async () => () => {}),
    onMoved: vi.fn(async () => () => {}),
  };
  const module: TauriWindowModule = {
    getCurrentWindow: () => bridge,
    LogicalPosition: class {
      constructor(public x: number, public y: number) {}
    },
    LogicalSize: class {
      constructor(public width: number, public height: number) {}
    },
  };
  return { module, bridge };
}
