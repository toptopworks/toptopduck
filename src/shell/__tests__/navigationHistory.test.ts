import { describe, expect, it } from "vitest";
import {
  canBack,
  canForward,
  createHistory,
  entriesEqual,
  MAX_HISTORY,
  moveBack,
  moveForward,
  pushEntry,
} from "../navigationHistory";
import type { HistoryState, NavEntry } from "../navigationHistory";

// Helpers build NavEntry variants so each case reads as a destination, not a
// literal object shape.
const session = (id: string | null): NavEntry => ({
  sessionId: id,
  settings: { open: false, section: "general" },
});
const settingsPane = (
  section: NavEntry["settings"]["section"],
  open = true,
): NavEntry => ({ sessionId: "s1", settings: { open, section } });

describe("navigationHistory pure stack", () => {
  it("createHistory seeds a single-entry stack at the head (no back/forward)", () => {
    const state = createHistory(session("s1"));
    expect(state.stack).toHaveLength(1);
    expect(state.cursor).toBe(0);
    expect(canBack(state)).toBe(false);
    expect(canForward(state)).toBe(false);
  });

  it("pushEntry appends a new entry and moves the cursor to the tail", () => {
    const state = pushEntry(createHistory(session("s1")), session("s2"));
    expect(state.stack).toHaveLength(2);
    expect(state.cursor).toBe(1);
    expect(state.stack[1]).toEqual(session("s2"));
    expect(canBack(state)).toBe(true);
    expect(canForward(state)).toBe(false);
  });

  it("pushEntry is a no-op (same identity) when the entry equals the current one", () => {
    const state = pushEntry(createHistory(session("s1")), session("s2"));
    expect(pushEntry(state, session("s2"))).toBe(state);
  });

  it("pushEntry after going back truncates the forward branch", () => {
    // Arrange: s1 -> s2 -> s3, then back to s2 (s3 becomes a forward entry).
    let state = createHistory(session("s1"));
    state = pushEntry(state, session("s2"));
    state = pushEntry(state, session("s3"));
    state = moveBack(state);
    expect(state.cursor).toBe(1);

    // Act: a new navigation from the middle drops the forward branch (s3).
    state = pushEntry(state, session("s4"));

    expect(state.stack.map((e) => e.sessionId)).toEqual(["s1", "s2", "s4"]);
    expect(canForward(state)).toBe(false);
  });

  it("moveBack / moveForward walk the cursor within bounds", () => {
    let state = createHistory(session("s1"));
    state = pushEntry(state, session("s2"));
    state = pushEntry(state, session("s3"));
    expect(state.cursor).toBe(2);

    state = moveBack(state);
    expect(state.cursor).toBe(1);
    state = moveBack(state);
    expect(state.cursor).toBe(0);
    expect(canBack(state)).toBe(false);

    state = moveForward(state);
    expect(state.cursor).toBe(1);
    expect(canForward(state)).toBe(true);
    state = moveForward(state);
    expect(canForward(state)).toBe(false);
  });

  it("moveBack at the head and moveForward at the tail are identity no-ops", () => {
    const head = createHistory(session("s1"));
    expect(moveBack(head)).toBe(head);
    const tail = pushEntry(pushEntry(head, session("s2")), session("s3"));
    expect(moveForward(tail)).toBe(tail);
  });

  it("pushEntry caps the stack at MAX_HISTORY, dropping the oldest entries", () => {
    // Arrange: seed s0, then push s1..sMAX (MAX pushes) -> MAX+1 attempted.
    let state = createHistory(session("s0"));
    for (let i = 1; i <= MAX_HISTORY; i++) {
      state = pushEntry(state, session(`s${i}`));
    }

    // Assert: cap drops s0; the tail (cursor) is the most recent push.
    expect(state.stack).toHaveLength(MAX_HISTORY);
    expect(state.cursor).toBe(state.stack.length - 1);
    expect(state.stack[0]).toEqual(session("s1"));
    expect(state.stack[state.cursor]).toEqual(session(`s${MAX_HISTORY}`));
  });

  it("entriesEqual distinguishes session, settings.open, and section", () => {
    expect(entriesEqual(session("s1"), session("s1"))).toBe(true);
    expect(entriesEqual(session("s1"), session("s2"))).toBe(false);
    expect(
      entriesEqual(
        { sessionId: "s1", settings: { open: true, section: "general" } },
        { sessionId: "s1", settings: { open: false, section: "general" } },
      ),
    ).toBe(false);
    expect(
      entriesEqual(
        { sessionId: "s1", settings: { open: true, section: "general" } },
        { sessionId: "s1", settings: { open: true, section: "engine" } },
      ),
    ).toBe(false);
  });

  it("settings section switches are distinct navigable entries", () => {
    // Arrange: general -> profiles -> engine within one open settings overlay.
    let state = createHistory(settingsPane("general"));
    state = pushEntry(state, settingsPane("profiles"));
    state = pushEntry(state, settingsPane("engine"));

    // Assert: back walks the section history in reverse.
    expect(canBack(state)).toBe(true);
    state = moveBack(state);
    expect(state.stack[state.cursor]).toEqual(settingsPane("profiles"));
    state = moveBack(state);
    expect(state.stack[state.cursor]).toEqual(settingsPane("general"));
  });

  it("a state object is never mutated by any transition", () => {
    const original: HistoryState = createHistory(session("s1"));
    const snapshot = { stack: [...original.stack], cursor: original.cursor };
    pushEntry(original, session("s2"));
    moveBack(original);
    moveForward(original);
    expect(original.stack).toEqual(snapshot.stack);
    expect(original.cursor).toBe(snapshot.cursor);
  });
});
