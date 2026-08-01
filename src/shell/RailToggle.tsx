import { useIntl } from "react-intl";
import { PanelRight, PanelRightClose } from "lucide-react";

// Thread-rail collapse toggle (ADR-0054 level 2, issue #84). Mirrors
// SidebarToggle: the button lives in this child so it can reach intl (App sits
// above <IntlProvider>). Each intl.formatMessage branch is a STATIC literal so
// @formatjs/cli extract resolves both ids. Disabled when no session is active:
// the rail only exists inside a SessionPane, so on the cold-start hero the
// toggle has no visible target (the persisted pref still applies once a session
// opens). PanelRight* glyph distinguishes it from the sidebar's PanelLeft*,
// replacing the prior single-angle ‹› text.
export function RailToggle({
  collapsed,
  disabled,
  onToggle,
  alert = false,
}: {
  collapsed: boolean;
  disabled: boolean;
  onToggle: () => void;
  /** The session has an UNANSWERED approval (ADR-0083, issue #297). With the
   *  rail collapsed the in-flow card is hidden, so the toggle carries an
   *  attention dot inviting the expand; the dot retires once the rail is open
   *  (the card itself is visible then). No new hue -- the --warning token is
   *  the shell's established "needs attention" semantic (ADR-0050). */
  alert?: boolean;
}) {
  const intl = useIntl();
  // The collapsed-rail badge needs a localized name for assistive tech (the
  // dot is aria-hidden); the expanded rail needs no announcement (the card is
  // perceivable). One label expression so the two states cannot drift.
  const label = collapsed
    ? alert
      ? intl.formatMessage({
          id: "rail.expandPendingApproval",
          defaultMessage: "Expand conversation rail (an approval awaits your answer)",
        })
      : intl.formatMessage({ id: "rail.expand", defaultMessage: "Expand conversation rail" })
    : intl.formatMessage({ id: "rail.collapse", defaultMessage: "Collapse conversation rail" });
  return (
    <button
      type="button"
      // ADR-0067 (#171): visual rule -> inline utilities; ghost icon button
      // (codex-style): h-6 w-6 button + h-3 w-3 glyph + text-foreground/70.
      // Disabled dims + drops the pointer (cold-start hero has no rail to
      // collapse). `relative` anchors the pending-approval dot.
      className="rail-toggle relative inline-flex h-6 w-6 items-center justify-center rounded-md text-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50"
      disabled={disabled}
      aria-label={label}
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      {collapsed ? (
        <PanelRight className="h-3 w-3" aria-hidden />
      ) : (
        <PanelRightClose className="h-3 w-3" aria-hidden />
      )}
      {alert && collapsed && (
        <span
          className="rail-alert absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-warning"
          aria-hidden="true"
        />
      )}
    </button>
  );
}
