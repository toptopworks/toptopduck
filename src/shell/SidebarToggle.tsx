import { useIntl } from "react-intl";

// Sidebar collapse toggle (ADR-0052 i18n). App sits above <IntlProvider> so the
// button lives in this child component to reach intl. Each
// intl.formatMessage branch is a STATIC literal so @formatjs/cli extract
// resolves both ids (a template id would break the i18n:check CI gate).
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
      className="sidebar-toggle py-0.5 px-2 text-base leading-none cursor-pointer border border-border bg-card rounded-md"
      aria-label={
        collapsed
          ? intl.formatMessage({ id: "sidebar.expand", defaultMessage: "Expand session bar" })
          : intl.formatMessage({ id: "sidebar.collapse", defaultMessage: "Collapse session bar" })
      }
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      {collapsed ? "»" : "«"}
    </button>
  );
}
