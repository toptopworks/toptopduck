import { useIntl } from "react-intl";
import { PanelRightClose, PanelRightOpen } from "lucide-react";

// Workspace-panel collapse toggle (ADR-0083, issue #298). Mirrors
// SidebarToggle: the button lives in this child so it can reach intl (App
// sits above <IntlProvider>). The workspace defaults to COLLAPSED (cold
// start) and opens on demand -- the header toggle is the manual path (a
// first-promotion auto-expand + rail result selections also open it, see
// useWorkspaceCollapse). PanelRightOpen / PanelRightClose glyphs read as
// open-the-right-panel / close-the-right-panel, distinct from the sidebar
// toggle's PanelLeft pair at the topbar's left edge. Each
// intl.formatMessage branch is a STATIC literal so @formatjs/cli extract
// resolves both ids.
export function WorkspaceToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const intl = useIntl();
  const label = collapsed
    ? intl.formatMessage({ id: "workspace.expand", defaultMessage: "Open workspace" })
    : intl.formatMessage({ id: "workspace.collapse", defaultMessage: "Close workspace" });
  return (
    <button
      type="button"
      // Ghost icon button (ADR-0067 #171 visual rule): h-7 w-7 + h-3.5 w-3.5
      // glyph + text-foreground/70, matching the sidebar/nav topbar family
      // (issue #774: 28px hit area).
      className="workspace-toggle inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
