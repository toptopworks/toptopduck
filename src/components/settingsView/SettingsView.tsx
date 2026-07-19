import { useCallback, useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { ArrowLeft } from "lucide-react";

import { fmtError } from "../../api";
import type {
  AppConfig,
  EngineDefaults,
  LocalePreference,
  ProviderConfig,
  ProviderProfile,
  Theme,
} from "../../types";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { EngineSection } from "./EngineSection";
import { GeneralSection } from "./GeneralSection";
import { ProfilesSection, type ProfilesSectionProps } from "./ProfilesSection";
import { PrivacySection } from "./PrivacySection";
import { SETTINGS_SECTIONS, type SettingsForm, type SettingsSection } from "./sections";

// In-app overlay settings view (ADR-0065, issue #151/#153). While settingsOpen
// is true the shell renders <SettingsView/> instead of <SessionShell/>,
// covering the grid (non-modal, no mask -- it IS the current view). The view
// owns its header (‹ Back to app + Settings title), a left section nav
// (General / Profiles / Engine / Privacy), the active section's content on the
// right, and a footer with the global Save / Cancel actions. session sidebar +
// topbar + the keep-alive session panes stay mounted (display:none) underneath
// so App state and any in-flight turn survive the round trip. Entry: topbar
// gear (settingsOpen=true). Exit: ‹ Back or ESC (settingsOpen=false).
//
// Issue #153: the API-key + endpoint fields moved OUT of General into the
// Profiles pane (per-profile management, ADR-0064). Save now commits only
// theme + locale + engine + the provider config (profiles list + active id);
// per-profile key set/clear is immediate IPC inside ProfilesSection (the key
// never rides the app-config write, ADR-0029/0038).

// Mirror of the Rust DEFAULT_PROVIDER_BASE_URL / DEFAULT_PROVIDER_MODEL
// (src-tauri/src/model.rs). A freshly-created profile seeds from these so the
// edit form shows a sensible anthropic endpoint before the first save (the
// backend's normalize would otherwise clamp empties to the same values on
// save). Kept in sync with the Rust constants; drift here only affects the new-
// profile skeleton default, not stored configs.
const NEW_PROFILE_DEFAULT_BASE_URL = "https://api.anthropic.com";
const NEW_PROFILE_DEFAULT_MODEL = "claude-sonnet-4-6";

/** Mint a fresh, stable, opaque profile id (ADR-0064). UUID v4 via the Web
 *  Crypto API (available in the Tauri webview's secure context). The id is the
 *  keychain account suffix (`key-<id>`); callers must not assume structure. */
function newProfileId(): string {
  return crypto.randomUUID();
}

// Renders the label for one settings section. Each case is a STATIC
// <FormattedMessage id="..." defaultMessage="..." /> literal so @formatjs/cli
// extract can statically resolve every settings.nav.* id (ADR-0052: a variable
// id or a helper returning {id} would break the i18n:check CI gate). The
// SETTINGS_SECTIONS array drives ORDER + state only; the rendered text comes
// from this switch.
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
      // Exhaustiveness guard: a future SettingsSection value fails to compile
      // here (never is not assignable to a new case) and throws at runtime.
      const _exhaustive: never = section;
      throw new Error(`Unknown settings section: ${String(_exhaustive)}`);
    }
  }
}

// Renders the active section's content pane. Mirrors SectionLabel's
// exhaustiveness guard. The Profiles case takes its own prop slice
// (ProfilesSectionProps) rather than the shared SettingsForm, so the General /
// Engine panes stay free of profile entanglement (issue #153).
function SectionContent({
  section,
  form,
  profilesProps,
}: {
  section: SettingsSection;
  form: SettingsForm;
  profilesProps: ProfilesSectionProps;
}) {
  switch (section) {
    case "general":
      return <GeneralSection form={form} />;
    case "profiles":
      return <ProfilesSection {...profilesProps} />;
    case "engine":
      return <EngineSection form={form} />;
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
}: {
  // The current app-config (loaded by the parent). Edited locally and committed
  // as one atomic write on save.
  appConfig: AppConfig;
  // Persist the edited app-config. The parent keeps its state + the disk in
  // sync; this view does not call setAppConfig directly.
  onCommitAppConfig: (cfg: AppConfig) => Promise<void> | void;
  // Called on ‹ Back / Cancel / Save / ESC. The parent uses it to both unmount
  // the view and refresh its key-status indicator.
  onClose: () => void;
}) {
  const intl = useIntl();
  const [section, setSection] = useState<SettingsSection>("general");
  // Local editable copies seeded from the app-config prop. A save commits them
  // as one atomic write; a cancel discards them.
  const [theme, setTheme] = useState<Theme>(appConfig.theme);
  const [locale, setLocale] = useState<LocalePreference>(appConfig.locale);
  const [engine, setEngine] = useState<EngineDefaults>(appConfig.engine);
  const [provider, setProvider] = useState<ProviderConfig>(appConfig.provider);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Provider mutators (issue #153, ADR-0064) ------------------------------
  // All immutable (coding-style: never mutate). Profile LIST + active id land
  // on Save as part of the atomic app-config write; per-profile key set/clear
  // is separate immediate IPC inside ProfilesSection.

  const updateProfile = useCallback(
    (id: string, patch: Partial<ProviderProfile>) => {
      setProvider((prev) => ({
        ...prev,
        profiles: prev.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      }));
    },
    [],
  );

  const createProfile = useCallback((): string => {
    // Mint a fresh id + an anthropic-protocol skeleton. Returns the id so the
    // Profiles pane can auto-select the new profile for editing.
    const id = newProfileId();
    const profile: ProviderProfile = {
      id,
      display_name: "",
      protocol: "anthropic",
      base_url: NEW_PROFILE_DEFAULT_BASE_URL,
      model: NEW_PROFILE_DEFAULT_MODEL,
    };
    setProvider((prev) => ({ ...prev, profiles: [...prev.profiles, profile] }));
    return id;
  }, []);

  const deleteProfile = useCallback((id: string) => {
    // Local removal only (committed on Save). The profile's keychain entry
    // (`key-<id>`) is left in place -- ADR-0064 sanctions the orphan as
    // harmless (the id is never referenced again). normalize repairs an empty
    // profiles list / dangling active id on Save.
    setProvider((prev) => ({
      ...prev,
      profiles: prev.profiles.filter((p) => p.id !== id),
    }));
  }, []);

  const setActiveProfile = useCallback((id: string) => {
    setProvider((prev) => ({ ...prev, active_profile: id }));
  }, []);

  // Close-blocker ref fed by the Profiles pane (issue #153 review): while a
  // per-profile key IPC is in flight, ESC / Back / Cancel must not unmount the
  // pane -- the returned has_key would land on an unmounted component and a
  // failure would never reach the user (ADR-0029 trust root). A ref (not state)
  // so the ESC handler reads it without re-subscribing the window listener.
  const profileBlockingRef = useRef(false);
  const handleProfilesBusyChange = useCallback((busy: boolean) => {
    profileBlockingRef.current = busy;
  }, []);

  // Focus management (ADR-0065 accessibility). On enter, remember the trigger
  // (topbar gear) and move focus onto the overlay's container (tabindex=-1, no
  // ring). On exit, restore focus to the trigger. Radix Dialog used to do this
  // for free; without it we mirror the contract by hand.
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    triggerRef.current = (document.activeElement as HTMLElement | null) ?? null;
    containerRef.current?.focus();
    return () => {
      triggerRef.current?.focus();
    };
  }, []);

  // ESC exit (ADR-0065): preserve the dialog's ESC habit even without a mask.
  // One window-level keydown listener, registered ONCE; busy + onClose are read
  // through refs so the handler identity stays stable across renders (no
  // add/remove churn on every App render). A busy state (saving, or a key IPC
  // in flight inside the Profiles pane) bails so an in-flight atomic app-config
  // write or a one-shot keychain transfer cannot be torn; otherwise ESC closes
  // the view.
  const savingRef = useRef(saving);
  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (savingRef.current || profileBlockingRef.current) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      onCloseRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // One atomic app-config write carries theme + locale + engine + the
      // provider config (profiles list + active id). The key never enters this
      // path (ADR-0029/0038: per-profile key set/clear is separate immediate
      // IPC inside ProfilesSection).
      await onCommitAppConfig({
        ...appConfig,
        theme,
        locale,
        engine,
        provider,
      });
      onClose();
    } catch (e) {
      setError(fmtError(e, intl));
    } finally {
      setSaving(false);
    }
  }

  const form: SettingsForm = {
    theme,
    setTheme,
    locale,
    setLocale,
    engine,
    setEngine,
    saving,
  };

  const profilesProps: ProfilesSectionProps = {
    provider,
    updateProfile,
    createProfile,
    deleteProfile,
    setActiveProfile,
    saving,
    onBusyChange: handleProfilesBusyChange,
  };

  const busy = saving;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="false"
      aria-labelledby="settings-view-title"
      className="settings-overlay bg-background outline-none focus-visible:outline-none"
    >
      <header className="settings-header gap-3 px-4 border-b border-border bg-background">
        <Button
          type="button"
          variant="ghost"
          // Compact chrome narrowing on top of the ghost Button (variant keeps
          // the hover tint): h-8 + py-0 + px-2.5 makes ‹ Back read as a nav
          // arrow, not a CTA. px-2.5 + its svg-variant override the default
          // size's px-4 / has-[>svg]:px-3 so the horizontal chrome stays narrow
          // whether or not the icon renders (ADR-0067 visual-on-token).
          className="settings-back h-8 py-0 px-2.5 has-[>svg]:px-2.5"
          onClick={onClose}
          disabled={busy}
        >
          <ArrowLeft size={16} aria-hidden />
          <FormattedMessage id="settings.backToApp" defaultMessage="‹ Back to app" />
        </Button>
        <h2
          id="settings-view-title"
          className="settings-title m-0 text-base font-semibold"
        >
          <FormattedMessage id="settings.title" defaultMessage="App Settings" />
        </h2>
      </header>

      <nav
        className="settings-nav gap-0.5 p-2 bg-muted border-r border-border"
        aria-label="Settings sections"
      >
        {SETTINGS_SECTIONS.map((s) => (
          <button
            key={s}
            type="button"
            className={cn(
              // [all:unset] strips native <button> chrome so the entry reads as
              // a flat list row; subsequent utilities rebuild the box model over
              // the ADR-0050 token. aria-current carries the active section
              // (issue #170 AC: rendering unchanged) as bg-primary +
              // text-primary-foreground + font-semibold, replacing the retired
              // [aria-current="page"] CSS rule. The focus-visible outline
              // restores the keyboard ring `all: unset` stripped (WCAG 2.4.7).
              "settings-nav-button [all:unset] cursor-pointer py-1.5 px-2.5 rounded-md text-sm text-foreground",
              "hover:bg-accent",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              section === s && "bg-primary text-primary-foreground font-semibold",
            )}
            aria-current={section === s ? "page" : undefined}
            onClick={() => setSection(s)}
          >
            <SectionLabel section={s} />
          </button>
        ))}
      </nav>

      <main className="settings-content p-6 max-w-[1000px]">
        {/* Active section heading: same label the nav button shows (mirrors the
            catalog entry via SectionLabel, so a static id literal still drives
            formatjs extract). */}
        {/* text-[1.05rem] preserves the retired rule's font-size (issue #170
            AC: rendering unchanged) -- no Tailwind scale step matches, so the
            arbitrary value honors it rather than snapping to text-base/lg. */}
        <h3 className="settings-section-heading m-0 mb-4 text-[1.05rem] font-semibold">
          <SectionLabel section={section} />
        </h3>
        <SectionContent section={section} form={form} profilesProps={profilesProps} />
        {error && (
          <p className="settings-error mt-3 text-destructive text-sm">{error}</p>
        )}
      </main>

      <footer className="settings-footer gap-2 px-6 py-3 border-t border-border bg-background">
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          <FormattedMessage id="settings.cancel" defaultMessage="Cancel" />
        </Button>
        <Button type="button" onClick={save} disabled={busy}>
          {saving ? (
            <FormattedMessage id="settings.saving" defaultMessage="Saving…" />
          ) : (
            <FormattedMessage id="settings.save" defaultMessage="Save" />
          )}
        </Button>
      </footer>
    </div>
  );
}
