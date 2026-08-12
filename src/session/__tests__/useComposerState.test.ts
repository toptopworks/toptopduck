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
  handleIngestFiles: vi.fn(),
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

describe("useComposerState (ADR-0092 per-session drafts)", () => {
  it("returns idle defaults when sessionId is null", () => {
    const { result } = renderHook(() => useComposerState(null));
    expect(result.current.loading).toBe(false);
    expect(result.current.phase).toBeNull();
    expect(result.current.draft).toBe("");
    expect(result.current.handleAsk).toBeInstanceOf(Function);
    expect(result.current.handleCancel).toBeInstanceOf(Function);
    expect(result.current.handleIngestFiles).toBeInstanceOf(Function);
  });

  it("passes through session fields merged with owned draft when sessionId is non-null", () => {
    const { result } = renderHook(() =>
      useComposerState("sess-1", SESSION_FIELDS),
    );
    expect(result.current.loading).toBe(true);
    expect(result.current.phase).toBeNull();
    expect(result.current.handleAsk).toBe(SESSION_FIELDS.handleAsk);
    expect(result.current.handleCancel).toBe(SESSION_FIELDS.handleCancel);
    expect(result.current.handleIngestFiles).toBe(SESSION_FIELDS.handleIngestFiles);
    expect(result.current.draft).toBe("");
  });

  it("cold-start draft is separate from session drafts (per-session routing)", () => {
    const { result, rerender } = renderHook(
      ({ sid }) => useTestComposerState(sid, SESSION_FIELDS),
      { initialProps: { sid: null as string | null } },
    );
    // Type a cold-start question before a session exists.
    act(() => result.current.setDraft("cold start question"));
    expect(result.current.draft).toBe("cold start question");
    // Switch to a session — its draft is empty (a different draft slot).
    rerender({ sid: "sess-1" });
    expect(result.current.draft).toBe("");
    // Switch back to cold start — the cold-start draft is retained.
    rerender({ sid: null });
    expect(result.current.draft).toBe("cold start question");
  });

  it("per-session drafts are independent across sessions", () => {
    const { result, rerender } = renderHook(
      ({ sid }) => useTestComposerState(sid, SESSION_FIELDS),
      { initialProps: { sid: "sess-1" as string | null } },
    );
    act(() => result.current.setDraft("question for sess-1"));
    expect(result.current.draft).toBe("question for sess-1");
    // Switch to a second session — its draft starts empty.
    rerender({ sid: "sess-2" });
    expect(result.current.draft).toBe("");
    act(() => result.current.setDraft("question for sess-2"));
    // Switch back to sess-1 — its draft is retained.
    rerender({ sid: "sess-1" });
    expect(result.current.draft).toBe("question for sess-1");
    // Switch to sess-2 — its draft is retained.
    rerender({ sid: "sess-2" });
    expect(result.current.draft).toBe("question for sess-2");
  });

  it("setDraft updates the owned draft", () => {
    const { result } = renderHook(() => useComposerState(null));
    act(() => result.current.setDraft("hello"));
    expect(result.current.draft).toBe("hello");
    act(() => result.current.setDraft(""));
    expect(result.current.draft).toBe("");
  });

  it("idle handlers resolve without throwing", async () => {
    const { result } = renderHook(() => useComposerState(null));
    await act(async () => {
      await result.current.handleAsk("test question");
      await result.current.handleCancel();
      result.current.handleIngestFiles(["/x.csv"]);
    });
    // No throw = pass.
  });
});
