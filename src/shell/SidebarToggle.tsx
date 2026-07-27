import { useIntl } from "react-intl";
import { PanelLeft, PanelLeftClose } from "lucide-react";

// Sidebar collapse toggle (ADR-0052 i18n). App sits above <IntlProvider> so the
// button lives in this child component to reach intl. Each intl.formatMessage
// branch is a STATIC literal so @formatjs/cli extract resolves both ids (a
// template id would break the i18n:check CI gate). Codex-style ghost icon
// button: the glyph flips between PanelLeftClose (expanded -> click to fold)
// and PanelLeft (folded -> click to unfold), replacing the prior «» text.
export function SidebarToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const intl = useIntl();
  return (
    <button
      type="button"
      // ADR-0067 (#171): visual rule -> inline utilities; semantic hook kept.
      // Ghost icon button (codex-style, aligns dannysmith/tauri-template):
      // h-6 w-6 button + h-3 w-3 glyph + text-foreground/70, hover tint only.
      className="sidebar-toggle inline-flex h-6 w-6 items-center justify-center rounded-md text-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      aria-label={
        collapsed
          ? intl.formatMessage({ id: "sidebar.expand", defaultMessage: "Expand session bar" })
          : intl.formatMessage({ id: "sidebar.collapse", defaultMessage: "Collapse session bar" })
      }
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      {collapsed ? (
        <PanelLeft className="h-3 w-3" aria-hidden />
      ) : (
        <PanelLeftClose className="h-3 w-3" aria-hidden />
      )}
    </button>
  );
}
