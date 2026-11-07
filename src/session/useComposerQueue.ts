import { useCallback, useEffect, useRef, useState } from "react";
import { log } from "../lib/log";

// The composer question's queue behind an in-flight ingest batch (issue
// #1500). #1486 un-froze the main thread, making a pre-existing gate gap
// reachable: the bar's `loading` reflects the TURN domain only (ADR-0021 --
// an ingest mutation's in-flight window must not flip Ask/Stop), so a
// question submitted mid-batch went straight to `ask` and silently queued on
// the backend session lock inside spawn_blocking. This hook gives that
// submit the same treatment the cold-start chain already has (ADR-0092 /
// pendingPayload.ts): the question enters a per-session pending slot and the
// bar shows a visible queued posture; the batch's settle decides the exit.
//
// The exits ride handleIngestMany's `Promise<boolean>` verbatim (no batch
// logic is duplicated here):
// - resolve true (every file Loaded, incl. the post-guidance drain) -> the
//   held question auto-sends with its invocations (a NeedsGuidance park keeps
//   the Promise pending per the #500 gate, so the slot simply keeps waiting).
// - resolve false (cancel / Error / superseded / IPC reject) -> the question
//   and the staged invocations return through the same channels the
//   #991 atomic rollback uses (onSeedDraft / onSeedInvocations) -- never an
//   auto-send.
//
// The tracked ingestMany is the batch arming point: SessionPane routes the
// manual "+" section (the shell-reported handleIngestFiles), the working-set
// tab's add entry (issue #792), and the pendingPayload consumption through
// it, so a cold-start batch gates the bar exactly like a manual one. The
// wrapper is pass-through: the verdict Promise the caller consumes is the
// batch's own. The replace flight is the second arming point (#1512): the
// working-set seam fires its own IPC, so SessionPane hands the verdict
// Promise to trackWindow at entry -- the queue never wraps it.
//
// Lifecycle is the keep-alive pane's, for free: the slot survives a session
// switch (the pane stays mounted) and dies with the pane, whose unmount
// flips the alive guard -- a settle after close neither leaks an auto-send
// into a dropped session nor seeds a draft slot for a sid that no longer
// exists.
//
// Single-slot semantics: the slot holds at most ONE question, whichever
// entry filled it. The chain (pendingPayload) holds its question at the
// pane's mount, before any bar interaction, so a question-carrying chain
// window admits no second question (a bar submit is inert) -- and a
// files-only chain window carries no held question at all, leaving the
// slot to whichever bar submit lands first.
interface QueuedQuestion {
  question: string;
  invocations: string[];
}

export interface ComposerQueueDeps {
  sessionId: string;
  ingestMany: (paths: string[]) => Promise<boolean>;
  ask: (question: string, invocations?: string[]) => Promise<void>;
  onSeedDraft: (sessionId: string, question: string) => void;
  onSeedInvocations: (sessionId: string, names: string[]) => void;
  /** The synchronous live-turn probe (issue #1503); the ref-truth contract
   *  lives on UseTurnFlow.hasLiveTurn. */
  hasLiveTurn: () => boolean;
}

export interface ComposerQueue {
  /** True while the held question waits behind the in-flight batch: the
   *  bar disables the input and shows the queued copy. A NEW axis -- never
   *  folds into the turn-domain `loading` (ADR-0021). */
  queued: boolean;
  /** The tracked handleIngestMany: pass-through verdict, arms the settle. */
  ingestMany: (paths: string[]) => Promise<boolean>;
  /** Arm an already-started flight as the queue window (#1512): the replace
   *  seam fires its own IPC and hands the verdict Promise here at entry --
   *  same gate, same identity rule, newest arming owns the exit. */
  trackWindow: (flight: Promise<boolean>) => void;
  /** The queue-aware ask the bar routes through. Outside a batch it is the
   *  direct fire; inside one it fills the slot and resolves immediately. */
  handleAsk: (question: string, invocations?: string[]) => Promise<void>;
  /** Occupy the slot with a question that predates the bar (the ADR-0092
   *  chain's held question): the settle exits fire it exactly like a bar
   *  submit -- auto-send on true, seed-back on false -- so the slot is the
   *  ONE holder of pending questions and a bar submit during the chain
   *  window is inert (single slot, first wins). */
  hold: (question: string, invocations: string[]) => void;
}

export function useComposerQueue(deps: ComposerQueueDeps): ComposerQueue {
  const { sessionId, ingestMany, ask, onSeedDraft, onSeedInvocations, hasLiveTurn } = deps;
  // The in-flight window's verdict Promise, or null between windows. The
  // synchronous-read ref (not state) is the queue's gate: the submit path
  // consults it in the same tick the user hits Enter, and the settle
  // continuation clears it without waiting for a render flush. The window
  // is whichever long IPC holds the backend session lock (#1512): a tracked
  // ingest batch (the wrapper below) or a source replace flight (armed
  // imperatively via trackWindow) -- the newest arming owns the exit.
  const windowRef = useRef<Promise<boolean> | null>(null);
  const [queued, setQueued] = useState<QueuedQuestion | null>(null);
  // The slot's synchronous mirror: the settle continuation reads it without
  // waiting for the render flush (the same refs-first idiom as useTurnFlow's
  // live mirrors -- the batch settles off the render cycle).
  const queuedRef = useRef<QueuedQuestion | null>(null);
  // The pane-liveness guard: a settle after close is a full stop -- no ask,
  // no seed. The setup RE-ARMS the flag (not an init-once ref): StrictMode's
  // dev simulate-unmount runs setup -> cleanup -> setup on mount, so an
  // init-once ref would read false for the pane's whole life and every
  // settle would early-return -- the held question strands in the slot (the
  // #1500 live-app report) while later submits fire direct.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const settle = useCallback(
    (allLoaded: boolean) => {
      windowRef.current = null;
      const held = queuedRef.current;
      if (!aliveRef.current || held === null) return;
      queuedRef.current = null;
      setQueued(null);
      if (allLoaded && !hasLiveTurn()) {
        // ask catches its own failures internally (session error state) and
        // never intentionally rejects; the `.catch` is the same defensive
        // log the pendingPayload / shell-ask paths carry.
        void ask(held.question, held.invocations).catch((e: unknown) =>
          log.error("useComposerQueue", "queued ask threw unexpectedly", e),
        );
      } else {
        // Two seed-back exits, one channel (the #991 atomic rollback):
        // - !allLoaded: the batch halted (cancel / Error / superseded /
        //   IPC reject) -- never an auto-send.
        // - a live turn (#1503, the #1504 review's Advisory A): the
        //   auto-send would die on useTurnFlow's single-turn guard as a
        //   SILENT drop -- the question vanishes with no feedback, worse
        //   than a halt (which at least returns the draft). Seed back
        //   through the halt channel instead; the user re-submits when
        //   the turn lands.
        onSeedDraft(sessionId, held.question);
        if (held.invocations.length > 0) {
          onSeedInvocations(sessionId, held.invocations);
        }
      }
    },
    [ask, hasLiveTurn, onSeedDraft, onSeedInvocations, sessionId],
  );

  const ingestManyTracked = useCallback(
    (paths: string[]) => {
      const batch = ingestMany(paths);
      windowRef.current = batch;
      // The contract is resolve-only (an IPC reject resolves false), so the
      // rejection arm is purely defensive: an unexpected throw must not
      // strand the question queued forever -- it takes the halt exit.
      // Identity gate: only the CURRENTLY armed batch's settle owns the
      // exit. Batches can overlap (a mid-batch "+" pick, an OS-level window
      // drop, or the #748 drop-under-dialog supersede resolving the parked
      // batch synchronously under the newer arming), and a stale settle must
      // neither clear the newer batch's gate nor exit the slot on its own
      // verdict -- the question keeps waiting behind the newest batch.
      void batch.then(
        (allLoaded) => {
          if (windowRef.current === batch) settle(allLoaded);
        },
        (e: unknown) => {
          log.error("useComposerQueue", "ingest batch rejected unexpectedly", e);
          if (windowRef.current === batch) settle(false);
        },
      );
      return batch;
    },
    [ingestMany, settle],
  );

  // Arm a flight that already started OUTSIDE this hook (#1512): the seam's
  // replace handler fires the IPC itself and hands the verdict Promise here
  // at entry -- the same arming + identity gate as the tracked batch, minus
  // the wrapper. The flight is resolve-only (Loaded -> true, every failure
  // route -> false); the rejection arm stays defensive for the same reason.
  const trackWindow = useCallback(
    (flight: Promise<boolean>) => {
      windowRef.current = flight;
      void flight.then(
        (allLoaded) => {
          if (windowRef.current === flight) settle(allLoaded);
        },
        (e: unknown) => {
          log.error("useComposerQueue", "tracked window rejected unexpectedly", e);
          if (windowRef.current === flight) settle(false);
        },
      );
    },
    [settle],
  );

  const queuedAsk = useCallback(
    (question: string, invocations?: string[]) => {
      if (windowRef.current !== null) {
        // Single slot: the bar disables the input while queued, so a second
        // submit here is the belt-and-suspenders path -- ignored client-side
        // (the same contract as the ADR-0021 loading guard), first wins.
        if (queuedRef.current === null) {
          const held = { question, invocations: invocations ?? [] };
          queuedRef.current = held;
          setQueued(held);
        }
        return Promise.resolve();
      }
      return ask(question, invocations);
    },
    [ask],
  );

  const hold = useCallback((question: string, invocations: string[]) => {
    // The temporal contract: hold requires an armed batch (the sole caller
    // arms in the same synchronous task). A no-batch hold would strand the
    // slot forever -- the bar locks with no settle to free it -- so the
    // misuse logs and drops (the idle-handleAsk observability precedent).
    if (windowRef.current === null) {
      log.warn("useComposerQueue", "hold with no armed window; question dropped", {
        question,
      });
      return;
    }
    if (queuedRef.current !== null) return;
    const held = { question, invocations };
    queuedRef.current = held;
    setQueued(held);
  }, []);

  return {
    queued: queued !== null,
    ingestMany: ingestManyTracked,
    trackWindow,
    handleAsk: queuedAsk,
    hold,
  };
}
