import { useCallback, useEffect, useRef, useState } from "react";
import { findLatestMaterializedPrimary } from "./workspace";
import type { ThreadEntry } from "../types/thread";

// The workspace fold state machine (ADR-0083, issue #298). The workspace
// panel defaults to COLLAPSED -- conversation is the primary surface; the
// panel opens on demand. Three entry paths open it:
//  1. the FIRST result_N promotion of the session auto-expands ONCE,
//     showing the just-produced dataset ("the full picture lives here"
//     one-time guide);
//  2. a result selection from the rail (preview card / result link) expands
//     with the selected dataset (dual-view linkage, ADR-0083);
//  3. the session-header toggle (the manual fold-AND-unfold path).
// After the one-shot auto-expand the fold is PURELY manual -- subsequent
// promotions never steal focus. The fold state is session-ephemeral: a
// SessionPane mount (new session, app launch, resume) always starts folded
// and the last expand state is never persisted. The one-shot, however, is
// scoped to the SESSION, not the mount (issue #771): a mount onto a thread
// that already materialized a result finds the guidance consumed, so only a
// session whose first result arrives after the mount auto-expands.

export interface UseWorkspaceCollapse {
  /** True while the workspace panel is folded away (the rail owns the pane). */
  workspaceCollapsed: boolean;
  /** Open the panel (result selection from the rail). Idempotent. */
  expandWorkspace: () => void;
  /** The session header toggle (the manual fold-AND-unfold path). */
  toggleWorkspace: () => void;
  /** A result_N promotion just settled (the useTurnFlow markProduced seam).
   *  The FIRST call within the session auto-expands; every later call is a
   *  no-op (the one-shot is spent whether or not it moved the fold). */
  notePromotion: () => void;
}

export function useWorkspaceCollapse(thread: ThreadEntry[]): UseWorkspaceCollapse {
  // Cold start (app / session start) is always folded (ADR-0083).
  const [workspaceCollapsed, setWorkspaceCollapsed] = useState(true);
  // The auto-expand one-shot. A ref (not state) because its consumption never
  // needs a render on its own -- it only guards the notePromotion transition.
  const autoExpandedRef = useRef(false);

  // Issue #771: the one-shot consumption derives from session facts, not
  // from the mount. The first time the thread resolves WITH content, a
  // session that already materialized a result has nothing left to teach --
  // spend the one-shot silently. The R5 resume-init shape (useViewedResult):
  // the ref guard holds through empty threads, the scan runs at most once
  // per mount, and later thread updates (a live promotion settling into the
  // cache) never re-run it, so a fresh session still auto-expands. Accepted
  // race (the same window the R5 suppressInit seam guards in useViewedResult,
  // judged not worth a compensation seam here): an ask landing before the
  // resume query resolves fires the guide once for an already-materialized
  // session.
  const initScanRef = useRef(false);
  useEffect(() => {
    if (initScanRef.current || thread.length === 0) return;
    initScanRef.current = true;
    if (findLatestMaterializedPrimary(thread) !== null) {
      autoExpandedRef.current = true;
    }
  }, [thread]);

  const expandWorkspace = useCallback(() => {
    setWorkspaceCollapsed(false);
  }, []);
  const toggleWorkspace = useCallback(() => {
    setWorkspaceCollapsed((collapsed) => !collapsed);
  }, []);
  const notePromotion = useCallback(() => {
    if (autoExpandedRef.current) return;
    autoExpandedRef.current = true;
    setWorkspaceCollapsed(false);
  }, []);

  return {
    workspaceCollapsed,
    expandWorkspace,
    toggleWorkspace,
    notePromotion,
  };
}
