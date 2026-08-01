import { useIntl } from "react-intl";
import { PanelRightClose, PanelRightOpen } from "lucide-react";

// Workspace-panel collapse toggle (ADR-0083, issue #298). Mirrors RailToggle:
// the button lives in this child so it can reach intl (App sits above
// <IntlProvider>). The workspace defaults to COLLAPSED (cold start) and opens
// on demand -- the header toggle is the manual path (a first-promotion
// auto-expand + rail result selections also open it, see
// useWorkspaceCollapse). PanelRightOpen / PanelRightClose glyphs read as
// open-the-right-panel / close-the-right-panel, distinct from the rail
// toggle's PanelRight pair at the header's left edge. Each
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
      // Mirrors the RailToggle visual rule (ADR-0067 #171): ghost icon button,
      // h-6 w-6 + h-3 w-3 glyph + text-foreground/70.
      className="workspace-toggle inline-flex h-6 w-6 items-center justify-center rounded-md text-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      aria-label={label}
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      {collapsed ? (
        <PanelRightOpen className="h-3 w-3" aria-hidden />
      ) : (
        <PanelRightClose className="h-3 w-3" aria-hidden />
      )}
    </button>
  );
}
