import { render } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";

// SettingsDialog routes its chrome through react-intl (ADR-0052). Rendered inside
// an empty-catalog English IntlProvider so FormattedMessage / useIntl fall back to
// the defaultMessage -- the canonical English source (ADR-0052) -- and assertions
// anchor on stable English strings without coupling to the zh-CN catalog.
// onError silences the expected missing-message warnings (the ids intentionally
// resolve via defaultMessage, not the empty catalog). Shared by SettingsView +
// ProfileSwitcher tests (issue #216 split).
export function renderSettings(ui: ReactElement) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      {ui}
    </IntlProvider>,
  );
}
