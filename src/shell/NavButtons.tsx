import { useIntl } from "react-intl";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useNavigationHistory } from "./useNavigationHistory";

// Topbar back/forward buttons (issue #288). Browser-style in-app history bound to
// NavigationHistoryProvider: back/forward move the stack cursor and the provider
// calls restore() to re-apply the target view. Each button is a Codex-style ghost
// icon button matching SidebarToggle (h-6 w-6 + h-3 w-3 glyph); disabled at the
// stack head/tail so the affordance mirrors canBack/canForward. App sits above
// <IntlProvider>, so the labels live here as STATIC formatMessage literals (a
// template id would break the @formatjs/cli i18n:check CI gate, ADR-0052).
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
        // ADR-0067 (#171): visual rules -> inline utilities; semantic hook kept.
        className="nav-button inline-flex h-6 w-6 items-center justify-center rounded-md text-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50"
        aria-label={backLabel}
        title={backLabel}
        disabled={!canBack}
        onClick={back}
      >
        <ArrowLeft className="h-3 w-3" aria-hidden />
      </button>
      <button
        type="button"
        className="nav-button inline-flex h-6 w-6 items-center justify-center rounded-md text-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50"
        aria-label={forwardLabel}
        title={forwardLabel}
        disabled={!canForward}
        onClick={forward}
      >
        <ArrowRight className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
}
