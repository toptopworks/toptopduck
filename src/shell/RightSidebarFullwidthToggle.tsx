import { useIntl } from "react-intl";
import { Maximize2, Minimize2 } from "lucide-react";

// Right-sidebar fullwidth toggle (issue #1685). Lives in the tab-row
// control cluster beside the collapse toggle (a folded shell has no
// fullwidth posture, so this only renders while the panel is expanded).
// Maximize2 / Minimize2 glyphs read as fill-the-main-region / restore-the-
// negotiated-width. Each intl.formatMessage branch is a STATIC literal so
// @formatjs/cli extract resolves both ids. The button persists across its
// own toggle (only the glyph swaps), so a keyboard activation keeps focus
// on the control -- no mount-site swap, no ref hand-off.
export function RightSidebarFullwidthToggle({
  fullwidth,
  onToggle,
}: {
  fullwidth: boolean;
  onToggle: () => void;
}) {
  const intl = useIntl();
  const label = fullwidth
    ? intl.formatMessage({ id: "rightSidebar.exitFullwidth", defaultMessage: "Exit full width" })
    : intl.formatMessage({ id: "rightSidebar.enterFullwidth", defaultMessage: "Expand to full width" });
  return (
    <button
      type="button"
      // Ghost icon button (ADR-0067 #171 visual rule): h-7 w-7 + h-3.5 w-3.5
      // glyph + text-foreground/70, matching the right-sidebar toggle family
      // (issue #774: 28px hit area).
      className="right-sidebar-fullwidth-toggle inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground/70 transition-colors hover:bg-transit hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      aria-label={label}
      title={label}
      aria-pressed={fullwidth}
      onClick={onToggle}
    >
      {fullwidth ? (
        <Minimize2 className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <Maximize2 className="h-3.5 w-3.5" aria-hidden />
      )}
    </button>
  );
}
