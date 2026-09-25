import { useEffect, useMemo } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import {
  deleteSkill,
  importSkills,
  listSkills,
  setSkillEnabled,
} from "../api";
import { skillKeys } from "../session/queryKeys";
import type { AppConfig } from "../types/app-config";
import type {
  ImportItem,
  ImportMode,
  SkillEntry,
  SkillListing,
} from "../types/skills";

// The skills registry's frontend cache owner (issue #1077; ADR-0086's
// process-global registry direction). ONE seam owns every read and write of
// the registry's TanStack cache: the listing query pair
// (skillKeys.all() + listSkills) lives here, the three mutations
// (enablement / delete / import) ride here, and the module-level
// invalidateSkills() is the single invalidation entry the mount rescan and
// the mutations share. The consumers -- the settings pane, the import
// dialog, the composer picker, the thread rail -- read the projections and
// fire the mutations; none of them pairs its own query or rolls its own
// invalidate.
//
// Invalidation cascade contract: invalidateSkills() issues ONE prefix
// invalidate against skillKeys.all(), and TanStack's prefix matching is what
// carries it across the family -- the import dialog's source-discovery reads
// are keyed ["skills", "sources", <customPaths>] under the same "skills"
// prefix, so this single call also evicts them. The eviction matters because
// discovery classifies each skill against the registry snapshot the backend
// read: a previously `already_exists` skill only becomes importable-shaped
// once its name leaves the registry, and the stale discovery read re-fetches
// on the dialog's next open. This module header is the contract's
// authoritative narrative (moved here from the key factory's comment).

// The client the module-level invalidateSkills() targets. The hook registers
// its useQueryClient() value in an effect: the client is provider-stable
// (one QueryClient per App, ADR-0051), so the assignment is an idempotent
// pointer refresh. The registration runs before every real caller -- it
// precedes the consumers' own mount effects in the same flush, and the
// mutations / the settings pane's rescan-then all fire later still. It is
// deliberately NOT cleared on unmount: an in-flight mutation's or the
// rescan's late invalidate must stay cache-scoped after the calling pane
// went away (the picker / rail observers outlive it).
let registeredClient: QueryClient | null = null;

/** The one invalidation entry for the whole registry cache (see the cascade
 *  contract above). Fire-and-forget and cache-scoped, so it stays safe after
 *  the calling pane unmounted (the picker / rail observers outlive it). */
export function invalidateSkills(): void {
  if (registeredClient === null) return;
  void registeredClient.invalidateQueries({ queryKey: skillKeys.all() });
}

/** The enablement-axis roster (ADR-0119 Decision 5): the listing's enabled
 *  subset -- what the composer picker offers, since a disabled skill cannot
 *  be invoked (the row promised a staging the submit would silently drop).
 *  An unanswered listing (loading / failed) reads as empty. */
export function enabledRoster(
  listing: SkillListing | undefined,
): SkillEntry[] {
  return (listing?.skills ?? []).filter((skill) => skill.enabled);
}

/** The listing keyed by spec name: the thread rail's lifecycle markers look
 *  a name up here to flag one the registry no longer carries (resume drift).
 *  Undefined while no answer has landed (a failed / loading read), so the
 *  markers render the verb + name from the event alone. */
export function skillIndex(
  listing: SkillListing | undefined,
): Map<string, SkillEntry> | undefined {
  const skills = listing?.skills;
  if (skills === undefined) return undefined;
  const index = new Map<string, SkillEntry>();
  for (const skill of skills) index.set(skill.name, skill);
  return index;
}

export interface UseSkillsRegistryOpts {
  /** Master switch for the read (the picker's surface-off posture): false
   *  keeps the listing IPC from ever firing -- nothing opens on a trigger
   *  char and no round-trip happens. */
  enabled?: boolean;
  /** The settings pane's wholesale app-config sync: a successful enablement
   *  write forwards the command's returned FULL config here (the same
   *  state-only-sync contract the other settings panes' writes use). */
  onAppConfigSync?: (cfg: AppConfig) => void;
}

export function useSkillsRegistry({
  enabled = true,
  onAppConfigSync,
}: UseSkillsRegistryOpts = {}) {
  const queryClient = useQueryClient();
  useEffect(() => {
    registeredClient = queryClient;
  }, [queryClient]);

  const { data: listing, error, refetch, isFetching } = useQuery({
    queryKey: skillKeys.all(),
    queryFn: listSkills,
    enabled,
  });

  // The enablement write returns the updated FULL config: forwarded to the
  // injected sync, then the one invalidation refreshes the listing so each
  // row's `enabled` follows (the command returns the config alone --
  // without the refetch the switch would visually snap back).
  const setSkillEnabledMutation = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      setSkillEnabled(name, enabled),
    onSuccess: (cfg) => {
      onAppConfigSync?.(cfg);
      invalidateSkills();
    },
  });

  // A local skill's directory / a linked skill's link removal; the listing
  // refresh drops the row everywhere it renders.
  const deleteSkillMutation = useMutation({
    mutationFn: (name: string) => deleteSkill(name),
    onSuccess: () => {
      invalidateSkills();
    },
  });

  // The import batch (one mode for the whole batch): the registry's
  // invalidation is the cascade contract's live trigger -- a successful
  // import must evict the sources discovery reads alongside the listing.
  const importSkillsMutation = useMutation({
    mutationFn: ({ items, mode }: { items: ImportItem[]; mode: ImportMode }) =>
      importSkills(items, mode),
    onSuccess: () => {
      invalidateSkills();
    },
  });

  const roster = useMemo(() => enabledRoster(listing), [listing]);
  const index = useMemo(() => skillIndex(listing), [listing]);

  return {
    listing,
    error,
    isFetching,
    refetch,
    enabledRoster: roster,
    skillIndex: index,
    setSkillEnabledMutation,
    deleteSkillMutation,
    importSkillsMutation,
  };
}
