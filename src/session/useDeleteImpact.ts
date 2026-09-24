import { useQuery } from "@tanstack/react-query";
import { previewDeleteImpact } from "../api";
import { sessionKeys } from "./queryKeys";
import type { DeleteImpactEntry } from "../types/dataset";

// The delete-confirm dialogs' cascade-impact preview (issue #1063): the live
// results a source removal would mark stale, read through the read-only IPC
// command (`preview_delete_impact`). Both dialogs mount conditionally (Radix
// confirm dialogs), so the mount itself gates the query -- a null target (no
// dialog open) simply idles; the `?? ""` placeholders never execute, since a
// disabled query's queryFn never runs.
//
// Failure is not fatal by contract: the dialogs degrade to today's copy and
// the delete stays executable (the preview is a read-only convenience, never
// a single point of dependency for the removal).
export function useDeleteImpact(
  sessionId: string | null,
  referenceName: string | null,
): {
  entries: DeleteImpactEntry[];
  isLoading: boolean;
  error: unknown;
} {
  const enabled = sessionId !== null && referenceName !== null;
  const query = useQuery({
    queryKey: sessionKeys.deleteImpact(sessionId ?? "", referenceName ?? ""),
    queryFn: () => previewDeleteImpact(sessionId ?? "", referenceName ?? ""),
    enabled,
  });
  return {
    entries: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}
