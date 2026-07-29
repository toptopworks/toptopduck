import { useIntl } from "react-intl";
import { Settings } from "lucide-react";
import type { ProviderConfig } from "../types/provider";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";

// Bare <button> chrome reset for the connection row (ADR-0067). Same recipe as
// the sidebar's bareButtonReset (SessionSidebar, issue #171): NOT [all:unset]
// (it cascades after the display utilities and clobbers `display: flex` back to
// inline) -- appearance-none/bg-transparent/border-0 strip the native chrome
// without touching display; the base-layer `button { font: inherit }` (app.css)
// owns the font.
const bareButtonReset = "appearance-none bg-transparent border-0";

// The active profile's key status (App-level UI state, issue #275): has_key is
// authoritative when keychain_fault is null; a non-null fault means the OS
// keychain read failed, so the connection row renders "Keychain unavailable"
// instead of misreading as "no key configured".
export type KeyStatus = { has_key: boolean; keychain_fault: string | null };

// The shared left-column footer (ADR-0075 rail chrome, issue #281; cross-view
// unification, issue #282): a connection-status row (status dot + active
// profile name + Connected / No key / Keychain unavailable) + the dual-state
// settings gear. BOTH views render this same component at their left column's
// bottom so the connection readout sits in one place app-wide: the settings
// rail passes the "back to workspace" gear half + a jump to the Profiles pane;
// the workspace sidebar passes the "open settings" gear half + an entry that
// lands on the Profiles pane. Both rows bind the same App-level data
// (keyStatus + the appConfig.provider active profile), so a profile switch /
// key change refreshes the two views in step.
export function ConnectionStatus({
  provider,
  keyStatus,
  gearLabel,
  onGearClick,
  onRowClick,
}: {
  // The non-secret provider config; the active profile is derived here so both
  // views share the single derivation (ADR-0064 active pointer).
  provider: ProviderConfig;
  keyStatus: KeyStatus;
  // The dual-state gear's accessible name + tooltip content -- the caller
  // supplies the view-specific half of the semantic (workspace: open settings;
  // settings: back to workspace).
  gearLabel: string;
  onGearClick: () => void;
  // The whole-row click -- the caller decides the target (settings view: jump
  // to the Profiles pane; workspace: open settings landing on Profiles).
  onRowClick: () => void;
}) {
  const intl = useIntl();
  const activeProfile = provider.profiles.find((p) => p.id === provider.active_profile);
  const unnamed = intl.formatMessage({
    id: "settings.profiles.unnamed",
    defaultMessage: "Unnamed profile",
  });
  const activeName = activeProfile
    ? activeProfile.display_name.trim() || unnamed
    : intl.formatMessage({
        id: "settings.connection.notConfigured",
        defaultMessage: "Not configured",
      });
  const connectionLabel = keyStatus.keychain_fault
    ? intl.formatMessage({
        id: "settings.connection.keychainFault",
        defaultMessage: "Keychain unavailable",
      })
    : keyStatus.has_key
      ? intl.formatMessage({ id: "settings.connection.connected", defaultMessage: "Connected" })
      : intl.formatMessage({ id: "settings.connection.noKey", defaultMessage: "No key" });
  // Status-dot colors ride the ADR-0050 semantic tokens, reusing the key-state
  // pairing ADR-0067 anchored for the header badges (primary teal = configured
  // / active, warning amber = needs key, destructive = fault) -- no raw palette.
  const connectionDotClass = !activeProfile
    ? "bg-muted-foreground/40"
    : keyStatus.keychain_fault
      ? "bg-destructive"
      : keyStatus.has_key
        ? "bg-primary"
        : "bg-warning";

  return (
    <div className="connection-status border-border border-t p-2">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className={cn(
            bareButtonReset,
            "connection-row flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 hover:bg-accent focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2",
          )}
          onClick={onRowClick}
        >
          <span className={cn("size-2 shrink-0 rounded-full", connectionDotClass)} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{activeName}</span>
            <span className="text-muted-foreground block truncate text-xs">
              {connectionLabel}
            </span>
          </span>
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="shrink-0"
              aria-label={gearLabel}
              onClick={onGearClick}
            >
              <Settings className="size-4" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{gearLabel}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
