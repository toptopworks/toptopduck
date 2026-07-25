// App-level config state (issue #196). Owns the AppConfig advisory state +
// every action that mutates it (ADR-0038): commitAppConfig (the single
// persistence write), switchActiveProfile (top-bar quick switcher, issue
// #154 / ADR-0065), commitShellPrefs + toggleSidebarCollapse /
// toggleRailCollapse (ADR-0054 shell collapse), and the restore + persist
// effects for window geometry (ADR-0038 onResized / onMoved, 500ms debounce)
// and collapse prefs (ADR-0054 one-shot restore on first resolve).
//
// ADR-0068: this is advisory state held in React (NOT TanStack Query) -- the
// app-config blob is the persistence layer for shell prefs (theme / locale /
// recent files / window geometry / sidebar + rail collapse / active profile),
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
//
// refreshKeyStatus (the header key indicator for the active profile's keychain
// slot, ADR-0029) stays in App -- it owns the hasKey UI flag and also fires on
// settings-close. App passes it in so the load effect can kick it once on mount
// and switchActiveProfile can kick it after a profile swap.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { LogicalPosition, LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { getAppConfig, setAppConfig } from "../api";
import { toAppError } from "../lib/error-presentation";
import { catalogFor, coerceLocalePreference, useLocale } from "../i18n";
import type { EffectiveLocale } from "../i18n";
import { log } from "../lib/log";
import type { AppConfig } from "../types/app-config";
import type { AppError } from "../types/error";

/** Acquire the main window, or null when the Tauri bridge is absent (jsdom
 *  tests). Every window-geometry call site is a no-op without it. */
function safeMainWindow(): ReturnType<typeof getCurrentWindow> | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export interface UseAppConfigStateDeps {
  /** From useShellError: surfaces a shell-layer AppError (kind "shell") for a
   *  switchActiveProfile reject. */
  setShellError: (error: AppError | null) => void;
  /** From App: refreshes the header key indicator (hasKey reflects the active
   *  profile's keychain slot, ADR-0029 boolean). Fired once on mount by the
   *  load effect, again after a switchActiveProfile swap so the next ask's
   *  slot is reflected, and on settings-close (a Save may have changed the
   *  slot -- App owns that handler). The impl catches its own rejects, so the
   *  hook can fire-and-forget (`void refreshKeyStatus()`). */
  refreshKeyStatus: () => Promise<void>;
}

/** The AppConfig advisory state + every mutating action + the restore / persist
 *  effects + the locale / intl derived from the owned appConfig.locale.
 *  sidebarCollapsed / railCollapsed are public (the shell className reads
 *  them); appConfigRef / geometryRestoredRef / collapseRestoredRef stay
 *  internal (the restore effects' one-shot guards). effectiveLocale + intl are
 *  returned so App can feed <IntlProvider> + the downstream shell hooks
 *  (usePersistedSessions / useShellSessions) from a single locale resolution.
 *  Composed into App as the app-config + collapse + locale source
 *  (ADR-0038/0052/0054). */
export function useAppConfigState({
  setShellError,
  refreshKeyStatus,
}: UseAppConfigStateDeps): {
  appConfig: AppConfig | null;
  effectiveLocale: EffectiveLocale;
  intl: IntlShape;
  commitAppConfig: (cfg: AppConfig) => Promise<void>;
  switchActiveProfile: (id: string) => Promise<void>;
  switchActiveProfileModel: (model: string) => Promise<void>;
  sidebarCollapsed: boolean;
  railCollapsed: boolean;
  toggleSidebarCollapse: () => void;
  toggleRailCollapse: () => void;
} {
  const [appConfig, setAppConfigState] = useState<AppConfig | null>(null);
  const appConfigRef = useRef<AppConfig | null>(null);
  const geometryRestoredRef = useRef(false);

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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const collapseRestoredRef = useRef(false);

  // Load app-config once on mount (theme/locale/recent files/geometry). Also
  // kicks refreshKeyStatus so the header key indicator reflects the active
  // profile's keychain slot at start.
  useEffect(() => {
    let cancelled = false;
    // External system -> state: a legitimate one-shot fetch. refreshKeyStatus
    // is passed in from App; its own setState-in-effect (setHasKey) is governed
    // at App's call sites, not here (the rule fires in the definer's scope).
    void refreshKeyStatus();
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
  }, [refreshKeyStatus]);

  // The single persistence write (ADR-0068). OPTIMISTIC -- state + ref flip
  // BEFORE the IPC await; a write failure surfaces the error but does NOT roll
  // back (live_config reads disk truth on the next turn, so a failed write
  // leaves the next ask on the OLD value). Mirrors SettingsView Save. Callers
  // install their own surfacing: switchActiveProfile wraps in try/catch ->
  // setShellError; commitShellPrefs + the geometry persist flush attach
  // .catch -> log.warn (the visible effect already landed optimistically).
  const commitAppConfig = useCallback(async (cfg: AppConfig): Promise<void> => {
    appConfigRef.current = cfg;
    setAppConfigState(cfg);
    await setAppConfig(cfg);
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
  // next ask uses the new profile's endpoint + keychain slot. Post-swap kick:
  // refreshKeyStatus so the header key indicator reflects the NEW active
  // profile's keychain slot (ADR-0029; see UseAppConfigStateDeps for the full
  // kick surface). The optimistic + no-rollback contract is commitAppConfig's
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
        void refreshKeyStatus();
      } catch (e) {
        setShellError(toAppError(e, intl, "shell"));
      }
    },
    [appConfig, commitAppConfig, refreshKeyStatus, intl, setShellError],
  );

  // Switch the active profile's model from the composer popover (issue #238,
  // ADR-0071). Sibling to switchActiveProfile: there is no separate set-model
  // IPC -- model is a field of the active profile in app-config (ADR-0064:
  // model is per-profile, NOT a global -- different providers support
  // different model sets, so a global active model is meaningless). The
  // switch is one commitAppConfig write that patches ONLY the active
  // profile's model field (immutable map over profiles), so live_config
  // reads the new model on the next turn without touching the keychain slot
  // (the profile id is unchanged -> ADR-0029 key indicator stays). The
  // contract is commitAppConfig's (optimistic + no-rollback); a reject is
  // caught into setShellError, mirroring switchActiveProfile. No draft -- the
  // composer commit is immediate (a one-field swap), so the next ask picks it
  // up; the Settings stage + Save remains the bulk-edit path.
  const switchActiveProfileModel = useCallback(
    async (model: string): Promise<void> => {
      if (!appConfig) return;
      const { provider } = appConfig;
      const active = provider.profiles.find((p) => p.id === provider.active_profile);
      // No active profile (a malformed config normalize repairs on the next
      // store) OR a no-op model: skip the pointless write.
      if (!active || model === active.model) return;
      try {
        await commitAppConfig({
          ...appConfig,
          provider: {
            ...provider,
            profiles: provider.profiles.map((p) =>
              p.id === active.id ? { ...p, model } : p,
            ),
          },
        });
      } catch (e) {
        setShellError(toAppError(e, intl, "shell"));
      }
    },
    [appConfig, commitAppConfig, intl, setShellError],
  );

  // Commit the two shell collapse prefs as one app-config write (ADR-0038/0054,
  // issue #84). No-op before app-config resolves (appConfigRef null) -- the
  // restore effect's one-shot then applies the persisted value on first load.
  const commitShellPrefs = useCallback(
    (next: { sidebar: boolean; rail: boolean }): void => {
      const base = appConfigRef.current;
      if (!base) return;
      void commitAppConfig({
        ...base,
        shell: { sidebar_collapsed: next.sidebar, rail_collapsed: next.rail },
      }).catch((e) => {
        // IPC write failed -- the UI already flipped optimistically (state is
        // set before the commit), so the only consequence is the pref not
        // surviving a restart. Mirror the geometry persist handler: log to
        // devtools, not a user toast (the toggle's visible effect landed).
        log.warn("shell", "collapse persist failed", e);
      });
    },
    [commitAppConfig],
  );

  const toggleSidebarCollapse = useCallback(() => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    commitShellPrefs({ sidebar: next, rail: railCollapsed });
  }, [sidebarCollapsed, railCollapsed, commitShellPrefs]);

  const toggleRailCollapse = useCallback(() => {
    const next = !railCollapsed;
    setRailCollapsed(next);
    commitShellPrefs({ sidebar: sidebarCollapsed, rail: next });
  }, [sidebarCollapsed, railCollapsed, commitShellPrefs]);

  // Restore window geometry ONCE on the first app-config load (ADR-0038).
  useEffect(() => {
    if (!appConfig || geometryRestoredRef.current) return;
    const win = safeMainWindow();
    if (!win) return;
    geometryRestoredRef.current = true;
    const { width, height, x, y, maximized } = appConfig.window;
    if (maximized) {
      void win.maximize().catch((e) => {
        log.warn("geometry", "restore failed (maximize)", e);
      });
    } else {
      void win
        .setSize(new LogicalSize(width, height))
        .then(async () => {
          if (x !== null && y !== null) {
            await win.setPosition(new LogicalPosition(x, y)).catch((e) => {
              log.warn("geometry", "restore failed (setPosition)", e);
            });
          }
        })
        .catch((e) => {
          log.warn("geometry", "restore failed (setSize)", e);
        });
    }
  }, [appConfig]);

  // Restore shell collapse prefs ONCE on the first app-config load (ADR-0038 /
  // 0054, issue #84). Mirrors geometryRestoredRef: a one-shot so a later
  // app-config write (e.g. a toggle's own commit) does not re-clobber the
  // user's in-session state with the persisted value.
  useEffect(() => {
    if (!appConfig || collapseRestoredRef.current) return;
    collapseRestoredRef.current = true;
    setSidebarCollapsed(appConfig.shell.sidebar_collapsed);
    setRailCollapsed(appConfig.shell.rail_collapsed);
  }, [appConfig]);

  // Persist window geometry on resize/move, debounced (ADR-0038).
  useEffect(() => {
    const win = safeMainWindow();
    if (!win) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      Promise.all([win.innerSize(), win.outerPosition(), win.isMaximized()])
        .then(([size, pos, maximized]) => {
          const base = appConfigRef.current;
          if (!base) return;
          void commitAppConfig({
            ...base,
            window: {
              width: size.width,
              height: size.height,
              x: pos.x,
              y: pos.y,
              maximized,
            },
          }).catch((e) => {
            log.warn("geometry", "persist failed", e);
          });
        })
        .catch(() => {});
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 500);
    };
    const unresizedP = win.onResized(schedule).catch((e) => {
      log.warn("geometry", "onResized subscription failed", e);
      return () => {};
    });
    const unmovedP = win.onMoved(schedule).catch((e) => {
      log.warn("geometry", "onMoved subscription failed", e);
      return () => {};
    });
    return () => {
      if (timer) clearTimeout(timer);
      void unresizedP.then((un) => un()).catch(() => {});
      void unmovedP.then((un) => un()).catch(() => {});
    };
  }, [commitAppConfig]);

  return {
    appConfig,
    effectiveLocale,
    intl,
    commitAppConfig,
    switchActiveProfile,
    switchActiveProfileModel,
    sidebarCollapsed,
    railCollapsed,
    toggleSidebarCollapse,
    toggleRailCollapse,
  };
}
