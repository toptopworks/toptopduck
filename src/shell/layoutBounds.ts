// Width algebra for the three-column session shell (sidebar / conversation
// column / right sidebar), issue #770, renegotiated by issue #1685. The
// right sidebar is an EXPLICIT width (issue #1685): the conversation column
// is the flexible remainder (minmax(0, 1fr) semantics) and the right
// sidebar's dynamic ceiling carries the conversation's 420px protection
// floor — the ceiling = min(1200, track host − 420), so the conversation
// keeps ≥420px whenever the window can afford it. The CSS side mirrors the
// derived defaults (styles.css cross-references this module).

/** Minimum right sidebar width (px): the negotiated explicit minimum. */
export const RIGHT_SIDEBAR_MIN_WIDTH = 300;

/** Lower floor for the conversation column under sidebar-driven narrowing
 *  (px), issue #1685: the right sidebar's dynamic ceiling subtracts this so
 *  the conversation column keeps ≥420px whenever the window can afford it
 *  (the sidebar drag yields the right sidebar's rendered width down to the
 *  conversation's protection line instead of crushing it). The CSS side
 *  mirrors it as the conversation column's min-width (styles.css). */
export const CONVERSATION_MIN_WIDTH = 420;

/** Static ceiling for the right sidebar (px): caps the user's stored
 *  preference and the drag on very wide windows. */
export const RIGHT_SIDEBAR_MAX_WIDTH = 1200;

/** Default right sidebar width for a viewport (px), issue #1685: the pi-web
 *  negotiation number, clamp(viewport × 0.42, 360, 640) — the initial
 *  preference when nothing is stored, never re-derived after (the stored
 *  preference takes over from the first drag on). */
export function rightSidebarDefaultWidth(viewport: number): number {
  return Math.max(360, Math.min(640, viewport * 0.42));
}

/** min(staticMax, dynamic) — a dynamic reading of undefined means "no
 *  availability constraint" and keeps the static ceiling. Shared by the
 *  resize hooks so the merge rule cannot drift between them. */
export function mergeCeiling(
  dynamic: number | undefined,
  staticMax: number,
): number {
  return dynamic === undefined ? staticMax : Math.min(staticMax, dynamic);
}

/** Rendered width derivation shared by the resize hooks (issue #1303):
 *  min(preference, ceiling), floored defensively so an extreme ceiling can
 *  never crush the column below its readability floor. Declared here rather
 *  than in the hook modules so the derivation rule cannot drift between
 *  them (same rationale as mergeCeiling). */
export function clampRenderedWidth(
  pref: number,
  max: number,
  floor: number,
): number {
  return Math.max(floor, Math.min(pref, max));
}

/** Sidebar width ceiling: the shell width minus the two other column floors.
 *
 * Deliberately floor-based (the conversation column's protection floor)
 * rather than live widths: the sidebar drag yields the right sidebar's
 * rendered width down toward the conversation's 420px protection line, so a
 * live-width ceiling would bind at the same widths this floor form does,
 * while the floor form also stays correct at restore time. */
export function sidebarMaxWidth(shellWidth: number): number {
  return shellWidth - CONVERSATION_MIN_WIDTH - RIGHT_SIDEBAR_MIN_WIDTH;
}

/** Right sidebar width ceiling: the track host width (shell minus the
 *  sidebar) minus the conversation column's protection floor, still capped
 *  by the static ceiling (issue #1685). */
export function rightSidebarMaxWidth(trackHostWidth: number): number {
  return Math.min(
    RIGHT_SIDEBAR_MAX_WIDTH,
    trackHostWidth - CONVERSATION_MIN_WIDTH,
  );
}
