// Width algebra for the three-column session shell (sidebar / conversation
// rail / workspace), issue #770. The 320px workspace floor matches the
// "minimum usable column" convention — the conversation rail's 320px
// flex-basis floor (issue #350; DESIGN.md's conversation-rail width token)
// is the prior art. The CSS side mirrors this constant as
// --workspace-min-width on .shell (styles.css cross-references it).

/** Minimum workspace column width when expanded (px). */
export const WORKSPACE_MIN_WIDTH = 320;

/** Lower floor for the rail under sidebar-driven compensation (px): the
 *  sidebar drag may push the rail below its own direct-drag floor to keep
 *  the workspace usable (the toolbar compresses but stays functional).
 *  Declared here rather than in useRailResize so this pure algebra module
 *  has no dependency on the React hook modules; useRailResize imports it. */
export const COMPENSATED_MIN_WIDTH = 280;

/** min(staticMax, dynamic) — a dynamic reading of undefined means "no
 *  availability constraint" and keeps the static ceiling. Shared by both
 *  resize hooks so the merge rule cannot drift between them. */
export function mergeCeiling(
  dynamic: number | undefined,
  staticMax: number,
): number {
  return dynamic === undefined ? staticMax : Math.min(staticMax, dynamic);
}

/** Sidebar width ceiling: the shell width minus the two other column floors.
 *
 * Deliberately floor-based (the rail's compensated floor) rather than the
 * rail's live width: the sidebar→rail compensation keeps the two widths
 * anti-correlated during a drag, so a live-rail ceiling would bind at exactly
 * the same widths this floor form does (once the rail saturates at its
 * floor) — while the floor form also stays correct at restore time, where
 * the rail's state can be stale relative to its visually-yielded width. */
export function sidebarMaxWidth(shellWidth: number): number {
  return shellWidth - COMPENSATED_MIN_WIDTH - WORKSPACE_MIN_WIDTH;
}

/** Rail width ceiling: the track-host width (shell minus sidebar) minus the
 * workspace floor. */
export function railMaxWidth(trackHostWidth: number): number {
  return trackHostWidth - WORKSPACE_MIN_WIDTH;
}
