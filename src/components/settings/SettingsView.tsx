import { useCallback, useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
  ArrowLeft,
  Brain,
  Cable,
  Database,
  Puzzle,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";

import { getAppConfig } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import type { AppConfig } from "../../types/app-config";
import { bareButtonReset } from "../../lib/buttonReset";
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
import { McpSection } from "./McpSection";
import { type ProfilesControls } from "./ProfilesSection";
import { PrivacySection } from "./PrivacySection";
import { RuntimeSection } from "./RuntimeSection";
import { SkillsSection } from "./SkillsSection";
import {
  SETTINGS_SECTIONS,
  type IpcBusyReporter,
  type IpcChannel,
  type SettingsSection,
} from "./sections";

// In-app overlay settings view (ADR-0065 shell + ADR-0075 chrome/persistence,
// issue #281). While settingsView.open, the shell renders <SettingsView/> over
// the grid's content cell (non-modal, no mask -- it IS the current view); the
// session sidebar + keep-alive panes stay mounted but hidden underneath, so
// App state and any in-flight turn survive the round trip. The shell titlebar
// stays visible ABOVE the overlay: decorations:false (ADR-0074) makes its
// window controls + drag region shell-wide chrome, required in every view --
// App strips only the topbar's workspace children while settings are open.
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
// failure, serialized on a single-flight chain so a revert can never race a
// later commit. Panes choose WHEN to call it: theme/language commit immediately,
// the engine numbers on per-field Save, profile endpoints on blur, structural
// ops at once. Close/ESC flushes a still-focused profile field (staying open
// when the flush fails) and confirms a dirty add-mode form ("discard new
// profile?"); close is blocked while any IPC is in flight -- commits via this
// view's own counter, pane-owned key / test IPCs via transitions mirrored up
// (they survive a section switch that unmounts the pane) -- and restores focus
// to the opener (ADR-0065 focus habit).

/** Icon for one nav section (decorative; the accessible name is the label). */
function SectionIcon({ section }: { section: SettingsSection }) {
  switch (section) {
    case "general":
      return <SlidersHorizontal className="size-4 shrink-0" aria-hidden />;
    case "skills":
      return <Puzzle className="size-4 shrink-0" aria-hidden />;
    case "runtime":
      return <Brain className="size-4 shrink-0" aria-hidden />;
    case "database-engine":
      return <Database className="size-4 shrink-0" aria-hidden />;
    case "privacy":
      return <ShieldCheck className="size-4 shrink-0" aria-hidden />;
    case "mcp":
      return <Cable className="size-4 shrink-0" aria-hidden />;
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
    case "skills":
      return <FormattedMessage id="settings.nav.skills" defaultMessage="Skills" />;
    case "runtime":
      return <FormattedMessage id="settings.nav.runtime" defaultMessage="Runtime" />;
    case "database-engine":
      return <FormattedMessage id="settings.nav.databaseEngine" defaultMessage="Database Engine" />;
    case "privacy":
      return <FormattedMessage id="settings.nav.privacy" defaultMessage="Privacy" />;
    case "mcp":
      return <FormattedMessage id="settings.nav.mcp" defaultMessage="MCP Servers" />;
    default: {
      const _exhaustive: never = section;
      throw new Error(`Unknown settings section: ${String(_exhaustive)}`);
    }
  }
}

/** The active pane. Each pane self-persists via onCommit; the Profiles pane also
 *  publishes its close-contract controls through profilesControlsRef and mirrors
 *  its key / test IPC transitions up through onIpcBusy. */
function SectionContent({
  section,
  appConfig,
  onCommit,
  onSessionsDirChanged,
  onDefaultRuntimeChanged,
  onIpcBusy,
  initialEditProfileId,
  profilesControlsRef,
}: {
  section: SettingsSection;
  appConfig: AppConfig;
  onCommit: (mutate: (cfg: AppConfig) => AppConfig) => Promise<string | null>;
  onSessionsDirChanged: (cfg: AppConfig) => void;
  onDefaultRuntimeChanged: (cfg: AppConfig) => void;
  onIpcBusy: IpcBusyReporter;
  initialEditProfileId?: string;
  profilesControlsRef: React.MutableRefObject<ProfilesControls | null>;
}) {
  switch (section) {
    case "general":
      return (
        <GeneralSection
          appConfig={appConfig}
          onCommitImmediate={onCommit}
          onSessionsDirChanged={onSessionsDirChanged}
          onIpcBusy={onIpcBusy}
        />
      );
    case "skills":
      return (
        <SkillsSection configuredMcpIds={appConfig.mcp_servers.servers.map((s) => s.id)} />
      );
    case "runtime":
      return (
        <RuntimeSection
          provider={appConfig.provider}
          defaultRuntime={appConfig.default_runtime}
          onCommit={onCommit}
          onDefaultRuntimeChanged={onDefaultRuntimeChanged}
          onIpcBusy={onIpcBusy}
          initialEditProfileId={initialEditProfileId}
          profilesControlsRef={profilesControlsRef}
        />
      );
    case "database-engine":
      return <EngineSection appConfig={appConfig} onCommit={onCommit} />;
    case "privacy":
      return <PrivacySection />;
    case "mcp":
      return <McpSection appConfig={appConfig} onCommit={onCommit} />;
    default: {
      const _exhaustive: never = section;
      throw new Error(`Unknown settings section: ${String(_exhaustive)}`);
    }
  }
}

export function SettingsView({
  appConfig,
  onCommitAppConfig,
  onReplaceAppConfig,
  onSessionsDirChanged,
  onDefaultRuntimeChanged,
  onClose,
  section,
  onSectionChange,
  initialEditProfileId,
  collapsed,
}: {
  // Collapse state (issue #287): when true the nav subtree goes inert so
  // keyboard / screen-reader focus cannot land on the opacity-0 controls.
  collapsed: boolean;
  appConfig: AppConfig;
  // Persist a full app-config; MUST return the IPC promise so commits can await
  // + catch failures (App passes commitAppConfig unwrapped).
  onCommitAppConfig: (cfg: AppConfig) => Promise<void>;
  // Replace local appConfig state WITHOUT an IPC write (#659). When a commit
  // AND its compensating write both fail, the disk truth is unknown (the
  // first write may have landed despite rejecting); the view re-reads it and
  // hands the disk config back through this state-only sync so the controls
  // show what is actually stored.
  onReplaceAppConfig: (cfg: AppConfig) => void;
  // Replace local appConfig state WITHOUT an IPC write (issue #452). After
  // setSessionsDir IPC persists + returns the updated config, this syncs the
  // frontend state + triggers the sidebar re-scan.
  onSessionsDirChanged: (cfg: AppConfig) => void;
  // Replace local appConfig state WITHOUT an IPC write (issue #571). The
  // setDefaultRuntime IPC already persisted + returned the updated config;
  // this is the state-only sync (no sidebar re-scan -- a machine-level
  // runtime preference does not move session files).
  onDefaultRuntimeChanged: (cfg: AppConfig) => void;
  // Called to exit back to the workspace (rail-top back, the gear, or ESC).
  onClose: () => void;
  // The live settings section is controlled by the shell (issue #288): the
  // shell's back/forward history restores it, so SettingsView no longer owns it.
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  initialEditProfileId?: string;
}) {
  const intl = useIntl();
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);

  // Latest app-config for read-modify-write. Mirrored from the prop in an effect
  // AND updated inside each serialized commit run, so a commit always reads the
  // true current config (INCLUDING a predecessor's revert) without writing the
  // ref during render (react-hooks/refs).
  const latestRef = useRef(appConfig);
  useEffect(() => {
    latestRef.current = appConfig;
  }, [appConfig]);

  // Commits run on a single-flight chain: each read-modify-write starts only
  // after the previous one SETTLES (its success or its compensating revert).
  // Concurrent optimistic commits could otherwise diverge UI from disk -- e.g.
  // a failed commit's revert clobbering an overlapping later success.
  const commitChainRef = useRef<Promise<void>>(Promise.resolve());
  // Commits currently queued / in flight (gates ESC / close). Lives here, not
  // in a pane, so it survives a section switch mid-commit.
  const commitsInFlightRef = useRef(0);

  const commitWithRevert = useCallback(
    (mutate: (cfg: AppConfig) => AppConfig): Promise<string | null> => {
      const run = async (): Promise<string | null> => {
        commitsInFlightRef.current += 1;
        try {
          const prev = latestRef.current;
          const next = mutate(prev);
          latestRef.current = next;
          try {
            await onCommitAppConfig(next);
            return null;
          } catch (e) {
            // Compensating write: restore the previous config in React state +
            // disk so the UI never diverges from what is stored (ADR-0075
            // revert-on-fail). AWAITED inside the chain so the next commit
            // reads the reverted config and disk ordering stays consistent.
            latestRef.current = prev;
            try {
              await onCommitAppConfig(prev);
            } catch {
              // The compensating write failed too (#659): the disk truth is
              // now unknown (the original write may have landed despite
              // rejecting). Re-read it and sync both this view's mirror and
              // the shell state so the controls show what is actually stored
              // instead of a silent divergence that survives until the next
              // successful write or restart.
              try {
                const disk = await getAppConfig();
                latestRef.current = disk;
                onReplaceAppConfig(disk);
              } catch {
                // The read failed as well (backend unavailable): the surfaced
                // error stays the only signal -- nothing more this layer
                // can do.
              }
            }
            return fmtError(e, intl);
          }
        } finally {
          commitsInFlightRef.current -= 1;
        }
      };
      const result = commitChainRef.current.then(run);
      // Keep the chain alive regardless of outcome (run never actually
      // rejects -- failures come back as formatted error strings).
      commitChainRef.current = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    [onCommitAppConfig, onReplaceAppConfig, intl],
  );

  // Sessions-dir IPC bypasses commitWithRevert (it uses a dedicated IPC, not
  // set_app_config). Update latestRef synchronously so a concurrent theme/locale
  // commit reads the true current config instead of a stale snapshot (I-1 race).
  const handleSessionsDirChanged = useCallback((cfg: AppConfig) => {
    latestRef.current = cfg;
    onSessionsDirChanged(cfg);
  }, [onSessionsDirChanged]);

  // Default-runtime IPC also bypasses commitWithRevert (dedicated IPC, issue
  // #571). Same latestRef sync for the same I-1 race reason.
  const handleDefaultRuntimeChanged = useCallback((cfg: AppConfig) => {
    latestRef.current = cfg;
    onDefaultRuntimeChanged(cfg);
  }, [onDefaultRuntimeChanged]);

  // The Profiles pane's close-contract controls (flush / addDirty / discardAdd /
  // busy / dialogOpen); null when the pane is not mounted.
  const profilesControlsRef = useRef<ProfilesControls | null>(null);

  // Key / test IPCs are owned by pane children whose busy state dies on
  // unmount, so their in-flight transitions are mirrored here (channel booleans,
  // set idempotently). The pane reports from the field's IPC finally block,
  // which runs even after a section switch unmounts the pane -- so the close
  // guard still blocks until that IPC settles (ADR-0075: close is blocked while
  // ANY in-flight IPC, not only while the owning pane stays mounted).
  const paneIpcBusyRef = useRef<Record<IpcChannel, boolean>>({
    key: false,
    test: false,
    sessionsDir: false,
    probe: false,
    defaultRuntime: false,
  });
  const handlePaneIpcBusy = useCallback<IpcBusyReporter>((channel, busy) => {
    paneIpcBusyRef.current[channel] = busy;
  }, []);

  // Single close path (ADR-0075): block while any IPC is in flight, flush a
  // still-focused profile field (staying open when the flush fails so the
  // inline error remains visible), confirm a dirty add-mode form, else close.
  async function requestClose() {
    const ctl = profilesControlsRef.current;
    const paneIpc = paneIpcBusyRef.current;
    if (commitsInFlightRef.current > 0 || Object.values(paneIpc).some(Boolean) || ctl?.busy) return;
    if (ctl && !(await ctl.flush())) return;
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

  // ESC exits via the same requestClose path. While a confirm dialog is open --
  // this view's discard confirm OR the Profiles pane's delete confirm -- the
  // AlertDialog owns ESC and this handler bails (ADR-0075 close contract). Refs
  // keep the once-registered listener stable across renders.
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
      if (profilesControlsRef.current?.dialogOpen) return;
      e.preventDefault();
      void requestCloseRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The rail's "back to workspace" label (rail-top back button + the footer
  // gear's accessible name / tooltip).
  const backToWorkspaceLabel = intl.formatMessage({
    id: "settings.backToWorkspace",
    defaultMessage: "Back to workspace",
  });

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
        className="settings-nav border-border bg-muted border-r p-2"
        aria-label="Settings sections"
        inert={collapsed}
      >
        {/* Rail top: back to workspace. */}
        <div className="settings-rail-top border-border border-b pt-2 pb-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            // settings-back hook class (ADR-0067 selector stability) so tests can
            // target the rail-top back button distinctly from the gear (both are
            // labelled "Back to workspace").
            className="settings-back w-full justify-start gap-2 text-muted-foreground"
            onClick={() => void requestClose()}
          >
            <ArrowLeft className="size-4" aria-hidden />
            {backToWorkspaceLabel}
          </Button>
        </div>

        {/* Nav list. */}
        <div className="settings-nav-list flex-1 space-y-0.5 overflow-y-auto">
          {SETTINGS_SECTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={cn(
                bareButtonReset,
                "settings-nav-button text-foreground flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm",
                "hover:bg-accent",
                "focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2",
                section === s && "bg-accent text-accent-foreground font-medium",
              )}
              aria-current={section === s ? "page" : undefined}
              onClick={() => onSectionChange(s)}
            >
              <SectionIcon section={s} />
              <SectionLabel section={s} />
            </button>
          ))}
        </div>

        {/* Rail bottom: the "back to workspace" gear (issue #282). */}
        <div className="settings-footer border-border border-t p-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={backToWorkspaceLabel}
                onClick={() => void requestClose()}
              >
                <Settings className="size-4" aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{backToWorkspaceLabel}</TooltipContent>
          </Tooltip>
        </div>
      </nav>

      <main className="settings-content p-6">
        <div className="mx-auto max-w-3xl">
          <SectionContent
            section={section}
            appConfig={appConfig}
            onCommit={commitWithRevert}
            onSessionsDirChanged={handleSessionsDirChanged}
            onDefaultRuntimeChanged={handleDefaultRuntimeChanged}
            onIpcBusy={handlePaneIpcBusy}
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
