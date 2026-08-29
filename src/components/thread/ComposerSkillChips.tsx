import { useIntl } from "react-intl";
import { Puzzle } from "lucide-react";

// Pre-activation chips (ADR-0112, issue #716): the composer's display of the
// activation intents expressed since the last submit. Rendered inline in the
// QuestionBar input area, flowing with the draft text -- the list is
// display:contents so each chip participates in the input row's flex wrap and
// the caret seats right after the last chip. Pure display: withdrawal rides
// the textarea's Backspace at the draft start (the chips seat before the
// draft's first char, so the last chip deletes like a text char) and the
// unmount cascade -- the component itself carries no removal affordance.

export type ComposerSkillChipsProps = {
  /** Pre-activation intent names, in pick order. Empty renders nothing. */
  names: string[];
};

export function ComposerSkillChips({ names }: ComposerSkillChipsProps) {
  const intl = useIntl();
  if (names.length === 0) return null;
  return (
    <ul
      className="contents"
      aria-label={intl.formatMessage({
        id: "composer.skillChips.groupAria",
        defaultMessage: "Pre-activated skills",
      })}
    >
      {names.map((name) => (
        <li
          key={name}
          className="inline-flex min-w-0 max-w-full items-center gap-1 text-sm font-medium text-accent-foreground"
        >
          <Puzzle className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{name}</span>
        </li>
      ))}
    </ul>
  );
}
