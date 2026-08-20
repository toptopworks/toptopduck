import { useState, type ReactNode } from "react";
import { useIntl, type IntlShape } from "react-intl";
import { ArrowUp, Square } from "lucide-react";
import type { TurnPhase } from "../../types/session";
import { Button } from "../ui/button";

type QuestionBarProps = {
  onSubmit: (question: string) => void;
  /** Fire while a turn is in flight (ADR-0021 cancel). Hidden when not loading. */
  onCancel: () => void;
  loading: boolean;
  /** The in-flight turn's latest progress event (ADR-0059, calibrated by
   *  ADR-0078): when non-null and loading, the bar shows a compact wait label
   *  ("Thinking (attempt N)" / "Running") so the user sees the turn moving
   *  instead of a blank spinner -- the per-call detail rides the rail's live
   *  trace card (issue #297), not the bar. null/absent when no turn is running
   *  (the listener clears it on outcome, incl. Cancelled). Optional so call
   *  sites / tests that don't exercise phase feedback omit it. */
  phase?: TurnPhase | null;
  /** Top-row controls rendered inside the unified container above the
   *  textarea (the Skills / MCP trigger chips threaded from the shell,
   *  ADR-0092). */
  header?: ReactNode;
  /** Left-side toolbar controls rendered inside the unified container (the
   *  composer "+" / auth-mode slots threaded from the shell, ADR-0092). */
  children?: ReactNode;
  /** Right-side toolbar controls, seated before the phase + submit/stop
   *  button (the runtime / model picker threaded from the shell, ADR-0092). */
  trailing?: ReactNode;
} & {
  /** Controlled draft pair (ADR-0092 useComposerState). Both must be provided
   *  together so the parent owns the draft state. When omitted, QuestionBar
   *  falls back to local state (used by tests that render QuestionBar in
   *  isolation). Partial binding is a type error to prevent the silent
   *  input-freeze / stale-value desync that independent optionals would
   *  allow. */
} & (
  | { draft: string; setDraft: (value: string) => void }
  | { draft?: never; setDraft?: never }
);

// Natural-language question entry (PRD #1, issue #22). A blank or in-flight
// submit is ignored client-side; the orchestrator runs one turn at a time
// (ADR-0021 single in-flight). While a turn runs the input is disabled and a
// stop button replaces the submit so the user can cancel the in-flight query.
// The discrete phase feedback (ADR-0059, calibrated to the tool-call event
// stream by ADR-0078) renders alongside the stop button -- "Thinking
// (attempt N)" for the LLM wait, "Running" while tool calls dispatch -- an
// honest discrete label, not a fabricated percentage. The whole bar's chrome
// (placeholder, aria-label, button labels, phase feedback) ships through the
// react-intl catalog (ADR-0052); see the questionBar.* keys.
//
// Unified composer container: a rounded border + shadow box. An optional
// header row (the Skills / MCP trigger chips) rides the top; the textarea
// sits below it; a toolbar row at the bottom carries the composer slot
// controls (passed as children) on the left and the phase + submit/stop
// button on the right. Enter submits (Shift+Enter inserts a newline).
export function QuestionBar({ onSubmit, onCancel, loading, phase = null, draft, setDraft, header, children, trailing }: QuestionBarProps) {
  const intl = useIntl();
  const [localDraft, setLocalDraft] = useState("");
  const value = draft ?? localDraft;
  const setValue = setDraft ?? setLocalDraft;

  function submit() {
    const q = value.trim();
    // ADR-0021 single in-flight: a second submit while a turn runs is
    // ignored client-side (the input is also disabled, this is the
    // belt-and-suspenders guard).
    if (!q || loading) return;
    onSubmit(q);
  }

  return (
    // ADR-0067 (issue #172): the .question-bar input/button visual rules
    // (focus outline, primary submit, outline cancel) retired into shadcn
    // Input + Button (default + outline variants). The .question-bar class
    // hook stays for selector / test stability. The unified container layout
    // (vertical: textarea on top, toolbar below) replaces the former flat
    // horizontal row.
    <form
      className="question-bar @container flex flex-col rounded-lg border border-border bg-card shadow-md"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {header && (
        <div className="flex items-center gap-1 px-2 pt-2">
          {header}
        </div>
      )}
      <textarea
        id="question-bar-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={intl.formatMessage({ id: "questionBar.placeholder", defaultMessage: "Ask in natural language…" })}
        aria-label={intl.formatMessage({ id: "questionBar.ariaLabel", defaultMessage: "Question" })}
        disabled={loading}
        rows={3}
        className="w-full resize-none border-0 bg-transparent px-3 pt-3 pb-2 text-sm outline-none placeholder:text-muted-foreground focus:outline-none focus:ring-0 disabled:cursor-not-allowed disabled:opacity-50"
        onKeyDown={(e) => {
          // Enter submits; Shift+Enter inserts a newline (standard chat
          // composer behavior). The form onSubmit is the belt-and-suspenders
          // guard for test-driven submit events.
          // Guard against IME composition confirmation (CJK input methods):
          // Enter confirms the in-progress composition, but isComposing is
          // still true on this keydown. Without the guard the raw pre-
          // composition value would be submitted prematurely.
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {/* Toolbar row: composer controls (children) on the left, phase
          feedback + submit/stop on the right. */}
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <div className="flex items-center gap-1.5">
          {children}
        </div>
        <div className="flex items-center gap-2">
          {trailing}
          {loading && phase !== null && (
            // ADR-0059 discrete phase feedback. The attempt number surfaces only
            // on a blind retry (>1); the first attempt shows the bare verb
            // (ADR-0017 -- honest, not fabricated, and the first attempt needs
            // no attempt-number noise).
            // ADR-0067 (issue #185): the .phase-indicator visual rule (font-size +
            // color + white-space) retired onto utility here; the class hook had no
            // selector / test dependent (Shell.test.tsx queries role="status", not
            // the class) and is dropped. role="status" + aria-live stay.
            <span
              className="text-[0.82rem] text-muted-foreground whitespace-nowrap"
              role="status"
              aria-live="polite"
            >
              {phaseLabel(phase, intl)}
            </span>
          )}
          {loading ? (
            // Cancel is the only actionable control while a turn runs: the input is
            // disabled (single in-flight, ADR-0021), so submit would be inert. The
            // stop button fires the cancel token -> the in-flight ask lands as
            // Cancelled (ADR-0028 D). Outline circle with a filled square -- the
            // universal "stop" glyph. The sr-only span carries the accessible
            // name (NOT aria-label) so getByLabelText stays scoped to the
            // textarea whose aria-label is the same zh-CN word "提问".
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              className="size-8 shrink-0 rounded-full p-0"
            >
              <Square className="size-3.5 fill-current" aria-hidden />
              <span className="sr-only">
                {intl.formatMessage({ id: "questionBar.cancel", defaultMessage: "Stop" })}
              </span>
            </Button>
          ) : (
            // Primary submit: filled teal circle with an upward arrow (standard
            // chat-composer send glyph). The sr-only span carries the accessible
            // name (NOT aria-label) so getByLabelText stays scoped to the
            // textarea whose aria-label is the same zh-CN word "提问".
            <Button
              type="submit"
              disabled={value.trim() === ""}
              className="size-8 shrink-0 rounded-full p-0"
            >
              <ArrowUp className="size-4" aria-hidden />
              <span className="sr-only">
                {intl.formatMessage({ id: "questionBar.submit", defaultMessage: "Ask" })}
              </span>
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}

// Discrete phase label (ADR-0059 + 0017 honesty, calibrated by ADR-0078,
// issue #297): Thinking with the 1-based STEP shown only past the first
// round-trip (> 1 -- the bare verb reads cleaner than an "attempt 1" suffix
// that implies a retry count), and a bare "Running…" for the tool-call
// events (the rail's live trace card shows the per-call detail; the bar's
// label only signals which wait the turn is in). i18n'd via react-intl
// (ADR-0052); each formatMessage id is a static literal at the call site so
// @formatjs/cli extract resolves them.
function phaseLabel(phase: TurnPhase, intl: IntlShape): string {
  if ("Thinking" in phase) {
    const { attempt } = phase.Thinking;
    return attempt > 1
      ? intl.formatMessage(
          { id: "questionBar.phase.thinkingRetry", defaultMessage: "Thinking (attempt {attempt})…" },
          { attempt },
        )
      : intl.formatMessage({ id: "common.thinking", defaultMessage: "Thinking…" });
  }
  // ToolCallStarted / ToolCallCompleted: the rail renders the call rows; the
  // bar's compact label just names the running wait.
  return intl.formatMessage({ id: "questionBar.phase.running", defaultMessage: "Running…" });
}
