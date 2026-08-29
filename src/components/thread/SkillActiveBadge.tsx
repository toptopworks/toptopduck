import { FormattedMessage } from "react-intl";

// The Active badge (issue #699's activation FACE, kept display-only by
// ADR-0112): one domain concept, one color -- the picker row and the
// mount-list row share this span so the two surfaces agree by code, not by
// convention (the same standard the shared filterSkills set). Same primary
// token as the thread's Activate marker.
export function SkillActiveBadge() {
  return (
    <span className="bg-primary text-primary-foreground shrink-0 rounded-md px-2 py-0.5 text-xs font-medium leading-none">
      <FormattedMessage
        id="composer.contextPanel.skillActiveBadge"
        defaultMessage="Active"
      />
    </span>
  );
}
