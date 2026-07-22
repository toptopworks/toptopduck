import { render } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";
import { catalogFor } from "../../../i18n";

// Shared zh-CN react-intl test wrapper for components that route their chrome
// through react-intl (ADR-0052) and assert on Chinese strings. withIntl wraps a
// node for a rerender call (RTL's rerender replaces the whole tree, so it must
// re-provide the provider); renderI18n is the render-time convenience. Lives in
// the common base so the common + dataset domains share one wrapper instead of
// each inline-copying it (issue #216 split).

export function withIntl(ui: ReactElement) {
  return (
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      {ui}
    </IntlProvider>
  );
}

export function renderI18n(ui: ReactElement) {
  return render(withIntl(ui));
}
