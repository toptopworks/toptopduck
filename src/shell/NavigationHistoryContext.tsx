import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  canBack,
  canForward,
  createHistory,
  moveBack,
  moveForward,
  pushEntry,
  type HistoryState,
  type NavEntry,
} from "./navigationHistory";
import { NavigationHistoryContext, type NavigationHistoryValue } from "./useNavigationHistory";

// Provider for the in-app back/forward navigation history (issue #288). Owns the
// browser-style stack (pure transitions in navigationHistory.ts) and is the
// single seam between toptopduck's state-driven navigation model and the
// back/forward buttons. There is no router (issue #288 Context: a router's
// one-Route-at-a-time model is incompatible with ADR-0051 session keep-alive),
// so the consumer derives a NavEntry "location" from activeSessionId + the
// settings overlay state and passes it in; this provider pushes on every
// location change.
//
// back()/forward() move the cursor and call `restore` to re-apply the target
// view via the consumer's RAW setters. A skipNextRef flag tells the location
// effect to ignore the location change that restore just caused -- otherwise
// walking the stack would re-push the restored entry (the classic effect loop).
//
// The Context object + useNavigationHistory consumer live in useNavigationHistory.ts
// (react-refresh: keep this file component-export-only).

type ProviderProps = {
  /** The current toptopduck view (active session + settings overlay state),
   *  derived by the consumer. The provider pushes a new entry on every change. */
  location: NavEntry;
  /** Re-apply a history entry to the app WITHOUT pushing (used by back/forward).
   *  Must drive the same state the location is derived from, via raw setters --
   *  NOT nav-wrappers -- so the resulting location change is skipped, not
   *  re-pushed. */
  restore: (entry: NavEntry) => void;
  children: ReactNode;
};

export function NavigationHistoryProvider({ location, restore, children }: ProviderProps) {
  const [state, setState] = useState<HistoryState>(() => createHistory(location));

  // Latest stack+cursor so back/forward can read the target entry synchronously
  // without making their identities depend on `state` (which would churn the
  // context value every push). Mirrored in an effect (react-hooks/refs: never
  // write a ref during render); read only in handlers.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // skipNextRef: set by back/forward before restore so the location change they
  // cause is treated as a cursor move, not a new navigation.
  const skipNextRef = useRef(false);

  // restore in a ref so the push effect can stay subscribed to `location` only
  // (re-subscribing on every restore identity change would re-fire the push).
  const restoreRef = useRef(restore);
  useEffect(() => {
    restoreRef.current = restore;
  }, [restore]);

  // Push on location change. On mount this compares location to the seeded
  // single entry and is a no-op (pushEntry returns the same state for an equal
  // current entry, so React bails out). A restore-driven change is skipped.
  useEffect(() => {
    if (skipNextRef.current) {
      skipNextRef.current = false;
      return;
    }
    setState((prev) => pushEntry(prev, location));
  }, [location]);

  const back = useCallback(() => {
    const prev = stateRef.current;
    if (!canBack(prev)) return;
    const target = prev.stack[prev.cursor - 1];
    if (!target) return;
    setState(moveBack(prev));
    skipNextRef.current = true;
    restoreRef.current(target);
  }, []);

  const forward = useCallback(() => {
    const prev = stateRef.current;
    if (!canForward(prev)) return;
    const target = prev.stack[prev.cursor + 1];
    if (!target) return;
    setState(moveForward(prev));
    skipNextRef.current = true;
    restoreRef.current(target);
  }, []);

  const value = useMemo<NavigationHistoryValue>(
    () => ({ canBack: canBack(state), canForward: canForward(state), back, forward }),
    [state, back, forward],
  );

  return (
    <NavigationHistoryContext.Provider value={value}>{children}</NavigationHistoryContext.Provider>
  );
}
