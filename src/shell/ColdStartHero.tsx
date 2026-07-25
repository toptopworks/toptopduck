import { useEffect, useState } from "react";
import { FormattedMessage } from "react-intl";

import { listProviderProfiles } from "../api";
import { log } from "../lib/log";
import type { ProviderConfig } from "../types/provider";
import { Button } from "../components/ui/button";

// Cold-start / all-closed hero (ADR-0061). The right side when no session is
// active. Issue #239 (ADR-0071 grilling): the old single "New session" CTA is
// replaced by THREE honest states so a first-run user with no profile / no key
// is guided straight to setup instead of being waved through to a "New session"
// that would fail on the first ask:
//
//   1. no-profile  -- provider.profiles is empty. CTA opens Settings on the
//      Profiles tab (no edit target -- there is no profile to edit yet).
//   2. no-key      -- profiles exist but the ACTIVE profile has no keychain
//      entry. CTA opens Settings on the Profiles tab with the active profile
//      pre-selected for editing (fill its key).
//   3. ready       -- profiles exist and the active profile has a key. The
//      legacy "New session" CTA (behavior unchanged, ADR-0061).
//
// The active profile's has_key comes from list_provider_profiles -- the SAME
// IPC ProfileSwitcher / ProfilesSection use (ADR-0029 one-shot keychain
// surface; the frontend learns only booleans, never the key), so no new IPC is
// introduced (issue #239 AC). The hero stays mounted (CSS-hidden via
// .settings-mode, ADR-0065) while Settings is open; App bumps profileKeyEpoch
// on settings-close (issue #238), and that bump is this effect's sole dep, so
// the overlay refetches and the hero never lingers on a stale "no key" after
// the user just configured one (ADR-0019 honest gate).
//
// Loading: while the overlay is in flight AND profiles already exist, the hero
// renders the legacy "Start an analysis" copy rather than guessing no-key vs
// ready -- the steady state is what matters for honesty (the spec's concern is
// a hero STUCK on ready when no key is known-missing), and the ms-scale loading
// transient is imperceptible.
//
// Error: a fetch failure is logged and the prior snapshot is RETAINED. A
// refetch error (epoch bump after a settings round-trip) keeps showing the
// last-known state, mirroring App.refreshKeyStatus ("keep the previous
// indicator"). On a FIRST-mount failure (no prior snapshot) the empty overlay
// yields has_key=false, directing the user to the "no-key" CTA -- the
// conservative direction per the spec's "don't pretend ready when unconfigured"
// (issue #239); Settings then surfaces the real key status, and the ask path
// catches a real missing-key failure if the user proceeds anyway.
//
// This is the shell-level empty state before any DuckDB instance exists (zero
// memory until the user acts). A freshly-created unsaved session shows its own
// hero inside its SessionPane. The privacy disclosure lives in SettingsView's
// Privacy pane (ADR-0066) -- the hero does not duplicate it.
//
// ADR-0067 (issue #173): .workspace-hero / .cold-start-hero / .cold-start-title
// / .primary-cta stay as layout / selector / test hooks; their retired visual
// rules ride inline utilities (flex column, centered, gap, padding, text-align,
// the 1.4rem title, the lg primary CTA). ADR-0067 (issue #182): the ready
// CTA's disabled state re-opens the shadcn base's disabled:pointer-events-none
// via disabled:pointer-events-auto so the cursor-progress hint renders, and
// disabled:opacity-60 nudges the default disabled:opacity-50 back to 0.6.

/** The three cold-start modes (issue #239). Ordered by detection priority:
 *  no-profile wins on an empty profiles list; otherwise the active profile's
 *  has_key decides no-key vs ready. The "ready" mode also serves as the
 *  loading / fallback appearance (see the file header). */
type ColdStartHeroMode = "no-profile" | "no-key" | "ready";

export function ColdStartHero({
  disabled,
  provider,
  profileKeyEpoch,
  onNew,
  onOpenSettingsProfiles,
}: {
  /** Busy gate for the ready-state "New session" CTA (a session operation is in
   *  flight). The settings CTAs are NOT gated -- opening Settings is harmless
   *  and never races with persistence. */
  disabled: boolean;
  /** The non-secret provider config (app-config). Null while app-config is
   *  unresolved; the hero renders the legacy copy until it resolves (App gates
   *  the settings gear on the same condition). */
  provider: ProviderConfig | null;
  /** Invalidation counter bumped by App on settings-close so the overlay
   *  refetches after a Save / immediate key set that may have changed a
   *  keychain slot (issue #238). */
  profileKeyEpoch: number;
  /** ready-state CTA: open a new session. */
  onNew: () => void;
  /** no-profile / no-key CTA: open Settings on the Profiles tab. The active
   *  profile id is forwarded on the no-key path so ProfilesSection lands on
   *  its edit form (issue #239 AC); omitted on the no-profile path. */
  onOpenSettingsProfiles: (editProfileId?: string) => void;
}) {
  // Per-profile has_key overlay (issue #239). Map keyed by profile_id, built
  // from list_provider_profiles. Mirrors the ProfileSwitcher / ProfilesSection
  // snapshot pattern; only the booleans live here (profile RECORDS stay
  // single-sourced in the provider prop).
  const [profileKeys, setProfileKeys] = useState<Record<string, boolean>>({});
  const [keysLoading, setKeysLoading] = useState(true);

  // profilesLen drives the fetch decision: 0 (provider null OR no profiles)
  // -> skip; N -> fetch. Coupling to the COUNT rather than provider identity
  // is deliberate -- a switch / model edit / base_url edit changes the provider
  // reference but NOT the keys (ADR-0065 per-profile key invariant), so it
  // must not trigger a re-fetch (Shell.test.tsx asserts this). The
  // null -> resolved transition (useAppConfigState loads app-config via an
  // async getAppConfig IPC, so the hero often mounts with provider=null) shows
  // up as 0 -> N, covering the issue #239 honest-gate mount-order gap: without
  // this dep the effect would short-circuit on null and never re-run, leaving
  // the hero stuck on the "ready" appearance even when the active profile has
  // no key. Adding / removing a profile also flips the count, correctly
  // refetching to pick up the new profile's key status.
  const profilesLen = provider?.profiles.length ?? 0;
  useEffect(() => {
    // The render-time mode computation short-circuits to "no-profile" whenever
    // profiles is empty, so the overlay is not needed in that case -- skip the
    // fetch entirely (one less cold-start IPC, and no setState in the effect
    // body: keysLoading / profileKeys are simply not consulted on that path).
    if (profilesLen === 0) {
      return;
    }
    let cancelled = false;
    listProviderProfiles()
      .then((status) => {
        if (cancelled) return;
        const map: Record<string, boolean> = {};
        for (const s of status) map[s.profile_id] = s.has_key;
        setProfileKeys(map);
      })
      .catch((e: unknown) => {
        // Log, keep the prior snapshot, fall through to the ready appearance.
        // The hero is a guidance surface, not an error surface; the ask path
        // surfaces real missing-key failures (mirrors App.refreshKeyStatus).
        log.warn("ColdStartHero", "list_provider_profiles failed", e);
      })
      .finally(() => {
        if (!cancelled) setKeysLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profileKeyEpoch, profilesLen]);

  // Resolve the three-state mode. provider null (app-config pending) and
  // keysLoading both defer to "ready" so the hero never guesses no-key before
  // the overlay resolves. A dangling active_profile (normalize repairs it on
  // save) yields activeHasKey=false -> "no-key", which opens Profiles without
  // an edit target (acceptable; there is no real active profile to edit).
  const activeProfile =
    provider?.profiles.find((p) => p.id === provider.active_profile) ?? null;
  const activeHasKey = activeProfile
    ? profileKeys[activeProfile.id] ?? false
    : false;
  const mode: ColdStartHeroMode =
    provider !== null && profilesLen === 0
      ? "no-profile"
      : provider !== null && !keysLoading && !activeHasKey
        ? "no-key"
        : "ready";

  return (
    <div className="workspace-hero cold-start-hero flex flex-col items-center gap-4 p-8 text-center">
      {mode === "no-profile" ? (
        <>
          <h2 className="cold-start-title m-0 mb-2 text-[1.4rem]">
            <FormattedMessage
              id="coldStart.noProfile.title"
              defaultMessage="Set up a provider profile"
            />
          </h2>
          <p className="text-muted-foreground">
            <FormattedMessage
              id="coldStart.noProfile.hint"
              defaultMessage="You need at least one provider profile before you can start an analysis."
            />
          </p>
          <Button
            size="lg"
            className="primary-cta"
            onClick={() => onOpenSettingsProfiles()}
          >
            <FormattedMessage id="coldStart.openSettings" defaultMessage="Open settings" />
          </Button>
        </>
      ) : mode === "no-key" ? (
        <>
          <h2 className="cold-start-title m-0 mb-2 text-[1.4rem]">
            <FormattedMessage id="coldStart.noKey.title" defaultMessage="Add an API key" />
          </h2>
          <p className="text-muted-foreground">
            <FormattedMessage
              id="coldStart.noKey.hint"
              defaultMessage="Your active profile has no API key yet. Add one to start asking questions."
            />
          </p>
          <Button
            size="lg"
            className="primary-cta"
            onClick={() => onOpenSettingsProfiles(activeProfile?.id)}
          >
            <FormattedMessage id="coldStart.openSettings" defaultMessage="Open settings" />
          </Button>
        </>
      ) : (
        <>
          <h2 className="cold-start-title m-0 mb-2 text-[1.4rem]">
            <FormattedMessage id="coldStart.title" defaultMessage="Start an analysis" />
          </h2>
          <p className="text-muted-foreground">
            <FormattedMessage
              id="coldStart.hint"
              defaultMessage="Click “New session” on the left, or open a saved session to resume. Drop a data file to start a new analysis in one step."
            />
          </p>
          <Button
            size="lg"
            className="primary-cta disabled:pointer-events-auto disabled:cursor-progress disabled:opacity-60"
            disabled={disabled}
            onClick={onNew}
          >
            <FormattedMessage id="coldStart.newSession" defaultMessage="New session" />
          </Button>
        </>
      )}
    </div>
  );
}
