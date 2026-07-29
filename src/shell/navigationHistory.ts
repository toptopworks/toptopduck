// Browser-style navigation history stack for the in-app back/forward buttons
// (issue #288). Pure, router-agnostic transitions -- the stateful wiring (push
// on location change + skipNextRef on back/forward restore) lives in
// NavigationHistoryContext. The algorithm mirrors a browser history: a new
// navigation truncates any forward branch, then appends; the cursor walks the
// stack without growing it.
//
// NavEntry describes a toptopduck view: the active session (null = cold-start
// hero) + the settings overlay state (open + section). editProfileId is
// intentionally excluded -- it is a one-shot mount hint, not a restorable
// destination (issue #288).

import type { SettingsSection } from "../components/settings/sections";

/** A navigable toptopduck view, captured for the back/forward stack. */
export type NavEntry = {
  /** The active session id, or null on the cold-start hero. */
  sessionId: string | null;
  /** The settings overlay state. section is the live section (authoritative
   *  while open; retained as-is while closed so a re-open stays consistent). */
  settings: { open: boolean; section: SettingsSection };
};

/** The history stack + cursor. cursor points at the current entry. */
export type HistoryState = {
  stack: NavEntry[];
  cursor: number;
};

/** Cap so an unbounded nav session cannot grow the stack without limit; the
 *  oldest entries drop first, browser-style. */
export const MAX_HISTORY = 50;

/** Structural equality on NavEntry -- same session + same settings open/section.
 *  Used so re-deriving an unchanged location is a push no-op. */
export function entriesEqual(a: NavEntry, b: NavEntry): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.settings.open === b.settings.open &&
    a.settings.section === b.settings.section
  );
}

/** Initial state: a single-entry stack seeded with the current view. */
export function createHistory(initial: NavEntry): HistoryState {
  return { stack: [initial], cursor: 0 };
}

/** Whether back() would move the cursor. */
export function canBack(state: HistoryState): boolean {
  return state.cursor > 0;
}

/** Whether forward() would move the cursor. */
export function canForward(state: HistoryState): boolean {
  return state.cursor < state.stack.length - 1;
}

/** Push a new entry: a no-op (same identity) if it equals the current cursor
 *  entry; otherwise truncate any forward branch, append, and cap at
 *  MAX_HISTORY (dropping oldest). Immutable -- returns a new state. */
export function pushEntry(state: HistoryState, entry: NavEntry): HistoryState {
  const current = state.stack[state.cursor];
  if (current !== undefined && entriesEqual(current, entry)) {
    return state;
  }
  const truncated = state.stack.slice(0, state.cursor + 1);
  truncated.push(entry);
  if (truncated.length <= MAX_HISTORY) {
    return { stack: truncated, cursor: truncated.length - 1 };
  }
  // Over cap: drop from the oldest side, keep the cursor at the new tail.
  const overflow = truncated.length - MAX_HISTORY;
  const trimmed = truncated.slice(overflow);
  return { stack: trimmed, cursor: trimmed.length - 1 };
}

/** Move the cursor back one entry; a no-op (same identity) at the head. */
export function moveBack(state: HistoryState): HistoryState {
  if (!canBack(state)) return state;
  return { stack: state.stack, cursor: state.cursor - 1 };
}

/** Move the cursor forward one entry; a no-op (same identity) at the tail. */
export function moveForward(state: HistoryState): HistoryState {
  if (!canForward(state)) return state;
  return { stack: state.stack, cursor: state.cursor + 1 };
}
