import { useState } from "react";
import type { TurnPhase } from "../types/session";
import { log } from "../lib/log";

// The QuestionBar-facing slice of session state (ADR-0092). ADR-0092 hoists
// QuestionBar from SessionPane to the shell level, where activeSessionId is
// null on cold start. This hook gives the shell a single call site that
// returns idle defaults when no session is active, and the live session's bar
// state when one is.
//
// The hook OWNS the input draft (useState) so it persists across the
// null-to-non-null cold-start transition (the draft survives session creation
// so a cold-start question is not lost). The final ADR-0092 shell bar will
// route per-session drafts via Record<sessionId, string>; the single useState
// here is a transitional form for the extraction slice. The turn-flow outputs
// (loading / phase / handleAsk / handleCancel) still live in useSessionState
// for this slice — moving useTurnFlow out of useSessionState requires a
// larger refactoring of its dependency graph (sessionId-routed query shards,
// approval-flow coupling). They are passed through the `session` parameter
// and merged with the owned draft.

// Session-derived bar fields the hook can't own yet (sourced from
// useSessionState -> useTurnFlow). Passed in by the caller and merged with the
// hook's own draft state.
export interface ComposerSessionFields {
  loading: boolean;
  phase: TurnPhase | null;
  handleAsk: (question: string) => Promise<void>;
  handleCancel: () => Promise<void>;
}

export interface ComposerState extends ComposerSessionFields {
  // The textarea draft. Owned by this hook so it survives the null-to-non-null
  // cold-start transition (ADR-0092). The empty-string idle default keeps the
  // QuestionBar submit button disabled via the `value.trim() === ""` guard.
  draft: string;
  setDraft: (value: string) => void;
}

// Idle handlers for the null-sessionId cold-start bar (ADR-0092). The bar
// renders but no turn can run — loading is false, phase is null, and the
// handlers are no-ops. handleAsk logs a warning so an unwired cold-start bar
// (missing upstream session-creation intercept) is observable instead of
// silently discarding the user's question. The question text itself is never
// logged (ADR-0029 source-data invariant); only its length is recorded.
const idleHandleAsk = async (question: string): Promise<void> => {
  log.warn(
    "useComposerState",
    "handleAsk invoked on idle path (null sessionId) — question discarded",
    { questionLength: question.length },
  );
};
const idleHandleCancel = async (): Promise<void> => {};
const IDLE_SESSION_FIELDS: ComposerSessionFields = {
  loading: false,
  phase: null,
  handleAsk: idleHandleAsk,
  handleCancel: idleHandleCancel,
};

// Null-safe hook for the composer bar's QuestionBar-facing state. Owns the
// draft via useState; merges it with the caller-provided session fields (or
// idle defaults when sessionId is null). The draft persists across the
// null-to-non-null transition so a cold-start question survives session
// creation.
//
// Overloads: when sessionId is null the session parameter is omitted (the
// idle defaults are used); when sessionId is a string the session fields are
// required.
export function useComposerState(sessionId: null): ComposerState;
export function useComposerState(
  sessionId: string,
  session: ComposerSessionFields,
): ComposerState;
export function useComposerState(
  sessionId: string | null,
  session?: ComposerSessionFields,
): ComposerState {
  const [draft, setDraft] = useState("");

  if (sessionId === null) {
    return { ...IDLE_SESSION_FIELDS, draft, setDraft };
  }
  return { ...(session ?? IDLE_SESSION_FIELDS), draft, setDraft };
}
