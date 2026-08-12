import { useState } from "react";
import { useIntl } from "react-intl";
import { useQuery } from "@tanstack/react-query";
import { Puzzle } from "lucide-react";

import { listMountedSkills, listSkills } from "../../api";
import { sessionKeys, skillKeys } from "../../session/queryKeys";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ComposerSkillsSection } from "./ComposerSkillsSection";

// The Skills trigger chip, rendered in the QuestionBar container's top row
// (SessionPane header slot). Shows the puzzle icon + mounted/total count.
// Click opens a popover with the search + checkbox list + add-skill footer.
// The count queries share cache keys with ComposerSkillsSection, so the
// popover content rides the same IPC round-trip.

export type ComposerSkillsTriggerProps = {
  sessionId: string;
  loading: boolean;
  onOpenSettingsSkills: () => void;
};

const CHIP_CLASS =
  "composer-skills-trigger inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted cursor-pointer";

export function ComposerSkillsTrigger({
  sessionId,
  loading,
  onOpenSettingsSkills,
}: ComposerSkillsTriggerProps) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);

  // Mounted count for the chip label (shared cache with ComposerSkillsSection).
  const { data: mounted } = useQuery({
    queryKey: sessionKeys.mountedSkills(sessionId),
    queryFn: () => listMountedSkills(sessionId),
  });
  // Registry total for the chip label (shared cache with ComposerSkillsSection).
  const { data: listing } = useQuery({
    queryKey: skillKeys.all(),
    queryFn: listSkills,
  });

  const mountedCount = (mounted ?? []).length;
  const totalCount = (listing?.skills ?? []).length;
  const label = intl.formatMessage(
    {
      id: "composer.skillsTrigger.label",
      defaultMessage: "Skills ({mounted}/{total})",
    },
    { mounted: mountedCount, total: totalCount },
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={CHIP_CLASS} aria-label={label}>
          <Puzzle className="size-3.5" aria-hidden />
          {/* @max-[320px]:hidden collapses the label when the QuestionBar
              @container narrows, leaving the icon -- the same threshold the
              auth-mode chip uses. aria-label keeps the full label (with
              counts) as the accessible name at every width. */}
          <span className="@max-[320px]:hidden">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-64 p-3">
        <ComposerSkillsSection
          sessionId={sessionId}
          loading={loading}
          onOpenSettingsSkills={() => {
            setOpen(false);
            onOpenSettingsSkills();
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
