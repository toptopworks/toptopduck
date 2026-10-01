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
// ask catches its own failures internally (sets the session error state)
// and never intentionally rejects; the `.catch` below is a defensive log so
// an unexpected throw surfaces instead of becoming an unhandled rejection.
export type PendingPayloadDeps = {
  sessionId: string;
  paths: string[];
  question: string | null;
  invocations: string[];
  /** One-shot dedup state, held by the caller (a React ref in the pane). */
  consumedRef: RefObject<string | null>;
  onIngestConsumed: () => void;
  onQuestionConsumed: () => void;
  onSeedDraft: (sessionId: string, question: string) => void;
  onSeedInvocations: (sessionId: string, names: string[]) => void;
  ingestMany: (paths: string[]) => Promise<boolean>;
  ask: (question: string, invocations: string[]) => Promise<void>;
};

export async function consumePendingPayload(deps: PendingPayloadDeps): Promise<void> {
  const {
    sessionId, paths, question, invocations, consumedRef,
    onIngestConsumed, onQuestionConsumed, onSeedDraft, onSeedInvocations,
    ingestMany, ask,
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
    const allLoaded = await ingestMany(paths);
    if (!allLoaded) {
      if (question !== null) onSeedDraft(sessionId, question);
      if (invocations.length > 0) onSeedInvocations(sessionId, invocations);
      return;
    }
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
