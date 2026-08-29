import { useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";

import { Input } from "../ui/input";
import { TruncatingTooltip } from "./TruncatingTooltip";
import {
  listActivatedSkills,
  listMountedSkills,
  listSkills,
  mountSkill,
  unmountSkill,
} from "../../api";
import { fmtError } from "../../lib/error-presentation";
import type { CliToolConfig } from "../../types/cli-tool";
import { SkillActiveBadge } from "./SkillActiveBadge";
import { log } from "../../lib/log";
import { sessionKeys, skillKeys } from "../../session/queryKeys";
import type { SkillEntry } from "../../types/skills";
import { filterSkills } from "./skillPickerLogic";

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
//
// This list is the mount trust gate and NOTHING else (ADR-0112): the
// activation ENTRY is the input-bar picker ("/" / "$"), not a row action --
// the retired issue #699 row-tail activate button made way for it. The
// activation FACE stays: an activated row shows the Active badge (same
// primary token as the thread's Activate marker), and there is no
// deactivation action -- unmount is activation's sole exit. A picker
// selection syncs the checkbox through the selection union (below), so the
// two surfaces never disagree on what is selected; the intent itself
// materializes at submit, never at click. Every successful skill mutation
// also invalidates the thread query so the lifecycle marker refetches (the
// server timeline is the marker's source; nothing else refreshes the thread
// after a skill mutation).

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
  /** The registered CLI tools (issue #677): on the cold-start bar, the
   *  auto-included builtin skills (builtin-sourced, enabled, in-registry)
   *  render checked AND disabled -- the backend folds them into every new
   *  session's initial set, so the panel agrees with the trigger count by
   *  showing them as already in, not toggleable off. */
  cliTools?: CliToolConfig[];
  /** When sessionId is null (cold-start bar), a toggle hands the NEXT pending
   *  list (pick appended / removed) to the shell via this callback. Undefined
   *  when sessionId is non-null. */
  onPendingSkillsChange?: (next: string[]) => void;
  /** Pre-activation intents (ADR-0112): the chip list the composer holds.
   *  A picker selection is a mount + activate composite, so the checkbox
   *  displays the mount authority UNION the intents (the mount half has not
   *  materialized yet); clearing the checkbox drops the intent in the same
   *  action (the cascade's intent half). */
  activationIntents?: string[];
  /** Drop-one-intent channel for the cascade above. Undefined callers get no
   *  union display and no cascade (the activation surface rides the picker
   *  alone). */
  onActivationIntentsChange?: (next: string[]) => void;
};

export function ComposerSkillsSection({
  sessionId,
  loading,
  onOpenSettingsSkills,
  pendingSkills,
  cliTools,
  onPendingSkillsChange,
  activationIntents,
  onActivationIntentsChange,
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

  const {
    data: listing,
    isLoading,
    error: listingQueryError,
  } = useQuery({
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
    () => new Set(sessionId === null ? (pendingSkills ?? []) : (mounted ?? [])),
    [sessionId, pendingSkills, mounted],
  );

  // The activation state read (issue #699): session-mode only, like the
  // mounted query above. Draft mode leaves it disabled -- no IPC, no
  // affordance, an empty set.
  const { data: activated, error: activatedQueryError } = useQuery({
    queryKey: sessionKeys.activatedSkills(sessionId ?? ""),
    queryFn: () => listActivatedSkills(sessionId as string),
    enabled: sessionId !== null,
  });
  const activatedSet = useMemo(() => new Set(activated ?? []), [activated]);
  const intentSet = useMemo(
    () => new Set(activationIntents ?? []),
    [activationIntents],
  );

  // Auto-included builtin skills on the cold-start bar (issue #677): the
  // backend folds these into every new session's initial set (derived here
  // the same way the trigger count derives them -- no extra IPC), so the
  // draft-mode checkbox reads them as checked and their toggle is disabled
  // (unchecking cannot stop the backend from including them).
  const autoIncludedSet = useMemo(() => {
    if (sessionId !== null) return new Set<string>();
    const tools = cliTools ?? [];
    return new Set(
      (listing?.skills ?? [])
        .filter(
          (s) =>
            s.acquired === "builtin" &&
            tools.some(
              (t) => t.name === s.name && t.source === "builtin" && t.enabled,
            ),
        )
        .map((s) => s.name),
    );
  }, [sessionId, listing, cliTools]);
  // Selection display set (ADR-0112 Decision 2): the checkbox reads the
  // mount authority -- the mounted set in session mode, the pending list in
  // draft mode -- UNION the pre-activation intents, because a picker
  // selection expresses a mount intent that only materializes at submit.
  // The draft branch unions the auto-included builtins too (checked +
  // disabled, above) so the panel agrees with the trigger count; the
  // session branch needs the explicit intent union because its mounted set
  // is server truth the intent has not joined yet. The sync is
  // display-only: no mount IPC fires until the submit does.
  const selectedSet = useMemo(() => {
    if (sessionId === null) {
      const draft = new Set(mountedSet);
      for (const name of autoIncludedSet) draft.add(name);
      return draft;
    }
    const union = new Set(mountedSet);
    for (const name of activationIntents ?? []) union.add(name);
    return union;
  }, [sessionId, mountedSet, activationIntents, autoIncludedSet]);

  // Session-mode-only machinery below: toggle() holds the invariant -- it
  // routes null-sessionId rows to the pending-list path before any mutation
  // runs -- so none of these ever execute in draft mode. The `as string`
  // casts trust that routing (the same pattern the disabled-query queryFns
  // above use).
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

  // The activation-set twin of applyMountDelta (issue #699): same ritual, the
  // activated key.
  function applyActivationDelta(
    delta: (prev: string[] | undefined) => string[],
  ) {
    setError(null);
    queryClient.setQueryData<string[]>(
      sessionKeys.activatedSkills(sessionId as string),
      delta,
    );
    void queryClient.invalidateQueries({
      queryKey: sessionKeys.activatedSkills(sessionId as string),
    });
  }

  // Every skill mutation appends a lifecycle event to the server timeline;
  // the thread cache must re-read or the marker never appears (staleTime is
  // Infinity, so nothing else refetches it). Unlike the turn flow's "thread
  // stays un-invalidated" rule (ADR-0051 -- a refetch there would wipe the
  // optimistic append), a skill mutation cannot overlap a turn: the loading
  // gate below blocks the click and the backend's reject_if_in_flight
  // refuses the write, so there is no optimistic thread state to protect.
  function refreshThread() {
    void queryClient.invalidateQueries({
      queryKey: sessionKeys.thread(sessionId as string),
    });
  }

  const mountMutation = useMutation({
    mutationFn: (name: string) => mountSkill(sessionId as string, name),
    onMutate: (name) => markPending(name),
    onSuccess: (_data, name) => {
      applyMountDelta((prev) =>
        prev?.includes(name) ? prev : [...(prev ?? []), name],
      );
      refreshThread();
    },
    onError: (e) => {
      setError(fmtError(e, intl));
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.mountedSkills(sessionId as string),
      });
    },
    onSettled: (_d, _e, name) => clearPending(name),
  });

  const unmountMutation = useMutation({
    mutationFn: (name: string) => unmountSkill(sessionId as string, name),
    onMutate: (name) => markPending(name),
    onSuccess: (_data, name) => {
      applyMountDelta((prev) => prev?.filter((n) => n !== name) ?? []);
      // Cascade (ADR-0110 Decision 4: unmount is activation's sole exit) --
      // subtract from the activated cache with a setQueryData right after the
      // mounted one, before any refetch starts, so the badge drops without a
      // stale one-beat flash; invalidate-only would leave the old state
      // visible until the refetch lands.
      applyActivationDelta((prev) => prev?.filter((n) => n !== name) ?? []);
      refreshThread();
    },
    onError: (e) => {
      setError(fmtError(e, intl));
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.mountedSkills(sessionId as string),
      });
    },
    onSettled: (_d, _e, name) => clearPending(name),
  });

  function toggle(skill: SkillEntry) {
    if (loading || pendingNames.has(skill.name)) return;
    // The intent half of the uncheck cascade (ADR-0112 Decision 2): clearing
    // a selection drops that skill's pre-activation intent in the same
    // action -- the intent version of "unmount is activation's sole exit".
    const dropIntent = () => {
      if (intentSet.has(skill.name) && onActivationIntentsChange) {
        onActivationIntentsChange(
          (activationIntents ?? []).filter((n) => n !== skill.name),
        );
      }
    };
    // Null sessionId (cold-start bar, ADR-0092 / #500): rewrite the
    // caller-held pending list synchronously — no IPC, no per-name pending
    // gate. When the callback is absent the toggle is logged and discarded so
    // an unwired cold-start bar is observable instead of silently swallowed.
    if (sessionId === null) {
      if (onPendingSkillsChange) {
        const current = pendingSkills ?? [];
        const next = selectedSet.has(skill.name)
          ? current.filter((n) => n !== skill.name)
          : [...current, skill.name];
        onPendingSkillsChange(next);
        if (selectedSet.has(skill.name)) dropIntent();
      } else {
        log.warn(
          "ComposerSkillsSection",
          "toggle called with null sessionId but no onPendingSkillsChange handler — selection discarded",
        );
      }
      return;
    }
    if (selectedSet.has(skill.name)) {
      // Unchecking: the intent drops synchronously; the unmount IPC fires
      // only when the skill was actually mounted (an intent-only row never
      // mounted, so its uncheck is pure intent removal -- no NotMounted
      // refusal to surface).
      dropIntent();
      if (mountedSet.has(skill.name)) {
        unmountMutation.mutate(skill.name);
      }
      return;
    }
    mountMutation.mutate(skill.name);
  }

  const registry = useMemo(() => listing?.skills ?? [], [listing]);
  const filtered = useMemo(() => {
    // The shared name-or-description substring, case-insensitive match
    // (filterSkills), the same filter the picker applies -- the two surfaces
    // agree on what a query selects by code, not by convention.
    const matched = filterSkills(registry, search);
    // Pin selected skills to the top (mounted OR intent-union -- both read as
    // "selected"); Array.prototype.sort is stable, so the registry order is
    // preserved within each group.
    return [...matched].sort(
      (a, b) =>
        Number(selectedSet.has(b.name)) - Number(selectedSet.has(a.name)),
    );
  }, [registry, search, selectedSet]);

  const empty = !isLoading && registry.length === 0;
  const noMatches = !empty && filtered.length === 0;
  const displayError =
    error ??
    (listingQueryError ? fmtError(listingQueryError, intl) : null) ??
    (mountedQueryError ? fmtError(mountedQueryError, intl) : null) ??
    (activatedQueryError ? fmtError(activatedQueryError, intl) : null);

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
          const isActivated = activatedSet.has(skill.name);
          const pending = pendingNames.has(skill.name);
          const disabled = loading || pending;
          return (
            // The li is the row's flex container; the mount label is the
            // whole row (checkbox + name + builtin badge) -- the retired
            // #699 row-tail activate action made way for the ADR-0112
            // input-bar picker, leaving the Active badge as the only tail.
            <li key={skill.name} className="flex items-center gap-1">
              <label className={`${ROW_CLASS} min-w-0 flex-1`}>
                <input
                  type="checkbox"
                  checked={selectedSet.has(skill.name)}
                  disabled={disabled || autoIncludedSet.has(skill.name)}
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
                {skill.acquired === "builtin" && (
                  <span className="bg-muted text-muted-foreground shrink-0 rounded-md px-2 py-0.5 text-xs font-medium leading-none">
                    <FormattedMessage
                      id="composer.contextPanel.builtinSkillBadge"
                      defaultMessage="System"
                    />
                  </span>
                )}
              </label>
              {/* Session-mode row tail: the Active badge is the activation
                  FACE (display only) -- the same primary token as the thread
                  Activate marker, one domain concept one color. Nothing
                  renders in draft mode, and there is no activate /
                  deactivate action here (ADR-0112: the picker is the entry,
                  unmount the sole exit). The activated set is always a
                  subset of the mounted set, so no mounted check is needed. */}
              {sessionId !== null && isActivated && <SkillActiveBadge />}
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
