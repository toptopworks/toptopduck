import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { unmountSkill } from "../../api";
import { sessionKeys } from "../../session/queryKeys";
import { useActivatedSkills } from "./useActivatedSkills";

/** The chips display union (issue #961): the intents in pick order first,
 * then the activated names not already carried by an intent, in activation
 * order. Pure so the merge is unit-testable independent of the queries. */
export function mergeChipNames(
  intents: string[],
  activated: string[],
): string[] {
  const merged = [...intents];
  for (const name of activated) {
    if (!merged.includes(name)) merged.push(name);
  }
  return merged;
}

// The chips display union + removal dispatch (issue #961, ADR-0118 Decision
// 4): the composer's chips show the pre-activation intents UNION the
// session's activated truth (the queries ride the shared sessionKeys caches,
// so the picker and badges all agree), and one removal dispatches
// BOTH halves -- the intent withdrawal (the caller-held ADR-0112 state) and,
// when the skill is mounted, the unmount IPC whose event fold cascades the
// deactivation. A disabled-but-mounted chip needs no special case here: the
// settings-pane enablement axis governs the SEED and the gray-out; an
// in-session removal is the session-level veto, which is exactly what the
// chip expresses.

export interface UseSkillChipsOpts {
  /** The active session; null on the cold-start bar (no session queries). */
  sessionId: string | null;
  /** The caller-held pre-activation intents, in pick order. */
  intents: string[];
  /** Drop one intent from the caller-held state (the ADR-0112 half). */
  onIntentRemove: (name: string) => void;
  /** Surface an unmount reject (the shell error face). */
  onRemoveError: (error: unknown) => void;
}

export function useSkillChips({
  sessionId,
  intents,
  onIntentRemove,
  onRemoveError,
}: UseSkillChipsOpts): { names: string[]; remove: (name: string) => void } {
  const queryClient = useQueryClient();

  // The session-only activated read (the cold-start bar keeps it disabled --
  // no session, no activated truth).
  const { data: activated } = useActivatedSkills(sessionId);

  const names = mergeChipNames(intents, activated ?? []);

  const remove = useCallback(
    (name: string) => {
      // The intent half always runs (a no-op when the chip carried only the
      // activated truth); the unmount half runs exactly when the chip was
      // ACTIVATED -- an activated skill is mounted by invariant, so the
      // unmount's event fold cascades the deactivation (ADR-0110 Decision 4
      // reused verbatim). An intent-only chip never reached the session and
      // stops at the withdrawal. The activated truth is read from the cache
      // AT DISPATCH TIME (not the render's snapshot) so an invalidated cache
      // never leaves the callback deciding on a stale closure.
      onIntentRemove(name);
      if (sessionId === null) return;
      const activatedNow =
        queryClient.getQueryData<string[]>(
          sessionKeys.activatedSkills(sessionId),
        ) ?? [];
      if (!activatedNow.includes(name)) return;
      void unmountSkill(sessionId, name)
        .then(() => {
          // The two caches the fold touches: activated and the thread (the
          // Unmount lifecycle event lands on the server timeline).
          void queryClient.invalidateQueries({
            queryKey: sessionKeys.activatedSkills(sessionId),
          });
          void queryClient.invalidateQueries({
            queryKey: sessionKeys.thread(sessionId),
          });
        })
        .catch((e: unknown) => onRemoveError(e));
    },
    [sessionId, onIntentRemove, onRemoveError, queryClient],
  );

  return { names, remove };
}
