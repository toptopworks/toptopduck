import { useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Monitor, Moon, Sun } from "lucide-react";
import {
  clearApiKey,
  fmtError,
  getProviderConfig,
  setApiKey,
} from "../api";
import type { AppConfig, EngineDefaults, LocalePreference, ProviderConfig, Theme } from "../types";

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
        if (!cancelled) setError(fmtError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ESC closes (a11y); disabled during the initial load so a slow config read
  // can't be interrupted before the fields are populated.
  useEffect(() => {
    if (loading || saving) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loading, saving, onClose]);

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
      setError(fmtError(e));
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
      setError(fmtError(e));
    } finally {
      setSaving(false);
    }
  }

  const busy = loading || saving;

  return (
    <div className="dialog-overlay">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <h2 id="settings-title">
          <FormattedMessage id="settings.title" defaultMessage="App Settings" />
        </h2>
        <p className="muted">
          <FormattedMessage
            id="settings.intro"
            defaultMessage="Preferences and defaults live in the system app-data directory (orthogonal to the shareable .duck); the API key lives only in this machine's OS keychain, read by the Rust core — the frontend and page never hold it, and it is never written to app-config."
          />
        </p>

        {loading ? (
          <p className="muted">
            <FormattedMessage id="settings.reading" defaultMessage="Reading current config…" />
          </p>
        ) : (
          <>
            <section>
              <label>
                <FormattedMessage id="settings.apiKeyLabel" defaultMessage="Anthropic API key:" />{" "}
                <input
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
              </label>
              <p className="muted">
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

            <section>
              <label>
                <FormattedMessage
                  id="settings.baseUrlLabel"
                  defaultMessage="Endpoint base URL (optional, Anthropic direct by default):"
                />{" "}
                <input
                  type="text"
                  value={provider.base_url}
                  onChange={(e) => setProvider({ ...provider, base_url: e.target.value })}
                  disabled={saving}
                />
              </label>
              <label>
                <FormattedMessage id="settings.modelLabel" defaultMessage="Model (Sonnet-class by default):" />{" "}
                <input
                  type="text"
                  value={provider.model}
                  onChange={(e) => setProvider({ ...provider, model: e.target.value })}
                  disabled={saving}
                />
              </label>
              <p className="muted">
                <FormattedMessage
                  id="settings.endpointHint"
                  defaultMessage="If you use a self-hosted Anthropic-protocol-compatible gateway, put it in base URL; the payload goes through that gateway, and its retention/training policy is your responsibility."
                />
              </p>
            </section>

            <section>
              <fieldset>
                <legend>
                  <FormattedMessage id="settings.theme.legend" defaultMessage="Theme" />
                </legend>
                {(["system", "light", "dark"] as const).map((t) => {
                  // Lucide glyphs: system=Monitor, light=Sun, dark=Moon (a
                  // theme-radio UX choice; not in ADR-0050's glyph table).
                  // Decorative -- the radio's accessible name is the text label.
                  const Icon = t === "system" ? Monitor : t === "light" ? Sun : Moon;
                  return (
                    <label key={t}>
                      <input
                        type="radio"
                        name="theme"
                        checked={theme === t}
                        onChange={() => setTheme(t)}
                        disabled={saving}
                      />
                      <Icon size={16} aria-hidden />
                      {t === "system" ? (
                        <FormattedMessage id="settings.theme.system" defaultMessage="Follow system" />
                      ) : t === "light" ? (
                        <FormattedMessage id="settings.theme.light" defaultMessage="Light" />
                      ) : (
                        <FormattedMessage id="settings.theme.dark" defaultMessage="Dark" />
                      )}
                    </label>
                  );
                })}
              </fieldset>
            </section>

            {/* Locale radio (ADR-0052, issue #78). Three-state, mirrors the theme
                toggle above -- system follows the OS language; zh-CN / en-US are
                explicit overrides persisted to app-config (ADR-0038). */}
            <section>
              <fieldset>
                <legend>
                  <FormattedMessage id="settings.locale.legend" defaultMessage="Language" />
                </legend>
                {(["system", "zh-CN", "en-US"] as const).map((l) => (
                  <label key={l}>
                    <input
                      type="radio"
                      name="locale"
                      checked={locale === l}
                      onChange={() => setLocale(l)}
                      disabled={saving}
                    />
                    {l === "system" ? (
                      <FormattedMessage id="settings.locale.system" defaultMessage="Follow system" />
                    ) : l === "zh-CN" ? (
                      <FormattedMessage id="settings.locale.zhCN" defaultMessage="简体中文" />
                    ) : (
                      <FormattedMessage id="settings.locale.enUS" defaultMessage="English" />
                    )}
                  </label>
                ))}
              </fieldset>
              <p className="muted">
                <FormattedMessage
                  id="settings.locale.hint"
                  defaultMessage="Switching the language only affects new turns going forward; past turns keep the language they were generated in (ADR-0039 verbatim principle)."
                />
              </p>
            </section>

            <section>
              <fieldset>
                <legend>
                  <FormattedMessage id="settings.engine.legend" defaultMessage="Engine defaults (ADR-0005)" />
                </legend>
                <label>
                  <FormattedMessage id="settings.engine.memoryLimit" defaultMessage="Memory limit:" />{" "}
                  <input
                    type="text"
                    value={engine.memory_limit}
                    onChange={(e) => setEngine({ ...engine, memory_limit: e.target.value })}
                    disabled={saving}
                    placeholder="512MB"
                  />
                </label>
                <label>
                  <FormattedMessage id="settings.engine.threads" defaultMessage="Threads:" />{" "}
                  <input
                    type="number"
                    min={1}
                    value={engine.threads}
                    onChange={(e) =>
                      setEngine({ ...engine, threads: Math.max(1, Number(e.target.value) || 1) })}
                    disabled={saving}
                  />
                </label>
                <label>
                  <FormattedMessage id="settings.engine.rowCap" defaultMessage="Result row cap:" />{" "}
                  <input
                    type="number"
                    min={1}
                    value={engine.row_cap}
                    onChange={(e) =>
                      setEngine({ ...engine, row_cap: Math.max(1, Number(e.target.value) || 1) })}
                    disabled={saving}
                  />
                </label>
                <label>
                  <FormattedMessage
                    id="settings.engine.statementTimeout"
                    defaultMessage="Statement timeout (ms):"
                  />{" "}
                  <input
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
                </label>
              </fieldset>
              <p className="muted">
                <FormattedMessage
                  id="settings.engine.hint"
                  defaultMessage="This slice persists and restores these values across restarts; applying them to the live DuckDB engine is a follow-up slice."
                />
              </p>
            </section>
          </>
        )}

        {error && <p className="error">{error}</p>}

        <div className="dialog-actions">
          <button onClick={onClose} disabled={busy}>
            <FormattedMessage id="settings.cancel" defaultMessage="Cancel" />
          </button>
          {hasKey && (
            <button onClick={clearKey} disabled={busy}>
              <FormattedMessage id="settings.clearKey" defaultMessage="Clear key" />
            </button>
          )}
          <button onClick={save} disabled={busy}>
            {saving ? (
              <FormattedMessage id="settings.saving" defaultMessage="Saving…" />
            ) : (
              <FormattedMessage id="settings.save" defaultMessage="Save" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
