import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { mergeChipNames, useSkillChips } from "../useSkillChips";
import { listActivatedSkills, unmountSkill } from "../../../api";
import { sessionKeys } from "../../../session/queryKeys";

vi.mock("../../../api", () => ({
  listActivatedSkills: vi.fn(),
  unmountSkill: vi.fn(),
}));

function renderChips(opts: Parameters<typeof useSkillChips>[0]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rendered = renderHook(() => useSkillChips(opts), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  // The hook-result holder (`rendered.result`, the `{ current }` object the
  // tests read) plus the client, so tests can spy the cache surface.
  return { result: rendered.result, queryClient };
}

describe("useSkillChips (issue #961 chips union + removal dispatch)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listActivatedSkills).mockResolvedValue([]);
    vi.mocked(unmountSkill).mockResolvedValue(undefined);
  });

  it("unions the intents with the session's activated truth", async () => {
    vi.mocked(listActivatedSkills).mockResolvedValue(["sql-coach", "charting"]);
    const { result } = renderChips({
      sessionId: "s1",
      intents: ["charting", "data-cleaning"],
      onIntentRemove: () => {},
      onRemoveError: () => {},
    });
    await waitFor(() =>
      expect(result.current.names).toEqual([
        "charting",
        "data-cleaning",
        "sql-coach",
      ]),
    );
  });

  it("is the intents alone on the cold-start bar (no session queries)", async () => {
    const { result } = renderChips({
      sessionId: null,
      intents: ["charting"],
      onIntentRemove: () => {},
      onRemoveError: () => {},
    });
    expect(result.current.names).toEqual(["charting"]);
    expect(listActivatedSkills).not.toHaveBeenCalled();
  });

  it("removing an activated chip withdraws the intent and unmounts", async () => {
    vi.mocked(listActivatedSkills).mockResolvedValue(["sql-coach"]);
    const onIntentRemove = vi.fn();
    const { result, queryClient } = renderChips({
      sessionId: "s1",
      intents: ["sql-coach"],
      onIntentRemove,
      onRemoveError: () => {},
    });
    // names carrying the activated name is itself the proof the activated
    // cache resolved (the dispatch reads that cache).
    await waitFor(() => expect(result.current.names).toEqual(["sql-coach"]));
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    result.current.remove("sql-coach");
    expect(onIntentRemove).toHaveBeenCalledWith("sql-coach");
    await waitFor(() =>
      expect(unmountSkill).toHaveBeenCalledWith("s1", "sql-coach"),
    );
    // The three caches the fold touches (issue #961): mounted + activated
    // (the caches) and the thread (the Unmount lifecycle event lands on the
    // server timeline) each invalidate after the resolve.
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledTimes(3));
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: sessionKeys.mountedSkills("s1"),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: sessionKeys.activatedSkills("s1"),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: sessionKeys.thread("s1"),
    });
  });

  it("removing an intent-only chip never calls the unmount IPC", async () => {
    const onIntentRemove = vi.fn();
    const { result } = renderChips({
      sessionId: "s1",
      intents: ["charting"],
      onIntentRemove,
      onRemoveError: () => {},
    });
    await waitFor(() => expect(result.current.names).toEqual(["charting"]));
    result.current.remove("charting");
    expect(onIntentRemove).toHaveBeenCalledWith("charting");
    expect(unmountSkill).not.toHaveBeenCalled();
  });

  it("an unmount reject surfaces through the error channel", async () => {
    vi.mocked(listActivatedSkills).mockResolvedValue(["sql-coach"]);
    vi.mocked(unmountSkill).mockRejectedValue(new Error("turn in flight"));
    const onRemoveError = vi.fn();
    const { result } = renderChips({
      sessionId: "s1",
      intents: [],
      onIntentRemove: () => {},
      onRemoveError,
    });
    await waitFor(() => expect(result.current.names).toEqual(["sql-coach"]));
    result.current.remove("sql-coach");
    await waitFor(() => expect(onRemoveError).toHaveBeenCalled());
  });
});

describe("mergeChipNames (issue #961 chips display union)", () => {
  it("keeps intent order first, appends unseen activated names", () => {
    expect(mergeChipNames(["charting"], ["sql-coach", "charting", "pdf-tools"]))
      .toEqual(["charting", "sql-coach", "pdf-tools"]);
  });

  it("is the intents alone on the cold-start bar", () => {
    expect(mergeChipNames(["charting", "data-cleaning"], [])).toEqual([
      "charting",
      "data-cleaning",
    ]);
  });
});
