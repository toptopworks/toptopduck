import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import {
  clearApiKey,
  fmtError,
  getProviderConfig,
  setApiKey,
} from "../api";
import type { AppConfig, EngineDefaults, ProviderConfig, Theme } from "../types";

// App-level settings (issue #53, ADR-0038): edits the app-config document
// (theme, engine defaults, endpoint baseURL/model) in one atomic write, plus
// the API key which stays in the OS keychain (ADR-0029 -- never in app-config,
// never returned across IPC). The key field clears after a save (the stored
// status surfaces as a boolean); the endpoint + theme + engine fields retain
// their values so the user can re-edit.
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
  // Local editable copies seeded from the app-config prop. A save commits them
  // as one atomic write; a cancel discards them.
  const [theme, setTheme] = useState<Theme>(appConfig.theme);
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
  // theme / engine are seeded from the prop, so no extra fetch is needed.
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
      // One atomic app-config write carries theme + engine + endpoint together.
      await onCommitAppConfig({
        ...appConfig,
        theme,
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
        <h2 id="settings-title">应用设置</h2>
        <p className="muted">
          偏好与默认参数存在系统 app-data 目录（与可分享的 .duck 正交）；API key 仅存在本机系统钥匙串，由 Rust 核心读取，前端与页面永不持有，也绝不写入 app-config。
        </p>

        {loading ? (
          <p className="muted">正在读取当前配置…</p>
        ) : (
          <>
            <section>
              <label>
                Anthropic API key：
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKeyField(e.target.value)}
                  placeholder={hasKey ? "已保存（留空则不修改）" : "粘贴你的 Anthropic API key"}
                  disabled={saving}
                  autoComplete="off"
                />
              </label>
              <p className="muted">
                {hasKey
                  ? "当前已保存 key。留空保存即保持不变；可点击下方「清除 key」。"
                  : "尚未配置 key——提问将返回「未配置」失败。"}
              </p>
            </section>

            <section>
              <label>
                Endpoint base URL（可配，默认 Anthropic 直连）：
                <input
                  type="text"
                  value={provider.base_url}
                  onChange={(e) => setProvider({ ...provider, base_url: e.target.value })}
                  disabled={saving}
                />
              </label>
              <label>
                模型（默认 Sonnet 级）：
                <input
                  type="text"
                  value={provider.model}
                  onChange={(e) => setProvider({ ...provider, model: e.target.value })}
                  disabled={saving}
                />
              </label>
              <p className="muted">
                若你使用自有 Anthropic 协议兼容网关，填在 base URL；载荷将经过该网关，其留存/训练政策由你自负。
              </p>
            </section>

            <section>
              <fieldset>
                <legend>主题</legend>
                {(["system", "light", "dark"] as const).map((t) => {
                  // Lucide glyphs (ADR-0050): system=Monitor, light=Sun, dark=Moon.
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
                      {t === "system" ? "跟随系统" : t === "light" ? "浅色" : "深色"}
                    </label>
                  );
                })}
              </fieldset>
            </section>

            <section>
              <fieldset>
                <legend>引擎默认参数（ADR-0005）</legend>
                <label>
                  内存上限：
                  <input
                    type="text"
                    value={engine.memory_limit}
                    onChange={(e) => setEngine({ ...engine, memory_limit: e.target.value })}
                    disabled={saving}
                    placeholder="512MB"
                  />
                </label>
                <label>
                  线程数：
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
                  结果行数上限：
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
                  语句超时（毫秒）：
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
                本切片先持久化并跨启动恢复这些值；将其应用到 live DuckDB 引擎是后续切片。
              </p>
            </section>
          </>
        )}

        {error && <p className="error">{error}</p>}

        <div className="dialog-actions">
          <button onClick={onClose} disabled={busy}>
            取消
          </button>
          {hasKey && (
            <button onClick={clearKey} disabled={busy}>
              清除 key
            </button>
          )}
          <button onClick={save} disabled={busy}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
