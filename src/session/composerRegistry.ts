import { useCallback, useState } from "react";
import type { ComposerSessionFields } from "./useComposerState";
import { IDLE_SESSION_FIELDS } from "./useComposerState";

// The shell-level composer registry (ADR-0092): the ONE owner of the
// per-session bar-fields registry and its sibling face, the scoped
// invocation staging. App wires the pane report callbacks through here and
// reads the active session's merged view; only call + render wiring stays
// behind.
//
// Identity contract (the single home of the ADR-0092 registry invariants --
// the prose that used to live next to every call site retired into this
// block): every handler inside a reported ComposerSessionFields payload
// (handleAsk / handleCancel / handleIngestFiles) MUST be useCallback-stable
// across renders: the pane's report effect lists them in its dependency
// array, so an unstable identity re-fires the report on every render, and
// each report re-renders the shell. The recorded failure
// (handleIntlError): react-intl shallow-compares ALL IntlProvider props to
// decide whether to rebuild the `intl` context object, so an inline-arrow
// onError there rebuilds `intl` every render, handing every session handler
// that lists `intl` in its useCallback deps a fresh identity -- which
// re-fires the pane's report effect on every render, looping the bar's
// fields registry forever. Never "fix" a stale-looking payload by ignoring
// handler identity:
// the identity IS semantic (the closures capture `intl` / setError state),
// and snapshotting handlers by value would pin stale closures. The
// module-level `handleIntlError` in App and the stable handlers inside
// useSessionState exist to satisfy this contract.
//
// The registry's own writes (report / reportUnmount) are identity-stable with
// no deps: SessionPane binds them as props and its report effect lists them
// in its dependency array, so an unstable identity here would re-fire the
// report on every render (the same loop, from the other side).

// Scoped invocation staging (ADR-0112 trigger-then-stage, calibrated by
// ADR-0119: a pick stages THIS turn's user invocation): ONE map keyed by the
// owning scope -- `null` is the cold-start shell memory, a session id the
// session view. The two former shapes (a cold list + a single view-scoped
// {sid, names} cell) had isomorphic lifecycles and only differed by key;
// the unified map keeps every behavior bit for bit:
//
// - The cold-start slot survives a session peek and dies only on the
//   minting submit's consume -- deliberate cross-facet coexistence.
// - Session staging is SINGLE-SLOT across sessions: staging under a NEW
//   session id replaces the previous session's entry (A stages, B stages,
//   back to A -> gone), while a switch without staging restores on return
//   (resume mints a fresh sid, so the restore never sees stale truth).
//   Widening the single slot to per-session persistence would be a behavior
//   change -- do not.
// - The staging materializes as the turn's invocation records at submit --
//   the ONLY materialization moment. The submitting view's clear
//   (consumeView) wipes the whole session face: the old single cell was
//   rebound to the submitting sid and emptied UNCONDITIONALLY, so a third
//   session's unsubmitted staging died with the submit -- kept bit for bit.
//   The cold slot dies only on the minting submit's consumeCold.
// - Closing a session drops its entry explicitly (dropSession) instead of
//   relying on the sid-mismatch implicit invalidation.
export type ComposerScope = string | null;

// What App consumes: the pane report face (SessionPane's onComposerFields /
// onComposerFieldsUnmount props bind to report / reportUnmount), the active
// session's merged fields (IDLE defaults folded in), the by-sid read the
// submit / cancel / ingest paths use, and the staging API (read / stage /
// withdraw / consume / dropSession). Every mutator is identity-stable with
// no deps; only readFields / readInvocations rebuild when their state does.
export interface ComposerRegistry {
  /** Store a session's bar-relevant fields (SessionPane's report effect). */
  report: (sessionId: string, fields: ComposerSessionFields) => void;
  /** Drop a session's entry on pane unmount (close / delete / error-boundary
   *  replacement): the removal intent is explicit at the type level instead
   *  of relying on a sentinel reference. */
  reportUnmount: (sessionId: string) => void;
  /** By-sid read for the shell's delegated paths (submit / cancel / ingest).
   *  Undefined while the pane has not reported yet -- the mint ->
   *  first-report window where the shell must never mint a second session. */
  readFields: (sessionId: string) => ComposerSessionFields | undefined;
  /** The active session's fields with the idle defaults folded in (cold
   *  start or the not-yet-reported window both read IDLE_SESSION_FIELDS). */
  readonly activeSessionFields: ComposerSessionFields;
  /** The staged names for a scope; [] when the scope has none. */
  readInvocations: (scope: ComposerScope) => string[];
  /** Stage names under a scope: merge-unique into an existing slot; a NEW
   *  session slot replaces the previous session's (single-slot semantics);
   *  the cold slot only ever merges. Empty lists are a no-op. */
  stage: (scope: ComposerScope, names: string[]) => void;
  /** Withdraw one name (chip removal / Backspace-at-draft-start). Unknown
   *  names and unknown scopes are no-ops. */
  withdraw: (scope: ComposerScope, name: string) => void;
  /** Consume the cold slot at the minting submit (its staging rides the
   *  pendingQuestion channel into the minted session's pane). */
  consumeCold: () => void;
  /** The submitting view's clear: wipe EVERY session slot in one stroke --
   *  the old single-cell submit rebound the cell to the submitting sid and
   *  emptied it unconditionally, so a third session's unsubmitted staging
   *  died with the submit. Kept bit for bit; the cold slot is untouched. */
  consumeView: () => void;
  /** Explicitly drop a closed / deleted session's entry so the map tracks
   *  the live session set. */
  dropSession: (sessionId: string) => void;
}

// The shared empty read: readInvocations hands out this one instance for
// scopes with no staging, so the empty case stays reference-stable across
// renders (a fresh [] per call would churn every consumer's deps arrays).
// Module-private and never mutated -- treat it as read-only.
const EMPTY_INVOCATIONS: string[] = [];

export function useComposerRegistry(activeSessionId: string | null): ComposerRegistry {
  // --- The bar-fields registry (ADR-0092) ----------------------------------
  const [fieldsMap, setFieldsMap] = useState<
    Record<string, ComposerSessionFields>
  >({});

  const report = useCallback(
    (sessionId: string, fields: ComposerSessionFields) => {
      setFieldsMap((prev) => ({ ...prev, [sessionId]: fields }));
    },
    [],
  );

  const reportUnmount = useCallback((sessionId: string) => {
    setFieldsMap((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  const readFields = useCallback(
    (sessionId: string) => fieldsMap[sessionId],
    [fieldsMap],
  );

  const activeSessionFields =
    activeSessionId !== null
      ? (fieldsMap[activeSessionId] ?? IDLE_SESSION_FIELDS)
      : IDLE_SESSION_FIELDS;

  // --- The scoped invocation staging (ADR-0112/0119) -----------------------
  // A Map (not a Record) because the cold scope is the null KEY itself --
  // precise at the type level instead of a "null" string sentinel.
  const [invocations, setInvocations] = useState<
    Map<ComposerScope, string[]>
  >(new Map());

  const stage = useCallback((scope: ComposerScope, names: string[]) => {
    if (names.length === 0) return;
    setInvocations((prev) => {
      const existing = prev.get(scope);
      if (existing !== undefined) {
        const merged = [
          ...existing,
          ...names.filter((n) => !existing.includes(n)),
        ];
        return merged.length === existing.length
          ? prev
          : new Map(prev).set(scope, merged);
      }
      if (scope === null) {
        return new Map(prev).set(scope, [...names]);
      }
      // A new session slot: the single-slot semantics -- the fresh view's
      // entry replaces the previous session's, and the cold-start slot
      // (if seeded) stays.
      const next: Map<ComposerScope, string[]> = new Map();
      const cold = prev.get(null);
      if (cold !== undefined) next.set(null, cold);
      next.set(scope, [...names]);
      return next;
    });
  }, []);

  const withdraw = useCallback((scope: ComposerScope, name: string) => {
    setInvocations((prev) => {
      const existing = prev.get(scope);
      if (existing === undefined) return prev;
      const filtered = existing.filter((n) => n !== name);
      return filtered.length === existing.length
        ? prev
        : new Map(prev).set(scope, filtered);
    });
  }, []);

  const consumeCold = useCallback(() => {
    setInvocations((prev) => {
      if (!prev.has(null)) return prev;
      const next = new Map(prev);
      next.delete(null);
      return next;
    });
  }, []);

  const consumeView = useCallback(() => {
    setInvocations((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const scope of [...next.keys()]) {
        if (scope !== null) {
          next.delete(scope);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const dropSession = useCallback((sessionId: string) => {
    setInvocations((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  return {
    report,
    reportUnmount,
    readFields,
    activeSessionFields,
    readInvocations: useCallback(
      (scope: ComposerScope) => invocations.get(scope) ?? EMPTY_INVOCATIONS,
      [invocations],
    ),
    stage,
    withdraw,
    consumeCold,
    consumeView,
    dropSession,
  };
}
