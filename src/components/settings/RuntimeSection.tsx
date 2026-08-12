import { useId, useState, type ReactNode } from "react";
import { FormattedMessage } from "react-intl";

import type { AppConfig } from "../../types/app-config";
import { bareButtonReset } from "../../lib/buttonReset";
import { cn } from "../../lib/utils";
import type { ProfilesControls } from "./ProfilesSection";
import { ProfilesSection } from "./ProfilesSection";
import { LocalCliTab } from "./LocalCliTab";
import { PaneHeader } from "./settings-chrome";

// Runtime section (issue #489, ADR-0091): the Settings "Runtime" pane, split
// into two sub-tabs -- "API Access" (the existing ProfilesSection master-detail
// + keychain + preflight) and "Local CLI" (the v1 adapter management panel).
//
// The PaneHeader (hero title + description) sits ABOVE the tabs and describes
// the entire runtime section. Tab state is local useState -- NOT persisted: a
// nav switch away and back resets to the default "API Access" tab (the
// RuntimeSection unmounts on nav switch, so useState naturally resets on
// remount). Both tab contents are always mounted (CSS-hidden when inactive) so
// the ProfilesSection's close-contract controlsRef stays populated and an
// in-flight add-mode draft survives a tab switch.

/** The two sub-tabs inside the runtime section. */
type RuntimeTab = "api-access" | "local-cli";

const DEFAULT_TAB: RuntimeTab = "api-access";

export type RuntimeSectionProps = {
  provider: AppConfig["provider"];
  onCommit: (mutate: (cfg: AppConfig) => AppConfig) => Promise<string | null>;
  onRefreshKeyStatus: () => void;
  onIpcBusy: (channel: "key" | "test", busy: boolean) => void;
  initialEditProfileId?: string;
  profilesControlsRef: React.MutableRefObject<ProfilesControls | null>;
};

export function RuntimeSection({
  provider,
  onCommit,
  onRefreshKeyStatus,
  onIpcBusy,
  initialEditProfileId,
  profilesControlsRef,
}: RuntimeSectionProps) {
  const [tab, setTab] = useState<RuntimeTab>(DEFAULT_TAB);

  // Stable ids for the tab-tabpanel aria-labelledby association (WAI-ARIA APG).
  const baseId = useId();
  const apiTabId = `${baseId}-api`;
  const cliTabId = `${baseId}-cli`;

  return (
    <div>
      <PaneHeader
        title={<FormattedMessage id="settings.nav.runtime" defaultMessage="Runtime" />}
        description={(
          <FormattedMessage
            id="settings.runtime.description"
            defaultMessage="API access profiles and local CLI adapters for driving turns."
          />
        )}
      />

      {/* Tab switcher (issue #489): two tab buttons. State is NOT persisted --
          a nav switch unmounts RuntimeSection and useState resets on remount.
          Each label is a static <FormattedMessage> literal at the call site so
          @formatjs/cli extract resolves every settings.runtime.tab.* id
          (ADR-0052: a variable id would fail the i18n:check CI gate). */}
      <div
        className="mb-6 inline-flex items-center gap-1 rounded-lg bg-muted p-0.5"
        role="tablist"
      >
        <TabButton
          id={apiTabId}
          active={tab === "api-access"}
          onClick={() => setTab("api-access")}
          label={(
            <FormattedMessage
              id="settings.runtime.tab.apiAccess"
              defaultMessage="API Access"
            />
          )}
        />
        <TabButton
          id={cliTabId}
          active={tab === "local-cli"}
          onClick={() => setTab("local-cli")}
          label={(
            <FormattedMessage
              id="settings.runtime.tab.localCli"
              defaultMessage="Local CLI"
            />
          )}
        />
      </div>

      {/* Both tabs are always mounted (CSS-hidden when inactive) so
          ProfilesSection's controlsRef stays populated and an in-flight
          add-mode draft survives a tab switch. */}
      <div
        className={cn(tab !== "api-access" && "hidden")}
        role="tabpanel"
        aria-labelledby={apiTabId}
      >
        <ProfilesSection
          provider={provider}
          onCommit={onCommit}
          onRefreshKeyStatus={onRefreshKeyStatus}
          onIpcBusy={onIpcBusy}
          initialEditProfileId={initialEditProfileId}
          controlsRef={profilesControlsRef}
          hideHeader
        />
      </div>
      <div
        className={cn(tab !== "local-cli" && "hidden")}
        role="tabpanel"
        aria-labelledby={cliTabId}
      >
        <LocalCliTab />
      </div>
    </div>
  );
}

// A presentational tab button. The label arrives as an already-resolved
// ReactNode (a static <FormattedMessage> from the call site) so formatjs
// extract never sees a dynamic id here.
function TabButton({
  id,
  active,
  onClick,
  label,
}: {
  id: string;
  active: boolean;
  onClick: () => void;
  label: ReactNode;
}) {
  return (
    <button
      type="button"
      id={id}
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        bareButtonReset,
        "rounded-md px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer",
        "focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
