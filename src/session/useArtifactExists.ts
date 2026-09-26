import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { artifactExists } from "../api";
import { log } from "../lib/log";
import { artifactKeys } from "./queryKeys";

// Whether a manifest entry's file still sits on disk (ADR-0124 Decision 2):
// a render-time fact every artifact surface reads through this one hook --
// the rail row, the file card, and the HTML branch's iframe gate. Keyed by
// absolute path (artifactKeys, process-global -- the rail's check and the
// stage's gate share one cache entry), staleTime 0 overrides the app-wide
// Infinity so existence re-checks on every mount, no retry (a miss is an
// answer, not a transient).
//
// undefined reads as exists both while in flight AND on an IPC rejection --
// the latter deliberately: a transient IPC failure must not render every
// delivered file missing; the click-through surfaces the failure itself
// (the selection lands a stage whose read degrades; the card's openPath
// failure notes). The rejection is logged, never swallowed.
export function useArtifactExists(path: string): boolean {
  const { data, isError, error } = useQuery({
    queryKey: artifactKeys.exists(path),
    queryFn: () => artifactExists(path),
    staleTime: 0,
    retry: false,
  });
  useEffect(() => {
    if (isError) log.warn("ArtifactExists", "artifact_exists failed", error);
  }, [isError, error]);
  return data !== false;
}
