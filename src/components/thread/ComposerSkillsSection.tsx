import { useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";

import { Input } from "../ui/input";
import { TruncatingTooltip } from "./TruncatingTooltip";
import { listMountedSkills, listSkills, mountSkill, unmountSkill } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import { sessionKeys, skillKeys } from "../../session/queryKeys";
import type { SkillEntry } from "../../types/skills";

// The skills section of the Skills trigger popover (issue #365, ADR-0086).
// Rendered inside ComposerSkillsTrigger's PopoverContent -- the trigger chip
// carries the icon + count header, so this component is pure content: search +
// checkbox list + add-skill footer. One toggle per row mounts / unmounts the
// skill into THIS session's active set: the write appends a SkillLifecycleEvent
// to the timeline + persists the recipe; the mount SET is folded from that
// sequence (Mount in / Unmount out), never stored as a snapshot.
//
// The turn-in-flight `loading` gate (ADR-0040) disables every toggle: the
// backend `mount_skill` / `unmount_skill` commands also refuse during resume /
// an in-flight turn (reject_if_resuming + reject_if_in_flight), so the visual
// gate and the IPC gate agree (AC #5). The "Add skill" footer hops to the
// settings SkillsSection via the parent's onOpenSettingsSkills callback.

const ROW_CLASS =
  "composer-skill-row focus-visible:outline-ring flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2";

export type ComposerSkillsSectionProps = {
  /** The session whose mount set this section reads / writes. */
  sessionId: string;
  /** The session is mid-turn or mid-mutation: toggles are gated off (AC #5),
   *  mirroring the file-entry gate the parent already honors. */
  loading: boolean;
  /** Hop to the settings SkillsSection (the registry CRUD surface). Shell-owned
   *  navigation -- the parent threads the App.openSettings callback through. */
  onOpenSettingsSkills: () => void;
};

export function ComposerSkillsSection({
  sessionId,
  loading,
  onOpenSettingsSkills,
}: ComposerSkillsSectionProps) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [pendingNames, setPendingNames] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  function markPending(name: string) {
    setPendingNames((prev) => new Set(prev).add(name));
  }
  function clearPending(name: string) {
    setPendingNames((prev) => {
      if (!prev.has(name)) return prev;
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  }

  const { data: listing, isLoading } = useQuery({
    queryKey: skillKeys.all(),
    queryFn: listSkills,
  });
  const { data: mounted, error: mountedQueryError } = useQuery({
    queryKey: sessionKeys.mountedSkills(sessionId),
    queryFn: () => listMountedSkills(sessionId),
  });

  const mountedSet = useMemo(() => new Set(mounted ?? []), [mounted]);

  function applyMountDelta(delta: (prev: string[] | undefined) => string[]) {
    setError(null);
    queryClient.setQueryData<string[]>(sessionKeys.mountedSkills(sessionId), delta);
    void queryClient.invalidateQueries({ queryKey: sessionKeys.mountedSkills(sessionId) });
  }

  function invalidateAfterSkillMutation(name: string) {
    clearPending(name);
    void queryClient.invalidateQueries({ queryKey: sessionKeys.mcpStatus(sessionId) });
  }

  const mountMutation = useMutation({
    mutationFn: (name: string) => mountSkill(sessionId, name),
    onMutate: (name) => markPending(name),
    onSuccess: (_data, name) =>
      applyMountDelta((prev) => (prev?.includes(name) ? prev : [...(prev ?? []), name])),
    onError: (e) => {
      setError(fmtError(e, intl));
      void queryClient.invalidateQueries({ queryKey: sessionKeys.mountedSkills(sessionId) });
    },
    onSettled: (_d, _e, name) => invalidateAfterSkillMutation(name),
  });

  const unmountMutation = useMutation({
    mutationFn: (name: string) => unmountSkill(sessionId, name),
    onMutate: (name) => markPending(name),
    onSuccess: (_data, name) =>
      applyMountDelta((prev) => prev?.filter((n) => n !== name) ?? []),
    onError: (e) => {
      setError(fmtError(e, intl));
      void queryClient.invalidateQueries({ queryKey: sessionKeys.mountedSkills(sessionId) });
    },
    onSettled: (_d, _e, name) => invalidateAfterSkillMutation(name),
  });

  function toggle(skill: SkillEntry) {
    if (loading || pendingNames.has(skill.name)) return;
    if (mountedSet.has(skill.name)) {
      unmountMutation.mutate(skill.name);
    } else {
      mountMutation.mutate(skill.name);
    }
  }

  const registry = useMemo(() => listing?.skills ?? [], [listing]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched =
      q === "" ? registry : registry.filter((s) => s.name.toLowerCase().includes(q));
    // Pin mounted (selected) skills to the top; Array.prototype.sort is
    // stable, so the registry order is preserved within each group.
    return [...matched].sort(
      (a, b) => Number(mountedSet.has(b.name)) - Number(mountedSet.has(a.name)),
    );
  }, [registry, search, mountedSet]);

  const empty = !isLoading && registry.length === 0;
  const noMatches = !empty && filtered.length === 0;
  const displayError = error ?? (mountedQueryError ? fmtError(mountedQueryError, intl) : null);

  return (
    <div className="composer-skill-section grid gap-1.5">
      <Input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={intl.formatMessage({
          id: "composer.contextPanel.skillsSearchPlaceholder",
          defaultMessage: "Search skills…",
        })}
        aria-label={intl.formatMessage({
          id: "composer.contextPanel.skillsSearchPlaceholder",
          defaultMessage: "Search skills…",
        })}
        className="h-7 px-2 text-xs dark:bg-background"
      />
      {/* minmax(0,1fr) caps the implicit grid track at the popover width so
          long names hit the row's truncate instead of widening the track;
          min-h-0 lets max-h-44 actually cap the list height (without it, the
          grid item's default min-height:auto overrides max-height and the
          list grows unbounded); overflow-x-hidden keeps the vertical scroller
          from ever growing a horizontal one. */}
      <ul className="grid max-h-44 min-h-0 grid-cols-[minmax(0,1fr)] gap-0.5 overflow-x-hidden overflow-y-auto pr-0.5">
        {filtered.map((skill) => {
          const isMounted = mountedSet.has(skill.name);
          const pending = pendingNames.has(skill.name);
          const disabled = loading || pending;
          return (
            <li key={skill.name}>
              <label className={ROW_CLASS}>
                <input
                  type="checkbox"
                  checked={isMounted}
                  disabled={disabled}
                  onChange={() => toggle(skill)}
                  className="size-3.5 cursor-pointer accent-primary disabled:cursor-not-allowed"
                  aria-label={intl.formatMessage(
                    {
                      id: "composer.contextPanel.skillToggleAria",
                      defaultMessage: "Mount skill {name}",
                    },
                    { name: skill.name },
                  )}
                />
                <TruncatingTooltip text={skill.name} className="truncate">
                  {skill.name}
                </TruncatingTooltip>
              </label>
            </li>
          );
        })}
      </ul>
      {empty && (
        <span className="text-muted-foreground px-2 py-2 text-xs">
          <FormattedMessage
            id="composer.contextPanel.skillsEmpty"
            defaultMessage="No skills"
          />
        </span>
      )}
      {noMatches && (
        <span className="text-muted-foreground px-2 py-2 text-xs">
          <FormattedMessage
            id="composer.contextPanel.skillsNoMatches"
            defaultMessage="No skills match your search."
          />
        </span>
      )}
      {displayError && (
        <p className="text-destructive px-2 text-xs" role="alert">
          {displayError}
        </p>
      )}
      <div className="border-t border-border" />
      <button
        type="button"
        onClick={onOpenSettingsSkills}
        className="hover:bg-accent focus-visible:outline-ring -mx-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <Plus className="size-3.5" aria-hidden />
        <FormattedMessage
          id="composer.contextPanel.addSkill"
          defaultMessage="Add skill"
        />
      </button>
    </div>
  );
}
