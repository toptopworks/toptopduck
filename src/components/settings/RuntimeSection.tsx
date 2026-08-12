import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
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

const TABS: readonly RuntimeTab[] = ["api-access", "local-cli"] as const;
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

  // Stable ids for the tab-tabpanel aria association (WAI-ARIA APG).
  const baseId = useId();
  const apiTabId = `${baseId}-api-tab`;
  const cliTabId = `${baseId}-cli-tab`;
  const apiPanelId = `${baseId}-api-panel`;
  const cliPanelId = `${baseId}-cli-panel`;

  // WAI-ARIA APG keyboard activation: ArrowLeft/Right move focus + activate,
  // Home/End jump to the first/last tab. Roving tabindex: the active tab is
  // in the tab sequence (tabIndex 0), inactive tabs are removed (-1).
  function handleTabKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const idx = TABS.indexOf(tab);
    let next: RuntimeTab | null = null;
    if (e.key === "ArrowRight") next = TABS[(idx + 1) % TABS.length];
    else if (e.key === "ArrowLeft") next = TABS[(idx - 1 + TABS.length) % TABS.length];
    else if (e.key === "Home") next = TABS[0];
    else if (e.key === "End") next = TABS[TABS.length - 1];

    if (next) {
      e.preventDefault();
      setTab(next);
      const nextTabId = next === "api-access" ? apiTabId : cliTabId;
      document.getElementById(nextTabId)?.focus();
    }
  }

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
        onKeyDown={handleTabKeyDown}
      >
        <TabButton
          id={apiTabId}
          panelId={apiPanelId}
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
          panelId={cliPanelId}
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
        id={apiPanelId}
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
        id={cliPanelId}
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
// extract never sees a dynamic id here. Roving tabindex (APG): the active
// tab is focusable via Tab key (tabIndex 0), inactive tabs are not (-1) --
// ArrowLeft/Right (handled by the parent tablist) move focus between them.
function TabButton({
  id,
  panelId,
  active,
  onClick,
  label,
}: {
  id: string;
  panelId: string;
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
      aria-controls={panelId}
      tabIndex={active ? 0 : -1}
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
