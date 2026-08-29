import { Puzzle } from "lucide-react";
import { FormattedMessage, useIntl } from "react-intl";
import { cn } from "@/lib/utils";

import type { ReactNode } from "react";
import type { SkillEntry } from "../../types/skills";
import type { SkillPickerMode } from "./skillPickerLogic";

// The floating picker surface of the composer (ADR-0112, issue #716). One
// component, two presentation modes: mode "global" ("/") renders the group
// header "Skills" above the list -- the grouping architecture future item
// types (e.g. subagents) join as new groups, never an empty placeholder
// group; mode "skills" ("$") renders the flat skills-direct list with no
// header. Pure presentation: the parent (QuestionBar via useSkillPicker)
// owns the trigger state, the filtered rows, and the highlight index; this
// panel only renders rows and reports hover / click. The keyboard contract
// (↑↓ / Enter / Esc) is handled at the textarea, so focus never leaves it --
// the listbox marks the highlighted row via aria-activedescendant instead of
// DOM focus.
//
// Row anatomy (Decision 5): leading skill icon + name + right-aligned
// truncated description + provenance badge on every row (built-in vs
// personal) + display-only Active badge. While a query is active the row
// text dims to muted and every case-insensitive hit of it renders in the
// foreground (name and description alike), so each row reads its own reason
// for surviving the name-or-description filter. The Active badge is pure
// display -- it reads the activated set the parent passes and never gates
// selection: an already-activated skill selects like any other, and the
// submit-time materialization absorbs the redundancy idempotently.

// bottom-full + mb-2: the panel floats above the bar's top edge with a gap,
// never overlapping the composer (the header trigger row stays uncovered).
const PANEL_CLASS =
  "absolute bottom-full left-0 z-40 mb-2 grid w-full gap-0.5 overflow-hidden rounded-md border border-border bg-popover p-1 shadow-md";
const LIST_CLASS = "grid max-h-60 min-h-0 gap-0.5 overflow-y-auto pr-0.5";
const ROW_CLASS =
  "flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none";
const NOTE_CLASS = "text-muted-foreground px-2 py-2 text-xs";

export type SkillPickerPanelProps = {
  /** The DOM id the textarea's aria-controls points at. */
  id: string;
  /** Which presentation mode the trigger char opened (Decision 1). */
  mode: SkillPickerMode;
  /** Pre-filtered rows; the parent owns the query filter. */
  skills: SkillEntry[];
  /** The raw filter query; drives the matched-substring highlighting. */
  query: string;
  /** Registry size before filtering -- distinguishes the "No skills" empty
   *  registry face from the no-match row. */
  totalSkills: number;
  /** Activated names for the display-only Active badges (empty on the
   *  cold-start bar -- no session, no activation truth). */
  activatedNames: ReadonlySet<string>;
  /** The highlighted row index (already clamped by the parent). */
  highlightIndex: number;
  onHoverIndex: (index: number) => void;
  onSelect: (skill: SkillEntry) => void;
};

export function SkillPickerPanel({
  id,
  mode,
  skills,
  query,
  totalSkills,
  activatedNames,
  highlightIndex,
  onHoverIndex,
  onSelect,
}: SkillPickerPanelProps) {
  const intl = useIntl();
  const empty = totalSkills === 0;
  const noMatches = !empty && skills.length === 0;
  const filtering = query.trim() !== "";

  return (
    <div className={PANEL_CLASS} role="presentation">
      {mode === "global" && (
        // Group header: the "/" panel's signature. The "$" direct panel
        // omits it (flat by definition, Decision 1).
        <div className="text-muted-foreground px-2 py-1 text-xs font-medium">
          <FormattedMessage
            id="composer.skillPicker.groupLabel"
            defaultMessage="Skills"
          />
        </div>
      )}
      <ul
        id={id}
        role="listbox"
        aria-label={intl.formatMessage({
          id: "composer.skillPicker.listAria",
          defaultMessage: "Skill picker",
        })}
        className={LIST_CLASS}
        aria-activedescendant={
          skills.length > 0 ? optionId(id, highlightIndex) : undefined
        }
      >
        {skills.map((skill, index) => (
          <li
            key={skill.name}
            id={optionId(id, index)}
            role="option"
            aria-selected={index === highlightIndex}
            className={cn(
              ROW_CLASS,
              index === highlightIndex &&
              "bg-accent text-accent-foreground",
            )}
            // Hover mirrors the keyboard highlight so mouse and ↑↓ agree on
            // which row Enter will pick; mousedown is prevented so the click
            // never pulls focus out of the textarea.
            onMouseEnter={() => onHoverIndex(index)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelect(skill)}
          >
            <Puzzle
              className="text-muted-foreground size-4 shrink-0"
              aria-hidden
            />
            <span
              className={cn(
                "shrink-0 truncate font-medium",
                filtering && "text-muted-foreground",
              )}
            >
              {highlightMatches(skill.name, query)}
            </span>
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-right">
              {highlightMatches(skill.description, query)}
            </span>
            <span className="text-muted-foreground shrink-0 text-xs">
              {skill.acquired === "builtin" ? (
                <FormattedMessage
                  id="composer.contextPanel.builtinSkillBadge"
                  defaultMessage="System"
                />
              ) : (
                <FormattedMessage
                  id="composer.skillPicker.localBadge"
                  defaultMessage="Personal"
                />
              )}
            </span>
            {activatedNames.has(skill.name) && (
              // Same primary token as the section's Active badge -- one
              // domain concept, one color.
              <span className="bg-primary text-primary-foreground shrink-0 rounded-md px-2 py-0.5 text-xs font-medium leading-none">
                <FormattedMessage
                  id="composer.contextPanel.skillActiveBadge"
                  defaultMessage="Active"
                />
              </span>
            )}
          </li>
        ))}
      </ul>
      {empty && (
        <div className={NOTE_CLASS}>
          <FormattedMessage
            id="composer.contextPanel.skillsEmpty"
            defaultMessage="No skills"
          />
        </div>
      )}
      {noMatches && (
        <div className={NOTE_CLASS}>
          <FormattedMessage
            id="composer.contextPanel.skillsNoMatches"
            defaultMessage="No skills match your search."
          />
        </div>
      )}
    </div>
  );
}

/** Split `text` around every case-insensitive occurrence of the trimmed
 *  query, wrapping each hit in a foreground span. An empty query returns the
 *  plain string -- no spans, no dimming. */
function highlightMatches(text: string, query: string): ReactNode {
  const q = query.trim().toLowerCase();
  if (q === "") return text;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let at = lower.indexOf(q);
  while (at !== -1) {
    if (at > cursor) parts.push(text.slice(cursor, at));
    parts.push(
      <span key={at} className="text-foreground">
        {text.slice(at, at + q.length)}
      </span>,
    );
    cursor = at + q.length;
    at = lower.indexOf(q, cursor);
  }
  parts.push(text.slice(cursor));
  return parts;
}

function optionId(panelId: string, index: number): string {
  return `${panelId}-option-${index}`;
}
