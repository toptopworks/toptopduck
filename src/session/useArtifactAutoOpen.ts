import { useEffect, useRef } from "react";
import { latestArtifactCandidate } from "./workspace";
import type { ThreadEntry } from "../types/thread";

// The artifact auto-open one-shot (ADR-0124 Decision 3, issue #1088): a turn
// that delivered artifacts but materialized no result has nothing else to
// show for itself -- the workspace expands and the view moves onto the
// manifest's primary. A turn that did BOTH keeps the existing promotion
// semantics (the view follows the produced dataset, notePromotion expands):
// the artifact arrives without stealing the stage.
//
// Consumption is keyed by the candidate's signature (the manifest's paths)
// so the ONE candidate never fires twice however often it is re-seen -- a
// rerender, a refetch rebuilding the thread array, a late duplicate arrival
// -- while a genuinely fresh delivery (a different manifest) re-arms. The
// consumption ref (not state): nothing renders off it, it only guards the
// transition -- the same shape as useWorkspaceCollapse's autoExpandedRef.
//
// Resume posture mirrors #771: the first time the thread resolves WITH
// content, a session whose manifest already landed has nothing left to
// auto-open -- the one-shot spends silently, so a reopened session keeps the
// hero posture (the R5 resume landing is dataset-shaped only). A fresh
// session's optimistic append carries no manifest, so the init scan runs and
// spends nothing there -- the manifest lands with the turn-end refetch and
// auto-opens.
export function useArtifactAutoOpen(
  thread: ThreadEntry[],
  selectFile: (path: string) => void,
  expandWorkspace: () => void,
): void {
  const consumedRef = useRef<string | null>(null);
  const initScanRef = useRef(false);

  useEffect(() => {
    if (initScanRef.current || thread.length === 0) return;
    initScanRef.current = true;
    const candidate = latestArtifactCandidate(thread);
    if (candidate !== null) {
      consumedRef.current = candidate.signature;
    }
  }, [thread]);

  useEffect(() => {
    const candidate = latestArtifactCandidate(thread);
    if (candidate === null) return;
    if (consumedRef.current === candidate.signature) return;
    consumedRef.current = candidate.signature;
    // Both-present turn (ADR-0124 Decision 3): the promotion semantics own
    // the stage. The signature is still consumed -- the decision not to
    // steal is per-delivery, not a pending state that a later rerender
    // revisits.
    if (candidate.turnMaterialized) return;
    expandWorkspace();
    selectFile(candidate.primaryPath);
  }, [thread, selectFile, expandWorkspace]);
}
