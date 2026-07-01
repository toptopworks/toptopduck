import { useEffect, useState } from "react";
import {
  clearApiKey,
  fmtError,
  getProviderConfig,
  setApiKey,
  setProviderConfig,
} from "../api";

// v1 defaults mirrored from the Rust `model::DEFAULT_PROVIDER_*` constants
// (ADR-0007/0019). Shown as the initial field values before the server reports
// the stored config; a successful load overwrites them with the effective view.
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MODEL = "claude-sonnet-4-6";

// LLM provider settings (issue #29, ADR-0007/0019/0029): collect the Anthropic
// API key (one-shot frontend -> Rust transfer, stored in the OS keychain) and
// the non-secret endpoint config (base URL + model). The key is never read back
// -- only `has_key` is shown -- so the dialog clears the key field after a save
// and surfaces the stored status as a boolean.
export function SettingsDialog({
  onClose,
}: {
  // Called when the user closes the dialog OR a save/clear succeeds. The parent
  // uses it to both unmount the dialog and refresh its key-status indicator.
  onClose: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [apiKey, setApiKeyField] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the effective config + key status on open.
  useEffect(() => {
    let cancelled = false;
    getProviderConfig()
      .then((cfg) => {
        if (cancelled) return;
        setBaseUrl(cfg.base_url);
        setModel(cfg.model);
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
      }
      const view = await setProviderConfig({ base_url: baseUrl, model });
      setHasKey(view.has_key);
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
        <h2 id="settings-title">LLM 提供方设置</h2>
        <p className="muted">
          数据只发往你配置的 LLM endpoint；API key 仅存在本机系统钥匙串，由 Rust 核心读取并发起调用，前端与页面永不持有。
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
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={DEFAULT_BASE_URL}
                  disabled={saving}
                />
              </label>
              <p className="muted">
                若你使用自有 Anthropic 协议兼容网关，填在此处；载荷将经过该网关，其留存/训练政策由你自负。
              </p>
            </section>

            <section>
              <label>
                模型（默认 Sonnet 级）：
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={DEFAULT_MODEL}
                  disabled={saving}
                />
              </label>
              <p className="muted">
                例如 claude-sonnet-4-6（默认）、claude-opus-4-8、claude-haiku-4-5。
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
