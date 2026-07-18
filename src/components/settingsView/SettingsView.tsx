import { useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { ArrowLeft } from "lucide-react";

import { clearApiKey, fmtError, getProviderConfig, setApiKey } from "../../api";
import type {
  AppConfig,
  EngineDefaults,
  LocalePreference,
  ProviderConfig,
  ProviderProfile,
  Theme,
} from "../../types";
import { Button } from "../ui/button";
import { EngineSection } from "./EngineSection";
import { GeneralSection } from "./GeneralSection";
import { PrivacySection } from "./PrivacySection";
import { ProfilesPlaceholder } from "./ProfilesPlaceholder";
import { SETTINGS_SECTIONS, type SettingsForm, type SettingsSection } from "./sections";

// In-app overlay settings view (ADR-0065, issue #151). Replaces the modal
// SettingsDialog: while settingsOpen is true the shell renders <SettingsView/>
// instead of <SessionShell/>, covering the grid (non-modal, no mask -- it IS
// the current view). The view owns its header (‹ Back to app + Settings title),
// a left section nav (General / Profiles / Engine / Privacy), the active
// section's content on the right, and a footer with the global Save / Cancel /
// Clear-key actions. session sidebar + topbar + the keep-alive session panes
// stay mounted (display:none) underneath so App state and any in-flight turn
// survive the round trip. Entry: topbar gear (settingsOpen=true). Exit: ‹ Back
// or ESC (settingsOpen=false).
//
// This slice migrates the EXISTING preferences verbatim (ADR-0065: only the
// form factor changes): theme / locale / engine + the API-key + endpoint fields
// stay editable on the General pane while the Profiles pane is a placeholder
// (the endpoint + key move into per-profile management in a later slice). Radix
// Dialog is no longer used for settings; AlertDialog remains available for
// future delete-profile confirmations.

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
// exhaustiveness guard: a new SettingsSection value fails to compile here
// (never is not assignable) and throws at runtime, so the render branch set
// cannot silently drift out of sync with the union -- a bare
// `{section === "x" && ...}` ladder would compile-fail-free on a new id and
// render an empty pane.
function SectionContent({
  section,
  form,
}: {
  section: SettingsSection;
  form: SettingsForm;
}) {
  switch (section) {
    case "general":
      return <GeneralSection form={form} />;
    case "profiles":
      return <ProfilesPlaceholder />;
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
  // Called on ‹ Back / Cancel / Save / Clear-key success / ESC. The parent
  // uses it to both unmount the view and refresh its key-status indicator.
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

  // The endpoint inputs edit the ACTIVE profile (ADR-0064). Falls back to the
  // first profile when active_profile is dangling (normalize repairs on save;
  // the UI never hands the user a dead endpoint to type into).
  const activeProfile =
    provider.profiles.find((p) => p.id === provider.active_profile) ??
    provider.profiles[0];

  // Patch the active profile's fields, immutably (coding-style: never mutate).
  function updateActiveProfile(patch: Partial<ProviderProfile>) {
    setProvider({
      ...provider,
      profiles: provider.profiles.map((p) =>
        p.id === provider.active_profile ? { ...p, ...patch } : p,
      ),
    });
  }

  // The key never enters app-config (ADR-0029/0038): it is collected here only
  // to forward once to the keychain. An empty field means "leave the stored key
  // as-is"; `hasKey` reflects the stored status as a boolean, never the value.
  const [apiKey, setApiKeyField] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the key status on open (the only piece NOT in app-config). Endpoint /
  // theme / locale / engine are seeded from the prop, so no extra fetch is needed.
  useEffect(() => {
    let cancelled = false;
    getProviderConfig()
      .then((cfg) => {
        if (cancelled) return;
        setHasKey(cfg.has_key);
      })
      .catch((e) => {
        if (!cancelled) setError(fmtError(e, intl));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [intl]);

  const busy = loading || saving;

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
  // add/remove churn on every App render). A busy state (loading/saving) bails
  // so an in-flight atomic app-config write cannot be torn; otherwise ESC
  // closes the view. (Same-element listeners all fire regardless of
  // preventDefault, so the busy guard is the real gate, not event suppression.)
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (busyRef.current) {
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
      // The key is sent only when the user typed one -- an empty field means
      // "leave the stored key as-is" (the user is editing config only).
      const trimmedKey = apiKey.trim();
      if (trimmedKey) {
        await setApiKey(trimmedKey);
        setHasKey(true);
      }
      // One atomic app-config write carries theme + locale + engine + endpoint.
      await onCommitAppConfig({
        ...appConfig,
        theme,
        locale,
        engine,
        provider,
      });
      setApiKeyField(""); // never retain the key in component state after save
      onClose();
    } catch (e) {
      setError(fmtError(e, intl));
    } finally {
      setSaving(false);
    }
  }

  async function clearKey() {
    setSaving(true);
    setError(null);
    try {
      await clearApiKey();
      setHasKey(false);
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
    apiKey,
    setApiKey: setApiKeyField,
    hasKey,
    activeProfile,
    updateActiveProfile,
    saving,
  };

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="false"
      aria-labelledby="settings-view-title"
      className="settings-overlay"
    >
      <header className="settings-header">
        <Button
          type="button"
          variant="ghost"
          className="settings-back"
          onClick={onClose}
          disabled={busy}
        >
          <ArrowLeft size={16} aria-hidden />
          <FormattedMessage id="settings.backToApp" defaultMessage="‹ Back to app" />
        </Button>
        <h2 id="settings-view-title" className="settings-title">
          <FormattedMessage id="settings.title" defaultMessage="App Settings" />
        </h2>
      </header>

      <nav className="settings-nav" aria-label="Settings sections">
        {SETTINGS_SECTIONS.map((s) => (
          <button
            key={s}
            type="button"
            className="settings-nav-button"
            aria-current={section === s ? "page" : undefined}
            onClick={() => setSection(s)}
          >
            <SectionLabel section={s} />
          </button>
        ))}
      </nav>

      <main className="settings-content">
        {/* Active section heading: same label the nav button shows (mirrors the
            catalog entry via SectionLabel, so a static id literal still drives
            formatjs extract). */}
        <h3 className="settings-section-heading">
          <SectionLabel section={section} />
        </h3>
        {loading ? (
          <p className="text-muted-foreground">
            <FormattedMessage id="settings.reading" defaultMessage="Reading current config…" />
          </p>
        ) : (
          <SectionContent section={section} form={form} />
        )}
        {error && <p className="settings-error text-destructive text-sm">{error}</p>}
      </main>

      <footer className="settings-footer">
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          <FormattedMessage id="settings.cancel" defaultMessage="Cancel" />
        </Button>
        {hasKey && (
          <Button type="button" variant="destructive" onClick={clearKey} disabled={busy}>
            <FormattedMessage id="settings.clearKey" defaultMessage="Clear key" />
          </Button>
        )}
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
