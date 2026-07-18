import { DisclosureBanner } from "../DisclosureBanner";

// Privacy pane (ADR-0065, issue #151): carries the ADR-0011/0019 honest-
// disclosure text -- what leaves the machine when asking (schema + sample
// rows + column names), where the API key lives (OS keychain only), and the
// self-hosted-gateway retention/training caveat. Reuses DisclosureBanner
// verbatim: the same content the cold-start hero and sidebar disclosure show,
// surfaced here as a dedicated settings section so a user browsing settings
// finds the privacy statement in its expected place.
export function PrivacySection() {
  return (
    <div className="grid gap-4">
      <DisclosureBanner />
    </div>
  );
}
