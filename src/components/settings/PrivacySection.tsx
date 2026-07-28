import { FormattedMessage } from "react-intl";

import { DisclosureBanner } from "../common/DisclosureBanner";
import { PaneHeader } from "./settings-chrome";

// Privacy pane (ADR-0065, issue #151): carries the ADR-0011/0029 honest-
// disclosure text -- what leaves the machine when asking (schema + sample
// rows + column names), where the API key lives (OS keychain only), and the
// self-hosted-gateway retention/training caveat. Per ADR-0066 this is the
// SOLE mount point for the global disclosure (the cold-start hero and session
// sidebar no longer duplicate it); a user browsing settings finds the privacy
// statement in its expected place.
export function PrivacySection() {
  return (
    <div>
      <PaneHeader
        title={<FormattedMessage id="settings.nav.privacy" defaultMessage="Privacy" />}
        description={(
          <FormattedMessage
            id="settings.privacy.description"
            defaultMessage="What leaves this machine when you ask a question, and where the API key is kept."
          />
        )}
      />
      <DisclosureBanner />
    </div>
  );
}
