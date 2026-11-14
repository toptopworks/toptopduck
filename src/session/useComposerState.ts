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
// own input text across switches. The session-reported fields (loading /
// queued / phase / handleAsk / handleCancel / handleIngestFiles) are passed
// through the `session` parameter and merged with the owned drafts.

// Session-derived bar fields the hook can't own yet (sourced from
// useSessionState -> useTurnFlow). Passed in by the caller and merged with the
// hook's own draft state.
export interface ComposerSessionFields {
  /** The TURN domain only (ask/cancel in flight, ADR-0021): the pane's
   *  turnLoading, not the union loading. A dataset/ingest mutation's
   *  in-flight window must not flip the bar's Ask/Stop button. */
  loading: boolean;
  /** The composer question's queued posture (issue #1500): true while the
   *  session holds a question in the pending slot behind an in-flight ingest
   *  batch -- the bar disables the input and shows the queued copy. A NEW
   *  axis owned by useComposerQueue; it deliberately does NOT fold into
   *  `loading` (the turn-domain ruling above). */
  queued: boolean;
  phase: TurnPhase | null;
  /** The turn clock (issue #1264 turn-clock ruling): the bar's phase label
   *  derives its continuous elapsed-seconds figure from it, freezing while
   *  an approval holds the turn. null when no turn is in flight. */
  turnStartedAt: number | null;
  turnPausedSince: number | null;
  handleAsk: (question: string, invocations?: string[]) => Promise<void>;
  handleCancel: () => Promise<void>;
  /** Multi-file ingest from the composer "+" file section (ADR-0083).
   *  Routed through useComposerQueue's tracked ingestMany (wrapping
   *  useIngestFlow's handleIngestMany) inside SessionPane. */
  handleIngestFiles: (paths: string[]) => void;
  /** The session pane's right-sidebar fold (ADR-0083). Bar-shaping, not
   *  turn-flow: the shell-level bar slot mirrors the pane's conversation-column
   *  geometry (rail width when the right sidebar is open, the full-width fold
   *  track when collapsed -- the bar card itself carries the centered
   *  reading-column width), so the bar width tracks the conversation column
   *  (ADR-0090 calibration, ADR-0092). */
  rightSidebarCollapsed: boolean;
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
  /** The ACTIVE session's quote staging (#1573): the selection toolbar's
   *  staged passages in staging order, displayed as the composer's quote
   *  chips and materialized into the question at the submit boundary.
   *  Empty for the cold start (a toolbar exists only inside a session
   *  pane). */
  readonly quotes: readonly QuoteEntry[];
  /** Stage one selected passage onto a session's quote list by explicit sid
   *  (#1573). Appends -- the same text staged twice is two entries (two
   *  chips); an empty selection is refused. Identity-stable. */
  stageQuote: (sessionId: string, text: string) => void;
  /** Withdraw one staged quote by entry id (#1573). Identity-stable. */
  removeQuote: (sessionId: string, id: number) => void;
  /** Empty a session's quote slot (#1573). The shell calls it at the submit
   *  boundary (the staging rode the question) and from the close/delete
   *  paths (the staging is unreachable). Identity-stable. */
  clearQuotes: (sessionId: string) => void;
}

/** One staged selection (#1573): the raw text (the submit materializer's
 *  input) plus a stable identity, so duplicate texts stay distinct chips
 *  and a mid-list withdrawal never re-keys a sibling. */
export interface QuoteEntry {
  readonly id: number;
  readonly text: string;
}

// The staging id mint (module-level: ids are unique per app run, never
// persisted).
let quoteSeq = 0;

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
/** Idle bar fields. The default bar state when no session is active (cold
 *  start). All handlers are no-ops; loading is false, phase is null. The shell
 *  uses this as the fallback when activeSessionId is null or the active
 *  session has not reported its fields yet. */
export const IDLE_SESSION_FIELDS: ComposerSessionFields = {
  loading: false,
  queued: false,
  phase: null,
  turnStartedAt: null,
  turnPausedSince: null,
  handleAsk: idleHandleAsk,
  handleCancel: idleHandleCancel,
  handleIngestFiles: idleHandleIngestFiles,
  rightSidebarCollapsed: false,
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
// The staging-free read (the cold start's and the not-yet-staged session's
// quotes slice): one frozen empty array keeps the read referentially stable
// (the NO_APPROVALS idiom).
const NO_QUOTES: readonly QuoteEntry[] = [];

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
  const [sessionQuotes, setSessionQuotes] = useState<
    Record<string, readonly QuoteEntry[]>
  >({});
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
  // Only writes when the slot is empty so a user who typed into the bar
  // during the ingest window (pane mounted, files loading) does not lose
  // their edits when the batch halts and the held-back question is seeded.
  // Identity-stable (no deps): SessionPane receives it as a prop and calls it
  // from the pending-payload consumption effect.
  const seedDraft = useCallback((sid: string, value: string) => {
    setSessionDrafts((prev) => {
      const existing = prev[sid];
      if (existing != null && existing !== "") return prev;
      return { ...prev, [sid]: value };
    });
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

  // Quote staging (#1573): the per-session map mirrors the draft map's
  // lifecycle exactly -- the staging survives session switches, the submit
  // boundary and the close/delete paths empty the slot. Identity-stable
  // mutators (no deps): they travel into SessionPane / the shell handlers
  // as props.
  const stageQuote = useCallback((sid: string, text: string) => {
    if (text === "") return;
    // The id mints OUTSIDE the state updater: updaters must stay pure
    // (React may invoke them more than once), the counter must advance
    // exactly once per staging.
    quoteSeq += 1;
    const entry: QuoteEntry = { id: quoteSeq, text };
    setSessionQuotes((prev) => ({
      ...prev,
      [sid]: [...(prev[sid] ?? []), entry],
    }));
  }, []);
  const removeQuote = useCallback((sid: string, id: number) => {
    setSessionQuotes((prev) => {
      const entries = prev[sid];
      if (entries === undefined) return prev;
      const next = entries.filter((entry) => entry.id !== id);
      if (next.length === entries.length) return prev;
      return { ...prev, [sid]: next };
    });
  }, []);
  const clearQuotes = useCallback((sid: string) => {
    setSessionQuotes((prev) => {
      if (!(sid in prev)) return prev;
      const next = { ...prev };
      delete next[sid];
      return next;
    });
  }, []);

  if (sessionId === null) {
    return {
      ...IDLE_SESSION_FIELDS,
      draft,
      setDraft,
      seedDraft,
      dropDraft,
      quotes: NO_QUOTES,
      stageQuote,
      removeQuote,
      clearQuotes,
    };
  }
  return {
    ...(session ?? IDLE_SESSION_FIELDS),
    draft,
    setDraft,
    seedDraft,
    dropDraft,
    quotes: sessionQuotes[sessionId] ?? NO_QUOTES,
    stageQuote,
    removeQuote,
    clearQuotes,
  };
}
