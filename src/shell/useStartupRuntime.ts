import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { adapterKeys } from "../session/queryKeys";
import {
  resolveStartupRuntime,
  type AdapterEntry,
  type SessionRuntimeChoice,
} from "../types/runtime";
import type { DefaultRuntime } from "../types/app-config";
import { listAdapters } from "../api";
import { log } from "../lib/log";

/** The cold-start startup runtime (ADR-0098 Decisions 2/3, issue #572): the
 *  `default_runtime` preference resolved against the shared adapter table.
 *  App renders <QueryClientProvider> itself, so it lives OUTSIDE the provider
 *  and cannot call useQuery -- this hook reads the shared adapterKeys cache
 *  directly on the client instead: useSyncExternalStore subscribes to the
 *  query cache, and a mount-time ensureQueryData fires the read when no other
 *  surface (picker, Local CLI tab, default-runtime control) already has. */
export function useStartupRuntime(
  queryClient: QueryClient,
  defaultRuntime: DefaultRuntime | undefined,
): SessionRuntimeChoice {
  const subscribe = useCallback(
    (onStoreChange: () => void) => queryClient.getQueryCache().subscribe(onStoreChange),
    [queryClient],
  );
  const getSnapshot = useCallback(
    () => queryClient.getQueryData<AdapterEntry[]>(adapterKeys.all()),
    [queryClient],
  );
  const adapters = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    queryClient
      .ensureQueryData({ queryKey: adapterKeys.all(), queryFn: listAdapters })
      .catch((e) => {
        // listAdapters is documented never-refusing; on a reject the snapshot
        // stays undefined and the resolution degrades to built-in, which is
        // the honest cold-start posture -- logged for the report trail.
        log.warn(
          "useStartupRuntime",
          "adapter table read failed; startup resolution stays built-in",
          e,
        );
      });
  }, [queryClient]);

  // Memoized: the resolved value feeds handleShellSubmit's useCallback deps,
  // and only the built-in constant / a stable external object keep that
  // callback from churning on every render.
  return useMemo(
    () => resolveStartupRuntime(defaultRuntime, adapters),
    [defaultRuntime, adapters],
  );
}
