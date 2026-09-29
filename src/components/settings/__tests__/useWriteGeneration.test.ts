import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useWriteGeneration } from "../useWriteGeneration";
import { baseAppConfig } from "../../../test-fixtures";

// No provider needed: the guard touches refs and the injected sync only.

describe("useWriteGeneration", () => {
  it("advances the generation with every applied user write", () => {
    const onSync = vi.fn();
    const { result } = renderHook(() => useWriteGeneration(onSync));
    expect(result.current.current()).toBe(0);
    act(() => {
      result.current.applyUserWrite(baseAppConfig());
    });
    expect(result.current.current()).toBe(1);
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it("skips a stale sync whose generation predates the latest write", () => {
    const onSync = vi.fn();
    const { result } = renderHook(() => useWriteGeneration(onSync));
    const staleGen = result.current.current();
    act(() => {
      result.current.applyUserWrite(baseAppConfig());
    });
    act(() => {
      result.current.syncIfCurrent(staleGen, baseAppConfig());
    });
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it("applies a sync whose generation is still current", () => {
    const onSync = vi.fn();
    const { result } = renderHook(() => useWriteGeneration(onSync));
    const gen = result.current.current();
    const next = baseAppConfig();
    act(() => {
      result.current.syncIfCurrent(gen, next);
    });
    expect(onSync).toHaveBeenCalledWith(next);
  });
});
