import { useState } from "react";
import { useIntl, FormattedMessage, type IntlShape } from "react-intl";
import type { TurnPhase } from "../../types/session";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface QuestionBarProps {
  onSubmit: (question: string) => void;
  /** Fire while a turn is in flight (ADR-0021 cancel). Hidden when not loading. */
  onCancel: () => void;
  loading: boolean;
  /** The in-flight turn's discrete phase (ADR-0059): when non-null and loading,
   *  the bar shows "Thinking (attempt N) / Querying" so the user sees the turn
   *  moving through its LLM + SQL waits instead of a blank spinner. null/absent
   *  when no turn is running (the listener clears it on outcome, incl. Cancelled).
   *  Optional so call sites / tests that don't exercise phase feedback omit it. */
  phase?: TurnPhase | null;
}

// Natural-language question entry (PRD #1, issue #22). A blank or in-flight
// submit is ignored client-side; the orchestrator runs one turn at a time
// (ADR-0021 single in-flight). While a turn runs the input is disabled and a
// stop button replaces the submit so the user can cancel the in-flight query.
// The discrete phase feedback (ADR-0059) renders alongside the stop button --
// "Thinking (attempt N) / Querying" reflects the two honest boundaries (LLM
// HTTP + SQL), not a fabricated percentage. The whole bar's chrome (placeholder,
// aria-label, button labels, phase feedback) ships through the react-intl
// catalog (ADR-0052); see the questionBar.* keys.
export function QuestionBar({ onSubmit, onCancel, loading, phase = null }: QuestionBarProps) {
  const intl = useIntl();
  const [value, setValue] = useState("");

  return (
    // ADR-0067 (issue #172): the .question-bar input/button visual rules
    // (focus outline, primary submit, outline cancel) retired into shadcn
    // Input + Button (default + outline variants). The .question-bar class
    // hook stays for selector / test stability; the flex layout rides the
    // component as utility (gap-2 / items-center) since the bar is a simple
    // row, not a layout the ADR-0067 layout-only decision protects.
    <form
      className="question-bar flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const q = value.trim();
        // ADR-0021 single in-flight: a second submit while a turn runs is
        // ignored client-side (the input is also disabled, this is the
        // belt-and-suspenders guard).
        if (!q || loading) return;
        onSubmit(q);
      }}
    >
      <Input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={intl.formatMessage({ id: "questionBar.placeholder", defaultMessage: "Ask in natural language…" })}
        aria-label={intl.formatMessage({ id: "questionBar.ariaLabel", defaultMessage: "Question" })}
        disabled={loading}
        className="flex-1"
      />
      {loading && phase !== null && (
        // ADR-0059 discrete phase feedback. The attempt number surfaces only
        // on a blind retry (>1); the first attempt shows the bare verb (守
        // 0017 -- honest, not fabricated, and the first attempt needs no
        // "第 1 次" noise).
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
        // Cancelled (ADR-0028 D). Outline variant mirrors the retired .cancel
        // override (background card + border, not primary fill).
        <Button type="button" variant="outline" onClick={onCancel}>
          <FormattedMessage id="questionBar.cancel" defaultMessage="Stop" />
        </Button>
      ) : (
        <Button type="submit" disabled={value.trim() === ""}>
          <FormattedMessage id="questionBar.submit" defaultMessage="Ask" />
        </Button>
      )}
    </form>
  );
}

// Discrete phase label (ADR-0059 + 0017 honesty): Thinking / Querying with the
// 1-based attempt shown ONLY on a blind retry (> 1). The first attempt renders
// the bare verb; an "attempt 1" suffix would be noise that implies a retry
// count. i18n'd via react-intl (ADR-0052); each formatMessage id is a static
// literal at the call site so @formatjs/cli extract resolves them.
function phaseLabel(phase: TurnPhase, intl: IntlShape): string {
  if ("Thinking" in phase) {
    const { attempt } = phase.Thinking;
    return attempt > 1
      ? intl.formatMessage(
          { id: "questionBar.phase.thinkingRetry", defaultMessage: "Thinking (attempt {attempt})…" },
          { attempt },
        )
      : intl.formatMessage({ id: "questionBar.phase.thinking", defaultMessage: "Thinking…" });
  }
  const { attempt } = phase.Querying;
  return attempt > 1
    ? intl.formatMessage(
        { id: "questionBar.phase.queryingRetry", defaultMessage: "Querying (attempt {attempt})…" },
        { attempt },
      )
    : intl.formatMessage({ id: "questionBar.phase.querying", defaultMessage: "Querying…" });
}
