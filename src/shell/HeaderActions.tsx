import { FormattedMessage, useIntl } from "react-intl";
import { Button } from "../components/ui/button";

// Header action cluster (ADR-0052 i18n). App sits above <IntlProvider> so it
// cannot call useIntl(); this child renders inside the provider. IDs are STATIC
// literals so @formatjs/cli extract can resolve them.
//
// Open / Save ONLY since issue #282: the key-state badge + the settings gear
// moved out of the topbar into the shared ConnectionStatus footer at the
// session sidebar's bottom (ADR-0075 cross-view unification) -- the topbar's
// key indicator + gear were the workspace/settings positional mismatch that
// slice retired. The settingsDisabled gate (appConfig-not-ready) retired with
// the gear: the sidebar footer renders only once app-config resolves, so the
// white-screen state (settings-mode shell + unmounted SettingsView, no ESC
// exit) stays unreachable without a disabled state.
export function HeaderActions({
  disabled,
  onOpenDuck,
  onSaveAs,
}: {
  disabled: boolean;
  onOpenDuck: () => void;
  onSaveAs: () => void;
}) {
  const intl = useIntl();
  const saveDisabledTitle = intl.formatMessage({
    id: "header.saveAs.disabledTitle",
    defaultMessage: "Open or create a session first",
  });
  // ADR-0067 (issue #182): the .header-actions container + .header-actions
  // button visual rules (bespoke border/bg/radius) retired from styles.css.
  // The container rides utility (flex row + density) and the two action
  // buttons are shadcn Button outline variants. Two notes: (1) the outline
  // variant rides bg-background (shadcn default) -- in dark mode this flattens
  // the buttons into the topbar (also bg-background), aligning with the shadcn
  // outline surface contract; (2) each Button adds disabled:pointer-events-auto
  // to override the shadcn base's disabled:pointer-events-none, which otherwise
  // suppresses the native title tooltip (saveDisabledTitle /
  // header.openDuck.title / header.saveAs.title) on the disabled buttons -- a
  // native disabled <button> still does not dispatch click, so re-enabling
  // pointer-events is safe. The .header-actions class hook stays on the
  // container for selector / test stability. (The .key-ok / .key-missing badge
  // hooks retired with the badge itself in issue #282 -- the key-state visual
  // now rides the ConnectionStatus footer's status dot.)
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
    </div>
  );
}
