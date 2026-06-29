import { useState } from "react";

interface QuestionBarProps {
  onSubmit: (question: string) => void;
  loading: boolean;
}

// Natural-language question entry (PRD #1, issue #22). A blank or in-flight
// submit is ignored client-side; the orchestrator runs one turn at a time
// (ADR-0021 -- concurrent turns are out of scope for this slice, but the
// loading lock already serializes submits).
export function QuestionBar({ onSubmit, loading }: QuestionBarProps) {
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
      <button type="submit" disabled={loading || value.trim() === ""}>
        提问
      </button>
    </form>
  );
}
