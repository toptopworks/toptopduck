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

// Module-level cache means the hook's module holds the resolved platform after
// the first read. Each scenario must start from a clean cache, so beforeEach
// clears the registry and each test re-imports the hook fresh (the mock factory
// stays registered, so the re-imported hook still sees the mocked platform()).
// Dynamic @testing-library/react import matches the post-reset instance the
// test rendered with -- the static cleanup in test-setup.ts is a separate
// instance (no containers tracked) and a no-op here.
beforeEach(() => {
  pluginOs.platform.mockReset();
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

  it("falls back to 'macos' when platform() throws (jsdom, no Tauri global)", async () => {
    // jsdom has no Tauri init script, so window.__TAURI_OS_PLUGIN_INTERNALS__ is
    // undefined and the real binding throws TypeError on .platform access.
    pluginOs.platform.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'platform')");
    });
    const { result } = await renderPlatformHook();
    expect(result.current).toBe("macos");
  });

  it("falls back to 'macos' for a non-desktop platform value", async () => {
    pluginOs.platform.mockReturnValue("ios");
    const { result } = await renderPlatformHook();
    expect(result.current).toBe("macos");
  });

  it("reads platform() once across multiple hook instances (module-level cache)", async () => {
    pluginOs.platform.mockReturnValue("linux");
    await renderPlatformHook();
    await renderPlatformHook();
    expect(pluginOs.platform).toHaveBeenCalledTimes(1);
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
});
