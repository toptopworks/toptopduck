import { useMemo, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";

import { listActivatedSkills, listSkills } from "../../api";
import { sessionKeys, skillKeys } from "../../session/queryKeys";
import type { SkillEntry } from "../../types/skills";
import {
  clampHighlight,
  detectTrigger,
  filterSkills,
  readPickerQuery,
  removeTriggerSpan,
  type SkillPickerTrigger,
} from "./skillPickerLogic";

// The state half of the composer skill picker (ADR-0112, issue #716): the
// QuestionBar delegates its textarea's change / key events here and renders
// the SkillPickerPanel from the returned snapshot. Owns the trigger state
// (which char opened the panel, where it sits in the draft), the query text,
// the highlight index, and the two reads the panel needs -- the registry
// listing (shared skillKeys.all() cache with the Skills trigger + section)
// and, session mode only, the activated set behind the display-only Active
// badges. The pure algebra lives in skillPickerLogic.ts.

export interface UseSkillPickerOpts {
  /** The session whose activation truth the Active badges read. null on the
   *  cold-start bar (ADR-0092): the activated query stays disabled. */
  sessionId: string | null;
  /** Receives each selected skill name. A selection is the mount + activate
   *  composite intent (ADR-0112 Decision 2) -- what it MEANS is entirely the
   *  caller's business (chip staging + submit-time materialization); this
   *  hook only consumes the trigger span and reports the name. */
  onPick: (name: string) => void;
  /** Draft setter: selection consumes the trigger span through it (Esc, by
   *  contrast, keeps the span -- the parent never touches the draft on
   *  close). */
  setValue: (value: string) => void;
  /** Master switch for the whole surface. false (QuestionBar rendered
   *  without the skillPicker prop) keeps the queries disabled -- nothing
   *  opens on a trigger char and no IPC fires. */
  enabled?: boolean;
}

export function useSkillPicker({
  sessionId,
  onPick,
  setValue,
  enabled = true,
}: UseSkillPickerOpts) {
  const [trigger, setTrigger] = useState<SkillPickerTrigger | null>(null);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  // Registry rows for the panel. The key is the shared skillKeys.all() cache
  // the Skills trigger + mount list already ride, so opening the picker adds
  // no extra IPC round-trip once any of them has loaded.
  const { data: listing } = useQuery({
    queryKey: skillKeys.all(),
    queryFn: listSkills,
    enabled,
  });
  const registry = useMemo(() => listing?.skills ?? [], [listing]);
  // Display-only activation truth (Decision 5): session mode reads the
  // activated set; cold start keeps the query disabled -- no session exists,
  // so no badges. The set NEVER gates selection (Decision 3).
  const { data: activated } = useQuery({
    queryKey: sessionKeys.activatedSkills(sessionId ?? ""),
    queryFn: () => listActivatedSkills(sessionId as string),
    enabled: enabled && sessionId !== null,
  });
  const activatedNames = useMemo(() => new Set(activated ?? []), [activated]);

  const rows = useMemo(
    () => (trigger !== null ? filterSkills(registry, query) : []),
    [trigger, registry, query],
  );
  // Render-time clamp: the query can shrink the row count below the stored
  // highlight index between keystrokes.
  const highlightIndex = Math.min(highlight, Math.max(0, rows.length - 1));

  /** Feed every textarea change: opens the panel on a freshly typed
   *  line-start trigger char and recomputes / closes the query region. */
  function handleChange(value: string, cursor: number): void {
    if (!enabled) return;
    if (trigger === null) {
      const next = detectTrigger(value, cursor);
      if (next) {
        setTrigger(next);
        setQuery("");
        setHighlight(0);
      }
      return;
    }
    const next = readPickerQuery(value, trigger, cursor);
    if (next === null) {
      setTrigger(null);
      return;
    }
    setQuery(next);
  }

  /** Selection: consume the trigger span from the draft (trigger char +
   *  query), report the pick, close the panel. */
  function select(skill: SkillEntry, value: string, cursor: number): void {
    if (trigger === null) return;
    setValue(removeTriggerSpan(value, trigger.triggerIndex, cursor));
    onPick(skill.name);
    setTrigger(null);
    setHighlight(0);
    setQuery("");
  }

  /** Route the panel's keys from the textarea. Returns true when consumed --
   *  the QuestionBar then skips its own Enter-submit handling. */
  function handleKeyDown(
    e: KeyboardEvent<HTMLTextAreaElement>,
  ): boolean {
    if (trigger === null) return false;
    // IME composition confirmation never selects (the same guard the submit
    // path applies -- an in-progress composition's Enter must not act).
    if (e.nativeEvent.isComposing) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      // Clamped movement, never wrapping (Decision 5).
      e.preventDefault();
      setHighlight(
        clampHighlight(
          highlightIndex,
          e.key === "ArrowDown" ? 1 : -1,
          rows.length,
        ),
      );
      return true;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      // Panel open: Enter selects, never submits -- including the no-match
      // face, where it is a plain no-op (Shift+Enter still inserts the
      // newline; the newline in the query region closes the panel anyway).
      e.preventDefault();
      const row = rows[highlightIndex];
      if (row) {
        select(
          row,
          e.currentTarget.value,
          e.currentTarget.selectionStart ?? e.currentTarget.value.length,
        );
      }
      return true;
    }
    if (e.key === "Escape") {
      // Esc closes the panel; the trigger char + query stay as plain text
      // (Decision 5) -- no draft mutation on this path.
      e.preventDefault();
      setTrigger(null);
      return true;
    }
    return false;
  }

  /** Blur closes the panel without touching the draft -- the trigger span
   *  stays as plain text; a re-focus does not reopen (Decision 5). */
  function handleBlur(): void {
    if (trigger === null) return;
    setTrigger(null);
    setHighlight(0);
  }

  /** Close without consuming anything (a submit while the panel is open is
   *  still a turn boundary). */
  function close(): void {
    setTrigger(null);
    setHighlight(0);
  }

  return {
    isOpen: trigger !== null,
    mode: trigger?.mode ?? null,
    rows,
    query,
    totalSkills: registry.length,
    activatedNames,
    highlightIndex,
    handleChange,
    handleKeyDown,
    handleBlur,
    select,
    setHighlight,
    close,
  };
}
