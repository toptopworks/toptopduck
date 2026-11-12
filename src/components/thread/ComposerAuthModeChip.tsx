import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { Check, ChevronDown, Hand, ShieldAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  getAuthorizationMode,
  listSessionTrust,
  onApprovalResolved,
  revokeSessionTrust,
  setAuthorizationMode,
} from "../../api";
import { fmtError } from "../../lib/error-presentation";
import { log } from "../../lib/log";
import { sessionKeys } from "../../session/queryKeys";
import type { AuthMode, ToolKey } from "../../types/approval";
import { AUTH_MODE_DEFAULT } from "../../types/approval";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { LABEL_HIDE_NARROW } from "./composer-visual";

// Composer session-approval composite face (ADR-0080, issue #482 / #1369).
// One popover on the composer button row (ADR-0083 puts the execution-posture
// switches there) carrying the session's two approval-relaxation surfaces:
//
//   - top half: the authorization posture radio group (confirm-each-call <->
//     no-confirmation), unchanged semantics from the former Radix Select but
//     re-homed on a RadioGroup so arrows switch postures and Tab can keep
//     walking into the panel (the Select trapped focus and swallowed Tab,
//     stranding any control seated after the options);
//   - bottom half (issue #1369): the session's always-allow trust set, listed
//     only while non-empty (zero-noise empty state -- no badge, no section),
//     with a per-row revoke button. Revoking is the safety-direction action:
//     no confirmation (a mis-click self-heals -- the tool's next call simply
//     re-enters approval), and the copy is "revoke trust", never "undo
//     allow" (the executed calls are not undone; only the session trust is).
//
// The posture is session-scoped and resume-resetting -- the backend
// (`open_recipe` -> `reset_approval`) returns it to per_call on a resume, and
// this chip re-reads it via the session-keyed query (a resume mints a NEW
// session id whose fresh SessionPane mount issues the read). The
// no-confirmation trigger face rides the --warning token: the posture is an
// explicit informed widening, and the warning hue marks it while it is on
// (ADR-0080 / ADR-0083).
//
// Reads + writes go through the session-keyed IPC pair (#294 / #1369); a
// rejected write keeps the server posture -- the chip resyncs via refetch and
// never shows a posture the backend did not grant. A rejected READ is
// surfaced via log.warn.
//
// Trust-set freshness rides three timings (#1369), no backend events added:
// the mount / session-switch read (the query keys off sessionId, so each
// pane's chip reflects its own slice), each `approval-resolved` event that
// carries `always_allow` for THIS session (the only response that grows the
// set), and a successful revoke (the cache is filtered in place -- the write
// is the truth source, no extra IPC round-trip).
//
// Cold start (ADR-0092): sessionId is null on the shell-level bar before any
// session exists. The posture renders the caller-held pending posture
// (AUTH_MODE_DEFAULT initial) with no IPC; the trust read is disabled (an
// empty set -- no badge, no section) and no resolution listener attaches.

export type ComposerAuthModeChipProps = {
  /** The session whose posture this chip reads / switches. null on the
   *  cold-start shell-level bar (ADR-0092): the chip reads pendingMode and
   *  writes via onPendingModeChange instead of per-session IPC. */
  sessionId: string | null;
  /** When sessionId is null (cold-start bar, ADR-0092), the shell-held
   *  pending posture shown by the chip. Defaults to AUTH_MODE_DEFAULT. */
  pendingMode?: AuthMode;
  /** When sessionId is null (cold-start bar, ADR-0092), a selection writes
   *  to the shell-level pending state via this callback instead of the
   *  per-session IPC. Undefined when sessionId is non-null. */
  onPendingModeChange?: (mode: AuthMode) => void;
};

// Trigger face chrome. The neutral face rides the composer chrome tokens
// (matching the ComposerProviderPicker trigger beside it); the no-confirmation
// face consumes the --warning token (border / fill / text).
const TRIGGER_NEUTRAL = "border-border bg-card hover:bg-transit";
const TRIGGER_WARNING =
  "border-warning/40 bg-warning/10 text-warning hover:bg-warning/20";

export function ComposerAuthModeChip({ sessionId, pendingMode, onPendingModeChange }: ComposerAuthModeChipProps) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  // Guards the write window: a selection that lands while the set IPC is in
  // flight is dropped instead of re-firing (the disabled attr is the visual
  // half of the same gate).
  const [switching, setSwitching] = useState(false);
  // The panel is controlled so an item click can close it (the former
  // Select's set-and-forget flow).
  const [open, setOpen] = useState(false);
  // The trust row currently revoking (its trustKeyOf identity), so only that
  // row's button spins/disables while its IPC is in flight.
  const [revokingKey, setRevokingKey] = useState<string | null>(null);

  // The session's posture (backend truth). Under the session prefix so a
  // close's removeQueries drops it with the rest; a resume lands the reset
  // value via the fresh SessionPane mount (see file header). Null sessionId
  // (cold-start bar, ADR-0092): the query is disabled (enabled:false) and
  // the caller-held pending posture drives the chip with no IPC. The
  // cold-start key uses a dedicated sentinel that never matches a real UUID
  // session id — it is never fetched and never cleaned up.
  const { data, isError, error } = useQuery({
    queryKey: sessionId !== null
      ? sessionKeys.authMode(sessionId)
      : sessionKeys.coldStartAuthMode(),
    queryFn: () => getAuthorizationMode(sessionId as string),
    enabled: sessionId !== null,
  });
  // AUTH_MODE_DEFAULT is the single TS expression of the backend's
  // #[default] PerCall (ADR-0080): the honest-default face renders immediately
  // while the read settles, never a blank slot. Cold start renders the
  // pending posture the same way.
  const mode: AuthMode =
    sessionId === null
      ? (pendingMode ?? AUTH_MODE_DEFAULT)
      : (data ?? AUTH_MODE_DEFAULT);
  const noConfirmation = mode === "no_confirmation";

  // The session's always-allow trust set (ADR-0080 Decision 3), keyed the
  // same way: session-prefixed, cold-start disabled (an empty set). The
  // default [] keeps the empty-state faces honest while the read settles.
  const {
    data: trustKeys,
    isError: trustIsError,
    error: trustError,
  } = useQuery({
    queryKey: sessionId !== null
      ? sessionKeys.sessionTrust(sessionId)
      : sessionKeys.coldStartSessionTrust(),
    queryFn: () => listSessionTrust(sessionId as string),
    enabled: sessionId !== null,
  });
  const trustedTools: ToolKey[] = trustKeys ?? [];
  const trustCount = trustedTools.length;

  // always_allow is the only approval response that grows the trust set:
  // invalidate on exactly those events (denials and allow-once resolutions
  // leave the set untouched, so they never spend an IPC). Other sessions'
  // events are ignored -- the chip reflects its own pane's slice only.
  useEffect(() => {
    if (sessionId === null) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onApprovalResolved((ev) => {
      if (ev.session_id === sessionId && ev.response === "always_allow") {
        void queryClient.invalidateQueries({
          queryKey: sessionKeys.sessionTrust(sessionId),
        });
      }
    }).then((fn) => {
      // The session can close before the subscription resolves; the unlisten
      // must then fire immediately instead of leaking the listener.
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [sessionId, queryClient]);

  // A persistently failing read (IPC panic, serialization crash, stale sid)
  // would otherwise leave the chip silently on the safe per_call face with no
  // signal -- log it so the operator can tell a real per_call posture from a
  // chip that lost its backend (ADR-0080 fail-safe default stays).
  useEffect(() => {
    if (isError) {
      log.warn(
        "ComposerAuthModeChip",
        "auth-mode read failed; showing default",
        fmtError(error, intl),
      );
    }
  }, [isError, error, intl]);

  // Mirror of the posture read's failure signal, on the trust side: a
  // persistently failing read would otherwise leave the chip silently
  // asserting "nothing is trusted" (no badge, no section) while the
  // backend's always-allow entries keep auto-passing -- under-reporting
  // trust is the dangerous direction on the revoke surface.
  useEffect(() => {
    if (trustIsError) {
      log.warn(
        "ComposerAuthModeChip",
        "session-trust read failed; showing empty set",
        fmtError(trustError, intl),
      );
    }
  }, [trustIsError, trustError, intl]);

  async function handleChange(next: AuthMode) {
    if (switching || next === mode) return;
    // Null sessionId (cold-start bar, ADR-0092): write to the caller-held
    // pending state. No IPC, no switching gate -- the write is synchronous.
    // When the callback is absent the selection is logged and discarded so
    // an unwired cold-start bar is observable instead of silently swallowed.
    if (sessionId === null) {
      if (onPendingModeChange) {
        onPendingModeChange(next);
      } else {
        log.warn(
          "ComposerAuthModeChip",
          "selection changed with null sessionId but no onPendingModeChange handler — selection discarded",
        );
      }
      return;
    }
    setSwitching(true);
    try {
      await setAuthorizationMode(sessionId, next);
      // The write is the truth source: seed the cache directly (no extra IPC
      // round-trip; a later remount refetches the same value).
      queryClient.setQueryData(sessionKeys.authMode(sessionId), next);
    } catch (e) {
      // Keep the server posture: refetch so the chip re-reads the backend
      // truth instead of showing a selection the write never granted.
      log.warn(
        "ComposerAuthModeChip",
        "set authorization mode failed; resyncing from the session",
        fmtError(e, intl),
      );
      void queryClient.invalidateQueries({ queryKey: sessionKeys.authMode(sessionId) });
    } finally {
      setSwitching(false);
    }
  }

  // Revoke is the safety-direction action: fire, then filter the cache in
  // place (the write is the truth source, mirroring handleChange's seed). No
  // confirmation and no turn impact -- the revoked tool's NEXT call simply
  // re-enters per-call approval (#1369). A rejected revoke resyncs from the
  // session instead of dropping a row the backend still trusts.
  async function handleRevoke(key: ToolKey) {
    if (sessionId === null) return;
    const rowKey = trustKeyOf(key);
    setRevokingKey(rowKey);
    try {
      await revokeSessionTrust(sessionId, key.server, key.tool);
      queryClient.setQueryData<ToolKey[]>(
        sessionKeys.sessionTrust(sessionId),
        (prev) => (prev ?? []).filter((t) => trustKeyOf(t) !== rowKey),
      );
    } catch (e) {
      log.warn(
        "ComposerAuthModeChip",
        "revoke session trust failed; resyncing from the session",
        fmtError(e, intl),
      );
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.sessionTrust(sessionId),
      });
    } finally {
      setRevokingKey(null);
    }
  }

  const perCallLabel = intl.formatMessage({
    id: "composer.authMode.perCall",
    defaultMessage: "Request approval",
  });
  const noConfirmationLabel = intl.formatMessage({
    id: "composer.authMode.noConfirmation",
    defaultMessage: "Full access",
  });
  const perCallDesc = intl.formatMessage({
    id: "composer.authMode.desc.requestApproval",
    defaultMessage: "Ask for approval before each external tool call",
  });
  const fullAccessDesc = intl.formatMessage({
    id: "composer.authMode.desc.fullAccess",
    defaultMessage: "All calls auto-pass for this session. Resets on resume",
  });
  const currentModeLabel = noConfirmation ? noConfirmationLabel : perCallLabel;
  // The count rides the accessible name only when it is non-zero (the empty
  // set is zero-noise, #1369): the badge itself is aria-hidden.
  const ariaLabel =
    trustCount > 0
      ? intl.formatMessage(
          {
            id: "composer.authMode.ariaLabelTrusted",
            defaultMessage:
              "Authorization mode: {mode}. {count, plural, one {# tool} other {# tools}} trusted for this session",
          },
          { mode: currentModeLabel, count: trustCount },
        )
      : intl.formatMessage(
          { id: "composer.authMode.ariaLabel", defaultMessage: "Authorization mode: {mode}" },
          { mode: currentModeLabel },
        );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={switching}>
        <button
          type="button"
          aria-label={ariaLabel}
          className={cn(
            // The former SelectTrigger's face: label left, chevron hugging the
            // right rim (justify-between), the same padding rhythm.
            "flex h-9 items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm shadow-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
            noConfirmation ? TRIGGER_WARNING : TRIGGER_NEUTRAL,
          )}
        >
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {noConfirmation ? (
              <ShieldAlert className="size-4 shrink-0" aria-hidden />
            ) : (
              <Hand className="size-4 shrink-0" aria-hidden />
            )}
            {/* truncate rides the label: during a rail drag the left group is
                the shrinking side (the badge + chevron group is shrink-0), and
                an unprotected label wraps one glyph per line inside the
                fixed-height trigger. The former SelectTrigger guarded the
                same span with line-clamp-1. */}
            <span className={cn("min-w-0 truncate", LABEL_HIDE_NARROW)}>{currentModeLabel}</span>
          </span>
          <span className="inline-flex shrink-0 items-center gap-1">
            {trustCount > 0 && (
              <span
                aria-hidden
                className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-xs font-medium tabular-nums text-foreground"
              >
                {trustCount}
              </span>
            )}
            <ChevronDown className="size-4 opacity-50" aria-hidden />
          </span>
        </button>
      </PopoverTrigger>
      {/* Auto width like the former Select's popper content: the posture
          descriptions run one line and the panel hugs its content; min-w
          keeps a floor under the narrow-rail trigger (label hidden). w-auto
          must override the shadcn copy-in's w-72 default explicitly --
          tailwind-merge does not conflict a width against a min-width. */}
      <PopoverContent align="start" className="w-auto min-w-56 p-1">
        {/* Posture radio group: Radix gives the arrow-key walk + roving
            tabindex + radio semantics; the visual stays the former AuthModeItem
            layout (icon + label row, description below, indicator at the
            right edge). Closing rides each item's onClick -- the former
            Select's click-anywhere-to-dismiss feel, kept for the
            already-selected posture too (it fires no onValueChange, and the
            arrow-key walk's synthetic click passes through onClick as well). */}
        <RadioGroupPrimitive.Root
          value={mode}
          onValueChange={(v) => {
            if (!isAuthMode(v)) return;
            void handleChange(v);
          }}
          // The former Select disabled its whole content while the write was
          // in flight; the radio items carry the same gate (the handleChange
          // switching guard is the functional half, this the visual one).
          disabled={switching}
          className="flex flex-col"
        >
          <PostureRadioItem
            value="per_call"
            icon={<Hand className="size-4 shrink-0" aria-hidden />}
            label={perCallLabel}
            description={perCallDesc}
            onItemClick={() => setOpen(false)}
          />
          <PostureRadioItem
            value="no_confirmation"
            icon={<ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden />}
            label={noConfirmationLabel}
            description={fullAccessDesc}
            onItemClick={() => setOpen(false)}
            warning
          />
        </RadioGroupPrimitive.Root>
        {/* Trust management (#1369): non-empty only. The section NEVER renders
            an empty state -- with no trusted tools the panel is exactly the
            posture picker it always was. */}
        {trustCount > 0 && (
          <>
            <div className="my-1 h-px bg-border" />
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
              {intl.formatMessage(
                { id: "composer.authMode.trust.title", defaultMessage: "Trusted tools ({count})" },
                { count: trustCount },
              )}
            </div>
            <ul className="flex flex-col">
              {trustedTools.map((toolKey) => {
                const rowKey = trustKeyOf(toolKey);
                return (
                  <li
                    key={rowKey}
                    className="flex min-w-0 items-center justify-between gap-1.5 rounded-sm px-2 py-1 text-sm"
                  >
                    {/* Display, not the storage key: the server rides muted
                        (it is the modifier), the tool name is the subject in
                        foreground ink. min-w-0 + truncate: a long tail
                        ellipsizes instead of pushing the revoke button out of
                        the panel; the native title tooltip always names the
                        full pair in the same display shape (never truncated),
                        so a clipped row still identifies itself on hover. */}
                    <span
                      className="min-w-0 flex-1 truncate"
                      title={`${toolKey.server} · ${toolKey.tool}`}
                    >
                      <span className="text-muted-foreground">{toolKey.server}</span>
                      <span className="text-muted-foreground/60"> · </span>
                      <span>{toolKey.tool}</span>
                    </span>
                    <button
                      type="button"
                      disabled={revokingKey === rowKey}
                      onClick={() => void handleRevoke(toolKey)}
                      className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-xs text-muted-foreground transition-colors outline-none hover:bg-transit hover:text-foreground focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {intl.formatMessage({
                        id: "composer.authMode.trust.revoke",
                        defaultMessage: "Revoke",
                      })}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

// The trust row's identity -- the list key, the revoking gate's token, and
// the revoke cache filter all ride it. Encoded as a JSON pair, NOT a `::`
// join: the backend keys trust on the ToolKey STRUCT (never a joined
// string), and the dispatch lane derives server names from model-emitted
// tool names with no alphabet validation (the issue #312 spoof class), so a
// plain `::` join could collide two distinct pairs. JSON of the pair is
// injective for any string inputs.
function trustKeyOf(toolKey: ToolKey): string {
  return JSON.stringify([toolKey.server, toolKey.tool]);
}

// A posture radio variant whose icon + title ride one row while the
// description sits below (the former AuthModeItem's shape, re-homed from the
// Select primitive onto the RadioGroup primitive). Uses RadioGroupPrimitive
// directly instead of the shared RadioGroupItem wrapper, which renders the
// circular dot indicator and cannot express the description slot.
type PostureRadioItemProps = {
  value: AuthMode;
  icon: React.ReactNode;
  label: string;
  description: string;
  /** Fires on every item click, including the already-selected one (which
   *  emits no onValueChange) -- the panel-close carrier. */
  onItemClick: () => void;
  /** Marks the item with the --warning token (no_confirmation posture). */
  warning?: boolean;
};

function PostureRadioItem({
  value,
  icon,
  label,
  description,
  onItemClick,
  warning = false,
}: PostureRadioItemProps) {
  return (
    <RadioGroupPrimitive.Item
      value={value}
      onClick={onItemClick}
      className={cn(
        // text-left: the RadioGroup item renders a <button>, whose UA default
        // centers inline content -- the former Select item rendered a <div>
        // and needed no such reset.
        "relative flex flex-col gap-0.5 items-start rounded-sm py-1.5 pr-8 pl-2 text-left text-sm outline-none select-none",
        "focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:border-ring",
        // A two-option CONTRAST pair: each option's faces all ride its own
        // hue -- hover PREVIEWS the commitment color instead of walking a
        // neutral transit ramp (deliberate exception to grey = transit;
        // this is a mode pair, not a walk list).
        // per_call: teal wash + teal text on hover/focus, pinned while
        // checked via data-state. no_confirmation: the --warning orange
        // ground on the same channels.
        warning
          ? "text-warning data-[state=checked]:bg-warning/10 hover:bg-warning/10 focus:bg-warning/10"
          : "hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground data-[state=checked]:bg-accent data-[state=checked]:text-accent-foreground",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
      )}
    >
      <RadioGroupPrimitive.Indicator className="absolute top-1.5 right-2 flex size-3.5 items-center justify-center">
        <Check className="size-4" />
      </RadioGroupPrimitive.Indicator>
      <span className="inline-flex items-center gap-1.5">
        {icon}
        <span className={LABEL_HIDE_NARROW}>{label}</span>
      </span>
      <span
        className={cn(
          "pl-6 text-xs leading-snug",
          warning ? "text-warning/80" : "text-muted-foreground",
        )}
      >
        {description}
      </span>
    </RadioGroupPrimitive.Item>
  );
}

// Narrows a Radix RadioGroup onValueChange string to the AuthMode union.
function isAuthMode(v: string): v is AuthMode {
  return v === "per_call" || v === "no_confirmation";
}
