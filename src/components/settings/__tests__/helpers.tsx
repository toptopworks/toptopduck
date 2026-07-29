import { render } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";
import { TooltipProvider } from "../../ui/tooltip";

// Settings routes its chrome through react-intl (ADR-0052). Rendered inside an
// empty-catalog English IntlProvider so FormattedMessage / useIntl fall back to
// the defaultMessage -- the canonical English source (ADR-0052) -- and
// assertions anchor on stable English strings without coupling to the zh-CN
// catalog. onError silences the expected missing-message warnings (the ids
// intentionally resolve via defaultMessage, not the empty catalog).
//
// TooltipProvider mirrors the App ancestor (the rail's dual-state gear carries a
// Tooltip); App mounts one high in the tree, so the pane tests reproduce that
// context. Shared by the SettingsView tests (issue #216 split).
export function renderSettings(ui: ReactElement) {
  return render(
    <TooltipProvider>
      <IntlProvider locale="en" messages={{}} onError={() => {}}>{ui}</IntlProvider>
    </TooltipProvider>,
  );
}
