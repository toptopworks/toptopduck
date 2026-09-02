import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useWorkspaceCollapse } from "../useWorkspaceCollapse";
import { materialized, textual } from "./fixtures";
import type { ThreadEntry } from "../../types/thread";

// Tests for useWorkspaceCollapse (issue #298) -- the ADR-0083 workspace
// fold state machine: cold-start collapsed, the first result_N promotion
// auto-expands ONCE, everything after is manual. Issue #771 scopes the
// one-shot to the session, not the mount: its consumption derives from the
// thread, so a remount onto an already-materialized session finds it spent.
// The hook is plain React state (no query / intl deps; the thread is a plain
// argument), so renderHook drives it directly.

describe("useWorkspaceCollapse", () => {
  describe("cold start (ADR-0083 default fold)", () => {
    it("starts collapsed on mount (app / session start)", () => {
      // Every mount is a cold start: a fresh SessionPane (new session, app
      // launch, resume) always begins folded -- the last expand state is
      // never remembered. [] = the thread query has not resolved yet.
      const { result } = renderHook(() => useWorkspaceCollapse([]));
      expect(result.current.workspaceCollapsed).toBe(true);
    });

    it("starts collapsed again on remount (no persistence across sessions)", () => {
      const { result, unmount } = renderHook(() => useWorkspaceCollapse([]));
      act(() => result.current.expandWorkspace());
      expect(result.current.workspaceCollapsed).toBe(false);
      unmount();
      const remounted = renderHook(() => useWorkspaceCollapse([]));
      expect(remounted.result.current.workspaceCollapsed).toBe(true);
    });
  });

  describe("manual fold (session-ephemeral)", () => {
    it("toggleWorkspace flips the current state", () => {
      const { result } = renderHook(() => useWorkspaceCollapse([]));
      act(() => result.current.toggleWorkspace());
      expect(result.current.workspaceCollapsed).toBe(false);
      act(() => result.current.toggleWorkspace());
      expect(result.current.workspaceCollapsed).toBe(true);
    });

    it("expandWorkspace is idempotent when already expanded", () => {
      const { result } = renderHook(() => useWorkspaceCollapse([]));
      act(() => result.current.expandWorkspace());
      act(() => result.current.expandWorkspace());
      expect(result.current.workspaceCollapsed).toBe(false);
    });
  });

  describe("first-promotion auto-expand once (ADR-0083)", () => {
    it("the first notePromotion expands the collapsed workspace", () => {
      const { result } = renderHook(() => useWorkspaceCollapse([]));
      act(() => result.current.notePromotion());
      expect(result.current.workspaceCollapsed).toBe(false);
    });

    it("a second notePromotion does NOT re-expand after a manual collapse", () => {
      const { result } = renderHook(() => useWorkspaceCollapse([]));
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
      const { result } = renderHook(() => useWorkspaceCollapse([]));
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
      const { result } = renderHook(() => useWorkspaceCollapse([]));
      act(() => result.current.expandWorkspace());
      act(() => result.current.notePromotion());
      act(() => result.current.toggleWorkspace());
      act(() => result.current.notePromotion());
      expect(result.current.workspaceCollapsed).toBe(true);
    });
  });

  describe("session-scoped one-shot (issue #771)", () => {
    it("treats the one-shot as consumed when the mount lands on a materialized thread", () => {
      // Session switch / resume / app restart onto a session that already
      // materialized results: "the full picture lives here" has nothing left
      // to teach, so the next promotion must not steal the fold.
      const { result } = renderHook(() => useWorkspaceCollapse([materialized("result_1")]));
      act(() => result.current.notePromotion());
      expect(result.current.workspaceCollapsed).toBe(true);
    });

    it("consumes via the empty -> content resolve (the resume query landing)", () => {
      // The thread arrives async: mount sees [], the query then resolves
      // with the materialized history -- the scan fires on first content,
      // not on the mount itself.
      const { result, rerender } = renderHook(({ thread }) => useWorkspaceCollapse(thread), {
        initialProps: { thread: [] as ThreadEntry[] },
      });
      rerender({ thread: [materialized("result_1"), textual("again?")] });
      act(() => result.current.notePromotion());
      expect(result.current.workspaceCollapsed).toBe(true);
    });

    it("keeps the one-shot armed when the thread has no Materialized turn", () => {
      // A resumed session that never materialized (text-only turns) still
      // gets the guide: the first promotion in this session is the first
      // result the user will have seen.
      const { result } = renderHook(() => useWorkspaceCollapse([textual("which?")]));
      act(() => result.current.notePromotion());
      expect(result.current.workspaceCollapsed).toBe(false);
      // ...and it stays spent afterwards (purely manual from here).
      act(() => result.current.toggleWorkspace());
      act(() => result.current.notePromotion());
      expect(result.current.workspaceCollapsed).toBe(true);
    });

    it("scans at most once -- a Materialized turn landing after the first content does not retro-consume", () => {
      // The fresh-session shape: mount sees [], the optimistic append lands
      // a non-materialized turn (first content; the scan runs, finds
      // nothing), then the promotion settles the turn Materialized in the
      // cache. The scan must not re-run over the settled history -- the
      // auto-expand of the live promotion depends on the one-shot staying
      // armed.
      const { result, rerender } = renderHook(({ thread }) => useWorkspaceCollapse(thread), {
        initialProps: { thread: [] as ThreadEntry[] },
      });
      rerender({ thread: [textual("q")] });
      rerender({ thread: [materialized("result_1")] });
      act(() => result.current.notePromotion());
      expect(result.current.workspaceCollapsed).toBe(false);
    });

    it("the manual fold paths are untouched by the consumption scan", () => {
      // A consumed one-shot silences promotions only; the header toggle and
      // the rail-selection expand keep full manual control.
      const { result } = renderHook(() => useWorkspaceCollapse([materialized("result_1")]));
      act(() => result.current.expandWorkspace());
      expect(result.current.workspaceCollapsed).toBe(false);
      act(() => result.current.toggleWorkspace());
      expect(result.current.workspaceCollapsed).toBe(true);
      act(() => result.current.notePromotion());
      expect(result.current.workspaceCollapsed).toBe(true);
    });
  });
});
