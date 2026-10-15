import { useEffect, useState } from "react";

import { listProviderProfiles } from "../api";
import { findActiveProfile } from "../lib/findActiveProfile";
import { log } from "../lib/log";
import type { ProfileKeyStatus, ProviderConfig } from "../types/provider";

// Shell-level per-profile has_key snapshot for the ADR-0092 submit-time
// honest gate (Decision 4). The retired ColdStartHero owned this fetch for
// its three-state CTA; with the hero gone, the shell-level bar still needs
// the same booleans to decide whether a cold-start submit may create a
// session or must redirect to the Settings Runtime tab first. The same IPC
// ProfilesSection / ComposerProviderPicker consume (ADR-0029 one-shot
// keychain surface: the frontend learns only booleans, never the key), so no
// new IPC is introduced.
//
// Loading honesty (the hero's steady-state rule): while the FIRST fetch is
// in flight the snapshot reports loading and the gate defers to "ready" --
// the ms-scale transient must not bounce a user to Settings. On a fetch
// failure the prior snapshot is RETAINED (a refetch keeps the last-known
// state); a FIRST-mount failure lands on the empty overlay, which yields
// has_key=false -- the conservative direction ("don't pretend ready when
// unconfigured"); Settings then surfaces the real key status.
//
// The effect keys on the profile COUNT rather than provider identity -- a
// profile switch / model edit changes the provider reference but not the
// keys (ADR-0065 per-profile key invariant) and must not refetch; adding or
// removing a profile flips the count and does. `epoch` is the App's
// settings-close invalidation counter (a Settings Save may have changed a
// keychain slot, ADR-0019 honest gate).

export interface ProfileKeysSnapshot {
  /** True while the first fetch is in flight (no snapshot yet). */
  loading: boolean;
  /** The active profile id (null when provider is unresolved, has no
   *  profiles, or active_profile dangles). */
  activeProfileId: string | null;
  /** Whether the active profile has a keychain entry. False while loading,
   *  on a dangling active_profile, and on a first-mount fetch failure. */
  activeHasKey: boolean;
  /** Non-null when the keychain read itself faulted (locked / service down)
   *  -- distinct from a plain missing key (issue #275). */
  activeKeychainFault: string | null;
}

export function useProfileKeys(
  provider: ProviderConfig | null,
  epoch: number,
): ProfileKeysSnapshot {
  // One snapshot object, updated ONLY from the fetch's async callbacks (never
  // synchronously in the effect body). `fetched` flips on the first settled
  // fetch; `loading` derives from it below. A refetch keeps the prior keys on
  // failure (the catch carries them forward).
  const [snapshot, setSnapshot] = useState<{
    keys: Record<string, ProfileKeyStatus>;
    fetched: boolean;
  }>({ keys: {}, fetched: false });

  // profilesLen drives the fetch decision: 0 (provider null OR no profiles)
  // -> skip; N -> fetch. See the file header for why the count, not the
  // provider identity, is the dep.
  const profilesLen = provider?.profiles.length ?? 0;
  useEffect(() => {
    if (profilesLen === 0) {
      return;
    }
    let cancelled = false;
    listProviderProfiles()
      .then((status) => {
        if (cancelled) return;
        const keys: Record<string, ProfileKeyStatus> = {};
        for (const s of status) keys[s.profile_id] = s;
        setSnapshot({ keys, fetched: true });
      })
      .catch((e: unknown) => {
        // Keep the prior snapshot; the gate's honesty note lives in the file
        // header. The bar is a guidance surface, and the ask path surfaces a
        // real missing-key failure if the user proceeds anyway.
        log.warn("useProfileKeys", "list_provider_profiles failed", e);
        if (!cancelled) {
          setSnapshot((prev) => ({ keys: prev.keys, fetched: true }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [epoch, profilesLen]);

  const activeProfile = provider
    ? (findActiveProfile(provider) ?? null)
    : null;
  const activeStatus = activeProfile
    ? snapshot.keys[activeProfile.id]
    : undefined;

  return {
    loading: profilesLen > 0 && !snapshot.fetched,
    activeProfileId: activeProfile?.id ?? null,
    activeHasKey: activeStatus?.has_key ?? false,
    activeKeychainFault: activeStatus?.keychain_fault ?? null,
  };
}
