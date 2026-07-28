import { FormattedMessage, useIntl } from "react-intl";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";

// Header action cluster (ADR-0052 i18n). App sits above <IntlProvider> so it
// cannot call useIntl(); this child renders inside the provider. IDs are STATIC
// literals so @formatjs/cli extract can resolve them.
export function HeaderActions({
  disabled,
  hasKey,
  keychainFault,
  onOpenDuck,
  onSaveAs,
  onOpenSettings,
  settingsDisabled,
}: {
  disabled: boolean;
  hasKey: boolean;
  // A keychain READ failure detail (issue #275): null when the read succeeded
  // (hasKey authoritative); a technical English string when the OS keychain
  // read failed. When non-null the badge renders "Keychain unavailable" (with
  // the detail as the native title) instead of misreading as "no key".
  keychainFault: string | null;
  onOpenDuck: () => void;
  onSaveAs: () => void;
  onOpenSettings: () => void;
  // C1: the gear stays disabled until appConfig resolves. Opening settings
  // while appConfig is null white-screens the shell -- .settings-mode hides
  // the session shell but SettingsView does not render (its own appConfig
  // gate) and its window ESC listener never mounts, leaving no exit. The
  // gate mirrors the SettingsView render condition (settingsOpen && appConfig)
  // so the unreachable state is never entered.
  settingsDisabled: boolean;
}) {
  const intl = useIntl();
  const saveDisabledTitle = intl.formatMessage({
    id: "header.saveAs.disabledTitle",
    defaultMessage: "Open or create a session first",
  });
  // ADR-0067 (issue #182): the .header-actions container + .header-actions
  // button + .key-ok / .key-missing visual rules (bespoke border/bg/radius,
  // hardcoded #1a7a3a / #b06000) retired from styles.css. The container rides
  // utility (flex row + density), the three action buttons became shadcn Button
  // outline variants, and the key-state span became a shadcn Badge outline
  // variant with the green/orange status semantic re-anchored on ADR-0050
  // tokens: --primary teal (green family, "configured/active") for key-ok and
  // --warning amber for key-missing. Two clarifications vs the legacy rule:
  // (1) the outline variant rides bg-background (shadcn default), not the
  // legacy var(--card) -- in dark mode this flattens the button into the topbar
  // (also bg-background), aligning with the shadcn outline surface contract
  // instead of the v0 card-raised tint; (2) each Button adds
  // disabled:pointer-events-auto to override the shadcn base's
  // disabled:pointer-events-none, which otherwise suppresses the native title
  // tooltip (saveDisabledTitle / header.openDuck.title / header.saveAs.title)
  // on the disabled open/save buttons -- a native disabled <button> still does
  // not dispatch click, so re-enabling pointer-events is safe. The
  // .header-actions / .key-ok / .key-missing class hooks stay on the elements
  // for selector / test stability.
  return (
    <div className="header-actions flex items-center gap-3 my-2 text-sm">
      <Button
        variant="outline"
        size="sm"
        className="disabled:pointer-events-auto"
        onClick={onOpenDuck}
        disabled={disabled}
        title={intl.formatMessage({
          id: "header.openDuck.title",
          defaultMessage: "Open a .duck to resume a prior analysis",
        })}
      >
        <FormattedMessage id="header.openDuck" defaultMessage="Open .duck" />
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="disabled:pointer-events-auto"
        onClick={onSaveAs}
        disabled={disabled}
        title={disabled ? saveDisabledTitle : intl.formatMessage({
          id: "header.saveAs.title",
          defaultMessage: "Save the current session as .duck (auto-saves each turn after)",
        })}
      >
        <FormattedMessage id="header.saveAs" defaultMessage="Save as .duck" />
      </Button>
      <Badge
        variant="outline"
        className={hasKey && !keychainFault ? "key-ok text-primary" : "key-missing text-warning"}
        title={keychainFault ?? undefined}
      >
        {keychainFault ? (
          <FormattedMessage
            id="header.keychainUnavailable"
            defaultMessage="Keychain unavailable"
          />
        ) : hasKey ? (
          <FormattedMessage id="header.keyOk" defaultMessage="LLM key configured" />
        ) : (
          <FormattedMessage
            id="header.keyMissing"
            defaultMessage="No LLM key configured — asking will fail"
          />
        )}
      </Badge>
      <Button
        variant="outline"
        size="sm"
        className="disabled:pointer-events-auto"
        onClick={onOpenSettings}
        disabled={settingsDisabled}
      >
        <FormattedMessage id="header.settings" defaultMessage="Settings" />
      </Button>
    </div>
  );
}
