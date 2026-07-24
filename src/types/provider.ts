// Provider config types split from the single-file src/types.ts (issue #197).
// Mirrors the Rust model types. Covers the multi-profile provider config
// (ADR-0064), the keyless config view (ADR-0029), and the per-profile key-status
// overlay (issue #153).

// The wire protocol a profile speaks (ADR-0064). "anthropic" = Anthropic
// Messages native (x-api-key auth); "openai" = OpenAI Chat Completions (Bearer
// auth; covers OpenAI direct / DeepSeek / GLM / Qwen / Ollama compatible
// endpoints). Mirrors the Rust Protocol enum (serde rename_all="lowercase").
export type Protocol = "anthropic" | "openai";

// One named access profile (ADR-0064): protocol + endpoint + model. The API key
// lives separately in the OS keychain under key-<id> (ADR-0029/0038). id is
// stable (created once); display_name is renamable (ADR-0037 split). Mirrors the
// Rust ProviderProfile.
export interface ProviderProfile {
  // Stable identity (ADR-0037 reference half); also the keychain account suffix.
  id: string;
  // Renamable display label (ADR-0037 display half).
  display_name: string;
  // Wire protocol (ADR-0064).
  protocol: Protocol;
  // Anthropic Messages API base URL (ADR-0019: configurable baseURL; default
  // Anthropic direct, overridable to a user's own Anthropic-compatible gateway).
  base_url: string;
  // Model id to request (ADR-0007: default Sonnet-class, pinned; the user may
  // switch to a stronger or cheaper model).
  model: string;
}

// Non-secret multi-profile provider config (ADR-0064): a list of named access
// profiles plus the id of the active one. Never carries the API key
// (ADR-0029/0038 -- the key lives only in the OS keychain). Mirrors the Rust
// ProviderConfig. This is both the app-config storage shape (AppConfig.provider)
// and the set_provider_config IPC input shape.
export interface ProviderConfig {
  // The named access profiles (ADR-0064); at least one in any valid config.
  profiles: ProviderProfile[];
  // The id of the active profile (ADR-0064: global single active). Its
  // protocol + endpoint + model drive the live provider; its id drives the
  // keychain account the key is read from.
  active_profile: string;
}

// The get_provider_config view (ADR-0029): effective base URL + model plus
// has_key -- a boolean, never the key itself. Mirrors the Rust
// ProviderConfigView. The frontend learns whether to prompt for a key without
// ever receiving it.
export interface ProviderConfigView {
  base_url: string;
  model: string;
  // Whether an API key is stored in the OS keychain. A boolean only (ADR-0029
  // invariant 3: the decrypted key lives only in the Rust core).
  has_key: boolean;
}

// Per-profile key-status overlay (issue #153, ADR-0064/0029). The Profiles
// management UI lists every profile with whether its keychain slot
// (`key-<profile_id>`) holds a key -- a boolean only, never the key itself
// (ADR-0029 invariant 3). The profile RECORDS come from app-config (single
// source of truth for the list); this view only carries the key status that
// app-config deliberately does not store. Mirrors the Rust ProfileKeyStatus;
// `list_provider_profiles` returns one entry per profile currently in app-config.
export interface ProfileKeyStatus {
  // The stable profile id (also the keychain account suffix `key-<id>`).
  profile_id: string;
  // Whether a key is stored for this profile. A boolean only (ADR-0029).
  has_key: boolean;
}

// The test_profile IPC return value (issue #236, ADR-0070 connection preflight).
// Four states along the ADR-0044 axis: Ok carries the listed models (fed to the
// model dropdown; empty when only the ping fallback succeeded -- the dropdown
// then falls back to a hand-typed input); KeyRejected (no key stored / HTTP
// 401/403); EndpointUnreachable (transport: DNS/TCP/TLS/timeout); Incompatible
// carries a technical English detail for the details fold. Mirrors the Rust
// ProfileTestOutcome -- adjacently-tagged (`kind`/`data`), pinned by
// tests/ipc_contract.rs. User wording lives in the locale catalog (ADR-0052).
export type ProfileTestOutcome =
  | { kind: "Ok"; data: { models: string[] } }
  | { kind: "KeyRejected" }
  | { kind: "EndpointUnreachable" }
  | { kind: "Incompatible"; data: { detail: string } };
