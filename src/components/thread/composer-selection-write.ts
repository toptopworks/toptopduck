import { useCallback, useEffect, useRef, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";

import {
  clearLastModelPosture,
  setSessionPosture,
  setSessionRuntime,
} from "../../api";
import { log } from "../../lib/log";
import { adapterKeys, sessionKeys } from "../../session/queryKeys";
import type { ModelPosture } from "../../types/app-config";
import type { SaveError } from "../../types/session";
import type { SessionModelConfig, SessionRuntimeChoice } from "../../types/runtime";
import { EMPTY_POSTURE, MODEL_CONFIG_DEFAULT } from "./posture-catalog";

// The composer selection write port (ADR-0095/0099/0100, issues #572/#574/
// #592): the ONE write face behind the picker's posture + runtime
// selections, with two adapters -- the session IPC adapter (in-session
// truth: the set IPCs, the cache seed, the persist verdict, resync on
// reject) and the cold-start pending adapter (the shell-held pending state
// on the ADR-0092 bar: synchronous pending writes, the #581 backfill clear
// with its ADR-0100 Decision 3 rollback, no session IPCs).
//
// ADR-0100 Decision 2 (postures are adapter-namespaced) lives HERE as the
// port's single namespace-reset point: an explicit runtime switch
// (writeRuntime) and a startup-resolution drift (the effective-runtime
// reconciliation in useColdStartSelection) both reset the pending posture
// from this one module. Keeping the pending-state owner and the write
// owner together is what lets the gesture-identity ledger (#592) guard
// the rollback: every pending-resetting gesture replaces the ledger
// token, so a rejected backfill clear may roll its pre-clear pair back
// ONLY while its own gesture is still the ledger's latest entry -- a
// later pick, a repeated equal clear, a runtime switch, a drift reset,
// or a mint consume each replace the token first, and the rollback
// skips.
//
// Structure (ADR-0099 two-level selector untouched): the picker builds a
// session adapter per render (stateless orchestration) and receives the
// cold-start channel as one prop in place of the four pending props;
// App owns useColdStartSelection so the mint submit can read and consume
// the pending facets (#572/#574).

// What a posture write resolved to. "written" carries the persist-now
// verdict of a successful in-session set (ADR-0095 Decision 6, issue #529);
// "rejected" carries the raw failure for the inline fault line -- the port
// never rejects, every failure lands on the outcome instead.
export type PostureWriteOutcome =
  | { status: "written"; persistError: SaveError | null; persistSuspended: boolean }
  | { status: "rejected"; error: unknown };

export type RuntimeWriteOutcome =
  | { status: "written" }
  | { status: "rejected"; error: unknown };

// The options of one posture write. `clearsBackfill`: a cold-start clear
// additionally wipes the #581 backfill entry (ADR-0100 Decision 3 --
// otherwise the next cold start re-seeds the cleared posture); in-session
// clears never do (the set IPC's server-side record is the single write
// point). True only on a whole-dimension clear gesture -- the picker
// derives it as the picked dimension's new value being null.
// `rollbackTo`: the DISPLAYED pair at submit time -- the rollback
// target if the backfill-clear IPC rejects.
export type PostureWriteOptions = {
  clearsBackfill: boolean;
  rollbackTo: ModelPosture;
};

export type SelectionWritePort = {
  writePosture(
    next: ModelPosture,
    options: PostureWriteOptions,
  ): Promise<PostureWriteOutcome>;
  writeRuntime(next: SessionRuntimeChoice): Promise<RuntimeWriteOutcome>;
};

// --- Session adapter (in-session, ADR-0095) ---------------------------------

// Stateless orchestration: cheap to rebuild each render, so the picker can
// construct it with the render-derived active adapter id.
export function createSessionSelectionPort(args: {
  sessionId: string;
  queryClient: QueryClient;
  activeAdapterId: string | null;
}): SelectionWritePort {
  const { sessionId, queryClient, activeAdapterId } = args;
  return {
    // The options are the cold-start adapter's contract: an in-session
    // clear never wipes the backfill entry and takes no rollback either
    // (the set IPC's server-side record is the single write point) -- a
    // reject resyncs from the backend truth below.
    async writePosture(next) {
      try {
        const outcome = await setSessionPosture(sessionId, next);
        // Functional update: a later selection in the same menu session
        // must patch the CURRENT cache, not a stale snapshot -- two rapid
        // selections would otherwise clobber each other.
        queryClient.setQueryData(
          sessionKeys.modelConfig(sessionId),
          (prev: SessionModelConfig | undefined): SessionModelConfig => ({
            ...(prev ?? MODEL_CONFIG_DEFAULT),
            ...next,
          }),
        );
        // The set lands the post-set pair in the startup backfill entry
        // server-side (record_last_model_posture, the single write point).
        // Invalidate so the NEXT return to cold start refetches the
        // post-set entry (staleTime: Infinity never auto-refetches,
        // ADR-0051).
        if (activeAdapterId !== null) {
          void queryClient.invalidateQueries({
            queryKey: adapterKeys.posture(activeAdapterId),
          });
        }
        return {
          status: "written",
          persistError: outcome.persist_error,
          persistSuspended: outcome.persist_suspended,
        };
      } catch (e) {
        // Keep the server posture: refetch so the picker re-reads the
        // backend truth instead of showing a selection the write never
        // granted.
        log.warn(
          "composer-selection-write",
          "set session posture failed; resyncing from the session",
          e,
        );
        void queryClient.invalidateQueries({
          queryKey: sessionKeys.modelConfig(sessionId),
        });
        return { status: "rejected", error: e };
      }
    },

    async writeRuntime(next) {
      try {
        await setSessionRuntime(sessionId, next);
        // The write is the truth source: seed the cache directly (no extra
        // IPC round-trip; a later remount refetches the same value).
        queryClient.setQueryData(sessionKeys.runtime(sessionId), next);
        // The switch also re-seeded the posture slot server-side from the
        // target adapter's backfill entry (ADR-0102 Decision 3, issue
        // #590) -- invalidate so the model button refetches the seeded
        // pair instead of lingering on the old adapter's stale one. The
        // seeded value lives server-side (the backfill map read), so an
        // invalidate + refetch is the honest path -- no local projection
        // of the entry.
        void queryClient.invalidateQueries({
          queryKey: sessionKeys.modelConfig(sessionId),
        });
        return { status: "written" };
      } catch (e) {
        log.warn(
          "composer-selection-write",
          "set session runtime failed; resyncing from the session",
          e,
        );
        void queryClient.invalidateQueries({
          queryKey: sessionKeys.runtime(sessionId),
        });
        return { status: "rejected", error: e };
      }
    },
  };
}

// --- Cold-start channel (ADR-0092 bar, ADR-0098/0100) ----------------------

// What the picker consumes on the cold-start bar: the displayed pending
// facets + the write port, one prop carrying the whole pending wiring.
export type ColdStartSelectionChannel = {
  // The runtime the bar displays: the explicit pick or the startup
  // resolution (ADR-0098 Decision 4) -- never the raw null sentinel (the
  // App-facing ColdStartSelection.pendingRuntime carries that one).
  effectiveRuntime: SessionRuntimeChoice;
  pendingModelPosture: ModelPosture | null;
  port: SelectionWritePort;
};

// What App consumes: the channel for the picker + the raw pending facets
// (null = untouched, #572/#574 mint semantics) + the mint consume.
export type ColdStartSelection = {
  channel: ColdStartSelectionChannel;
  pendingRuntime: SessionRuntimeChoice | null;
  pendingModelPosture: ModelPosture | null;
  consume: () => void;
};

export function useColdStartSelection(args: {
  startupRuntime: SessionRuntimeChoice;
  queryClient: QueryClient;
}): ColdStartSelection {
  const { startupRuntime, queryClient } = args;

  const [pendingRuntime, setPendingRuntime] =
    useState<SessionRuntimeChoice | null>(null);
  const [pendingModelPosture, setPendingModelPosture] =
    useState<ModelPosture | null>(null);
  // The displayed runtime (ADR-0098 Decision 4): the explicit pick or the
  // startup resolution -- never the raw null sentinel.
  const effectiveRuntime = pendingRuntime ?? startupRuntime;

  // The gesture ledger (#592): every pending-resetting gesture -- a
  // posture write, a runtime switch, a drift reset, a mint consume --
  // replaces the token. A rejected backfill clear may roll its pre-clear
  // pair back only while its own gesture is still the latest entry;
  // anything newer (a later pick, a repeated EQUAL clear the token's
  // fresh identity distinguishes from "no later gesture", the caller's
  // namespace resets) has replaced the token first.
  const gestureRef = useRef<object>({});

  const adapterId =
    effectiveRuntime.kind === "external" ? effectiveRuntime.data : null;

  const writePosture = useCallback(
    async (
      next: ModelPosture,
      { clearsBackfill, rollbackTo }: PostureWriteOptions,
    ): Promise<PostureWriteOutcome> => {
      const gesture = {};
      gestureRef.current = gesture;
      setPendingModelPosture(next);
      if (!clearsBackfill || adapterId === null) {
        return { status: "written", persistError: null, persistSuspended: false };
      }
      try {
        await clearLastModelPosture(adapterId);
        queryClient.setQueryData(adapterKeys.posture(adapterId), EMPTY_POSTURE);
        return { status: "written", persistError: null, persistSuspended: false };
      } catch (e) {
        // The entry survived -- roll the optimistic clear back so the bar
        // keeps showing it. Otherwise the next cold start (the pending
        // pair resets to null on a runtime switch / restart) re-seeds from
        // the un-cleared entry and the posture silently "comes back" --
        // precisely the backfill-defeats-clear outcome this IPC exists to
        // prevent (ADR-0100 Decision 3). The ledger guard: only while no
        // later gesture fired (#592) -- restoring the pre-clear snapshot
        // over a newer intent would silently clobber it.
        const stillThisGesture = gestureRef.current === gesture;
        if (stillThisGesture) {
          setPendingModelPosture(rollbackTo);
        }
        log.warn(
          "composer-selection-write",
          stillThisGesture
            ? "clear startup posture failed; rolled the pending clear back"
            : "clear startup posture failed; pending posture moved on, rollback skipped",
          e,
        );
        // The failed clear surfaces on the picker's shared set-fault line
        // in BOTH outcomes: rolled back, the bar would otherwise show the
        // restored entry with no explanation; skipped, the optimistic
        // clear stays displayed while the backfill entry survived -- the
        // failure would surface only at the NEXT cold start as the
        // posture "coming back".
        return { status: "rejected", error: e };
      }
    },
    [adapterId, queryClient],
  );

  const writeRuntime = useCallback(
    async (next: SessionRuntimeChoice): Promise<RuntimeWriteOutcome> => {
      // A runtime switch is a namespace reset (ADR-0100 Decision 2): model
      // ids are adapter-namespaced, so a posture picked under one CLI must
      // not leak into another (or into the built-in runtime, whose posture
      // is the active profile's model). Replacing the ledger token in the
      // same task keeps a still-in-flight clear reject from rolling its
      // pre-clear posture over the reset (#592).
      gestureRef.current = {};
      setPendingRuntime(next);
      setPendingModelPosture(null);
      return { status: "written" };
    },
    [],
  );

  // The namespace reset's second path: the EFFECTIVE runtime can move
  // without an explicit pick (default_runtime changes in Settings or an
  // adapter-table refetch move the startup resolution, ADR-0098). Same
  // reset, same ledger invalidation -- the picker-path reset above covers
  // explicit switches only.
  const prevEffectiveRuntimeRef = useRef(effectiveRuntime);
  useEffect(() => {
    const prev = prevEffectiveRuntimeRef.current;
    const next = effectiveRuntime;
    if (
      prev.kind !== next.kind ||
      (prev.kind === "external" &&
        next.kind === "external" &&
        prev.data !== next.data)
    ) {
      gestureRef.current = {};
      setPendingModelPosture(null);
    }
    prevEffectiveRuntimeRef.current = next;
  }, [effectiveRuntime]);

  const consume = useCallback(() => {
    // The mint consumed the pending pair: replace the ledger token too,
    // so a still-in-flight clear rejecting after this point skips its
    // rollback instead of resurrecting the consumed pair (#592).
    gestureRef.current = {};
    setPendingRuntime(null);
    setPendingModelPosture(null);
  }, []);

  // Rebuilt per render -- the picker only calls through it, never compares
  // identity.
  const port: SelectionWritePort = { writePosture, writeRuntime };

  return {
    channel: { effectiveRuntime, pendingModelPosture, port },
    pendingRuntime,
    pendingModelPosture,
    consume,
  };
}
