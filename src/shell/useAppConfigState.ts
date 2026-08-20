// App-level config state (issue #196). Owns the AppConfig advisory state +
// every action that mutates it (ADR-0038): commitAppConfig (the single
// persistence write), switchActiveProfile (top-bar quick switcher, issue
// #154 / ADR-0065), commitShellPrefs + toggleSidebarCollapse /
// toggleRailCollapse (ADR-0054 shell collapse), and the one-shot restore of
// collapse prefs on first resolve (ADR-0054). Window geometry persistence
// moved to tauri_plugin_window_state (issue #268); this hook no longer
// restores or persists geometry.
//
// ADR-0068: this is advisory state held in React (NOT TanStack Query) -- the
// app-config blob is the persistence layer for shell prefs (theme / locale /
// sidebar + rail collapse / active profile),
// read once on mount and re-written on each mutation. The optimistic +
// no-rollback contract on every mutating action lives on commitAppConfig
// below (the single persistence write all actions route through).
//
// Locale + intl live HERE (not in App): app-config owns locale (ADR-0038), and
// the effective locale resolves from appConfig.locale via useLocale. App sits
// above <IntlProvider> and needs a standalone IntlShape for the SHELL hooks
// (usePersistedSessions / useShellSessions) + switchActiveProfile's reject
// path. Keeping appConfig + the locale it owns + the derived IntlShape in one
// hook dodges the within-render cycle (intl derives from appConfig, and the
// hook that owns appConfig must not also depend on an intl App builds from it).
// App reads effectiveLocale + intl from the return; the IntlProvider + the
// document.lang effect + useTheme stay in App (DOM / provider concerns).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { getAppConfig, setAppConfig } from "../api";
import { toAppError } from "../lib/error-presentation";
import { catalogFor, coerceLocalePreference, useLocale } from "../i18n";
import type { EffectiveLocale } from "../i18n";
import { log } from "../lib/log";
import type { AppConfig } from "../types/app-config";
import type { SidebarGrouping } from "../types/app-config";
import type { AppError } from "../types/error";

export interface UseAppConfigStateDeps {
  /** From useShellError: surfaces a shell-layer AppError (kind "shell") for a
   *  switchActiveProfile reject. */
  setShellError: (error: AppError | null) => void;
}

/** The AppConfig advisory state + every mutating action + the restore
 *  effects + the locale / intl derived from the owned appConfig.locale.
 *  sidebarCollapsed / railCollapsed are public (the shell className reads
 *  them); appConfigRef / collapseRestoredRef stay internal (the restore
 *  effects' one-shot guards). effectiveLocale + intl are
 *  returned so App can feed <IntlProvider> + the downstream shell hooks
 *  (usePersistedSessions / useShellSessions) from a single locale resolution.
 *  Composed into App as the app-config + collapse + locale source
 *  (ADR-0038/0052/0054). */
export function useAppConfigState({
  setShellError,
}: UseAppConfigStateDeps): {
  appConfig: AppConfig | null;
  effectiveLocale: EffectiveLocale;
  intl: IntlShape;
  commitAppConfig: (cfg: AppConfig) => Promise<void>;
  /** Replace the local appConfig state WITHOUT an IPC write (issue #452).
   *  Used after `setSessionsDir` — that IPC already persisted the config, so
   *  the caller just needs the frontend state to reflect the disk truth. */
  replaceAppConfig: (cfg: AppConfig) => void;
  switchActiveProfile: (id: string) => Promise<void>;
  sidebarCollapsed: boolean;
  toggleSidebarCollapse: () => void;
  sidebarGrouping: SidebarGrouping;
  switchSidebarGrouping: (mode: SidebarGrouping) => void;
} {
  const [appConfig, setAppConfigState] = useState<AppConfig | null>(null);
  const appConfigRef = useRef<AppConfig | null>(null);

  // Locale (ADR-0052): resolved once from the persisted three-state preference
  // (defaulting to system before app-config resolves). The IntlShape is built
  // from the same catalog so switchActiveProfile can localize a reject at the
  // shell layer (issue #119); App also feeds this intl to the downstream shell
  // hooks + the IntlProvider subtree.
  const effectiveLocale = useLocale(coerceLocalePreference(appConfig?.locale));
  const intl = useMemo(
    () => createIntl({ locale: effectiveLocale, messages: catalogFor(effectiveLocale) }),
    [effectiveLocale],
  );

  // ADR-0054 shell collapse (issue #84): two independent manual levels --
  // session sidebar (full hide + topbar call-out) and thread rail (workspace
  // goes full-width). Both default expanded; both restore from app-config once
  // on the first resolve (ADR-0038) and persist on every toggle.
  // ADR-0072 (#251): the sidebar's flat/time grouping mode rides the same
  // shell-chrome surface -- restores with the two collapse prefs, persists on
  // every switch via commitShellPrefs's single IPC write.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarGrouping, setSidebarGroupingState] = useState<SidebarGrouping>("flat");
  const collapseRestoredRef = useRef(false);

  // Load app-config once on mount (theme/locale).
  useEffect(() => {
    let cancelled = false;
    // External system -> state: a legitimate one-shot fetch.
    void getAppConfig()
      .then((cfg) => {
        if (cancelled) return;
        appConfigRef.current = cfg;
        setAppConfigState(cfg);
      })
      .catch(() => {
        // Keep null; theme defaults to "system".
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The single persistence write (ADR-0068). OPTIMISTIC -- state + ref flip
  // BEFORE the IPC await; a write failure surfaces the error but does NOT roll
  // back (live_config reads disk truth on the next turn, so a failed write
  // leaves the next ask on the OLD value). Mirrors SettingsView Save. Callers
  // install their own surfacing: switchActiveProfile wraps in try/catch ->
  // setShellError; commitShellPrefs attaches .catch -> log.warn (the visible
  // effect already landed optimistically).
  const commitAppConfig = useCallback(async (cfg: AppConfig): Promise<void> => {
    appConfigRef.current = cfg;
    setAppConfigState(cfg);
    await setAppConfig(cfg);
  }, []);

  // Replace the local appConfig state WITHOUT an IPC write (issue #452).
  // `setSessionsDir` already persisted; this just syncs the frontend state +
  // ref so subsequent optimistic commits read the true current config.
  const replaceAppConfig = useCallback((cfg: AppConfig): void => {
    appConfigRef.current = cfg;
    setAppConfigState(cfg);
  }, []);

  // Switch the active profile from the top-bar quick switcher (issue #154,
  // ADR-0065). There is no separate set-active IPC: active_profile lives in
  // app-config (ADR-0038/0064), so the switch is one commitAppConfig write of
  // provider.active_profile -- the SAME persistence layer the settings Save
  // uses (#153 SettingsView.save -> onCommitAppConfig). The CONTRACT differs
  // from #153: settings stages the change in a draft and commits on Save
  // (batched with theme/locale/engine), while the top-bar switcher commits
  // IMMEDIATELY (a one-profile swap, no draft) so the next ask picks it up.
  // live_config reads active_profile fresh each turn (ADR-0064 -- the
  // ProviderConfigSource impl does a disk read per call, no caching), so the
  // next ask uses the new profile's endpoint + keychain slot.
  // The optimistic + no-rollback contract is commitAppConfig's
  // (above) -- a reject here is caught into setShellError.
  const switchActiveProfile = useCallback(
    async (id: string): Promise<void> => {
      if (!appConfig) return;
      if (id === appConfig.provider.active_profile) return;
      try {
        await commitAppConfig({
          ...appConfig,
          provider: { ...appConfig.provider, active_profile: id },
        });
      } catch (e) {
        setShellError(toAppError(e, intl, "shell"));
      }
    },
    [appConfig, commitAppConfig, intl, setShellError],
  );

  // Commit the three shell prefs (two collapses + the sidebar grouping mode) as
  // ONE app-config write (ADR-0038/0054, issue #84; ADR-0072, issue #251).
  // A single IPC write keeps the three shell-chrome prefs atomic against any
  // sibling commitAppConfig caller (e.g. switchActiveProfile). No-op before
  // app-config resolves (appConfigRef null) -- the restore effect's one-shot
  // then applies the persisted value on first load.
  const commitShellPrefs = useCallback(
    (next: { sidebar: boolean; grouping: SidebarGrouping }): void => {
      const base = appConfigRef.current;
      if (!base) return;
      void commitAppConfig({
        ...base,
        shell: {
          sidebar_collapsed: next.sidebar,
          sidebar_grouping: next.grouping,
        },
      }).catch((e) => {
        // IPC write failed -- the UI already flipped optimistically (state is
        // set before the commit), so the only consequence is the pref not
        // surviving a restart. Log to devtools, not a user toast (the toggle's
        // visible effect already landed).
        log.warn("shell", "collapse persist failed", e);
      });
    },
    [commitAppConfig],
  );

  const toggleSidebarCollapse = useCallback(() => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    commitShellPrefs({ sidebar: next, grouping: sidebarGrouping });
  }, [sidebarCollapsed, sidebarGrouping, commitShellPrefs]);

  // Switch the sidebar's flat/time grouping mode (ADR-0072, issue #251). Sibling
  // to the sidebar collapse toggle: a one-mode swap that commits immediately via
  // commitShellPrefs (no debounce -- a low-frequency discrete action, mirroring
  // the toggle's immediate commit contract). The optimistic + no-
  // rollback contract is commitAppConfig's; a reject lands in the .catch log.
  const switchSidebarGrouping = useCallback(
    (mode: SidebarGrouping) => {
      if (mode === sidebarGrouping) return;
      setSidebarGroupingState(mode);
      commitShellPrefs({ sidebar: sidebarCollapsed, grouping: mode });
    },
    [sidebarCollapsed, sidebarGrouping, commitShellPrefs],
  );

  // Restore shell collapse prefs + the sidebar grouping mode ONCE on the first
  // app-config load (ADR-0038 / 0054, issue #84; ADR-0072, issue #251). A
  // one-shot so a later app-config write (e.g. a toggle's own commit) does not
  // re-clobber the user's in-session state with the persisted value.
  useEffect(() => {
    if (!appConfig || collapseRestoredRef.current) return;
    collapseRestoredRef.current = true;
    setSidebarCollapsed(appConfig.shell.sidebar_collapsed);
    setSidebarGroupingState(appConfig.shell.sidebar_grouping);
  }, [appConfig]);

  return {
    appConfig,
    effectiveLocale,
    intl,
    commitAppConfig,
    replaceAppConfig,
    switchActiveProfile,
    sidebarCollapsed,
    toggleSidebarCollapse,
    sidebarGrouping,
    switchSidebarGrouping,
  };
}
