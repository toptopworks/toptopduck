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

// Non-secret multi-profile provider config (ADR-0064/0098): a list of named
// access profiles plus the id of the active one. The profile set may be empty
// and the active pointer may be null -- zero profiles is a legal persistent
// state (ADR-0098, the CLI-only user shape); first install ships empty and
// normalize never re-seeds a skeleton. Never carries the API key (ADR-0029/
// 0038 -- the key lives only in the OS keychain). Mirrors the Rust
// ProviderConfig. This is both the app-config storage shape (AppConfig.provider)
// and the set_provider_config IPC input shape.
export interface ProviderConfig {
  // The named access profiles (ADR-0064); may be empty (ADR-0098).
  profiles: ProviderProfile[];
  // The id of the active profile (ADR-0064: global single active), or null
  // when no profile is active (the zero-profile state, ADR-0098). When set,
  // its protocol + endpoint + model drive the live provider; its id drives
  // the keychain account the key is read from.
  active_profile: string | null;
}

// The active profile's key status pair (ADR-0029, issue #275): has_key is
// authoritative when keychain_fault is null; a non-null fault means the OS
// keychain read failed, so the consumer renders "Keychain unavailable" instead
// of misreading as "no key configured" (a boolean only -- the decrypted key
// lives only in the Rust core, ADR-0029 invariant 3). The fault detail is a
// technical English string (locked / service down / permission revoked / corrupt
// entry) mirroring ProfileTestOutcome.KeychainUnavailable.detail (issue #243).
// Defined once here so the two carriers cannot drift: ProviderConfigView
// (the get_provider_config IPC view) and ProfileKeyStatus (the per-profile
// keychain overlay).
export type KeyStatus = { has_key: boolean; keychain_fault: string | null };

// The get_provider_config view (ADR-0029/0098): the active profile's base URL
// + model plus its KeyStatus. Mirrors the Rust ProviderConfigView. base_url /
// model are null when no profile is active (the zero-profile state, ADR-0098)
// -- the honest "not configured" signal, not canonical defaults masquerading
// as a value. The connection row learns whether to prompt for a key without
// ever receiving it, and distinguishes a read fault from a legitimate no-key
// state (issue #275).
export interface ProviderConfigView extends KeyStatus {
  base_url: string | null;
  model: string | null;
}

// Per-profile key-status overlay (issue #153, ADR-0064/0029). The Profiles
// management UI lists every profile with whether its keychain slot
// (`key-<profile_id>`) holds a key. The profile RECORDS come from app-config
// (single source of truth for the list); this view only carries the KeyStatus
// pair + the profile id that app-config deliberately does not store. Mirrors
// the Rust ProfileKeyStatus; `list_provider_profiles` returns one entry per
// profile currently in app-config.
export interface ProfileKeyStatus extends KeyStatus {
  // The stable profile id (also the keychain account suffix `key-<id>`).
  profile_id: string;
}

// The test_profile IPC return value (issue #236, ADR-0070 connection preflight).
// Six states along the ADR-0044 axis: Ok carries the listed models (fed to the
// model dropdown; empty when only the ping fallback succeeded -- the dropdown
// then falls back to a hand-typed input); KeyRejected (no key stored / HTTP
// 401/403); KeychainUnavailable (the OS keychain read itself failed -- locked /
// service down / permission revoked -- the probe never ran, issue #243);
// EndpointUnreachable (transport: DNS/TCP/TLS/timeout); InvalidEndpoint (a
// non-http/https scheme rejected before any probe fires -- a configuration
// error, not a network failure, issue #279); Incompatible carries a technical
// English detail for the details fold. Mirrors the Rust ProfileTestOutcome --
// adjacently-tagged (`kind`/`data`), pinned by tests/ipc_contract.rs. User
// wording lives in the locale catalog (ADR-0052).
export type ProfileTestOutcome =
  | { kind: "Ok"; data: { models: string[] } }
  | { kind: "KeyRejected" }
  | { kind: "KeychainUnavailable"; data: { detail: string } }
  | { kind: "EndpointUnreachable" }
  | { kind: "InvalidEndpoint"; data: { detail: string } }
  | { kind: "Incompatible"; data: { detail: string } };
