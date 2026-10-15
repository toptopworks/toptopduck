import { useIntl } from "react-intl";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useNavigationHistory } from "./useNavigationHistory";

// Topbar back/forward buttons (issue #288). Browser-style in-app history bound to
// NavigationHistoryProvider: back/forward move the stack cursor and the provider
// calls restore() to re-apply the target view. Each button is a Codex-style
// ghost icon button matching SidebarToggle (h-7 w-7 + h-3.5 w-3.5 glyph;
// issue #774: 28px hit area); disabled at the stack head/tail so the
// affordance mirrors canBack/canForward. Labels use STATIC
// formatMessage literals (id + defaultMessage at the call site) so @formatjs/cli
// resolves both ids; a non-literal id would break the i18n:check CI gate
// (ADR-0052). NAV_BUTTON_CLASS is the single source of truth for the ghost-button
// styling so the two buttons cannot drift.
const NAV_BUTTON_CLASS =
  "nav-button inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50";

export function NavButtons() {
  const intl = useIntl();
  const { canBack, canForward, back, forward } = useNavigationHistory();
  const backLabel = intl.formatMessage({
    id: "header.nav.back",
    defaultMessage: "Back",
  });
  const forwardLabel = intl.formatMessage({
    id: "header.nav.forward",
    defaultMessage: "Forward",
  });
  return (
    <div className="nav-buttons inline-flex items-center gap-0.5">
      <button
        type="button"
        className={NAV_BUTTON_CLASS}
        aria-label={backLabel}
        title={backLabel}
        disabled={!canBack}
        onClick={back}
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
      </button>
      <button
        type="button"
        className={NAV_BUTTON_CLASS}
        aria-label={forwardLabel}
        title={forwardLabel}
        disabled={!canForward}
        onClick={forward}
      >
        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
