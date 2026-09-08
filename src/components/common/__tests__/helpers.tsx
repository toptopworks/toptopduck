import { render } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";
import { TooltipProvider } from "../../ui/tooltip";
import { catalogFor } from "../../../i18n";

// Shared zh-CN react-intl test wrapper for components that route their chrome
// through react-intl (ADR-0052) and assert on Chinese strings. withIntl wraps a
// node for a rerender call (RTL's rerender replaces the whole tree, so it must
// re-provide the provider); renderI18n is the render-time convenience. Lives in
// the common base so the common + dataset domains share one wrapper instead of
// each inline-copying it (issue #216 split).
//
// The TooltipProvider mirrors the app tree (App mounts the one app-wide
// provider; Radix tooltip consumers below it must not grow their own) -- so
// tests for components that render Tooltips (the working-set rows since #865)
// get the same ancestor instead of each suite hand-wrapping one.

export function withIntl(ui: ReactElement) {
  return (
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      <TooltipProvider>{ui}</TooltipProvider>
    </IntlProvider>
  );
}

export function renderI18n(ui: ReactElement) {
  return render(withIntl(ui));
}
