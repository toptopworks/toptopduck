import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { FormattedMessage, useIntl } from "react-intl";

import { fmtError, listProviderProfiles } from "../api";
import type { ProviderConfig } from "../types";
import { Badge } from "./ui/badge";

// Top-bar active-profile quick switcher (issue #154, ADR-0065). A lightweight
// disclosure anchored in the top bar: the trigger shows the ACTIVE profile's
// display name; opening lists every profile (display name + has_key badge) and
// selecting one commits the new active_profile via the parent's onSwitchActive
// callback -- a one-shot app-config write that live_config picks up on the next
// turn (ADR-0064: the provider source reads active_profile fresh from disk per
// call, no caching). Distinct from the Profiles MANAGEMENT pane (issue #153,
// inside SettingsView): the switcher is the always-visible "what am I about to
// ask with" indicator + one-click swap; management (CRUD, key edits) lives
// behind the gear. ADR-0065 hides the whole top bar under .settings-mode, so
// this component never needs its own settings-open guard.
//
// The has_key overlay is fetched ONCE on mount via list_provider_profiles and
// is NOT refetched after a switch -- per-profile key status is invariant under
// an active-id change (the switch moves the active pointer, not the keys), so
// the mount-time snapshot stays accurate. Profile RECORDS stay single-sourced
// from the parent's provider prop (app-config); only the key booleans overlay
// here, mirroring ProfilesSection's pattern.
//
// Disclosure mechanics: a plain <button> trigger + a conditionally rendered
// menu (no Radix DropdownMenu dependency). Click-outside + ESC close the menu;
// selecting an item closes it too. The trigger is a real <button> (not a
// <summary>) so jsdom assigns it role="button" and the black-box App tests can
// drive it via getByRole -- a native <summary>'s implicit role is inconsistent
// across jsdom versions.

export interface ProfileSwitcherProps {
  // The non-secret provider config from app-config (profiles list + active id).
  // Single-sourced by the parent; this component never mutates it.
  provider: ProviderConfig;
  /** Commit a new active_profile id (one-shot app-config write; live_config
   *  reads it fresh on the next turn, ADR-0064). The parent owns the persistence
   *  path -- this component never calls setProviderConfig/setAppConfig directly. */
  onSwitchActive: (id: string) => void;
  /** Disable the SWITCH (each menu item) while the parent is mid-write or an
   *  ask is in flight, so a second switch cannot land before the first persists
   *  or race an in-flight turn. The trigger stays clickable (browsing the list
   *  is harmless); only selecting is gated. */
  disabled?: boolean;
}

export function ProfileSwitcher({ provider, onSwitchActive, disabled }: ProfileSwitcherProps) {
  const intl = useIntl();

  // Per-profile has_key overlay (issue #154). Fetched once on mount; never
  // refetched (a switch moves the active pointer, not the keys). Profile
  // records come from the parent's provider prop (single source of truth).
  const [profileKeys, setProfileKeys] = useState<Record<string, boolean>>({});
  const [keysError, setKeysError] = useState<string | null>(null);

  // Stable intl ref so the mount-time fetch effect runs once ([] deps) instead
  // of re-firing on an intl identity change (mirrors ProfilesSection).
  const intlRef = useRef(intl);
  useEffect(() => {
    intlRef.current = intl;
  }, [intl]);

  useEffect(() => {
    let cancelled = false;
    listProviderProfiles()
      .then((status) => {
        if (cancelled) return;
        const map: Record<string, boolean> = {};
        for (const s of status) map[s.profile_id] = s.has_key;
        setProfileKeys(map);
      })
      .catch((e) => {
        if (!cancelled) setKeysError(fmtError(e, intlRef.current));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Controlled open so a select closes the menu (a native <details> would stay
  // open after an item click). Click-outside + ESC also close it; the effect
  // mounts only while open to keep the listener lifecycle tight.
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      // Close when the pointer goes down OUTSIDE the switcher (not on a child --
      // a click on an item closes via handleSelect, this would double-fire).
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function handleSelect(id: string) {
    setOpen(false);
    // No-op when the user re-picks the already-active profile (avoids a
    // pointless app-config write + key-status refresh).
    if (id !== provider.active_profile) {
      onSwitchActive(id);
    }
  }

  const unnamed = intl.formatMessage({
    id: "settings.profiles.unnamed",
    defaultMessage: "Unnamed profile",
  });
  const activeProfile = provider.profiles.find((p) => p.id === provider.active_profile);
  const activeLabel = activeProfile?.display_name.trim() || unnamed;

  return (
    <div className="profile-switcher" ref={containerRef}>
      <button
        type="button"
        className="profile-switcher-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={intl.formatMessage(
          { id: "header.profileSwitcher.labelAria", defaultMessage: "Active profile: {name}" },
          { name: activeLabel },
        )}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="profile-switcher-name">{activeLabel}</span>
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div
          className="profile-switcher-menu"
          role="list"
          aria-label={intl.formatMessage({
            id: "header.profileSwitcher.menuAria",
            defaultMessage: "Switch active profile",
          })}
        >
          {provider.profiles.map((p) => {
            const isActive = p.id === provider.active_profile;
            const pHasKey = profileKeys[p.id] ?? false;
            const label = p.display_name.trim() || unnamed;
            return (
              <button
                key={p.id}
                type="button"
                className="profile-switcher-item"
                disabled={disabled}
                aria-current={isActive ? "true" : undefined}
                aria-label={intl.formatMessage(
                  {
                    id: "header.profileSwitcher.switchAria",
                    defaultMessage: "Switch to \"{name}\"",
                  },
                  { name: label },
                )}
                onClick={() => handleSelect(p.id)}
              >
                <span className="profile-switcher-item-name">{label}</span>
                <Badge variant={pHasKey ? "secondary" : "outline"}>
                  {pHasKey ? (
                    <FormattedMessage id="settings.profiles.keySet" defaultMessage="Key set" />
                  ) : (
                    <FormattedMessage id="settings.profiles.keyMissing" defaultMessage="No key" />
                  )}
                </Badge>
              </button>
            );
          })}
          {keysError && (
            <p className="profile-switcher-error text-destructive text-sm">{keysError}</p>
          )}
        </div>
      )}
    </div>
  );
}
