import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  useComposerState,
  type ComposerSessionFields,
} from "../useComposerState";

// A session-fields fixture for the non-null path. The hook passes the values
// through verbatim, so the test only needs stable identities to assert
// passthrough (loading=true distinguishes from the idle default loading=false).
const SESSION_FIELDS: ComposerSessionFields = {
  loading: true,
  phase: null,
  handleAsk: vi.fn(),
  handleCancel: vi.fn(),
};

// Wrapper that always passes both args. The `as string` cast bypasses the
// public overloads so the transition test can change sessionId from null to
// non-null inside a single renderHook lifecycle (overloads are compile-time
// only; the runtime implementation accepts both forms).
function useTestComposerState(
  sid: string | null,
  fields: ComposerSessionFields,
) {
  return useComposerState(sid as string, fields);
}

describe("useComposerState (ADR-0092 null-safe composer hook)", () => {
  it("returns idle defaults when sessionId is null", () => {
    const { result } = renderHook(() => useComposerState(null));
    expect(result.current.loading).toBe(false);
    expect(result.current.phase).toBeNull();
    expect(result.current.draft).toBe("");
    // Idle handlers are no-ops — calling them resolves without throwing.
    expect(result.current.handleAsk).toBeInstanceOf(Function);
    expect(result.current.handleCancel).toBeInstanceOf(Function);
  });

  it("passes through session fields merged with owned draft when sessionId is non-null", () => {
    const { result } = renderHook(() =>
      useComposerState("sess-1", SESSION_FIELDS),
    );
    expect(result.current.loading).toBe(true);
    expect(result.current.phase).toBeNull();
    expect(result.current.handleAsk).toBe(SESSION_FIELDS.handleAsk);
    expect(result.current.handleCancel).toBe(SESSION_FIELDS.handleCancel);
    expect(result.current.draft).toBe("");
  });

  it("draft persists across the null-to-non-null cold-start transition", () => {
    const { result, rerender } = renderHook(
      ({ sid }) => useTestComposerState(sid, SESSION_FIELDS),
      { initialProps: { sid: null as string | null } },
    );
    // Type a cold-start question before a session exists.
    act(() => result.current.setDraft("cold start question"));
    expect(result.current.draft).toBe("cold start question");
    // A session is created — sessionId transitions to non-null.
    rerender({ sid: "sess-1" });
    // The draft survives the transition (ADR-0092 core contract).
    expect(result.current.draft).toBe("cold start question");
    // Session fields now come from the caller, not IDLE defaults.
    expect(result.current.loading).toBe(true);
  });

  it("setDraft updates the owned draft", () => {
    const { result } = renderHook(() => useComposerState(null));
    act(() => result.current.setDraft("hello"));
    expect(result.current.draft).toBe("hello");
    act(() => result.current.setDraft(""));
    expect(result.current.draft).toBe("");
  });

  it("idle handleAsk resolves without throwing", async () => {
    const { result } = renderHook(() => useComposerState(null));
    await act(async () => {
      await result.current.handleAsk("test question");
      await result.current.handleCancel();
    });
    // No throw = pass. The log.warn inside idleHandleAsk is fire-and-forget;
    // its IPC rejection is swallowed by the log module (ADR-0029 honest-degrade).
  });
});
