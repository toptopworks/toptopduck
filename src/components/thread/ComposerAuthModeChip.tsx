import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, Hand, ShieldAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import { getAuthorizationMode, setAuthorizationMode } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import { log } from "../../lib/log";
import { sessionKeys } from "../../session/queryKeys";
import type { AuthMode } from "../../types/approval";
import { AUTH_MODE_DEFAULT } from "../../types/approval";
import { Select, SelectContent, SelectTrigger, SelectValue } from "../ui/select";

// Composer authorization-mode selector (ADR-0080, issue #352 / #482). The
// session's execution posture at the turn-launch point (ADR-0083 puts the
// execution-posture switches on the composer button row): a Radix Select
// dropdown between confirm-each-call (the default, Hand icon) and
// no-confirmation (ShieldAlert icon, every external tool call auto-passes
// through the gateway). The posture is session-scoped and resume-resetting --
// the backend (`open_duck` -> `reset_approval`) returns it to per_call on a
// resume, and this Select re-reads it via the session-keyed query (a resume
// mints a NEW session id whose fresh SessionPane mount issues the read). The
// no-confirmation trigger face rides the --warning token: the posture is an
// explicit informed widening, and the warning hue marks it while it is on
// (ADR-0080 / ADR-0083).
//
// The trigger label hides when the question-bar @container drops to a narrow
// rail (issue #482); the dropdown panel is portaled outside the container so
// its copy of the label stays visible regardless. The per-item description is
// a sibling of ItemText -- it shows in the dropdown only, never echoed in the
// trigger.
//
// Reads + writes go through the get/set authorization-mode IPC (#294); a
// rejected write (session dropped mid-flight, mid-resume swap) keeps the
// server posture -- the Select resyncs via refetch and never shows a posture
// the backend did not grant. A rejected READ is surfaced via log.warn.

export type ComposerAuthModeChipProps = {
  /** The session whose posture this chip reads / switches. */
  sessionId: string;
};

// Trigger face chrome. The neutral face rides the composer chrome tokens
// (matching the ComposerProviderPicker trigger beside it); the no-confirmation
// face consumes the --warning token (border / fill / text).
const TRIGGER_NEUTRAL = "border-border bg-card hover:bg-muted";
const TRIGGER_WARNING =
  "border-warning/40 bg-warning/10 text-warning hover:bg-warning/20";

// Hides the mode label when the question-bar @container (set on the QuestionBar
// form) drops below the narrow-rail threshold, leaving the mode icon + chevron
// visible. The portaled dropdown panel sits outside the container so its label
// copy is unaffected.
const LABEL_HIDE_NARROW = "@max-[320px]:hidden";

export function ComposerAuthModeChip({ sessionId }: ComposerAuthModeChipProps) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  // Guards the write window: a selection that lands while the set IPC is in
  // flight is dropped instead of re-firing (the disabled attr is the visual
  // half of the same gate).
  const [switching, setSwitching] = useState(false);

  // The session's posture (backend truth). Under the session prefix so a
  // close's removeQueries drops it with the rest; a resume lands the reset
  // value via the fresh SessionPane mount (see file header).
  const { data, isError, error } = useQuery({
    queryKey: sessionKeys.authMode(sessionId),
    queryFn: () => getAuthorizationMode(sessionId),
  });
  // AUTH_MODE_DEFAULT is the single TS expression of the backend's
  // #[default] PerCall (ADR-0080): the honest-default face renders immediately
  // while the read settles, never a blank slot.
  const mode: AuthMode = data ?? AUTH_MODE_DEFAULT;
  const noConfirmation = mode === "no_confirmation";

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

  async function handleChange(next: AuthMode) {
    if (switching || next === mode) return;
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
  const ariaLabel = intl.formatMessage(
    { id: "composer.authMode.ariaLabel", defaultMessage: "Authorization mode: {mode}" },
    { mode: noConfirmation ? noConfirmationLabel : perCallLabel },
  );

  return (
    <Select value={mode} onValueChange={(v) => { if (isAuthMode(v)) void handleChange(v); }} disabled={switching}>
      <SelectTrigger
        aria-label={ariaLabel}
        className={cn(
          "gap-1.5 px-2.5",
          noConfirmation ? TRIGGER_WARNING : TRIGGER_NEUTRAL,
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="min-w-[16rem]">
        <AuthModeItem
          value="per_call"
          icon={<Hand className="size-4 shrink-0" aria-hidden="true" />}
          label={perCallLabel}
          description={perCallDesc}
        />
        <AuthModeItem
          value="no_confirmation"
          icon={<ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />}
          label={noConfirmationLabel}
          description={fullAccessDesc}
          warning
        />
      </SelectContent>
    </Select>
  );
}

// A SelectItem variant whose icon + title ride inside ItemText (the trigger
// echo source) while the description sits as a sibling (dropdown-only). Uses
// SelectPrimitive.Item directly instead of the shared SelectItem wrapper,
// which places ALL children inside ItemText and cannot express the description
// slot.
type AuthModeItemProps = {
  value: AuthMode;
  icon: ReactNode;
  label: string;
  description: string;
  /** Marks the item with the --warning token (no_confirmation posture). */
  warning?: boolean;
};

function AuthModeItem({
  value,
  icon,
  label,
  description,
  warning = false,
}: AuthModeItemProps) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      value={value}
      className={cn(
        "focus:bg-accent hover:bg-accent relative flex flex-col gap-0.5 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none",
        // The warning item keeps its --warning text on hover (only the
        // background shifts); the neutral item follows the standard accent
        // text swap.
        warning ? "text-warning" : "focus:text-accent-foreground",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
      )}
    >
      <span className="absolute right-2 top-1.5 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>
        <span className="inline-flex items-center gap-1.5">
          {icon}
          <span className={LABEL_HIDE_NARROW}>{label}</span>
        </span>
      </SelectPrimitive.ItemText>
      <span
        className={cn(
          "pl-6 text-xs leading-snug",
          warning ? "text-warning/80" : "text-muted-foreground",
        )}
      >
        {description}
      </span>
    </SelectPrimitive.Item>
  );
}

// Narrows a Radix Select onValueChange string to the AuthMode union.
function isAuthMode(v: string): v is AuthMode {
  return v === "per_call" || v === "no_confirmation";
}
