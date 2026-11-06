import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { checkForUpdates, type UpdateInfo } from "../api";
import { updateKeys } from "../session/queryKeys";

/** The startup auto-check delay (ADR-0143 Decision 4): 1s after mount, single
 *  shot, no polling -- past the first-paint window so the check never
 *  contends with boot, soon enough that the rail icon lands with the first
 *  meaningful glance. */
const STARTUP_DELAY_MS = 1000;

/** The startup delayed auto-check (ADR-0143, issue #1509): fires one silent
 *  check into the shared `update-check` cache slice. Silent is load-bearing --
 *  an offline boot, an absent manifest (pre-first-updater-release), or a
 *  broken mirror must surface NOTHING; the failure becomes visible only on
 *  the settings page's manual re-check. Mount once, near the App root. */
export function useStartupUpdateCheck(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const id = window.setTimeout(() => {
      void queryClient
        .fetchQuery({
          queryKey: updateKeys.check(),
          queryFn: checkForUpdates,
          staleTime: Infinity,
          retry: false,
        })
        .catch(() => {
          // Deliberately swallowed (see the doc comment): the manual check
          // owns the error surface.
        });
    }, STARTUP_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [queryClient]);
}

/** Pure subscription to the shared update-check slice: what the startup
 *  auto-check (or a manual settings-page check) last landed, `null` while no
 *  update is known. Never fetches on its own -- the `enabled: false` query is
 *  a cache listener, so the rail icon and the settings block both mirror the
 *  one process-wide truth without triggering mount-time fetches (the 1s
 *  startup delay must own the first network touch). */
export function useUpdateAvailable(): UpdateInfo | null {
  const { data } = useQuery({
    queryKey: updateKeys.check(),
    queryFn: checkForUpdates,
    enabled: false,
    staleTime: Infinity,
  });
  return data ?? null;
}
