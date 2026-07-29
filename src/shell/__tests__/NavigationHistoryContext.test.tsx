import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { NavigationHistoryProvider } from "../NavigationHistoryContext";
import { useNavigationHistory } from "../useNavigationHistory";
import type { NavEntry } from "../navigationHistory";

// Issue #288: the provider owns the stack; a location change pushes, and
// back/forward move the cursor + call `restore` so the consumer re-applies the
// target view via its RAW setters. These tests drive the provider through its
// public surface (a location prop + a restore spy) the way App does -- the pure
// stack transitions are covered separately in navigationHistory.test.ts.

const session = (id: string | null): NavEntry => ({
  sessionId: id,
  settings: { open: false, section: "general" },
});

// setup renders the hook inside a provider whose location reads from a mutable
// ref, so a test "navigates" by mutating the ref + rerendering (exactly how App
// drives a derived location through useMemo). Returns the live hook result, a
// navigate() helper, and the restore spy.
function setup(initial: NavEntry = session("s1")) {
  const restore = vi.fn();
  const ref: { current: NavEntry } = { current: initial };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationHistoryProvider location={ref.current} restore={restore}>
      {children}
    </NavigationHistoryProvider>
  );
  const { result, rerender } = renderHook(() => useNavigationHistory(), { wrapper });
  const navigate = (next: NavEntry) => {
    ref.current = next;
    rerender();
  };
  return { result, navigate, restore };
}

describe("NavigationHistoryProvider (issue #288)", () => {
  it("seeds with a single entry: no back/forward", () => {
    const { result } = setup();
    expect(result.current.canBack).toBe(false);
    expect(result.current.canForward).toBe(false);
  });

  it("a location change pushes and enables back", () => {
    const { result, navigate } = setup();
    navigate(session("s2"));
    expect(result.current.canBack).toBe(true);
    expect(result.current.canForward).toBe(false);
  });

  it("back restores the previous entry and flips the affordance", () => {
    const { result, navigate, restore } = setup();
    navigate(session("s2"));
    act(() => result.current.back());
    expect(restore).toHaveBeenCalledWith(session("s1"));
    expect(result.current.canBack).toBe(false);
    expect(result.current.canForward).toBe(true);
  });

  it("forward restores the next entry after a back", () => {
    const { result, navigate, restore } = setup();
    navigate(session("s2"));
    act(() => result.current.back());
    restore.mockClear();
    act(() => result.current.forward());
    expect(restore).toHaveBeenCalledWith(session("s2"));
    expect(result.current.canForward).toBe(false);
  });

  it("back at the head and forward at the tail are no-ops (no restore)", () => {
    const { result, navigate, restore } = setup();
    act(() => result.current.back());
    expect(restore).not.toHaveBeenCalled();
    navigate(session("s2"));
    act(() => result.current.forward());
    expect(restore).not.toHaveBeenCalled();
  });

  it("a new location after going back truncates the forward branch", () => {
    const { result, navigate, restore } = setup();
    navigate(session("s2"));
    navigate(session("s3"));
    act(() => result.current.back()); // cursor at s2; s3 becomes a forward entry
    // Simulate restore re-applying s2 to the location: in App, back/forward
    // drives the same state location is derived from, so the restore always
    // lands a location change that consumes the skip flag before the next nav.
    navigate(session("s2"));
    restore.mockClear();
    navigate(session("s4")); // a new navigation drops the s3 branch
    expect(result.current.canForward).toBe(false);
    expect(result.current.canBack).toBe(true);
  });

  it("a restore-driven location change does not grow the stack", () => {
    // s1 -> s2 -> s3, back twice to s1; restore would re-apply s1 as the
    // location. Assert the forward branch is preserved (the restore path is a
    // cursor move, not a new navigation that truncates + re-pushes).
    const { result, navigate } = setup();
    navigate(session("s2"));
    navigate(session("s3"));
    act(() => result.current.back()); // cursor -> s2
    act(() => result.current.back()); // cursor -> s1
    // Simulate restore re-applying s1 to the location.
    navigate(session("s1"));
    // The forward branch to s2/s3 is intact.
    expect(result.current.canForward).toBe(true);
    act(() => result.current.forward());
    expect(result.current.canForward).toBe(true);
    act(() => result.current.forward());
    expect(result.current.canForward).toBe(false); // tail (s3)
  });

  it("useNavigationHistory throws outside a provider", () => {
    // Suppress React's expected console.error for the thrown render.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useNavigationHistory())).toThrow(
      /must be used within a NavigationHistoryProvider/,
    );
    spy.mockRestore();
  });
});
