import { useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Monitor, Moon, Sun } from "lucide-react";
import {
  clearApiKey,
  fmtError,
  getProviderConfig,
  setApiKey,
} from "../api";
import type {
  AppConfig,
  EngineDefaults,
  LocalePreference,
  ProviderConfig,
  ProviderProfile,
  Theme,
} from "../types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

// App-level settings (issue #53, ADR-0038): edits the app-config document
// (theme, locale, engine defaults, endpoint baseURL/model) in one atomic write,
// plus the API key which stays in the OS keychain (ADR-0029 -- never in
// app-config, never returned across IPC). The key field clears after a save (the
// stored status surfaces as a boolean); the endpoint + theme + locale + engine
// fields retain their values so the user can re-edit.
//
// i18n (ADR-0052, issue #78): this dialog is the canonical showcase of layer-1
// chrome translation. Every FormattedMessage carries an English defaultMessage
// (the formatjs source-of-truth + dev fallback) so @formatjs/cli extract can
// statically resolve the catalog key set for the CI alignment guard.
//
// The shell is now a Radix Dialog (issue #105): portal + focus-trap + scroll-
// lock + ESC + overlay-click come from the primitive, replacing the hand-
// written overlay div + window keydown listener. The form controls migrated to
// shadcn copy-in primitives (Input / Label / RadioGroup / Button) per the issue;
// every settings.* FormattedMessage id + defaultMessage is preserved verbatim so
// the i18n catalogs stay aligned. The busy-guarded dismiss survives:
// onEscapeKeyDown / onInteractOutside cancel the close mid-load/mid-save.
export function SettingsDialog({
  appConfig,
  onCommitAppConfig,
  onClose,
}: {
  // The current app-config (loaded by the parent on mount). Edited locally and
  // committed as one atomic write on save.
  appConfig: AppConfig;
  // Persist the edited app-config. The parent keeps its state + the disk in
  // sync; this dialog does not call setAppConfig directly.
  onCommitAppConfig: (cfg: AppConfig) => Promise<void> | void;
  // Called when the user closes the dialog OR a save/clear succeeds. The parent
  // uses it to both unmount the dialog and refresh its key-status indicator.
  onClose: () => void;
}) {
  const intl = useIntl();
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

  const busy = loading || saving;

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => {
          if (busy) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (busy) e.preventDefault();
        }}
        className="max-h-[85vh] overflow-y-auto sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>
            <FormattedMessage id="settings.title" defaultMessage="App Settings" />
          </DialogTitle>
          <DialogDescription>
            <FormattedMessage
              id="settings.intro"
              defaultMessage="Preferences and defaults live in the system app-data directory (orthogonal to the shareable .duck); the API key lives only in this machine's OS keychain, read by the Rust core — the frontend and page never hold it, and it is never written to app-config."
            />
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="text-muted-foreground">
            <FormattedMessage id="settings.reading" defaultMessage="Reading current config…" />
          </p>
        ) : (
          <div className="grid gap-5">
            <section className="grid gap-2">
              <Label>
                <FormattedMessage id="settings.apiKeyLabel" defaultMessage="Anthropic API key:" />
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKeyField(e.target.value)}
                  placeholder={
                    hasKey
                      ? intl.formatMessage({
                          id: "settings.apiKeyPlaceholderSet",
                          defaultMessage: "Saved (leave blank to keep as-is)",
                        })
                      : intl.formatMessage({
                          id: "settings.apiKeyPlaceholderUnset",
                          defaultMessage: "Paste your Anthropic API key",
                        })
                  }
                  disabled={saving}
                  autoComplete="off"
                />
              </Label>
              <p className="text-muted-foreground text-sm">
                {hasKey ? (
                  <FormattedMessage
                    id="settings.apiKeyHintHas"
                    defaultMessage="A key is currently saved. Leave blank on save to keep it unchanged; you can click &quot;Clear key&quot; below."
                  />
                ) : (
                  <FormattedMessage
                    id="settings.apiKeyHintMissing"
                    defaultMessage='No key configured yet — asking will return a "not configured" failure.'
                  />
                )}
              </p>
            </section>

            <section className="grid gap-2">
              <Label>
                <FormattedMessage
                  id="settings.baseUrlLabel"
                  defaultMessage="Endpoint base URL (optional, Anthropic direct by default):"
                />
                <Input
                  type="text"
                  value={activeProfile.base_url}
                  onChange={(e) => updateActiveProfile({ base_url: e.target.value })}
                  disabled={saving}
                />
              </Label>
              <Label>
                <FormattedMessage id="settings.modelLabel" defaultMessage="Model (Sonnet-class by default):" />
                <Input
                  type="text"
                  value={activeProfile.model}
                  onChange={(e) => updateActiveProfile({ model: e.target.value })}
                  disabled={saving}
                />
              </Label>
              <p className="text-muted-foreground text-sm">
                <FormattedMessage
                  id="settings.endpointHint"
                  defaultMessage="If you use a self-hosted Anthropic-protocol-compatible gateway, put it in base URL; the payload goes through that gateway, and its retention/training policy is your responsibility."
                />
              </p>
            </section>

            <fieldset className="grid gap-2 border-0 p-0 m-0">
              <legend className="text-sm font-medium">
                <FormattedMessage id="settings.theme.legend" defaultMessage="Theme" />
              </legend>
              <RadioGroup
                value={theme}
                onValueChange={(v) => setTheme(v as Theme)}
                disabled={saving}
                className="gap-2"
              >
                {(["system", "light", "dark"] as const).map((t) => {
                  // Lucide glyphs: system=Monitor, light=Sun, dark=Moon (a
                  // theme-radio UX choice; not in ADR-0050's glyph table).
                  // Decorative -- the radio's accessible name is the text label.
                  const Icon = t === "system" ? Monitor : t === "light" ? Sun : Moon;
                  return (
                    <div key={t} className="flex items-center gap-2">
                      <RadioGroupItem id={`settings-theme-${t}`} value={t} />
                      <Label htmlFor={`settings-theme-${t}`} className="font-normal">
                        <Icon size={16} aria-hidden />
                        {t === "system" ? (
                          <FormattedMessage id="settings.theme.system" defaultMessage="Follow system" />
                        ) : t === "light" ? (
                          <FormattedMessage id="settings.theme.light" defaultMessage="Light" />
                        ) : (
                          <FormattedMessage id="settings.theme.dark" defaultMessage="Dark" />
                        )}
                      </Label>
                    </div>
                  );
                })}
              </RadioGroup>
            </fieldset>

            {/* Locale radio (ADR-0052, issue #78). Three-state, mirrors the theme
                toggle above -- system follows the OS language; zh-CN / en-US are
                explicit overrides persisted to app-config (ADR-0038). */}
            <fieldset className="grid gap-2 border-0 p-0 m-0">
              <legend className="text-sm font-medium">
                <FormattedMessage id="settings.locale.legend" defaultMessage="Language" />
              </legend>
              <RadioGroup
                value={locale}
                onValueChange={(v) => setLocale(v as LocalePreference)}
                disabled={saving}
                className="gap-2"
              >
                {(["system", "zh-CN", "en-US"] as const).map((l) => (
                  <div key={l} className="flex items-center gap-2">
                    <RadioGroupItem id={`settings-locale-${l}`} value={l} />
                    <Label htmlFor={`settings-locale-${l}`} className="font-normal">
                      {l === "system" ? (
                        <FormattedMessage id="settings.locale.system" defaultMessage="Follow system" />
                      ) : l === "zh-CN" ? (
                        <FormattedMessage id="settings.locale.zhCN" defaultMessage="简体中文" />
                      ) : (
                        <FormattedMessage id="settings.locale.enUS" defaultMessage="English" />
                      )}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
              <p className="text-muted-foreground text-sm">
                <FormattedMessage
                  id="settings.locale.hint"
                  defaultMessage="Switching the language only affects new turns going forward; past turns keep the language they were generated in (ADR-0039 verbatim principle)."
                />
              </p>
            </fieldset>

            <fieldset className="grid gap-2 border-0 p-0 m-0">
              <legend className="text-sm font-medium">
                <FormattedMessage id="settings.engine.legend" defaultMessage="Engine defaults (ADR-0005)" />
              </legend>
              <Label>
                <FormattedMessage id="settings.engine.memoryLimit" defaultMessage="Memory limit:" />
                <Input
                  type="text"
                  value={engine.memory_limit}
                  onChange={(e) => setEngine({ ...engine, memory_limit: e.target.value })}
                  disabled={saving}
                  placeholder="512MB"
                />
              </Label>
              <Label>
                <FormattedMessage id="settings.engine.threads" defaultMessage="Threads:" />
                <Input
                  type="number"
                  min={1}
                  value={engine.threads}
                  onChange={(e) =>
                    setEngine({ ...engine, threads: Math.max(1, Number(e.target.value) || 1) })}
                  disabled={saving}
                />
              </Label>
              <Label>
                <FormattedMessage id="settings.engine.rowCap" defaultMessage="Result row cap:" />
                <Input
                  type="number"
                  min={1}
                  value={engine.row_cap}
                  onChange={(e) =>
                    setEngine({ ...engine, row_cap: Math.max(1, Number(e.target.value) || 1) })}
                  disabled={saving}
                />
              </Label>
              <Label>
                <FormattedMessage
                  id="settings.engine.statementTimeout"
                  defaultMessage="Statement timeout (ms):"
                />
                <Input
                  type="number"
                  min={1}
                  value={engine.statement_timeout_ms}
                  onChange={(e) =>
                    setEngine({
                      ...engine,
                      statement_timeout_ms: Math.max(1, Number(e.target.value) || 1),
                    })}
                  disabled={saving}
                />
              </Label>
              <p className="text-muted-foreground text-sm">
                <FormattedMessage
                  id="settings.engine.hint"
                  defaultMessage="This slice persists and restores these values across restarts; applying them to the live DuckDB engine is a follow-up slice."
                />
              </p>
            </fieldset>
          </div>
        )}

        {error && <p className="text-destructive text-sm">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            <FormattedMessage id="settings.cancel" defaultMessage="Cancel" />
          </Button>
          {hasKey && (
            <Button variant="destructive" onClick={clearKey} disabled={busy}>
              <FormattedMessage id="settings.clearKey" defaultMessage="Clear key" />
            </Button>
          )}
          <Button onClick={save} disabled={busy}>
            {saving ? (
              <FormattedMessage id="settings.saving" defaultMessage="Saving…" />
            ) : (
              <FormattedMessage id="settings.save" defaultMessage="Save" />
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
