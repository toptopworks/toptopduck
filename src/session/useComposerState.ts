import { useCallback, useState } from "react";
import type { TurnPhase } from "../types/session";
import { log } from "../lib/log";

// The QuestionBar-facing slice of session state (ADR-0092). ADR-0092 hoists
// QuestionBar from SessionPane to the shell level, where activeSessionId is
// null on cold start. This hook gives the shell a single call site that
// returns idle defaults when no session is active, and the live session's bar
// state when one is.
//
// Per-session drafts (ADR-0092 Decision 6): the hook owns a
// Record<sessionId, string> for open sessions + a separate cold-start draft.
// The draft switches per activeSessionId — each keep-alive session retains its
// own input text across switches. The turn-flow outputs (loading / phase /
// handleAsk / handleCancel / handleIngestFiles) are passed through the
// `session` parameter and merged with the owned drafts.

// Session-derived bar fields the hook can't own yet (sourced from
// useSessionState -> useTurnFlow). Passed in by the caller and merged with the
// hook's own draft state.
export interface ComposerSessionFields {
  loading: boolean;
  phase: TurnPhase | null;
  handleAsk: (question: string) => Promise<void>;
  handleCancel: () => Promise<void>;
  /** Multi-file ingest from the composer "+" file section (ADR-0083). Routed
   *  through useIngestFlow's handleIngestMany inside SessionPane. */
  handleIngestFiles: (paths: string[]) => void;
  /** The session pane's workspace fold (ADR-0083). Bar-shaping, not
   *  turn-flow: the shell-level bar slot mirrors the pane's conversation-column
   *  geometry (rail width when the workspace is open, the centered 800px fold
   *  track when collapsed), so the bar width tracks the conversation column
   *  (ADR-0090 calibration, ADR-0092). */
  workspaceCollapsed: boolean;
}

export interface ComposerState extends ComposerSessionFields {
  // The textarea draft. Owned by this hook so it persists across session
  // switches (ADR-0092 per-session draft routing). The empty-string default
  // keeps the QuestionBar submit button disabled via the
  // `value.trim() === ""` guard.
  draft: string;
  setDraft: (value: string) => void;
  /** Write a session's draft by explicit sid, independent of which session is
   *  active (#500): the SessionPane hands a held-back cold-start question back
   *  to the shell when the pending ingest batch halts (guidance / error owns
   *  the user's attention), so the question stays visible + submittable in the
   *  bar instead of being silently discarded. */
  seedDraft: (sessionId: string, value: string) => void;
  /** Drop a closed/deleted session's draft so the per-session draft map does
   *  not grow unboundedly (the shell calls this from the close/delete paths). */
  dropDraft: (sessionId: string) => void;
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
const idleHandleIngestFiles = (): void => {};
/** Idle bar fields. Exported so SessionPane can reset the shell-level bar's
 *  per-session entry on unmount (a pane replaced by an error boundary or
 *  closed would otherwise leave a stale `loading: true` stuck on the bar).
 *  The shell's fields registry treats this exact reference as a removal
 *  signal (unmount = drop the entry, not a state to render). */
export const IDLE_SESSION_FIELDS: ComposerSessionFields = {
  loading: false,
  phase: null,
  handleAsk: idleHandleAsk,
  handleCancel: idleHandleCancel,
  handleIngestFiles: idleHandleIngestFiles,
  workspaceCollapsed: false,
};

// Null-safe hook for the composer bar's QuestionBar-facing state. Owns
// per-session drafts + a cold-start draft; merges them with the caller-provided
// session fields (or idle defaults when sessionId is null). The draft switches
// per activeSessionId — each keep-alive session retains its own input text.
//
// Overloads: when sessionId is null the session parameter is omitted (the
// idle defaults are used); when sessionId is a string the session fields are
// required. A union overload accepts `string | null` for callers (like the
// shell-level bar) that pass a reactive activeSessionId without a compile-time
// narrowing.
export function useComposerState(sessionId: null): ComposerState;
export function useComposerState(
  sessionId: string,
  session: ComposerSessionFields,
): ComposerState;
export function useComposerState(
  sessionId: string | null,
  session?: ComposerSessionFields,
): ComposerState;
export function useComposerState(
  sessionId: string | null,
  session?: ComposerSessionFields,
): ComposerState {
  // Per-session drafts (ADR-0092 Decision 6): Record<sessionId, string> for
  // open sessions + a separate cold-start draft for the null state. The draft
  // switches per activeSessionId — each keep-alive session retains its own
  // input text across switches.
  const [sessionDrafts, setSessionDrafts] = useState<Record<string, string>>({});
  const [coldStartDraft, setColdStartDraft] = useState("");

  const draft =
    sessionId === null ? coldStartDraft : (sessionDrafts[sessionId] ?? "");

  const setDraft = useCallback(
    (value: string) => {
      if (sessionId === null) {
        setColdStartDraft(value);
      } else {
        setSessionDrafts((prev) => ({ ...prev, [sessionId]: value }));
      }
    },
    [sessionId],
  );

  // Seed a session's draft by explicit sid (#500 held-back question path).
  // Identity-stable (no deps): SessionPane receives it as a prop and calls it
  // from the pending-payload consumption effect.
  const seedDraft = useCallback((sid: string, value: string) => {
    setSessionDrafts((prev) => ({ ...prev, [sid]: value }));
  }, []);

  // Drop a closed/deleted session's draft slot. Identity-stable (no deps):
  // the shell wires it into its close/delete handlers.
  const dropDraft = useCallback((sid: string) => {
    setSessionDrafts((prev) => {
      if (!(sid in prev)) return prev;
      const next = { ...prev };
      delete next[sid];
      return next;
    });
  }, []);

  if (sessionId === null) {
    return { ...IDLE_SESSION_FIELDS, draft, setDraft, seedDraft, dropDraft };
  }
  return { ...(session ?? IDLE_SESSION_FIELDS), draft, setDraft, seedDraft, dropDraft };
}
