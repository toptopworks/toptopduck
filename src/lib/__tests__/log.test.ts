import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the plugin-log bindings so the wrapper's formatting + IPC handling
// can be asserted without a real Tauri host. Each level takes one string
// (the plugin contract) and resolves by default; the rejection path is
// exercised by flipping a level per-test. vi.hoisted keeps the reference
// stable across vi.mock's top-of-file hoisting.
const pluginLog = vi.hoisted(() => ({
  // trace/debug/info are only used to satisfy log.ts's pluginFns Record and
  // are never called in these tests, so they stay param-less. warn/error are
  // read back via .mock.calls, so they carry the (message: string) signature
  // (typed via the generic; the impl itself takes no args -> no unused var).
  trace: vi.fn(() => Promise.resolve()),
  debug: vi.fn(() => Promise.resolve()),
  info: vi.fn(() => Promise.resolve()),
  warn: vi.fn<(message: string) => Promise<void>>(() => Promise.resolve()),
  error: vi.fn<(message: string) => Promise<void>>(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-log", () => pluginLog);

import { log } from "../log";

// Unit tests for src/lib/log (issue #98). The wrapper's reason for existing
// is the crash-prevention invariant: a log call -- or a rejected IPC, or a
// circular-ref extra -- must never throw. These tests lock that, plus the
// describe/format contract that scopes every call site's diagnostic line.

describe("log wrapper", () => {
  // Stub the dev console mirror (and the one-shot sink-dead fallback) so
  // they do not clutter test output; assertions read the plugin mock instead.
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("formats scope + message into the plugin binding's single string", () => {
    log.warn("shell", "collapse persist failed");
    expect(pluginLog.warn).toHaveBeenLastCalledWith("[shell] collapse persist failed");
  });

  it("joins stringified extras after the head", () => {
    log.warn("geometry", "persist failed", "retry-3", { attempt: 2 });
    expect(pluginLog.warn).toHaveBeenLastCalledWith(
      `[geometry] persist failed retry-3 {"attempt":2}`,
    );
  });

  it("describe: an Error collapses to its stack (throw-site kept, not just .message)", () => {
    const err = new Error("boom");
    log.error("scope", "crash", err);
    const line = pluginLog.error.mock.calls.at(-1)?.[0] ?? "";
    expect(line).toContain("[scope] crash");
    // The stack's first line carries the message; the backtrace follows. The
    // sink exists for this diagnostic, so it is preserved (ADR-0029 restricts
    // source DATA values, not stacks).
    expect(line).toContain("boom");
    expect(line).toContain("\n");
  });

  it("describe: an object is JSON-stringified", () => {
    log.warn("scope", "ctx", { a: 1 });
    expect(pluginLog.warn).toHaveBeenLastCalledWith(`[scope] ctx {"a":1}`);
  });

  it("describe: a large object is capped so it cannot evict rotation history", () => {
    log.warn("scope", "ctx", { blob: "x".repeat(2000) });
    const line = pluginLog.warn.mock.calls.at(-1)?.[0] ?? "";
    // MAX_EXTRA_LENGTH caps the JSON form; without it this line would be
    // ~2KB and a real result-set extra would be MiB-scale, evicting the 5MB
    // KeepOne sink on a single call.
    expect(line.length).toBeLessThan(600);
  });

  it("describe: a circular ref falls back to String without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => log.warn("scope", "ctx", circular)).not.toThrow();
    const line = pluginLog.warn.mock.calls.at(-1)?.[0] ?? "";
    expect(typeof line).toBe("string");
  });

  it("a rejected IPC never crashes the app (crash-prevention invariant)", async () => {
    pluginLog.error.mockImplementationOnce(() => Promise.reject(new Error("ipc dead")));
    // The wrapper attaches .catch and never rethrows -- this is the whole
    // reason the wrapper exists (ADR-0029 honest-degrade).
    expect(() => log.error("scope", "boom")).not.toThrow();
    // Drain the microtask so the wrapper's .catch runs within the test
    // (before afterEach restores console), not after.
    await Promise.resolve();
  });
});
