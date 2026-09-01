import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useViewedResult } from "../useViewedResult";
import { materialized, textual } from "./fixtures";
import type { ThreadEntry } from "../../types/thread";

// Tests for useViewedResult (issue #229) -- see useViewedResult.ts for the
// domain boundary. These pin the behaviors the parent used to inline -- R5
// resume landing and the viewedResult moves (ADR-0114 retired the pin flag;
// selection only moves viewedResult) -- in isolation from react-query /
// intl (the hook takes the thread as a plain argument).

describe("useViewedResult", () => {
  describe("R5 resume init (ADR-0062 R5)", () => {
    it("starts on hero (viewedResult null) when the thread is empty", () => {
      const { result } = renderHook(({ thread }) => useViewedResult(thread), {
        initialProps: { thread: [] as ThreadEntry[] },
      });
      expect(result.current.viewedResult).toBeNull();
    });

    it("points viewedResult at the LAST Materialized on first content (resume landing)", () => {
      const { result, rerender } = renderHook(({ thread }) => useViewedResult(thread), {
        initialProps: { thread: [] as ThreadEntry[] },
      });
      rerender({ thread: [materialized("result_1"), materialized("result_2")] });
      // R5 scans tail-first; result_2 is the last Materialized -> the resume
      // landing is "where the user left off".
      expect(result.current.viewedResult?.referenceName).toBe("result_2");
    });

    it("stays on hero when the thread has no Materialized turn", () => {
      const { result, rerender } = renderHook(({ thread }) => useViewedResult(thread), {
        initialProps: { thread: [] as ThreadEntry[] },
      });
      rerender({ thread: [textual("which?")] });
      expect(result.current.viewedResult).toBeNull();
    });

    it("runs at most once per mount (a later Materialized does not move viewedResult)", () => {
      const { result, rerender } = renderHook(({ thread }) => useViewedResult(thread), {
        initialProps: { thread: [materialized("result_1")] },
      });
      // R5 fired on initial content (viewedResult=result_1); a later thread
      // update must not re-fire R5 and yank viewedResult to result_2.
      rerender({ thread: [materialized("result_1"), materialized("result_2")] });
      expect(result.current.viewedResult?.referenceName).toBe("result_1");
    });
  });

  describe("selectResult (ADR-0114: moves only viewedResult)", () => {
    it("moves viewedResult to the clicked reference, history or current alike", () => {
      // No pin flag anymore: a history selection and the current working
      // position are the same action -- set viewedResult, nothing else.
      const thread = [materialized("result_1"), materialized("result_2")];
      const { result } = renderHook(() => useViewedResult(thread));
      act(() => result.current.selectResult("result_1"));
      expect(result.current.viewedResult?.referenceName).toBe("result_1");
      act(() => result.current.selectResult("result_2"));
      expect(result.current.viewedResult?.referenceName).toBe("result_2");
    });
  });

  describe("markProduced / clearForNewSource", () => {
    it("markProduced selects the just-produced result", () => {
      const { result } = renderHook(() => useViewedResult([materialized("result_1")]));
      act(() => result.current.markProduced("result_3"));
      expect(result.current.viewedResult?.referenceName).toBe("result_3");
    });

    it("clearForNewSource resets viewedResult to null", () => {
      const { result } = renderHook(() =>
        useViewedResult([materialized("result_1"), textual("q")]),
      );
      act(() => result.current.selectResult("result_1"));
      expect(result.current.viewedResult).not.toBeNull();
      act(() => result.current.clearForNewSource());
      expect(result.current.viewedResult).toBeNull();
    });
  });

  describe("jumpToLatest (issue #757 back-to-latest exit)", () => {
    it("moves viewedResult to the latest Materialized primary", () => {
      const thread = [materialized("result_1"), materialized("result_2")];
      const { result } = renderHook(() => useViewedResult(thread));
      act(() => result.current.selectResult("result_1"));
      act(() => result.current.jumpToLatest());
      expect(result.current.viewedResult?.referenceName).toBe("result_2");
    });

    it("skips trailing non-materialized turns", () => {
      const thread = [materialized("result_1"), materialized("result_2"), textual("which?")];
      const { result } = renderHook(() => useViewedResult(thread));
      act(() => result.current.selectResult("result_1"));
      act(() => result.current.jumpToLatest());
      expect(result.current.viewedResult?.referenceName).toBe("result_2");
    });

    it("falls back to hero when the thread materialized no primary", () => {
      // Defensive landing: the exit button is only reachable while a result is
      // showing (so some Materialized turn exists), but the move itself must
      // degrade to hero rather than crash on a primary-less thread.
      const { result } = renderHook(() => useViewedResult([textual("which?")]));
      act(() => result.current.jumpToLatest());
      expect(result.current.viewedResult).toBeNull();
    });
  });

  describe("suppressInit", () => {
    it("prevents the R5 resume init from firing on later thread content", () => {
      const { result, rerender } = renderHook(({ thread }) => useViewedResult(thread), {
        initialProps: { thread: [] as ThreadEntry[] },
      });
      // The parent's handleAsk calls suppressInit() right after the optimistic
      // thread append (any outcome) -- the user has acted, so R5 is moot even
      // if the thread query resolves later.
      act(() => result.current.suppressInit());
      rerender({ thread: [materialized("result_1")] });
      expect(result.current.viewedResult).toBeNull();
    });
  });
});
