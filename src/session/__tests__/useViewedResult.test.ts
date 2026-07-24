import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useViewedResult } from "../useViewedResult";
import { materialized, textual } from "./fixtures";
import type { ThreadEntry } from "../../types/thread";

// Issue #229: useViewedResult owns the viewedResult domain -- the state, the
// ADR-0062 R5 resume init, and the R2 pin rule -- collapsed out of
// useSessionState so the parent's turn/ingest flows drive it through semantic
// methods (markProduced / clearForNewSource / selectResult / suppressInit)
// instead of raw setViewedResult / setPinnedToHistory / a shared viewedInitRef.
// These tests pin the three behaviors the parent used to inline -- R5 resume
// landing, the selectResult pin rule, and the pin=false resets -- in isolation
// from react-query / intl (the hook takes the thread as a plain argument).

describe("useViewedResult", () => {
  describe("R5 resume init (ADR-0062 R5)", () => {
    it("starts on hero (viewedResult null) when the thread is empty", () => {
      const { result } = renderHook(({ thread }) => useViewedResult(thread), {
        initialProps: { thread: [] as ThreadEntry[] },
      });
      expect(result.current.viewedResult).toBeNull();
      expect(result.current.pinnedToHistory).toBe(false);
    });

    it("points viewedResult at the LAST Materialized on first content (resume landing)", () => {
      const { result, rerender } = renderHook(({ thread }) => useViewedResult(thread), {
        initialProps: { thread: [] as ThreadEntry[] },
      });
      rerender({ thread: [materialized("result_1"), materialized("result_2")] });
      // R5 scans tail-first; result_2 is the last Materialized -> the resume
      // landing is "where the user left off".
      expect(result.current.viewedResult?.referenceName).toBe("result_2");
      expect(result.current.pinnedToHistory).toBe(false);
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

  describe("selectResult pin rule (ADR-0047 + ADR-0062 R2)", () => {
    it("un-pins when selecting the LAST Materialized (it is the working position)", () => {
      const thread = [materialized("result_1"), materialized("result_2")];
      const { result } = renderHook(() => useViewedResult(thread));
      act(() => result.current.selectResult("result_2"));
      expect(result.current.viewedResult?.referenceName).toBe("result_2");
      expect(result.current.pinnedToHistory).toBe(false);
    });

    it("pins when selecting a NON-last Materialized (holds over a textual last turn)", () => {
      const thread = [materialized("result_1"), materialized("result_2")];
      const { result } = renderHook(() => useViewedResult(thread));
      act(() => result.current.selectResult("result_1"));
      expect(result.current.viewedResult?.referenceName).toBe("result_1");
      expect(result.current.pinnedToHistory).toBe(true);
    });

    it("pins when the last turn is textual and the user re-selects a past result", () => {
      // Last turn B/C/D + pinned -> viewedResult overrides the textual card
      // (ADR-0062 R2 -- the full path the pure-function workspace test covers).
      const thread = [materialized("result_1"), textual("which?")];
      const { result } = renderHook(() => useViewedResult(thread));
      act(() => result.current.selectResult("result_1"));
      expect(result.current.viewedResult?.referenceName).toBe("result_1");
      expect(result.current.pinnedToHistory).toBe(true);
    });
  });

  describe("markProduced / clearForNewSource (pin resets to false)", () => {
    it("markProduced selects the just-produced result with pin=false", () => {
      // Start pinned: select a non-last Materialized so pinnedToHistory=true.
      const { result } = renderHook(() =>
        useViewedResult([materialized("result_1"), materialized("result_2")]),
      );
      act(() => result.current.selectResult("result_1"));
      expect(result.current.pinnedToHistory).toBe(true);

      // A new Materialized turn produces result_3 -> viewedResult follows, pin resets.
      act(() => result.current.markProduced("result_3"));
      expect(result.current.viewedResult?.referenceName).toBe("result_3");
      expect(result.current.pinnedToHistory).toBe(false);
    });

    it("clearForNewSource resets viewedResult to null with pin=false", () => {
      const { result } = renderHook(() =>
        useViewedResult([materialized("result_1"), textual("q")]),
      );
      act(() => result.current.selectResult("result_1"));
      expect(result.current.viewedResult).not.toBeNull();
      expect(result.current.pinnedToHistory).toBe(true);
      act(() => result.current.clearForNewSource());
      expect(result.current.viewedResult).toBeNull();
      expect(result.current.pinnedToHistory).toBe(false);
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
