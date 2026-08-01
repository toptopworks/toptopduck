import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useWorkspaceCollapse } from "../useWorkspaceCollapse";

// Tests for useWorkspaceCollapse (issue #298) -- the ADR-0083 workspace
// fold state machine: cold-start collapsed, the first result_N promotion
// auto-expands ONCE (session-ephemeral one-shot), everything after is manual.
// The hook is plain React state (no query / intl deps), so renderHook drives
// it directly.

describe("useWorkspaceCollapse", () => {
  describe("cold start (ADR-0083 default fold)", () => {
    it("starts collapsed on mount (app / session start)", () => {
      // Every mount is a cold start: a fresh SessionPane (new session, app
      // launch, resume) always begins folded -- the last expand state is
      // never remembered.
      const { result } = renderHook(() => useWorkspaceCollapse());
      expect(result.current.workspaceCollapsed).toBe(true);
    });

    it("starts collapsed again on remount (no persistence across sessions)", () => {
      const { result, unmount } = renderHook(() => useWorkspaceCollapse());
      act(() => result.current.expandWorkspace());
      expect(result.current.workspaceCollapsed).toBe(false);
      unmount();
      const remounted = renderHook(() => useWorkspaceCollapse());
      expect(remounted.result.current.workspaceCollapsed).toBe(true);
    });
  });

  describe("manual fold (session-ephemeral)", () => {
    it("toggleWorkspace flips the current state", () => {
      const { result } = renderHook(() => useWorkspaceCollapse());
      act(() => result.current.toggleWorkspace());
      expect(result.current.workspaceCollapsed).toBe(false);
      act(() => result.current.toggleWorkspace());
      expect(result.current.workspaceCollapsed).toBe(true);
    });

    it("expandWorkspace is idempotent when already expanded", () => {
      const { result } = renderHook(() => useWorkspaceCollapse());
      act(() => result.current.expandWorkspace());
      act(() => result.current.expandWorkspace());
      expect(result.current.workspaceCollapsed).toBe(false);
    });
  });

  describe("first-promotion auto-expand once (ADR-0083)", () => {
    it("the first notePromotion expands the collapsed workspace", () => {
      const { result } = renderHook(() => useWorkspaceCollapse());
      act(() => result.current.notePromotion());
      expect(result.current.workspaceCollapsed).toBe(false);
    });

    it("a second notePromotion does NOT re-expand after a manual collapse", () => {
      const { result } = renderHook(() => useWorkspaceCollapse());
      act(() => result.current.notePromotion());
      expect(result.current.workspaceCollapsed).toBe(false);
      // The user folds it back via the header toggle; the one-shot is spent.
      act(() => result.current.toggleWorkspace());
      act(() => result.current.notePromotion());
      expect(result.current.workspaceCollapsed).toBe(true);
    });

    it("later promotions stay manual even without an intervening collapse", () => {
      // The one-shot is consumed by the FIRST promotion regardless of the
      // fold state it found -- a second promotion never moves the fold.
      const { result } = renderHook(() => useWorkspaceCollapse());
      act(() => result.current.notePromotion());
      act(() => result.current.toggleWorkspace());
      act(() => result.current.notePromotion());
      act(() => result.current.notePromotion());
      expect(result.current.workspaceCollapsed).toBe(true);
    });

    it("a manual expand before any promotion still spends the one-shot", () => {
      // The user opened the workspace themselves first; the first promotion
      // then has nothing to teach ("the full picture lives here" was already
      // discovered), so a later collapse stays collapsed.
      const { result } = renderHook(() => useWorkspaceCollapse());
      act(() => result.current.expandWorkspace());
      act(() => result.current.notePromotion());
      act(() => result.current.toggleWorkspace());
      act(() => result.current.notePromotion());
      expect(result.current.workspaceCollapsed).toBe(true);
    });
  });
});
