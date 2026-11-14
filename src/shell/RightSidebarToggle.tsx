import { useIntl } from "react-intl";
import { PanelRightClose, PanelRightOpen } from "lucide-react";

// Right-sidebar collapse toggle (ADR-0083, issue #298). Mirrors
// SidebarToggle: the button lives in this child so it can reach intl (App
// sits above <IntlProvider>). The right sidebar defaults to COLLAPSED (cold
// start) and opens on demand -- the header toggle is the manual path (a
// first-promotion auto-expand + rail result selections also open it, see
// useRightSidebarCollapse). PanelRightOpen / PanelRightClose glyphs read as
// open-the-right-panel / close-the-right-panel, distinct from the sidebar
// toggle's PanelLeft pair at the topbar's left edge. Each
// intl.formatMessage branch is a STATIC literal so @formatjs/cli extract
// resolves both ids.
export function RightSidebarToggle({
  collapsed,
  onToggle,
  ref,
}: {
  collapsed: boolean;
  onToggle: () => void;
  // React 19 ref-as-prop: the pane hands each mount a ref so a keyboard
  // toggle can hand focus to the surviving instance across the swap.
  ref?: React.Ref<HTMLButtonElement>;
}) {
  const intl = useIntl();
  const label = collapsed
    ? intl.formatMessage({ id: "rightSidebar.expand", defaultMessage: "Expand right sidebar" })
    : intl.formatMessage({ id: "rightSidebar.collapse", defaultMessage: "Collapse right sidebar" });
  return (
    <button
      ref={ref}
      type="button"
      // Ghost icon button (ADR-0067 #171 visual rule): h-7 w-7 + h-3.5 w-3.5
      // glyph + text-foreground/70, matching the sidebar/nav topbar family
      // (issue #774: 28px hit area).
      className="right-sidebar-toggle inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground/70 transition-colors hover:bg-transit hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      aria-label={label}
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      {collapsed ? (
        <PanelRightOpen className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <PanelRightClose className="h-3.5 w-3.5" aria-hidden />
      )}
    </button>
  );
}
