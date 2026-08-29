// Pure trigger/query algebra for the composer skill picker (ADR-0112, issue
// #716). Two trigger characters, one component, two presentation modes: "/"
// opens the global panel (grouped) and "$" the skills-direct panel (flat).
// The functions here are the whole keyboard contract minus the DOM: the
// QuestionBar feeds them the textarea's value + selection and owns no trigger
// logic of its own, so the contract pins in unit tests without any component
// render.

/** Which panel a trigger character opens (ADR-0112 Decision 1). "/" is the
 *  global panel (group header + list; future item types join it as new
 *  groups); "$" is the skills-direct flat list and never lists anything
 *  else. */
export type SkillPickerMode = "global" | "skills";

export interface SkillPickerTrigger {
  mode: SkillPickerMode;
  /** Index of the trigger character inside the draft value. */
  triggerIndex: number;
}

/** Detect a freshly typed trigger character: the char at `cursor - 1` must
 *  be "/" or "$" AND sit at a line start (index 0, or right after a newline)
 *  -- a mid-line character never opens the panel. An empty draft is the
 *  trivial line-start case. Returns null when no trigger applies. */
export function detectTrigger(
  value: string,
  cursor: number,
): SkillPickerTrigger | null {
  if (cursor <= 0) return null;
  const index = cursor - 1;
  const ch = value[index];
  if (ch !== "/" && ch !== "$") return null;
  if (index > 0 && value[index - 1] !== "\n") return null;
  return { mode: ch === "/" ? "global" : "skills", triggerIndex: index };
}

/** Recompute the filter query while the panel is open: the text between the
 *  trigger character and the caret. Returns null to CLOSE the panel -- the
 *  trigger character was deleted, the caret moved before it, or the query
 *  region crossed a newline (the query is single-line by contract). */
export function readPickerQuery(
  value: string,
  trigger: SkillPickerTrigger,
  cursor: number,
): string | null {
  if (value[trigger.triggerIndex] !== charFor(trigger.mode)) return null;
  if (cursor <= trigger.triggerIndex) return null;
  const query = value.slice(trigger.triggerIndex + 1, cursor);
  if (query.includes("\n")) return null;
  return query;
}

/** Selection consumes the trigger span: everything from the trigger
 *  character up to (not including) `end` leaves the draft, so only the
 *  remaining text is left to submit. `end` is the stored span's boundary
 *  (trigger char + stored query), NOT the live caret -- the caller gates the
 *  caret against the span first, so a caret moved outside it without a
 *  change event can never bound the removal and eat or duplicate text
 *  beyond the span. Esc, by contrast, keeps the span as plain text
 *  (ADR-0112 Decision 5). */
export function removeTriggerSpan(
  value: string,
  triggerIndex: number,
  end: number,
): string {
  return value.slice(0, triggerIndex) + value.slice(end);
}

/** Move the highlight by +1/-1 clamped to [0, count - 1] -- never wrapping
 *  (ADR-0112 Decision 5). Precondition: a NON-empty list (count >= 1) -- the
 *  empty face has no row to move, so the arrow keys are a no-op there and
 *  this function is never called; the picker snapshot's null highlightIndex
 *  is what marks the empty face (issue #718 retired the old "pin 0 for an
 *  empty list" branch that only a comment held honest). */
export function clampHighlight(
  index: number,
  delta: number,
  count: number,
): number {
  return Math.min(count - 1, Math.max(0, index + delta));
}

/** The name-or-description substring, case-insensitive filter -- the same
 *  match the mount list's search box applies, so the two surfaces agree on
 *  what a query selects (ADR-0112 Decision 5). */
export function filterSkills<T extends { name: string; description: string }>(
  skills: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...skills];
  return skills.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q),
  );
}

function charFor(mode: SkillPickerMode): string {
  return mode === "global" ? "/" : "$";
}

/** Option row DOM id inside the picker panel: the textarea's
 *  aria-activedescendant points at the highlighted option while focus stays
 *  in the textarea (the combobox pattern), so the id shape is contract --
 *  shared by the panel that renders the rows and the bar that names the
 *  active one. */
export function skillPickerOptionId(panelId: string, index: number): string {
  return `${panelId}-option-${index}`;
}
