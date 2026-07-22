import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AppError } from "../../types/error";
import { useShellError } from "../useShellError";

// Issue #194: useShellError owns the shell-layer AppError state, extracted from
// <App>. The hook returns { shellError, setShellError }; setShellError is the
// raw useState dispatcher (clears on null, holds an AppError on set). The hook
// depends on the merged AppError shape, so its test rides the same slice.

describe("useShellError", () => {
  it("starts with shellError null", () => {
    const { result } = renderHook(() => useShellError());
    expect(result.current.shellError).toBeNull();
  });

  it("surfaces an AppError (kind shell) then clears on null", () => {
    const { result } = renderHook(() => useShellError());
    const err: AppError = {
      message: "close-wait timed out",
      kind: "shell",
      detail: "retry shortly",
    };
    act(() => result.current.setShellError(err));
    expect(result.current.shellError).toEqual(err);
    act(() => result.current.setShellError(null));
    expect(result.current.shellError).toBeNull();
  });

  it("setShellError identity is stable across renders (raw useState dispatcher)", () => {
    // App's async handlers close over setShellError; a wrapper that rebuilds each
    // render would force every handler onto a fresh dependency. The hook exposes
    // the raw dispatcher so the identity stays stable.
    const { result, rerender } = renderHook(() => useShellError());
    const first = result.current.setShellError;
    rerender();
    expect(result.current.setShellError).toBe(first);
  });
});
