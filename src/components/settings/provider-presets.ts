// Provider preset catalog (issue #235, ADR-0071 Consequences). A preset is a
// ready-made endpoint template the user can apply to a profile instead of
// hand-typing protocol / base_url / model. It is FRONTEND-ONLY data: it never
// enters app-config (ADR-0038 -- a preset is a UI affordance, not a stored
// preference), and the user's choice is not persisted as "which preset" -- the
// applied protocol/base_url/model land on the profile, and the preset is
// re-DERIVED from those fields on every render (see derivePresetId). A profile
// whose base_url no longer matches any preset reads as "Custom".
//
// display_name / get_key_link.host / get_key_link.url / key_placeholder are
// locale-independent by design (ADR-0052 layer 4): provider names are proper
// nouns, the link host/url are addresses, and key_placeholder is a technical
// example token (sk-ant-...). None translate. Translatable copy (field labels,
// hints, the "Get key" link text) lives in the react-intl catalog, not here.
//
// Ollama rides the openai-compatible endpoint (ADR-0064): protocol is "openai",
// the endpoint is the loopback, and it needs no key by default -- hence
// get_key_link is null and key_placeholder is empty (the key field falls back to
// its generic placeholder).

import type { Protocol } from "../../types/provider";

// The link a user follows to obtain a key for a provider (aligns with the
// "Get key" pattern in mainstream BYOK settings panels). host is the short
// display host (no scheme), url is the full landing page.
export interface ProviderPresetGetKeyLink {
  host: string;
  url: string;
}

// One provider preset (issue #235). The id is the catalog key (stable, never
// persisted); display_name is the proper-noun provider name shown as the option
// label; protocol/base_url/default_model are written onto the profile when the
// preset is applied; get_key_link + key_placeholder drive the key field's
// affordances.
export interface ProviderPreset {
  id: string;
  display_name: string;
  protocol: Protocol;
  base_url: string;
  default_model: string;
  // null when the provider needs no key acquisition (Ollama loopback); the key
  // field then omits the "Get key" link.
  get_key_link: ProviderPresetGetKeyLink | null;
  // Example key token shown as the key-input placeholder when this preset is
  // active and no key is set. Empty string falls back to the generic placeholder.
  key_placeholder: string;
}

// The seven provider presets (issue #235). Order is the display order of
// the dropdown options. Anthropic first (the project's default-protocol
// provider), then the openai-compatible clouds, then the Ollama loopback last.
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "anthropic",
    display_name: "Anthropic",
    protocol: "anthropic",
    base_url: "https://api.anthropic.com",
    default_model: "claude-sonnet-4-6",
    get_key_link: {
      host: "console.anthropic.com",
      url: "https://console.anthropic.com/settings/keys",
    },
    key_placeholder: "sk-ant-api03-…",
  },
  {
    id: "openai",
    display_name: "OpenAI",
    protocol: "openai",
    base_url: "https://api.openai.com/v1",
    default_model: "gpt-4o",
    get_key_link: {
      host: "platform.openai.com",
      url: "https://platform.openai.com/api-keys",
    },
    key_placeholder: "sk-proj-…",
  },
  {
    id: "deepseek",
    display_name: "DeepSeek",
    protocol: "openai",
    base_url: "https://api.deepseek.com/v1",
    default_model: "deepseek-chat",
    get_key_link: {
      host: "platform.deepseek.com",
      url: "https://platform.deepseek.com/api_keys",
    },
    key_placeholder: "sk-…",
  },
  {
    id: "glm",
    display_name: "GLM",
    protocol: "openai",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    default_model: "glm-4",
    get_key_link: {
      host: "open.bigmodel.cn",
      url: "https://open.bigmodel.cn/usercenter/apikeys",
    },
    key_placeholder: "",
  },
  {
    id: "qwen",
    display_name: "Qwen",
    protocol: "openai",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    default_model: "qwen-plus",
    get_key_link: {
      host: "dashscope.console.aliyun.com",
      url: "https://dashscope.console.aliyun.com/apiKey",
    },
    key_placeholder: "sk-…",
  },
  {
    id: "moonshot",
    display_name: "Moonshot",
    protocol: "openai",
    base_url: "https://api.moonshot.cn/v1",
    default_model: "moonshot-v1-8k",
    get_key_link: {
      host: "platform.moonshot.cn",
      url: "https://platform.moonshot.cn/console/api-keys",
    },
    key_placeholder: "sk-…",
  },
  {
    id: "ollama",
    display_name: "Ollama",
    protocol: "openai",
    base_url: "http://localhost:11434/v1",
    default_model: "llama3.2",
    // Local server -- no key acquisition link (ADR-0064 Ollama note).
    get_key_link: null,
    // Ollama needs no key by default; the generic placeholder applies.
    key_placeholder: "",
  },
];

// The pseudo-preset id for a profile whose endpoint does not match any catalog
// entry. Selecting "Custom" in the dropdown does NOT mutate the profile -- it
// just surfaces the protocol RadioGroup + free-form endpoint fields so the user
// can configure by hand.
export const PRESET_CUSTOM = "custom";

// Derive the preset id a profile's current endpoint reflects (issue #235). A
// profile is "on a preset" only while its protocol + base_url still match the
// applied preset verbatim; any drift (the user edits base_url, or the protocol
// no longer matches) reads as "custom". This makes the dropdown a DERIVED view
// of the profile's endpoint state -- no preset_id is persisted (ADR-0038).
export function derivePresetId(endpoint: {
  protocol: Protocol;
  base_url: string;
}): string {
  const match = PROVIDER_PRESETS.find(
    (p) => p.protocol === endpoint.protocol && p.base_url === endpoint.base_url,
  );
  return match?.id ?? PRESET_CUSTOM;
}

// Look up a preset by id. Returns undefined for PRESET_CUSTOM (and any unknown
// id) so callers can branch "named preset vs custom" without a sentinel hunt.
export function findPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}
