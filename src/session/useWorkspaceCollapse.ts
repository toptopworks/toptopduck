import { useCallback, useRef, useState } from "react";

// The workspace fold state machine (ADR-0083, issue #298). The workspace
// panel defaults to COLLAPSED -- conversation is the primary surface; the
// panel opens on demand. Three entry paths open it:
//  1. the session's FIRST result_N promotion auto-expands ONCE, showing the
//     just-produced dataset ("the full picture lives here" one-time guide);
//  2. a result selection from the rail (preview card / result link) expands
//     with the selected dataset (dual-view linkage, ADR-0083);
//  3. the session header's manual toggle.
// After the one-shot auto-expand the fold is PURELY manual -- subsequent
// promotions never steal focus. The state is session-ephemeral: a SessionPane
// mount (new session, app launch, resume) always starts folded and the last
// expand state is never persisted (the hook holds plain useState + a one-shot
// ref; a remount resets both).

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

export function useWorkspaceCollapse(): UseWorkspaceCollapse {
  // Cold start (app / session start) is always folded (ADR-0083).
  const [workspaceCollapsed, setWorkspaceCollapsed] = useState(true);
  // The auto-expand one-shot. A ref (not state) because its consumption never
  // needs a render on its own -- it only guards the notePromotion transition.
  const autoExpandedRef = useRef(false);

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
