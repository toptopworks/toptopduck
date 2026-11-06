import type { RefObject } from "react";
import { log } from "../lib/log";

// ADR-0092 (#500): consume the pending payloads carried by a minted session
// from the cold-start bar submit / window drop. The consumed callbacks clear
// the shell props UPFRONT (onIngestConsumed / onQuestionConsumed) so a pane
// remount cannot re-fire; consumedRef dedups the payload KEY against a React
// StrictMode dev double-invoke / a re-render that lands before the clear
// does (the same shape as the retired useIngestFlow consumption effect --
// dedup-only, NO cleanup: a cleanup cancel would fire when the upfront clear
// flips the props and kill the in-flight consumption). Ordering is the
// contract: files ingest FIRST so the first turn sees the loaded sources;
// the question fires only when the whole batch loaded. A NeedsGuidance PARKS
// the batch on the guidance dialog (#748): ingestMany stays pending until
// the queue drains or halts terminally, so the auto-ask cannot fire
// underneath the dialog. A terminal halt (cancel / Error / IPC reject)
// settles the Promise false and hands the question back to the bar draft via
// onSeedDraft so it is never silently lost. The #991 atomic rollback rides
// the same halt: the staged invocations seed back into the staging too, so a
// resubmit carries both (the question to the draft, the names to the
// staging), never the question alone.
//
// Since #1500 the held question's EXIT is owned by the composer queue slot
// (useComposerQueue): files+question payloads hold the question into the
// slot at arming time (the slot's settle fires it on a full load and seeds
// it back through onSeedDraft / onSeedInvocations on a halt), so the chain
// itself neither awaits the verdict nor asks, and a bar submit during the
// chain window lands in the SAME single slot -- inert while occupied, so
// the session can never carry two pending questions at once. A files-only
// payload just arms the batch (the empty slot's settle is a no-op exit). A
// bare question (no files) has no batch to hold behind, so it asks directly.
// ask catches its own failures internally (sets the session error state)
// and never intentionally rejects; the `.catch` below is a defensive log so
// an unexpected throw surfaces instead of becoming an unhandled rejection.
export type PendingPayloadDeps = {
  paths: string[];
  question: string | null;
  invocations: string[];
  /** One-shot dedup state, held by the caller (a React ref in the pane). */
  consumedRef: RefObject<string | null>;
  onIngestConsumed: () => void;
  onQuestionConsumed: () => void;
  /** The tracked ingestMany (#1500): arming routes through the composer
   *  queue, whose settle owns the held question's exit. */
  ingestMany: (paths: string[]) => Promise<boolean>;
  /** Occupy the queue slot with the held question (#1500): the settle exits
   *  fire it exactly like a bar submit, so the chain neither awaits the
   *  verdict nor asks itself. */
  hold: (question: string, invocations: string[]) => void;
  ask: (question: string, invocations: string[]) => Promise<void>;
};

export async function consumePendingPayload(deps: PendingPayloadDeps): Promise<void> {
  const {
    paths, question, invocations, consumedRef,
    onIngestConsumed, onQuestionConsumed,
    ingestMany, hold, ask,
  } = deps;
  if (paths.length === 0 && question === null) return;
  // JSON.stringify makes the (paths, question, invocations) triple
  // collision-free without an ad-hoc separator character.
  const key = JSON.stringify([paths, question, invocations]);
  if (consumedRef.current === key) return;
  consumedRef.current = key;
  if (paths.length > 0) onIngestConsumed();
  if (question !== null) onQuestionConsumed();
  if (paths.length > 0) {
    // Arm the tracked batch: the slot owns the held question's exit (settle
    // true auto-sends with the invocations, settle false seeds both back
    // through the #991 channels). Holding is synchronous, within the same
    // task as the arming, so the slot is occupied before any settle
    // continuation can run -- the session cannot carry two pending
    // questions at once.
    ingestMany(paths);
    if (question !== null) hold(question, invocations);
    return;
  }
  if (question !== null) {
    // ADR-0119: the staged names are the first ask's user invocations --
    // they ride the ask itself (submit-time materialization), so the
    // minted session's first turn carries the picks with no per-session
    // state.
    void ask(question, invocations).catch((e) =>
      log.error("pendingPayload", "pendingQuestion ask threw unexpectedly", e),
    );
  }
}
