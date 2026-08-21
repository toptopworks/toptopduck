import { useState } from "react";
import { useIntl } from "react-intl";
import { useQuery } from "@tanstack/react-query";
import { Puzzle } from "lucide-react";

import { listMountedSkills, listSkills } from "../../api";
import { sessionKeys, skillKeys } from "../../session/queryKeys";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ComposerSkillsSection } from "./ComposerSkillsSection";
import { LABEL_HIDE_NARROW } from "./composer-visual";

// The Skills trigger chip, rendered in the QuestionBar container's top row
// (the shell-level bar's header slot). Shows the puzzle icon + mounted/total
// count. Click opens a popover with the search + checkbox list + add-skill
// footer. The count queries share cache keys with ComposerSkillsSection, so
// the popover content rides the same IPC round-trip.
//
// Cold start (ADR-0092 Decision 6, #500): sessionId is null on the centered
// bar before any session exists. The chip shows the caller-held pending mount
// list's count (empty initial — the "empty mount set" draft face) with no
// per-session IPC; toggles inside the popover write to the shell-level
// pending list via onPendingSkillsChange, and the shell mounts them onto the
// session the first submit mints.

export type ComposerSkillsTriggerProps = {
  /** The session whose mount set this trigger reads. null on the cold-start
   *  shell-level bar (ADR-0092): the chip reads pendingSkills instead of the
   *  per-session mount query. */
  sessionId: string | null;
  loading: boolean;
  onOpenSettingsSkills: () => void;
  /** When sessionId is null (cold-start bar, ADR-0092 / #500), the
   *  shell-held pending mount list behind the chip's mounted count. */
  pendingSkills?: string[];
  /** When sessionId is null (cold-start bar, ADR-0092 / #500), a popover
   *  toggle writes to the shell-level pending list via this callback instead
   *  of the per-session mount IPC. Undefined when sessionId is non-null. */
  onPendingSkillsChange?: (next: string[]) => void;
};

const CHIP_CLASS =
  "composer-skills-trigger inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted cursor-pointer";

export function ComposerSkillsTrigger({
  sessionId,
  loading,
  onOpenSettingsSkills,
  pendingSkills,
  onPendingSkillsChange,
}: ComposerSkillsTriggerProps) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);

  // Mounted count for the chip label (shared cache with ComposerSkillsSection).
  // Null sessionId (cold-start bar, ADR-0092): the query is disabled — no IPC
  // round-trip; the pending list's length drives the count.
  const { data: mounted } = useQuery({
    queryKey: sessionKeys.mountedSkills(sessionId ?? ""),
    queryFn: () => listMountedSkills(sessionId as string),
    enabled: sessionId !== null,
  });
  // Registry total for the chip label (shared cache with ComposerSkillsSection).
  const { data: listing } = useQuery({
    queryKey: skillKeys.all(),
    queryFn: listSkills,
  });

  const mountedCount =
    sessionId === null ? (pendingSkills ?? []).length : (mounted ?? []).length;
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
          {/* LABEL_HIDE_NARROW collapses the label when the QuestionBar
              @container narrows, leaving the icon -- the same threshold the
              auth-mode chip uses. aria-label keeps the full label (with
              counts) as the accessible name at every width. */}
          <span className={LABEL_HIDE_NARROW}>{label}</span>
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
          pendingSkills={pendingSkills}
          onPendingSkillsChange={onPendingSkillsChange}
        />
      </PopoverContent>
    </Popover>
  );
}
