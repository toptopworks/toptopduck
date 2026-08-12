import { useState } from "react";
import type { TurnPhase } from "../types/session";

// The QuestionBar-facing slice of session state (ADR-0092). ADR-0092 hoists
// QuestionBar from SessionPane to the shell level, where activeSessionId is
// null on cold start. This hook gives the shell a single call site that
// returns idle defaults when no session is active, and the live session's bar
// state when one is.
//
// The hook OWNS the input draft (useState) so it persists across session
// switches on the future shell-level bar. The turn-flow outputs (loading /
// phase / handleAsk / handleCancel) still live in useSessionState for this
// slice — moving useTurnFlow out of useSessionState requires a larger
// refactoring of its dependency graph. They are passed through the `session`
// parameter and merged with the owned draft.

// Session-derived bar fields the hook can't own yet (sourced from
// useSessionState → useTurnFlow). Passed in by the caller and merged with the
// hook's own draft state.
export interface ComposerSessionFields {
  loading: boolean;
  phase: TurnPhase | null;
  handleAsk: (question: string) => Promise<void>;
  handleCancel: () => Promise<void>;
}

export interface ComposerState extends ComposerSessionFields {
  // The textarea draft. Owned by this hook so it survives session switches on
  // the future shell-level bar (ADR-0092). Idle default is "" (empty).
  draft: string;
  setDraft: (value: string) => void;
}

// Idle session fields for the null-sessionId cold-start bar (ADR-0092). The bar
// renders but no turn can run -- loading is false, phase is null, and the
// handlers are no-ops (the first question creates a session, handled upstream).
const noopAsync = async (): Promise<void> => {};
const IDLE_SESSION_FIELDS: ComposerSessionFields = {
  loading: false,
  phase: null,
  handleAsk: noopAsync,
  handleCancel: noopAsync,
};

// Null-safe hook for the composer bar's QuestionBar-facing state. Owns the
// draft via useState; merges it with the caller-provided session fields (or
// idle defaults when sessionId is null). The draft persists across the
// null → non-null transition so a cold-start question survives session
// creation.
export function useComposerState(
  sessionId: string | null,
  session: ComposerSessionFields,
): ComposerState {
  const [draft, setDraft] = useState("");

  if (sessionId === null) {
    return { ...IDLE_SESSION_FIELDS, draft, setDraft };
  }
  return { ...session, draft, setDraft };
}
