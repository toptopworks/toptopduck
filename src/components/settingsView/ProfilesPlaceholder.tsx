import { FormattedMessage } from "react-intl";

// Profiles pane placeholder (ADR-0065, issue #151). The nav entry exists so the
// section is discoverable and the eventual home is visible; the management UI
// (per-profile list + CRUD + endpoint/key editing, ADR-0064) lands in a later
// slice. Without a placeholder the nav would silently hide a promised section,
// and the General pane could not be marked as the transitional home for the
// endpoint + key fields.
export function ProfilesPlaceholder() {
  return (
    <p className="settings-profiles-placeholder text-muted-foreground">
      <FormattedMessage
        id="settings.profiles.placeholder"
        defaultMessage="Profile management is coming in a later update."
      />
    </p>
  );
}
