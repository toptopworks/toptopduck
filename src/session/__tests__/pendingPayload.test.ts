import { describe, expect, it, vi } from "vitest";
import { consumePendingPayload, type PendingPayloadDeps } from "../pendingPayload";

function baseDeps(overrides: Partial<PendingPayloadDeps> = {}): PendingPayloadDeps {
  return {
    sessionId: "sess-1",
    paths: ["/tmp/a.csv"],
    question: "chart it",
    invocations: ["charting"],
    consumedRef: { current: null },
    onIngestConsumed: vi.fn(),
    onQuestionConsumed: vi.fn(),
    onSeedDraft: vi.fn(),
    onSeedInvocations: vi.fn(),
    ingestMany: vi.fn().mockResolvedValue(true),
    ask: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("consumePendingPayload", () => {
  it("consumes a payload once: the same key never re-fires the clears or the ask", async () => {
    const deps = baseDeps();
    await consumePendingPayload(deps);
    await consumePendingPayload(deps);
    expect(deps.onIngestConsumed).toHaveBeenCalledTimes(1);
    expect(deps.onQuestionConsumed).toHaveBeenCalledTimes(1);
    expect(deps.ingestMany).toHaveBeenCalledTimes(1);
    expect(deps.ask).toHaveBeenCalledTimes(1);
  });

  it("seeds the draft and the staging back atomically when the ingest fails (#991)", async () => {
    const deps = baseDeps({ ingestMany: vi.fn().mockResolvedValue(false) });
    await consumePendingPayload(deps);
    expect(deps.onSeedDraft).toHaveBeenCalledWith("sess-1", "chart it");
    expect(deps.onSeedInvocations).toHaveBeenCalledWith("sess-1", ["charting"]);
    expect(deps.ask).not.toHaveBeenCalled();
  });

  it("awaits the ingest before asking, and asks with the staged invocations", async () => {
    const order: string[] = [];
    let resolveIngest!: (loaded: boolean) => void;
    const deps = baseDeps({
      ingestMany: vi.fn(() => new Promise<boolean>((resolve) => { resolveIngest = resolve; })),
      ask: vi.fn(async () => { order.push("ask"); }),
    });
    const done = consumePendingPayload(deps);
    // files-first ordering: the ask cannot fire underneath a pending ingest.
    expect(deps.ask).not.toHaveBeenCalled();
    resolveIngest(true);
    await done;
    expect(order).toEqual(["ask"]);
    expect(deps.ask).toHaveBeenCalledWith("chart it", ["charting"]);
    expect(deps.onSeedDraft).not.toHaveBeenCalled();
    expect(deps.onSeedInvocations).not.toHaveBeenCalled();
  });
});
