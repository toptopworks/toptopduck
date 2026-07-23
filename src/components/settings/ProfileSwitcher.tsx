import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import { FormattedMessage, useIntl } from "react-intl";

import { listProviderProfiles } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import type { ProviderConfig } from "../../types/provider";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";

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
// Disclosure mechanics: a plain <button> trigger (aria-haspopup="menu") + a
// conditionally rendered menu using the ARIA menu pattern (role="menu" +
// role="menuitemradio" items, aria-checked marks the active one). Hand-rolled
// rather than Radix DropdownMenu -- the project has not copy-in'd that primitive
// and this is a single static list, so the full DropdownMenu component would be
// YAGNI. Keyboard contract (ARIA menu): opening moves focus onto the active
// item; ArrowUp/ArrowDown traverse the items; ESC and click-outside close;
// selecting commits and closes. The trigger is a real <button> so its implicit
// role and the menuitemradio children stay consistent for the black-box tests.

export interface ProfileSwitcherProps {
  // The non-secret provider config from app-config (profiles list + active id).
  // Single-sourced by the parent; this component never mutates it.
  provider: ProviderConfig;
  /** Commit a new active_profile id (one-shot app-config write; live_config
   *  reads it fresh on the next turn, ADR-0064). The parent owns the persistence
   *  path -- this component never calls setProviderConfig/setAppConfig directly. */
  onSwitchActive: (id: string) => void;
  /** Disable each menu item while the parent reports busy. The switch write
   *  itself needs NO guard here: commitAppConfig is optimistic (state flips
   *  before the IPC awaits) and live_config re-reads active_profile fresh each
   *  turn (ADR-0064), so a mid-switch ask is safe and a rapid double-switch
   *  converges on the last click. Today the only busy source is .duck
   *  persistence/resume (App's `persistenceBusy || resumeStatus`), during which
   *  a profile swap is pointless. The trigger stays clickable (browsing the
   *  list is harmless); only selecting is gated. Named for what it gates -- the
   *  trigger remains interactive, so this is not a whole-component disable. */
  disableSwitch?: boolean;
}

export function ProfileSwitcher({ provider, onSwitchActive, disableSwitch }: ProfileSwitcherProps) {
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

  // Menu keyboard nav (ARIA menu pattern). One ref slot per item so ArrowUp/
  // ArrowDown can move focus between them; the list is static across renders
  // (profiles come from the parent prop), so index-keyed slots stay stable.
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // On open, move focus onto the active item (or the first) -- the ARIA menu
  // contract puts focus inside the menu, not on the trigger.
  useEffect(() => {
    if (!open) return;
    const items = itemRefs.current.filter((b): b is HTMLButtonElement => b !== null);
    if (items.length === 0) return;
    const activeIdx = provider.profiles.findIndex((p) => p.id === provider.active_profile);
    (items[activeIdx] ?? items[0]).focus();
    // Re-focus only when the menu opens; provider.profiles is static while the
    // menu is open, so it is intentionally absent from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = itemRefs.current.filter((b): b is HTMLButtonElement => b !== null);
    if (items.length === 0) return;
    e.preventDefault();
    const cur = items.findIndex((b) => b === document.activeElement);
    const next =
      e.key === "ArrowDown"
        ? cur < 0
          ? 0
          : (cur + 1) % items.length
        : cur <= 0
          ? items.length - 1
          : cur - 1;
    items[next].focus();
  }

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

  // ADR-0067 (issue #171): the .profile-switcher* visual rules ride inline
  // utilities over the ADR-0050 token (see styles.css for the retirement
  // list). position:relative on the anchor + absolute on .profile-switcher-
  // menu stay as layout hooks (the menu is positioned off the anchor); the
  // semantic class hooks are kept for selector / test stability.
  return (
    <div className="profile-switcher relative" ref={containerRef}>
      <button
        type="button"
        className="profile-switcher-trigger inline-flex items-center gap-1 py-1 px-2.5 text-sm cursor-pointer border border-border bg-card rounded-md text-foreground max-w-56 hover:bg-muted"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={intl.formatMessage(
          { id: "header.profileSwitcher.labelAria", defaultMessage: "Active profile: {name}" },
          { name: activeLabel },
        )}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="profile-switcher-name truncate font-medium">{activeLabel}</span>
        <ChevronDown size={14} aria-hidden className="opacity-60 shrink-0" />
      </button>
      {open && (
        <div
          className="profile-switcher-menu absolute top-full right-0 z-50 min-w-64 max-w-80 flex flex-col gap-0.5 p-1 mt-0.5 border border-border bg-card rounded-md shadow-md"
          role="menu"
          aria-label={intl.formatMessage({
            id: "header.profileSwitcher.menuAria",
            defaultMessage: "Switch active profile",
          })}
          onKeyDown={onMenuKeyDown}
        >
          {provider.profiles.map((p, i) => {
            const isActive = p.id === provider.active_profile;
            const pHasKey = profileKeys[p.id] ?? false;
            const label = p.display_name.trim() || unnamed;
            return (
              <button
                key={p.id}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                className={cn(
                  "profile-switcher-item flex items-center justify-between gap-2 py-1.5 px-2 text-sm cursor-pointer border-0 bg-transparent rounded-sm text-foreground text-left",
                  // :hover:not(:disabled) -- the muted tint applies only when
                  // the item is interactive (mirrors the retired rule). Disabled
                  // items dim + drop the pointer, never tint.
                  "enabled:hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed",
                  isActive && "font-semibold",
                )}
                role="menuitemradio"
                aria-checked={isActive}
                disabled={disableSwitch}
                aria-label={intl.formatMessage(
                  {
                    id: "header.profileSwitcher.switchAria",
                    defaultMessage: "Switch to \"{name}\"",
                  },
                  { name: label },
                )}
                onClick={() => handleSelect(p.id)}
              >
                <span className="profile-switcher-item-name truncate">{label}</span>
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
            <p className="profile-switcher-error py-1.5 px-2 m-0 text-destructive text-sm">{keysError}</p>
          )}
        </div>
      )}
    </div>
  );
}
