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
  type SkillPickerMode,
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

/** The picker's render-time state, one variant per panel posture (issue
 *  #718 collapsed the isOpen/mode redundant pair into this discriminant):
 *  closed carries no panel fields at all; open carries every read the
 *  panel surface needs. */
export type SkillPickerState =
  | { status: "closed" }
  | {
    status: "open";
    mode: SkillPickerMode;
    rows: SkillEntry[];
    query: string;
    /** null = no highlighted row (the filtered list is empty). The
       *  sentinel exists ONLY in this snapshot -- the stored highlight
       *  stays a plain number. */
    highlightIndex: number | null;
    totalSkills: number;
    registryError: Error | null;
    activatedNames: ReadonlySet<string>;
  };

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
  // no extra IPC round-trip once any of them has loaded. The error channel
  // is exposed alongside the data: a rejected listing must surface as an
  // error row, not collapse into the "No skills" empty face (the mount list
  // riding the same cache surfaces its error -- the picker must not be the
  // one surface that hides it).
  const { data: listing, error: listingError } = useQuery({
    queryKey: skillKeys.all(),
    queryFn: listSkills,
    enabled,
  });
  const registry = useMemo(() => listing?.skills ?? [], [listing]);
  // Display-only activation truth (Decision 5): session mode reads the
  // activated set; cold start keeps the query disabled -- no session exists,
  // so no badges. The set NEVER gates selection (Decision 3).
  // Failure ruling (issue #718): a rejected read here degrades to "no
  // badges", NOT an error surface -- deliberately asymmetric with the
  // listing failure (which renders the error row): the badges are pure
  // display, so a failed read misstates nothing actionable, while a failed
  // listing hides the panel's whole substance.
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
  // The single holder of the null sentinel (issue #718): the stored
  // highlight stays a plain number; only this derivation maps an empty
  // filtered list to null (no row to name) and clamps against the live row
  // count otherwise -- the query can shrink the list below the stored index
  // between keystrokes. Every consumer reads the snapshot's value, never a
  // re-derivation of its own.
  const highlightIndex =
    rows.length === 0 ? null : Math.min(highlight, rows.length - 1);
  const state: SkillPickerState =
    trigger === null
      ? { status: "closed" }
      : {
          status: "open",
          mode: trigger.mode,
          rows,
          query,
          highlightIndex,
          totalSkills: registry.length,
          registryError: listingError ?? null,
          activatedNames,
        };

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
   *  stored query), report the pick, close the panel. The consumed span is
   *  the STORED one (what the rendered rows filtered); the live caret only
   *  gates that it still sits inside it -- a caret move that fires no change
   *  event (click / Home / arrows) leaves the stored span stale against the
   *  draft, and a removal bounded by an out-of-span caret would eat or
   *  duplicate text beyond the span. On an out-of-span caret the panel
   *  closes without picking and the draft is left untouched. */
  function select(skill: SkillEntry, value: string, cursor: number): void {
    if (trigger === null) return;
    const end = trigger.triggerIndex + 1 + query.length;
    if (cursor <= trigger.triggerIndex || cursor > end) {
      setTrigger(null);
      setHighlight(0);
      return;
    }
    setValue(removeTriggerSpan(value, trigger.triggerIndex, end));
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
      // Clamped movement, never wrapping (Decision 5). The empty face has
      // no row to move: a consumed no-op there -- the null sentinel marks
      // it, because the clamp's precondition is a non-empty list.
      e.preventDefault();
      if (highlightIndex === null) return true;
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
      const row = highlightIndex === null ? undefined : rows[highlightIndex];
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

  /** Close without consuming anything: blur (the trigger span stays as
   *  plain text; a re-focus does not reopen, Decision 5) and a submit while
   *  the panel is open (still a turn boundary) both land here -- while
   *  closed the state is already reset, and a same-value setState bails
   *  out without a render. */
  function close(): void {
    setTrigger(null);
    setHighlight(0);
  }

  // The action methods sit OUTSIDE the state union (issue #718): they are
  // posture-stable -- the closed-state submit path still calls close(), and
  // handleKeyDown returns false on closed so the key flows through to the
  // bar's own Enter-submit handling.
  return {
    state,
    handleChange,
    handleKeyDown,
    select,
    setHighlight,
    close,
  };
}
