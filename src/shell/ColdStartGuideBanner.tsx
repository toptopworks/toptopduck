import { Info } from "lucide-react";
import { FormattedMessage } from "react-intl";

import { Button } from "../components/ui/button";
import { Alert, AlertDescription } from "../components/ui/alert";
import type { DefaultRuntime } from "../types/app-config";
import type { AdapterEntry, SessionRuntimeChoice } from "../types/runtime";
import type { ProviderConfig } from "../types/provider";

// The cold-start guidance banner (issue #1337): the shell surfaces a runtime
// setup gap on the empty state BEFORE the submit-time honest gate (ADR-0092
// Decision 4) intercepts the first ask. The gap is a pure derivation over the
// same primitives the gate already reads -- no state, no IPC, no persistence
// of its own: the banner is a mirror, and the existing disappearance channels
// (the settings-close profileKeyEpoch bump + the adapter cache subscription)
// make it vanish the moment the gap closes.

/** Which wall the user is about to hit. `cli-missing` covers BOTH paths to a
 *  missing CLI: the degrade (the persisted default names an undetected
 *  adapter, so the startup resolution lands built-in) and the residue (a
 *  manual external pick whose adapter left the table). */
export type ColdStartGap = "cli-missing" | "profile-missing" | "key-missing";

export interface ColdStartGapInputs {
  /** The persisted default_runtime preference (app-config). */
  defaultRuntime: DefaultRuntime | undefined;
  /** The runtime the cold-start bar displays (explicit pick or the startup
   *  resolution -- the selection channel's effectiveRuntime). */
  pendingRuntime: SessionRuntimeChoice;
  /** The shared adapter table; undefined while the read is in flight. */
  adapters: AdapterEntry[] | undefined;
  /** The provider config (null = unresolved). */
  provider: ProviderConfig | null;
  /** useProfileKeys.loading -- the key overlay's first fetch in flight. */
  keysLoading: boolean;
  /** Whether the active profile has a keychain entry (false while loading,
   *  on a dangling active_profile, or on a first-mount fetch failure). */
  activeHasKey: boolean;
  /** Non-null when the keychain read itself faulted (issue #275) -- the
   *  banner stays out of the way rather than guessing a wall. */
  activeKeychainFault: string | null;
}

// Pure seam (the #1337 trigger matrix; module-level for direct per-cell tests
// per the first_free_target precedent). Order is load-bearing:
// 1. The unresolved-feed gates first -- resolveStartupRuntime degrades an
//    unloaded table to built-in, so deriving from the resolved value while
//    the table is in flight would point the banner at the wrong wall for the
//    first frames; the provider feed stays null while its one-shot
//    app-config read is pending or failed (the submit gate defers on the
//    same state). The gates keep the first painted frame correct.
// 2. Root cause before the key branch: a built-in pending over an external
//    default IS the undetected-CLI degrade -- cli-missing wins over any key
//    posture the degraded built-in would otherwise report.
// Same-file by ruling (issue #1337): the matrix IS the component's spec,
// co-located like the Rust first_free_target precedent (#1330). The refresh
// cost of editing a pure function is a full reload -- harmless.
// eslint-disable-next-line react-refresh/only-export-components
export function deriveColdStartGap(
  inputs: ColdStartGapInputs,
): ColdStartGap | null {
  if (inputs.keysLoading || inputs.adapters === undefined) return null;
  // A const local: the narrowing must survive into the predicate closure.
  const pending = inputs.pendingRuntime;
  if (pending.kind === "external") {
    const detected = inputs.adapters.some(
      (a) => a.id === pending.data && a.detected,
    );
    return detected ? null : "cli-missing";
  }
  // The DEGRADE only (#1337): a built-in pending over an external
  // default whose CLI is genuinely undetected -- root cause wins over any key
  // posture. A DETECTED default under a manual built-in pick is no CLI wall:
  // the user chose built-in, so the key posture speaks (fall through).
  const defaultRuntime = inputs.defaultRuntime;
  if (defaultRuntime?.kind === "external") {
    const defaultDetected = inputs.adapters.some(
      (a) => a.id === defaultRuntime.data && a.detected,
    );
    if (!defaultDetected) return "cli-missing";
  }
  // An unresolved provider feed (the app-config read pending or failed) is
  // a defer, not a wall -- the same posture as the gates above and the
  // submit gate; only a LOADED zero-profile config is the profile-missing
  // wall (the ADR-0098 fresh install).
  if (inputs.provider === null) return null;
  if (inputs.provider.profiles.length === 0) return "profile-missing";
  // A keychain fault is distinct from a missing key (issue #275): the OS
  // answer is unknowable, so the banner stays out of the way.
  if (inputs.activeKeychainFault !== null) return null;
  return inputs.activeHasKey ? null : "key-missing";
}

// shadcn Alert `info` variant (the --info token tint in the warning tint's
// shape): the tinted surface lifts the banner off the shell background, and
// the full-color info copy reads bright. role="status" overrides the
// assertive "alert" default -- a conditional guidance state, not an
// announcement. One-line layout: copy left, CTA right; `py-1.5` keeps the box
// tight (the Alert base is py-3). The width rides the slot's --shell-bar-cap
// custom property (styles.css) -- the SAME cap the bar track consumes, so the
// banner follows the bar's width instead of mirroring a copied literal.
// Mounted ONLY on the cold-start branch (App.tsx), between the greeting and
// the bar track; no scrollable inside, so the slot's wheel forwarding stays
// a structural no-op.
export function ColdStartGuideBanner({
  gap,
  onOpenSettings,
}: {
  gap: ColdStartGap;
  onOpenSettings: () => void;
}) {
  // The gap-to-copy mapping is a guarded switch, not a ternary chain: every
  // member named, and the never guard makes a fourth ColdStartGap value a
  // compile error HERE instead of the key-missing copy by omission (the
  // ResumeProgress precedent, issue #205). Each case keeps a STATIC
  // FormattedMessage literal so formatjs extract resolves every id.
  const copy = (() => {
    switch (gap) {
      case "cli-missing":
        return (
          <FormattedMessage
            id="coldStart.guide.cliMissing"
            defaultMessage="The CLI set as the default runtime was not detected — choose another runtime in Settings."
          />
        );
      case "profile-missing":
        return (
          <FormattedMessage
            id="coldStart.guide.profileMissing"
            defaultMessage="No provider profile is configured yet — create one in Settings to use the built-in runtime."
          />
        );
      case "key-missing":
        return (
          <FormattedMessage
            id="coldStart.guide.keyMissing"
            defaultMessage="The active profile has no API key — add one in Settings before asking."
          />
        );
      default: {
        const unhandled: never = gap;
        throw new Error(`Unhandled ColdStartGap: ${String(unhandled)}`);
      }
    }
  })();
  return (
    <Alert
      variant="info"
      role="status"
      className="cold-start-guide-banner items-center py-1.5 [&>svg]:translate-y-0"
    >
      <Info aria-hidden />
      <AlertDescription className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span>{copy}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2.5"
          onClick={onOpenSettings}
        >
          <FormattedMessage
            id="coldStart.guide.openSettings"
            defaultMessage="Open Settings"
          />
        </Button>
      </AlertDescription>
    </Alert>
  );
}
