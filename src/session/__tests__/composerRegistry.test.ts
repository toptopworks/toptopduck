import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useComposerRegistry } from "../composerRegistry";
import {
  IDLE_SESSION_FIELDS,
  type ComposerSessionFields,
} from "../useComposerState";

function makeFields(
  overrides?: Partial<ComposerSessionFields>,
): ComposerSessionFields {
  return {
    loading: true,
    phase: null,
    turnStartedAt: null,
    turnPausedSince: null,
    handleAsk: vi.fn(),
    handleCancel: vi.fn(),
    handleIngestFiles: vi.fn(),
    workspaceCollapsed: false,
    ...overrides,
  };
}

const FIELDS_A = makeFields({ loading: true });
const FIELDS_B = makeFields({ loading: false, workspaceCollapsed: true });

function renderSeam(initialSid: string | null = null) {
  return renderHook(({ sid }) => useComposerRegistry(sid), {
    initialProps: { sid: initialSid },
  });
}

describe("useComposerRegistry (shell-level composer registry)", () => {
  it("reads idle defaults before any pane reports (mint -> first-report window)", () => {
    const { result, rerender } = renderSeam("sess-1");
    // No pane has reported for sess-1 yet: the bar renders the idle shape.
    expect(result.current.activeSessionFields).toBe(IDLE_SESSION_FIELDS);
    // Cold start reads idle too.
    rerender({ sid: null });
    expect(result.current.activeSessionFields).toBe(IDLE_SESSION_FIELDS);
  });

  it("reports a session's bar fields and reads them back for the active session", () => {
    const { result, rerender } = renderSeam("sess-1");
    act(() => result.current.report("sess-1", FIELDS_A));
    expect(result.current.activeSessionFields).toBe(FIELDS_A);
    // The active-session read tracks the active id, not the last report.
    rerender({ sid: "sess-2" });
    expect(result.current.activeSessionFields).toBe(IDLE_SESSION_FIELDS);
    rerender({ sid: "sess-1" });
    expect(result.current.activeSessionFields).toBe(FIELDS_A);
  });

  it("drops a session's entry on the unmount report (close / delete / error boundary)", () => {
    const { result, rerender } = renderSeam("sess-1");
    act(() => result.current.report("sess-1", FIELDS_A));
    act(() => result.current.reportUnmount("sess-1"));
    expect(result.current.activeSessionFields).toBe(IDLE_SESSION_FIELDS);
    // The other sessions' entries survive the removal.
    act(() => result.current.report("sess-2", FIELDS_B));
    act(() => result.current.reportUnmount("sess-1"));
    rerender({ sid: "sess-2" });
    expect(result.current.activeSessionFields).toBe(FIELDS_B);
  });

  it("keeps each session's entry when another session reports", () => {
    const { result, rerender } = renderSeam("sess-1");
    act(() => result.current.report("sess-1", FIELDS_A));
    act(() => result.current.report("sess-2", FIELDS_B));
    expect(result.current.readFields("sess-1")).toBe(FIELDS_A);
    expect(result.current.readFields("sess-2")).toBe(FIELDS_B);
    // The active read still tracks the active id, not the last report.
    expect(result.current.activeSessionFields).toBe(FIELDS_A);
    rerender({ sid: "sess-2" });
    expect(result.current.activeSessionFields).toBe(FIELDS_B);
  });

  it("readFields reads by explicit sid for the submit / cancel / ingest paths", () => {
    const { result } = renderSeam("sess-1");
    act(() => result.current.report("sess-1", FIELDS_A));
    expect(result.current.readFields("sess-1")).toBe(FIELDS_A);
    expect(result.current.readFields("sess-never-reported")).toBeUndefined();
  });
});

describe("useComposerRegistry (scoped invocation staging)", () => {
  it("cold staging survives a session peek (the null slot is shell memory)", () => {
    const { result, rerender } = renderSeam(null);
    act(() => result.current.stage(null, ["skill-a"]));
    // A peek at a session does not touch the cold-start list...
    rerender({ sid: "sess-1" });
    expect(result.current.readInvocations(null)).toEqual(["skill-a"]);
    // ...and returning to cold start restores it.
    rerender({ sid: null });
    expect(result.current.readInvocations(null)).toEqual(["skill-a"]);
  });

  it("cold and session slots coexist across facets", () => {
    const { result, rerender } = renderSeam(null);
    act(() => result.current.stage(null, ["skill-a"]));
    rerender({ sid: "sess-1" });
    act(() => result.current.stage("sess-1", ["skill-x"]));
    expect(result.current.readInvocations(null)).toEqual(["skill-a"]);
    expect(result.current.readInvocations("sess-1")).toEqual(["skill-x"]);
  });

  it("staging under a new session replaces the previous session's single slot (A stages, B stages, back to A -> gone)", () => {
    const { result, rerender } = renderSeam("sess-1");
    act(() => result.current.stage("sess-1", ["skill-x"]));
    rerender({ sid: "sess-2" });
    act(() => result.current.stage("sess-2", ["skill-y"]));
    // The single session slot moved to sess-2: sess-1's unsubmitted intent
    // was overwritten, so switching back finds nothing.
    expect(result.current.readInvocations("sess-1")).toEqual([]);
    expect(result.current.readInvocations("sess-2")).toEqual(["skill-y"]);
  });

  it("switching sessions without staging restores the original session's intents on return", () => {
    const { result, rerender } = renderSeam("sess-1");
    act(() => result.current.stage("sess-1", ["skill-x"]));
    rerender({ sid: "sess-2" });
    // No staging under sess-2: the slot still owns sess-1's intents.
    expect(result.current.readInvocations("sess-2")).toEqual([]);
    rerender({ sid: "sess-1" });
    expect(result.current.readInvocations("sess-1")).toEqual(["skill-x"]);
  });

  it("same-slot staging merges unique (a repeated pick lands once)", () => {
    const { result } = renderSeam("sess-1");
    act(() => result.current.stage("sess-1", ["x", "y"]));
    act(() => result.current.stage("sess-1", ["y", "z"]));
    expect(result.current.readInvocations("sess-1")).toEqual(["x", "y", "z"]);
    // The cold slot dedupes the same way.
    act(() => result.current.stage(null, ["c"]));
    act(() => result.current.stage(null, ["c", "d"]));
    expect(result.current.readInvocations(null)).toEqual(["c", "d"]);
  });

  it("the in-session submit clear wipes the whole session face (the old single-cell rebind, unconditionally)", () => {
    const { result, rerender } = renderSeam("sess-1");
    act(() => result.current.stage("sess-1", ["skill-x"]));
    // The cold slot is seeded too -- a session submit must not touch it.
    act(() => result.current.stage(null, ["skill-a"]));
    // Switch to sess-2 WITHOUT staging there, then submit in sess-2: the old
    // code rebound THE single cell to sess-2 and emptied it, killing
    // sess-1's unsubmitted intent with the submit.
    rerender({ sid: "sess-2" });
    act(() => result.current.consumeView());
    expect(result.current.readInvocations("sess-1")).toEqual([]);
    expect(result.current.readInvocations("sess-2")).toEqual([]);
    expect(result.current.readInvocations(null)).toEqual(["skill-a"]);
  });

  it("the minting submit consumes only the cold slot", () => {
    const { result, rerender } = renderSeam(null);
    act(() => result.current.stage(null, ["skill-a"]));
    rerender({ sid: "sess-1" });
    act(() => result.current.stage("sess-1", ["skill-x"]));
    act(() => result.current.consumeCold());
    expect(result.current.readInvocations(null)).toEqual([]);
    expect(result.current.readInvocations("sess-1")).toEqual(["skill-x"]);
  });

  it("dropSession explicitly removes a closed session's entry without touching other slots", () => {
    const { result, rerender } = renderSeam("sess-1");
    act(() => result.current.stage("sess-1", ["skill-x"]));
    // Close sess-1 with NO later staging under a new session: the single-slot
    // replacement has not fired, so this explicit drop is the only thing
    // that can remove the entry (the pin must not ride the replacement
    // baseline).
    act(() => result.current.dropSession("sess-1"));
    expect(result.current.readInvocations("sess-1")).toEqual([]);
    // The cold slot and later sessions are untouched by the drop.
    act(() => result.current.stage(null, ["skill-a"]));
    rerender({ sid: "sess-2" });
    act(() => result.current.stage("sess-2", ["skill-y"]));
    expect(result.current.readInvocations(null)).toEqual(["skill-a"]);
    expect(result.current.readInvocations("sess-2")).toEqual(["skill-y"]);
    // A never-staged sid drops as a no-op.
    act(() => result.current.dropSession("sess-never"));
    expect(result.current.readInvocations("sess-2")).toEqual(["skill-y"]);
  });

  it("withdraw removes one name from the scope's slot; unknown names and scopes are no-ops", () => {
    const { result } = renderSeam("sess-1");
    act(() => result.current.stage("sess-1", ["x", "y"]));
    act(() => result.current.withdraw("sess-1", "x"));
    expect(result.current.readInvocations("sess-1")).toEqual(["y"]);
    // Withdrawing a name the scope never staged changes nothing.
    act(() => result.current.withdraw("sess-1", "nope"));
    expect(result.current.readInvocations("sess-1")).toEqual(["y"]);
    // Withdrawing under a scope without a slot is a no-op (the chip lives in
    // another session's slot and is not reachable from here).
    act(() => result.current.withdraw("sess-2", "y"));
    expect(result.current.readInvocations("sess-1")).toEqual(["y"]);
  });

  it("stage with an empty list is a no-op (the seed channel guards empties)", () => {
    const { result } = renderSeam("sess-1");
    act(() => result.current.stage("sess-1", ["x"]));
    // An empty stage onto a NEW scope must not fire the single-slot
    // replacement (the guard is what keeps the live sibling alive).
    act(() => result.current.stage("sess-2", []));
    expect(result.current.readInvocations("sess-1")).toEqual(["x"]);
    expect(result.current.readInvocations("sess-2")).toEqual([]);
  });
});
