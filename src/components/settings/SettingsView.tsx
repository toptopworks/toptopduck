import { useCallback, useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
  ArrowLeft,
  Cpu,
  KeyRound,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";

import { fmtError } from "../../lib/error-presentation";
import type { AppConfig } from "../../types/app-config";
import { cn } from "../../lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { EngineSection } from "./EngineSection";
import { GeneralSection } from "./GeneralSection";
import { ProfilesSection, type ProfilesControls } from "./ProfilesSection";
import { PrivacySection } from "./PrivacySection";
import { SETTINGS_SECTIONS, type SettingsSection } from "./sections";

// In-app overlay settings view (ADR-0065 shell + ADR-0075 chrome/persistence,
// issue #281). While settingsView.open, the shell renders <SettingsView/> over
// the grid (non-modal, no mask -- it IS the current view); the session sidebar
// + topbar + keep-alive panes stay mounted (display:none) underneath, so App
// state and any in-flight turn survive the round trip.
//
// CHROME (ADR-0075): the retired single settings header is split into a left
// RAIL -- brand + "Back to workspace" at the top, icon nav in the middle, and a
// connection-status row + dual-state gear (back to workspace) at the bottom --
// while each pane owns its own hero title + description. There is NO global
// Save/Cancel footer: every control persists itself (per-control persistence).
//
// PERSISTENCE (ADR-0075 governing principle): the single write path is
// commitWithRevert -- an optimistic read-modify-write over the latest app-config
// that reverts with a compensating write + returns a formatted error on IPC
// failure. Panes choose WHEN to call it: theme/language commit immediately, the
// engine numbers on per-field Save, profile endpoints on blur, structural ops at
// once. Close/ESC flushes a still-focused profile field and confirms a dirty
// add-mode form ("discard new profile?"); close is blocked while any IPC is in
// flight and restores focus to the opener (ADR-0065 focus habit).

/** Icon for one nav section (decorative; the accessible name is the label). */
function SectionIcon({ section }: { section: SettingsSection }) {
  switch (section) {
    case "general":
      return <SlidersHorizontal className="size-4 shrink-0" aria-hidden />;
    case "profiles":
      return <KeyRound className="size-4 shrink-0" aria-hidden />;
    case "engine":
      return <Cpu className="size-4 shrink-0" aria-hidden />;
    case "privacy":
      return <ShieldCheck className="size-4 shrink-0" aria-hidden />;
    default: {
      const _exhaustive: never = section;
      throw new Error(`Unknown settings section: ${String(_exhaustive)}`);
    }
  }
}

// Renders the label for one settings section. Each case is a STATIC
// <FormattedMessage id="..." defaultMessage="..." /> literal so @formatjs/cli
// extract resolves every settings.nav.* id (ADR-0052).
function SectionLabel({ section }: { section: SettingsSection }) {
  switch (section) {
    case "general":
      return <FormattedMessage id="settings.nav.general" defaultMessage="General" />;
    case "profiles":
      return <FormattedMessage id="settings.nav.profiles" defaultMessage="Profiles" />;
    case "engine":
      return <FormattedMessage id="settings.nav.engine" defaultMessage="Engine" />;
    case "privacy":
      return <FormattedMessage id="settings.nav.privacy" defaultMessage="Privacy" />;
    default: {
      const _exhaustive: never = section;
      throw new Error(`Unknown settings section: ${String(_exhaustive)}`);
    }
  }
}

/** The active pane. Each pane self-persists via onCommit; the Profiles pane also
 *  publishes its close-contract controls through profilesControlsRef. */
function SectionContent({
  section,
  appConfig,
  onCommit,
  onRefreshKeyStatus,
  initialEditProfileId,
  profilesControlsRef,
}: {
  section: SettingsSection;
  appConfig: AppConfig;
  onCommit: (mutate: (cfg: AppConfig) => AppConfig) => Promise<string | null>;
  onRefreshKeyStatus: () => void;
  initialEditProfileId?: string;
  profilesControlsRef: React.MutableRefObject<ProfilesControls | null>;
}) {
  switch (section) {
    case "general":
      return <GeneralSection appConfig={appConfig} onCommitImmediate={onCommit} />;
    case "profiles":
      return (
        <ProfilesSection
          provider={appConfig.provider}
          onCommit={onCommit}
          onRefreshKeyStatus={onRefreshKeyStatus}
          initialEditProfileId={initialEditProfileId}
          controlsRef={profilesControlsRef}
        />
      );
    case "engine":
      return <EngineSection appConfig={appConfig} onCommit={onCommit} />;
    case "privacy":
      return <PrivacySection />;
    default: {
      const _exhaustive: never = section;
      throw new Error(`Unknown settings section: ${String(_exhaustive)}`);
    }
  }
}

export function SettingsView({
  appConfig,
  onCommitAppConfig,
  onClose,
  onRefreshKeyStatus,
  keyStatus,
  initialSection = "general",
  initialEditProfileId,
}: {
  appConfig: AppConfig;
  // Persist a full app-config; MUST return the IPC promise so commits can await
  // + catch failures (App passes commitAppConfig unwrapped).
  onCommitAppConfig: (cfg: AppConfig) => Promise<void>;
  // Called to exit back to the workspace (rail-top back, the gear, or ESC).
  onClose: () => void;
  // Re-read the active profile's keychain slot (set-active switches inside the
  // Profiles pane refresh the connection row + header indicator, ADR-0029).
  onRefreshKeyStatus: () => void;
  // The active profile's key status (App-level), bound to the rail's connection
  // row -- the only visible key indicator while the top bar is hidden.
  keyStatus: { has_key: boolean; keychain_fault: string | null };
  initialSection?: SettingsSection;
  initialEditProfileId?: string;
}) {
  const intl = useIntl();
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);

  // Latest app-config for read-modify-write. Mirrored from the prop in an effect
  // AND updated optimistically inside commitWithRevert, so two rapid commits
  // chain correctly even before React re-renders (avoids a stale-closure
  // clobber) without writing the ref during render (react-hooks/refs).
  const latestRef = useRef(appConfig);
  useEffect(() => {
    latestRef.current = appConfig;
  }, [appConfig]);

  // Whether a commit this view initiated is in flight (gates ESC / close).
  const committingRef = useRef(false);

  const commitWithRevert = useCallback(
    async (mutate: (cfg: AppConfig) => AppConfig): Promise<string | null> => {
      const prev = latestRef.current;
      const next = mutate(prev);
      latestRef.current = next;
      committingRef.current = true;
      try {
        await onCommitAppConfig(next);
        return null;
      } catch (e) {
        // Compensating write: restore the previous config in React state + disk
        // so the UI never diverges from what is stored (ADR-0075 revert-on-fail).
        latestRef.current = prev;
        void onCommitAppConfig(prev).catch(() => {
          // best effort -- the surfaced error already tells the user.
        });
        return fmtError(e, intl);
      } finally {
        committingRef.current = false;
      }
    },
    [onCommitAppConfig, intl],
  );

  // The Profiles pane's close-contract controls (flush / addDirty / discardAdd /
  // busy); null when the pane is not mounted.
  const profilesControlsRef = useRef<ProfilesControls | null>(null);

  // Single close path (ADR-0075): block while any IPC is in flight, flush a
  // still-focused profile field, confirm a dirty add-mode form, else close.
  async function requestClose() {
    const ctl = profilesControlsRef.current;
    if (committingRef.current || ctl?.busy) return;
    if (ctl) await ctl.flush();
    if (ctl?.addDirty) {
      setConfirmDiscardOpen(true);
      return;
    }
    onClose();
  }

  // Focus management (ADR-0065): on enter, remember the trigger + focus the
  // overlay; on exit, restore focus to the trigger.
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    triggerRef.current = (document.activeElement as HTMLElement | null) ?? null;
    containerRef.current?.focus();
    return () => {
      triggerRef.current?.focus();
    };
  }, []);

  // ESC exits via the same requestClose path. While the discard confirm is open
  // the AlertDialog owns ESC (this handler bails). Refs keep the once-registered
  // listener stable across renders.
  const confirmDiscardRef = useRef(false);
  useEffect(() => {
    confirmDiscardRef.current = confirmDiscardOpen;
  }, [confirmDiscardOpen]);
  const requestCloseRef = useRef(requestClose);
  useEffect(() => {
    requestCloseRef.current = requestClose;
  });
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (confirmDiscardRef.current) return;
      e.preventDefault();
      void requestCloseRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Connection row (rail bottom): the active profile + its key status. The whole
  // row jumps to the Profiles pane. The gear beside it is the dual-state
  // settings toggle -- in the settings view it reads "back to workspace".
  const activeProfile = appConfig.provider.profiles.find(
    (p) => p.id === appConfig.provider.active_profile,
  );
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
  const connectionDotClass = !activeProfile
    ? "bg-muted-foreground/40"
    : keyStatus.keychain_fault
      ? "bg-destructive"
      : keyStatus.has_key
        ? "bg-emerald-500"
        : "bg-amber-500";
  const backToWorkspace = (
    <FormattedMessage id="settings.backToWorkspace" defaultMessage="Back to workspace" />
  );

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="false"
      aria-label={intl.formatMessage({ id: "settings.title", defaultMessage: "App Settings" })}
      className="settings-overlay bg-background outline-none focus-visible:outline-none"
    >
      <nav
        className="settings-nav border-border bg-muted/30 border-r"
        aria-label="Settings sections"
      >
        {/* Rail top: brand + back to workspace. */}
        <div className="settings-rail-top border-border border-b px-2 pt-3 pb-2">
          <div className="px-2 pb-2 text-sm font-semibold tracking-tight">TOPTOPDuck</div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            // settings-back hook class (ADR-0067 selector stability) so tests can
            // target the rail-top back button distinctly from the gear (both are
            // labelled "Back to workspace").
            className="settings-back w-full justify-start gap-2"
            onClick={() => void requestClose()}
          >
            <ArrowLeft className="size-4" aria-hidden />
            {backToWorkspace}
          </Button>
        </div>

        {/* Nav list. */}
        <div className="settings-nav-list flex-1 space-y-0.5 overflow-y-auto p-2">
          {SETTINGS_SECTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={cn(
                "settings-nav-button [all:unset] text-foreground flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm",
                "hover:bg-accent",
                "focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2",
                section === s && "bg-accent text-accent-foreground font-medium",
              )}
              aria-current={section === s ? "page" : undefined}
              onClick={() => setSection(s)}
            >
              <SectionIcon section={s} />
              <SectionLabel section={s} />
            </button>
          ))}
        </div>

        {/* Rail bottom: connection status row + dual-state gear. */}
        <div className="settings-rail-bottom border-border border-t p-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="connection-row [all:unset] flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 hover:bg-accent focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2"
              onClick={() => setSection("profiles")}
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
                  aria-label={intl.formatMessage({
                    id: "settings.backToWorkspace",
                    defaultMessage: "Back to workspace",
                  })}
                  onClick={() => void requestClose()}
                >
                  <Settings className="size-4" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{backToWorkspace}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </nav>

      <main className="settings-content p-6">
        <div className="mx-auto max-w-3xl">
          <SectionContent
            section={section}
            appConfig={appConfig}
            onCommit={commitWithRevert}
            onRefreshKeyStatus={onRefreshKeyStatus}
            initialEditProfileId={initialEditProfileId}
            profilesControlsRef={profilesControlsRef}
          />
        </div>
      </main>

      {/* Discard-confirm for a dirty add-mode profile form (ADR-0075 close
          contract). ESC here is owned by the AlertDialog (the window handler
          bails while open). */}
      {confirmDiscardOpen && (
        <AlertDialog
          defaultOpen
          onOpenChange={(open) => {
            if (!open) setConfirmDiscardOpen(false);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <FormattedMessage
                  id="settings.discardNew.title"
                  defaultMessage="Discard new profile?"
                />
              </AlertDialogTitle>
              <AlertDialogDescription>
                <FormattedMessage
                  id="settings.discardNew.body"
                  defaultMessage="The new profile hasn't been created yet. Discarding drops everything you typed."
                />
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setConfirmDiscardOpen(false)}>
                <FormattedMessage id="settings.discardNew.keep" defaultMessage="Keep editing" />
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => {
                  profilesControlsRef.current?.discardAdd();
                  setConfirmDiscardOpen(false);
                  onClose();
                }}
              >
                <FormattedMessage id="settings.discardNew.discard" defaultMessage="Discard" />
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
