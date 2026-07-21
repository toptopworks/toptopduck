import { useIntl } from "react-intl";

// Thread-rail collapse toggle (ADR-0054 level 2, issue #84). Mirrors
// SidebarToggle: the button lives in this child so it can reach intl (App sits
// above <IntlProvider>). Each intl.formatMessage branch is a STATIC literal so
// @formatjs/cli extract resolves both ids. Disabled when no session is active:
// the rail only exists inside a SessionPane, so on the cold-start hero the
// toggle has no visible target (the persisted pref still applies once a session
// opens). The single-angle glyph ‹› distinguishes it from the sidebar's «».
export function RailToggle({
  collapsed,
  disabled,
  onToggle,
}: {
  collapsed: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const intl = useIntl();
  return (
    <button
      type="button"
      // ADR-0067 (#171): visual rule -> inline utilities; disabled dims +
      // drops the pointer (cold-start hero has no rail to collapse).
      className="rail-toggle py-0.5 px-2 text-base leading-none cursor-pointer border border-border bg-card rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
      disabled={disabled}
      aria-label={
        collapsed
          ? intl.formatMessage({ id: "rail.expand", defaultMessage: "Expand conversation rail" })
          : intl.formatMessage({ id: "rail.collapse", defaultMessage: "Collapse conversation rail" })
      }
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      {collapsed ? "›" : "‹"}
    </button>
  );
}
