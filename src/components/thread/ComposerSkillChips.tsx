import { useIntl } from "react-intl";
import { Puzzle, X } from "lucide-react";
import { bareButtonReset } from "../../lib/buttonReset";

// Skill chips (ADR-0112 trigger-then-stage, calibrated by ADR-0119
// Decision 5): the composer's display of THIS turn's staged invocations,
// cleared at the submit boundary -- there is no session-level skill state
// left to display. Rendered inline in the QuestionBar input area, flowing
// with the draft text -- the list is display:contents so each chip
// participates in the input row's flex wrap and the caret seats right after
// the last chip. Withdrawal rides the textarea's Backspace at the draft
// start (the last staged name deletes like a text char) and the per-chip
// button; permanent removal goes through the enablement axis in settings.

export type ComposerSkillChipsProps = {
  /** The display union (pre-activation intents, then unseen activated
   * names), in order. Empty renders nothing. */
  names: string[];
  /** Per-chip removal dispatch (issue #961). Absent = pure display. */
  onRemove?: (name: string) => void;
};

export function ComposerSkillChips({ names, onRemove }: ComposerSkillChipsProps) {
  const intl = useIntl();
  if (names.length === 0) return null;
  return (
    <ul
      className="contents"
      aria-label={intl.formatMessage({
        id: "composer.skillChips.groupAria",
        defaultMessage: "Skills",
      })}
    >
      {names.map((name) => (
        <li
          key={name}
          className="inline-flex min-w-0 max-w-full items-center gap-1 text-sm font-medium text-accent-foreground"
        >
          <Puzzle className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{name}</span>
          {onRemove && (
            <button
              type="button"
              className={`${bareButtonReset} hover:bg-accent -m-0.5 shrink-0 cursor-pointer rounded-sm p-0.5 text-muted-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
              aria-label={intl.formatMessage(
                {
                  id: "composer.skillChips.removeLabel",
                  defaultMessage: "Remove skill {name}",
                },
                { name },
              )}
              onClick={() => onRemove(name)}
            >
              <X className="size-3 shrink-0" aria-hidden />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
