import type { ProviderConfig, ProviderProfile } from "../types/provider";

// The active profile, or undefined when `active_profile` is null (the legal
// zero-profile state, ADR-0098) or matches no profile (a dangling pointer the
// Rust normalize nulls). Mirrors the Rust `ProviderConfig::active()`
// (src-tauri/src/model/provider.rs) so the "a null pointer never matches any
// id" resolution semantics live in exactly one place on each side (issue
// #576); callers must not re-implement the lookup inline. No first-profile
// fallback here -- silently activating a profile the user did not choose
// would point the live provider and the keychain read at the wrong slot.
export function findActiveProfile(
  provider: ProviderConfig,
): ProviderProfile | undefined {
  return provider.profiles.find((p) => p.id === provider.active_profile);
}
