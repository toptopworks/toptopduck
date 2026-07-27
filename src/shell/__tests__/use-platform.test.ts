import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Issue #262 (ADR-0074): use-platform caches platform() at MODULE level so the
// webview never re-reads the injected Tauri global after the first resolve.
// Mock @tauri-apps/plugin-os so platform() is controllable (return value) and
// observable (call count) without the real init-script global. vi.hoisted keeps
// the fn reference stable across vi.mock's top-of-file hoisting AND across the
// per-test vi.resetModules -- the factory re-runs on each re-import but returns
// the same hoisted fn, so mockReset state and call counts survive.
const pluginOs = vi.hoisted(() => ({
  platform: vi.fn<() => string>(),
}));
vi.mock("@tauri-apps/plugin-os", () => ({
  platform: pluginOs.platform,
}));

// Mock the structured log sink so the throw-path log.warn is assertable and
// does not route into the real plugin-log binding (which rejects under jsdom).
// Same shape as the sibling usePersistedSessions / ColdStartHero mocks.
// logWarn is hoisted so the same fn survives vi.resetModules (the mock factory
// re-runs on each re-import but returns the same hoisted fn).
const logWarn = vi.hoisted(() => vi.fn());
vi.mock("../../lib/log", () => ({
  log: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: logWarn,
    error: vi.fn(),
  },
}));

// Module-level cache means the hook's module holds the resolved platform after
// the first read. Each scenario must start from a clean cache, so beforeEach
// clears the registry and each test re-imports the hook fresh (the mock factory
// stays registered, so the re-imported hook still sees the mocked platform()).
// Dynamic @testing-library/react import matches the post-reset instance the
// test rendered with -- the static cleanup in test-setup.ts is a separate
// instance (no containers tracked) and a no-op here. Isolation depends on
// vitest's default per-test module isolation; if pool/isolate is ever changed,
// vi.resetModules alone would no longer reset cachedPlatform between tests.
beforeEach(() => {
  pluginOs.platform.mockReset();
  logWarn.mockReset();
  vi.resetModules();
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

async function renderPlatformHook() {
  const { usePlatform } = await import("../use-platform");
  const { renderHook } = await import("@testing-library/react");
  return renderHook(() => usePlatform());
}

describe("usePlatform", () => {
  it("returns 'windows' when platform() reports windows", async () => {
    pluginOs.platform.mockReturnValue("windows");
    const { result } = await renderPlatformHook();
    expect(result.current).toBe("windows");
  });

  it("returns 'macos' when platform() reports macos", async () => {
    pluginOs.platform.mockReturnValue("macos");
    const { result } = await renderPlatformHook();
    expect(result.current).toBe("macos");
  });

  it("returns 'linux' when platform() reports linux", async () => {
    pluginOs.platform.mockReturnValue("linux");
    const { result } = await renderPlatformHook();
    expect(result.current).toBe("linux");
  });

  it("falls back to 'macos' and logs when platform() throws (jsdom, no Tauri global)", async () => {
    // jsdom has no Tauri init script, so window.__TAURI_OS_PLUGIN_INTERNALS__ is
    // undefined and the real binding throws TypeError on .platform access.
    pluginOs.platform.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'platform')");
    });
    const { result } = await renderPlatformHook();
    expect(result.current).toBe("macos");
    expect(logWarn).toHaveBeenCalledWith("platform", expect.any(String), expect.any(TypeError));
  });

  it("falls back to 'macos' for a non-desktop platform value", async () => {
    pluginOs.platform.mockReturnValue("ios");
    const { result } = await renderPlatformHook();
    expect(result.current).toBe("macos");
  });

  it("falls back to 'macos' when platform() returns empty string (init script misconfiguration)", async () => {
    // The init script may inject the global but leave the platform field empty
    // (a plausible misconfiguration); platform() returns "" without throwing.
    pluginOs.platform.mockReturnValue("");
    const { result } = await renderPlatformHook();
    expect(result.current).toBe("macos");
  });

  it("serves the cached value even after the underlying global changes", async () => {
    pluginOs.platform.mockReturnValue("windows");
    const { result: first } = await renderPlatformHook();
    expect(first.current).toBe("windows");

    // A later change to the global must not leak through -- the cache is
    // authoritative for the process lifetime (platform() is compile-time-fixed).
    pluginOs.platform.mockReturnValue("linux");
    const { result: second } = await renderPlatformHook();
    expect(second.current).toBe("windows");
  });

  it("serves the fallback-cached value even after platform() would succeed on a later call", async () => {
    // Cache-wins-over-recovery: a first-call throw latches the fallback for the
    // whole process lifetime, even if the global would resolve on a later call.
    pluginOs.platform.mockImplementation(() => {
      throw new TypeError("no global");
    });
    const { result: first } = await renderPlatformHook();
    expect(first.current).toBe("macos");

    pluginOs.platform.mockReturnValue("windows");
    const { result: second } = await renderPlatformHook();
    expect(second.current).toBe("macos");
  });
});
