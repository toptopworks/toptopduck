import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import { listWorkspaces } from "../api";
import { workspaceKeys } from "../session/queryKeys";
import type { PendingWorkspace } from "../components/thread/ComposerWorkspacePicker";

/** The sweep's face: the staged pick to watch, and the reset sink the pick's
 *  owner holds. Shared by the hook and its headless consumer below. */
type SweepProps = {
  staged: PendingWorkspace | null;
  onReset: (next: PendingWorkspace | null) => void;
};

/**
 * The removed-workspace sweep for the staged session-creation pick: the pick
 * is shell state the sidebar's remove mutation cannot reach, so while a pick
 * is staged this mirrors the registry listing (the remove's invalidation
 * refetches the shared key) and resets the pick when a refetch drops a path
 * it once carried. The once-listed guard keeps a browse-picked directory
 * (never a registry record) from being swept by the same refresh. A
 * degraded listing (a registry read failure, issue #1481) holds both the
 * pick and the baseline: its empty rows are the read's fallback, not a
 * removal, so judgment resumes on the next healthy listing -- the hold is
 * per-snapshot, never a grace period that could mask a real removal.
 *
 * Must run inside the QueryClientProvider -- App's own body sits above it,
 * which is why the consumer is the headless component below, not App itself.
 */
export function useStagedWorkspaceSweep({
  staged,
  onReset,
}: SweepProps): void {
  const { data: listing } = useQuery({
    queryKey: workspaceKeys.all(),
    queryFn: listWorkspaces,
    enabled: staged !== null,
  });
  const listedPathsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!listing) return;
    if (listing.degraded) return;
    const paths = new Set(listing.workspaces.map((w) => w.path));
    const prev = listedPathsRef.current;
    if (
      prev !== null &&
      staged !== null &&
      prev.has(staged.path) &&
      !paths.has(staged.path)
    ) {
      onReset(null);
    }
    listedPathsRef.current = paths;
  }, [listing, staged, onReset]);
}

/** Headless App consumer: renders nothing, runs the sweep. */
export function StagedWorkspaceSweep(props: SweepProps): null {
  useStagedWorkspaceSweep(props);
  return null;
}
