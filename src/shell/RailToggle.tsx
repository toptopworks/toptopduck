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
}: {
  collapsed: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const intl = useIntl();
  return (
    <button
      type="button"
      // ADR-0067 (#171): visual rule -> inline utilities; ghost icon button
      // (codex-style, aligns dannysmith/tauri-template): h-6 w-6 button +
      // h-3 w-3 glyph + text-foreground/70. Disabled dims + drops the pointer
      // (cold-start hero has no rail to collapse).
      className="rail-toggle inline-flex h-6 w-6 items-center justify-center rounded-md text-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50"
      disabled={disabled}
      aria-label={
        collapsed
          ? intl.formatMessage({ id: "rail.expand", defaultMessage: "Expand conversation rail" })
          : intl.formatMessage({ id: "rail.collapse", defaultMessage: "Collapse conversation rail" })
      }
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      {collapsed ? (
        <PanelRight className="h-3 w-3" aria-hidden />
      ) : (
        <PanelRightClose className="h-3 w-3" aria-hidden />
      )}
    </button>
  );
}
