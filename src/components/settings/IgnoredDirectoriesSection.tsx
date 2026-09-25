import { FormattedMessage } from "react-intl";

import type { SkippedSkill } from "../../types/skills";
import { NameBadge } from "./settings-chrome";

type IgnoredDirectoriesSectionProps = {
  skipped: SkippedSkill[];
};

// Collapsible diagnostic fold for spec-invalid skill directories the scan
// skipped (issue #373). Rendered ONLY when the list is non-empty (a clean
// registry never
// shows it). Each row shows the directory name + the English technical
// reason verbatim -- the locale catalog owns the title / intro wording,
// NOT the per-row reason (ADR-0052 layer 4). The section does not
// participate in the search / filter / edit flows: it is read-only context.
// Native <details> / <summary> keeps it KISS (no extra state, keyboard +
// screen-reader accessible out of the box); the section is folded shut by
// default so the primary skills list stays the visual focus.
export function IgnoredDirectoriesSection({ skipped }: IgnoredDirectoriesSectionProps) {
  return (
    <details
      data-testid="skills-ignored-details"
      className="border-border mt-3 rounded-lg border"
    >
      <summary className="hover:bg-accent flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium select-none">
        <span>
          <FormattedMessage
            id="settings.skills.ignoredTitle"
            defaultMessage="Ignored directories"
          />
        </span>
        <NameBadge>
          {skipped.length}
        </NameBadge>
      </summary>
      <div className="border-border border-t px-4 py-3">
        <p className="text-muted-foreground mb-2 text-xs">
          <FormattedMessage
            id="settings.skills.ignoredDescription"
            defaultMessage="These skill folders couldn't be loaded. Fix the folder or its SKILL.md file, then rescan."
          />
        </p>
        <ul className="grid gap-1.5">
          {skipped.map((entry) => (
            <li
              key={entry.dir}
              data-testid="ignored-skill-row"
              className="grid gap-0.5 text-xs"
            >
              <span className="font-mono font-medium">{entry.dir}</span>
              <span className="text-muted-foreground break-words">
                {entry.reason}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
