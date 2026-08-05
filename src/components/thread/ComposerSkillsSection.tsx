import { useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings } from "lucide-react";

import { listMountedSkills, listSkills, mountSkill, unmountSkill } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import { sessionKeys, skillKeys } from "../../session/queryKeys";
import type { SkillEntry } from "../../types/skills";

// The skills section of the composer "+" panel (issue #365, ADR-0086). Replaces
// the prior disabled placeholder (#351). Renders a compact checkbox list of
// every registry skill (name + checkbox only -- no description, no `acquired`
// chip; this slice lists ALL spec-valid skills; the muted-skill filter + the
// popover-internal mounted/total header land in later #303 slices). One toggle
// per row mounts / unmounts the skill into THIS session's active set: the write
// appends a SkillLifecycleEvent to the timeline + persists the recipe; the
// mount SET is folded from that sequence (Mount in / Unmount out), never stored
// as a snapshot. The trigger badge (mountedSkillCount + enabledMcpCount) lives
// in the parent ComposerContextPanel -- it shares this query's cache.
//
// The turn-in-flight `loading` gate (ADR-0040) disables every toggle: the
// backend `mount_skill` / `unmount_skill` commands also refuse during resume /
// an in-flight turn (reject_if_resuming + reject_if_in_flight), so the visual
// gate and the IPC gate agree (AC #5). The "Manage skills" footer hops to the
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
  // One pending name at a time -- the toggle the user just clicked stays
  // disabled until its IPC settles, so a double-click cannot enqueue a
  // redundant mount / unmount. Other rows stay interactive (the backend
  // serializes mutations through the session lock; rapid cross-row toggles are
  // fine).
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The process-global registry (one root shared by every session). The parent
  // ComposerContextPanel reads the same key for its degraded decision, so the
  // first mount pays the IPC + every later consumer rides the cache.
  const { data: listing } = useQuery({
    queryKey: skillKeys.all(),
    queryFn: listSkills,
  });
  // The session's active mount set (folded from the timeline on the backend).
  // Shares the cache with the parent's badge read; mount / unmount invalidate
  // it so the badge re-reads without a remount (ADR-0083).
  const { data: mounted } = useQuery({
    queryKey: sessionKeys.mountedSkills(sessionId),
    queryFn: () => listMountedSkills(sessionId),
  });

  const mountedSet = useMemo(() => new Set(mounted ?? []), [mounted]);

  // Resync the cache + clear the error after a mount / unmount settle. Central
  // here so both mutations share the identical post-write behavior (seed the
  // cache for an instant flip, then invalidate so the backend truth lands).
  function applyMountDelta(delta: (prev: string[] | undefined) => string[]) {
    setError(null);
    queryClient.setQueryData<string[]>(sessionKeys.mountedSkills(sessionId), delta);
    void queryClient.invalidateQueries({ queryKey: sessionKeys.mountedSkills(sessionId) });
  }

  const mountMutation = useMutation({
    mutationFn: (name: string) => mountSkill(sessionId, name),
    onMutate: (name) => setPendingName(name),
    onSuccess: (_data, name) =>
      applyMountDelta((prev) => (prev?.includes(name) ? prev : [...(prev ?? []), name])),
    onError: (e) => {
      setError(fmtError(e, intl));
      void queryClient.invalidateQueries({ queryKey: sessionKeys.mountedSkills(sessionId) });
    },
    onSettled: () => setPendingName(null),
  });

  const unmountMutation = useMutation({
    mutationFn: (name: string) => unmountSkill(sessionId, name),
    onMutate: (name) => setPendingName(name),
    onSuccess: (_data, name) =>
      applyMountDelta((prev) => prev?.filter((n) => n !== name) ?? []),
    onError: (e) => {
      setError(fmtError(e, intl));
      void queryClient.invalidateQueries({ queryKey: sessionKeys.mountedSkills(sessionId) });
    },
    onSettled: () => setPendingName(null),
  });

  function toggle(skill: SkillEntry) {
    if (loading || pendingName !== null) return;
    if (mountedSet.has(skill.name)) {
      unmountMutation.mutate(skill.name);
    } else {
      mountMutation.mutate(skill.name);
    }
  }

  const registry = useMemo(() => listing?.skills ?? [], [listing]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q === "") return registry;
    return registry.filter((s) => s.name.toLowerCase().includes(q));
  }, [registry, search]);

  const empty = registry.length === 0;
  const noMatches = !empty && filtered.length === 0;

  return (
    <section className="composer-skill-section grid gap-1.5">
      <span className="text-sm font-medium">
        <FormattedMessage
          id="composer.contextPanel.skillsTitle"
          defaultMessage="Skills"
        />
      </span>
      {/* Compact search -- filters by name only (the list shows name + checkbox,
          no description to also match against). The aria-label reuses the
          placeholder id: a placeholder alone is not a substitute for an
          accessible name (it vanishes on input), and the compact popover has no
          room for a visible <label>. */}
      <input
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
        className="border-border bg-background text-foreground h-7 w-full rounded-md border px-2 text-xs"
      />
      <ul className="grid max-h-44 gap-0.5 overflow-y-auto pr-0.5">
        {filtered.map((skill) => {
          const isMounted = mountedSet.has(skill.name);
          const pending = pendingName === skill.name;
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
                <span className="truncate">{skill.name}</span>
              </label>
            </li>
          );
        })}
      </ul>
      {empty && (
        <span className="text-muted-foreground px-2 py-2 text-xs">
          <FormattedMessage
            id="composer.contextPanel.skillsEmpty"
            defaultMessage="No skills yet. Add one in Settings."
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
      {error && (
        <p className="text-destructive px-2 text-xs" role="alert">
          {error}
        </p>
      )}
      {/* Footer: hop to the settings SkillsSection. The shell owns the
          navigation; the parent threads App.openSettings({ section: "skills" })
          through. */}
      <button
        type="button"
        onClick={onOpenSettingsSkills}
        className="hover:bg-accent focus-visible:outline-ring -mx-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <Settings className="size-3.5" aria-hidden />
        <FormattedMessage
          id="composer.contextPanel.manageSkills"
          defaultMessage="Manage skills"
        />
      </button>
    </section>
  );
}
