import { useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";

import { Input } from "../ui/input";
import { TruncatingTooltip } from "./TruncatingTooltip";
import { listMountedSkills, listSkills, mountSkill, unmountSkill } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import { log } from "../../lib/log";
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
// Cold start (ADR-0092 Decision 6, #500): sessionId is null on the centered
// bar before any session exists. The section runs in DRAFT mode: the mounted
// query is disabled (no IPC) and the caller-held pending list is the mount
// set; a toggle rewrites the list through onPendingSkillsChange and the shell
// mounts every pick onto the session the first submit mints.
//
// The turn-in-flight `loading` gate (ADR-0040) disables every toggle: the
// backend `mount_skill` / `unmount_skill` commands also refuse during resume /
// an in-flight turn (reject_if_resuming + reject_if_in_flight), so the visual
// gate and the IPC gate agree (AC #5). The "Add skill" footer hops to the
// settings SkillsSection via the parent's onOpenSettingsSkills callback.

const ROW_CLASS =
  "composer-skill-row focus-visible:outline-ring flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2";

export type ComposerSkillsSectionProps = {
  /** The session whose mount set this section reads / writes. null on the
   *  cold-start shell-level bar (ADR-0092 / #500): the section reads
   *  pendingSkills and writes via onPendingSkillsChange instead of the
   *  per-session mount IPC. */
  sessionId: string | null;
  /** The session is mid-turn or mid-mutation: toggles are gated off (AC #5),
   *  mirroring the file-entry gate the parent already honors. */
  loading: boolean;
  /** Hop to the settings SkillsSection (the registry CRUD surface). Shell-owned
   *  navigation -- the parent threads the App.openSettings callback through. */
  onOpenSettingsSkills: () => void;
  /** When sessionId is null (cold-start bar), the shell-held pending mount
   *  list rendered as the section's checked rows. */
  pendingSkills?: string[];
  /** When sessionId is null (cold-start bar), a toggle hands the NEXT pending
   *  list (pick appended / removed) to the shell via this callback. Undefined
   *  when sessionId is non-null. */
  onPendingSkillsChange?: (next: string[]) => void;
};

export function ComposerSkillsSection({
  sessionId,
  loading,
  onOpenSettingsSkills,
  pendingSkills,
  onPendingSkillsChange,
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

  const { data: listing, isLoading, error: listingQueryError } = useQuery({
    queryKey: skillKeys.all(),
    queryFn: listSkills,
  });
  // Null sessionId (cold-start bar, ADR-0092): the query is disabled and the
  // caller-held pending list is the mount set — no IPC round-trip.
  const { data: mounted, error: mountedQueryError } = useQuery({
    // The queryKey uses a stable placeholder when sessionId is null — the key
    // is inert (enabled:false prevents the queryFn from running, so no IPC).
    queryKey: sessionKeys.mountedSkills(sessionId ?? ""),
    queryFn: () => listMountedSkills(sessionId as string),
    enabled: sessionId !== null,
  });

  const mountedSet = useMemo(
    () =>
      new Set(
        sessionId === null ? (pendingSkills ?? []) : (mounted ?? []),
      ),
    [sessionId, pendingSkills, mounted],
  );

  // Session-mode-only mutation machinery below: toggle() routes null-sessionId
  // rows to the pending-list path, so none of these ever run in draft mode.
  // The `as string` casts carry that invariant (the same pattern the
  // disabled-query queryFns above use).
  function applyMountDelta(delta: (prev: string[] | undefined) => string[]) {
    setError(null);
    queryClient.setQueryData<string[]>(
      sessionKeys.mountedSkills(sessionId as string),
      delta,
    );
    void queryClient.invalidateQueries({
      queryKey: sessionKeys.mountedSkills(sessionId as string),
    });
  }

  function invalidateAfterSkillMutation(name: string) {
    clearPending(name);
    void queryClient.invalidateQueries({
      queryKey: sessionKeys.mcpStatus(sessionId as string),
    });
  }

  const mountMutation = useMutation({
    mutationFn: (name: string) => mountSkill(sessionId as string, name),
    onMutate: (name) => markPending(name),
    onSuccess: (_data, name) =>
      applyMountDelta((prev) => (prev?.includes(name) ? prev : [...(prev ?? []), name])),
    onError: (e) => {
      setError(fmtError(e, intl));
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.mountedSkills(sessionId as string),
      });
    },
    onSettled: (_d, _e, name) => invalidateAfterSkillMutation(name),
  });

  const unmountMutation = useMutation({
    mutationFn: (name: string) => unmountSkill(sessionId as string, name),
    onMutate: (name) => markPending(name),
    onSuccess: (_data, name) =>
      applyMountDelta((prev) => prev?.filter((n) => n !== name) ?? []),
    onError: (e) => {
      setError(fmtError(e, intl));
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.mountedSkills(sessionId as string),
      });
    },
    onSettled: (_d, _e, name) => invalidateAfterSkillMutation(name),
  });

  function toggle(skill: SkillEntry) {
    if (loading || pendingNames.has(skill.name)) return;
    // Null sessionId (cold-start bar, ADR-0092 / #500): rewrite the
    // caller-held pending list synchronously — no IPC, no per-name pending
    // gate. When the callback is absent the toggle is logged and discarded so
    // an unwired cold-start bar is observable instead of silently swallowed.
    if (sessionId === null) {
      if (onPendingSkillsChange) {
        const current = pendingSkills ?? [];
        const next = mountedSet.has(skill.name)
          ? current.filter((n) => n !== skill.name)
          : [...current, skill.name];
        onPendingSkillsChange(next);
      } else {
        log.warn(
          "ComposerSkillsSection",
          "toggle called with null sessionId but no onPendingSkillsChange handler — selection discarded",
        );
      }
      return;
    }
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
  const displayError = error
    ?? (listingQueryError ? fmtError(listingQueryError, intl) : null)
    ?? (mountedQueryError ? fmtError(mountedQueryError, intl) : null);

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
