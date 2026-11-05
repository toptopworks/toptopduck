import { describe, expect, it, vi } from "vitest";
import { consumePendingPayload, type PendingPayloadDeps } from "../pendingPayload";

function baseDeps(overrides: Partial<PendingPayloadDeps> = {}): PendingPayloadDeps {
  return {
    paths: ["/tmp/a.csv"],
    question: "chart it",
    invocations: ["charting"],
    consumedRef: { current: null },
    onIngestConsumed: vi.fn(),
    onQuestionConsumed: vi.fn(),
    ingestMany: vi.fn().mockResolvedValue(true),
    hold: vi.fn(),
    ask: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("consumePendingPayload", () => {
  it("consumes a payload once: the same key never re-fires the clears or the hold", async () => {
    const deps = baseDeps();
    await consumePendingPayload(deps);
    await consumePendingPayload(deps);
    expect(deps.onIngestConsumed).toHaveBeenCalledTimes(1);
    expect(deps.onQuestionConsumed).toHaveBeenCalledTimes(1);
    expect(deps.ingestMany).toHaveBeenCalledTimes(1);
    expect(deps.hold).toHaveBeenCalledTimes(1);
    // The chain never asks directly: the queue slot's settle owns the exit.
    expect(deps.ask).not.toHaveBeenCalled();
  });

  it("hands the question to the queue slot; the slot owns the halt seed-back (#991 via #1500)", async () => {
    const deps = baseDeps({ ingestMany: vi.fn().mockResolvedValue(false) });
    await consumePendingPayload(deps);
    // The chain holds the question into the slot; the slot's settle(false)
    // exit does the seed-back through the #991 channels -- the chain
    // itself neither seeds nor asks.
    expect(deps.hold).toHaveBeenCalledWith("chart it", ["charting"]);
    expect(deps.ask).not.toHaveBeenCalled();
  });

  it("holds the question synchronously at arming, before the batch settles", async () => {
    let resolveIngest!: (loaded: boolean) => void;
    const deps = baseDeps({
      ingestMany: vi.fn(() => new Promise<boolean>((resolve) => { resolveIngest = resolve; })),
    });
    const done = consumePendingPayload(deps);
    // Files-first ordering: the slot is occupied at arming time, within the
    // same task, so a settle continuation can never race an empty slot.
    expect(deps.hold).toHaveBeenCalledTimes(1);
    expect(deps.ask).not.toHaveBeenCalled();
    resolveIngest(true);
    await done;
    expect(deps.ask).not.toHaveBeenCalled();
  });

  it("asks a bare question directly (no batch to hold behind)", async () => {
    const deps = baseDeps({ paths: [] });
    await consumePendingPayload(deps);
    expect(deps.ask).toHaveBeenCalledWith("chart it", ["charting"]);
    expect(deps.ingestMany).not.toHaveBeenCalled();
    expect(deps.hold).not.toHaveBeenCalled();
  });

  it("arms a files-only batch without holding a question", async () => {
    const deps = baseDeps({ question: null, invocations: [] });
    await consumePendingPayload(deps);
    expect(deps.ingestMany).toHaveBeenCalledTimes(1);
    expect(deps.hold).not.toHaveBeenCalled();
    expect(deps.ask).not.toHaveBeenCalled();
  });
});
