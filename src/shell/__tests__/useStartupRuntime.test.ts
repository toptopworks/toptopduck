// Cold-start startup-runtime resolution (ADR-0098 Decisions 2/3, issue #572).
// The pure seam mirrors the Rust `commands::resolve_default_runtime`: the
// persisted `default_runtime` plus the detected adapter table resolve to the
// runtime a cold start opens on, degrading to built-in when the named CLI is
// undetected / outside the table / the table has not loaded yet. The hook
// wraps that seam over the shared adapterKeys cache so the shell (App) can
// read the resolution without living inside <QueryClientProvider>.

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../lib/queryClient";
import { useStartupRuntime } from "../useStartupRuntime";
import { adapterKeys } from "../../session/queryKeys";
import {
  RUNTIME_CHOICE_DEFAULT,
  resolveStartupRuntime,
  type AdapterEntry,
} from "../../types/runtime";
import type { DefaultRuntime } from "../../types/app-config";
import { listAdapters } from "../../api";

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return { ...actual, listAdapters: vi.fn() };
});

function entry(id: string, detected: boolean): AdapterEntry {
  return {
    id,
    display_name: id,
    detected,
    binary_path: detected ? `/bin/${id}` : null,
    stream_format: "acp",
  };
}

const EXTERNAL_QWEN: DefaultRuntime = { kind: "external", data: "qwen-code" };

describe("resolveStartupRuntime (pure seam)", () => {
  it("resolves a built-in / pending app-config to the built-in default", () => {
    expect(resolveStartupRuntime({ kind: "built_in" }, [entry("qwen-code", true)]))
      .toEqual(RUNTIME_CHOICE_DEFAULT);
    expect(resolveStartupRuntime(undefined, [entry("qwen-code", true)]))
      .toEqual(RUNTIME_CHOICE_DEFAULT);
  });

  it("resolves a detected external default to that external choice", () => {
    expect(
      resolveStartupRuntime(EXTERNAL_QWEN, [entry("gemini-cli", false), entry("qwen-code", true)]),
    ).toEqual({ kind: "external", data: "qwen-code" });
  });

  it("degrades to built-in when the default names an undetected adapter", () => {
    expect(resolveStartupRuntime(EXTERNAL_QWEN, [entry("qwen-code", false)]))
      .toEqual(RUNTIME_CHOICE_DEFAULT);
  });

  it("degrades to built-in when the id is outside the adapter table", () => {
    expect(resolveStartupRuntime(EXTERNAL_QWEN, [entry("gemini-cli", true)]))
      .toEqual(RUNTIME_CHOICE_DEFAULT);
    expect(resolveStartupRuntime(EXTERNAL_QWEN, [])).toEqual(RUNTIME_CHOICE_DEFAULT);
  });

  it("degrades to built-in while the adapter table has not loaded", () => {
    expect(resolveStartupRuntime(EXTERNAL_QWEN, undefined))
      .toEqual(RUNTIME_CHOICE_DEFAULT);
  });
});

describe("useStartupRuntime (cache subscription)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the shared adapter table and resolves the external default", async () => {
    vi.mocked(listAdapters).mockResolvedValue([entry("qwen-code", true)]);
    const client = createQueryClient();
    const { result } = renderHook(() => useStartupRuntime(client, EXTERNAL_QWEN));
    // Before the table lands the resolution degrades to built-in.
    expect(result.current).toEqual(RUNTIME_CHOICE_DEFAULT);
    await waitFor(() =>
      expect(result.current).toEqual({ kind: "external", data: "qwen-code" }),
    );
    expect(listAdapters).toHaveBeenCalledTimes(1);
  });

  it("reuses the cache the picker already populated instead of re-fetching", () => {
    vi.mocked(listAdapters).mockResolvedValue([entry("qwen-code", true)]);
    const client = createQueryClient();
    client.setQueryData(adapterKeys.all(), [entry("qwen-code", true)]);
    const { result } = renderHook(() => useStartupRuntime(client, EXTERNAL_QWEN));
    expect(result.current).toEqual({ kind: "external", data: "qwen-code" });
    expect(listAdapters).not.toHaveBeenCalled();
  });

  it("re-resolves when the persisted default changes across renders", async () => {
    vi.mocked(listAdapters).mockResolvedValue([
      entry("qwen-code", true),
      entry("gemini-cli", true),
    ]);
    const client = createQueryClient();
    const { result, rerender } = renderHook(
      ({ dr }: { dr: DefaultRuntime }) => useStartupRuntime(client, dr),
      { initialProps: { dr: EXTERNAL_QWEN } },
    );
    await waitFor(() =>
      expect(result.current).toEqual({ kind: "external", data: "qwen-code" }),
    );
    act(() => {
      client.setQueryData(adapterKeys.all(), [
        entry("qwen-code", true),
        entry("gemini-cli", true),
      ]);
    });
    rerender({ dr: { kind: "external", data: "gemini-cli" } });
    expect(result.current).toEqual({ kind: "external", data: "gemini-cli" });
  });

  it("keeps the built-in degrade when the adapter read rejects", async () => {
    vi.mocked(listAdapters).mockRejectedValue(new Error("table read failed"));
    const client = createQueryClient();
    const { result } = renderHook(() => useStartupRuntime(client, EXTERNAL_QWEN));
    await waitFor(() => expect(listAdapters).toHaveBeenCalled());
    expect(result.current).toEqual(RUNTIME_CHOICE_DEFAULT);
  });
});
