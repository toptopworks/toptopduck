import { useState } from "react";

interface QuestionBarProps {
  onSubmit: (question: string) => void;
  /** Fire while a turn is in flight (ADR-0021 cancel). Hidden when not loading. */
  onCancel: () => void;
  loading: boolean;
}

// Natural-language question entry (PRD #1, issue #22). A blank or in-flight
// submit is ignored client-side; the orchestrator runs one turn at a time
// (ADR-0021 single in-flight). While a turn runs the input is disabled and a
// 停止 button replaces the submit so the user can cancel the in-flight query.
export function QuestionBar({ onSubmit, onCancel, loading }: QuestionBarProps) {
  const [value, setValue] = useState("");

  return (
    <form
      className="question-bar"
      onSubmit={(e) => {
        e.preventDefault();
        const q = value.trim();
        if (!q || loading) return;
        onSubmit(q);
      }}
    >
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="用自然语言提问…"
        aria-label="提问"
        disabled={loading}
      />
      {loading ? (
        // Cancel is the only actionable control while a turn runs: the input is
        // disabled (single in-flight, ADR-0021), so submit would be inert. The
        // stop button fires the cancel token -> the in-flight ask lands as
        // Cancelled (ADR-0028 D).
        <button type="button" onClick={onCancel} className="cancel">
          停止
        </button>
      ) : (
        <button type="submit" disabled={value.trim() === ""}>
          提问
        </button>
      )}
    </form>
  );
}
