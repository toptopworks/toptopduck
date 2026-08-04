import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { cn } from "@/lib/utils";
import { getAuthorizationMode, setAuthorizationMode } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import { log } from "../../lib/log";
import { sessionKeys } from "../../session/queryKeys";
import type { AuthMode } from "../../types/approval";
import { AUTH_MODE_DEFAULT } from "../../types/approval";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

// Composer authorization-mode chip (ADR-0080, issue #352). The session's
// execution posture at the turn-launch point (ADR-0083 puts the
// execution-posture switches on the composer button row, distinct from the
// "+" context additions): a two-position toggle between confirm-each-call
// (the default) and no-confirmation (every external tool call auto-passes
// through the gateway). The posture is session-scoped and resume-resetting --
// the backend (`open_duck` -> `reset_approval`) returns it to per_call on a
// resume, and this chip re-reads it via the session-keyed query (a resume
// mints a NEW session id whose fresh SessionPane mount issues the read; the
// resume-path invalidateQueries fires against a not-yet-mounted key and is a
// no-op). The no-confirmation face rides the --warning token: the posture is
// an explicit informed widening, and the warning hue marks it while it is on
// (ADR-0080 / ADR-0083).
//
// Reads + writes go through the get/set authorization-mode IPC (#294); a
// rejected write (session dropped mid-flight, mid-resume swap) keeps the
// server posture -- the chip resyncs via refetch and never shows a posture
// the backend did not grant. A rejected READ is surfaced via log.warn (without
// it the chip would sit silently on the safe per_call default with no signal
// that the backend is unreachable).

export type ComposerAuthModeChipProps = {
  /** The session whose posture this chip reads / switches. */
  sessionId: string;
};

// Chip chrome sized to the composer control row (h-9 matches the icon-button
// triggers beside it). The per-call face rides the neutral composer chrome;
// the no-confirmation face consumes the --warning token (border / fill /
// text) like the Alert warning variant.
const CHIP_BASE =
  "composer-auth-mode-chip inline-flex h-9 items-center justify-center rounded-md border px-3 text-sm whitespace-nowrap transition-colors cursor-pointer disabled:pointer-events-none disabled:opacity-50";
const CHIP_PER_CALL = "border-border bg-card text-foreground hover:bg-muted";
const CHIP_NO_CONFIRMATION =
  "border-warning/40 bg-warning/10 text-warning hover:bg-warning/20";

export function ComposerAuthModeChip({ sessionId }: ComposerAuthModeChipProps) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  // Guards the write window: a click that lands while the set IPC is in
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

  const modeLabel = noConfirmation
    ? intl.formatMessage({
        id: "composer.authMode.noConfirmation",
        defaultMessage: "No confirmation",
      })
    : intl.formatMessage({
        id: "composer.authMode.perCall",
        defaultMessage: "Confirm each call",
      });
  // The tooltip names the consequence of the CURRENT posture (what the
  // switch means), so the warning-color face also reads honestly for AT /
  // hover users. Static-literal ids so @formatjs/cli extract resolves them.
  const tooltip = noConfirmation
    ? intl.formatMessage({
        id: "composer.authMode.tooltip.noConfirmation",
        defaultMessage:
          "No-confirmation is on: every external tool call auto-passes for this session. Resume resets it to confirm-each-call.",
      })
    : intl.formatMessage({
        id: "composer.authMode.tooltip.perCall",
        defaultMessage:
          "External tool calls ask for confirmation each time. Switch to no-confirmation to auto-pass them for this session (resume resets it).",
      });
  const ariaLabel = intl.formatMessage(
    { id: "composer.authMode.ariaLabel", defaultMessage: "Authorization mode: {mode}" },
    { mode: modeLabel },
  );

  async function toggle() {
    if (switching) return;
    const next: AuthMode = noConfirmation ? "per_call" : "no_confirmation";
    setSwitching(true);
    try {
      await setAuthorizationMode(sessionId, next);
      // The write is the truth source: seed the cache directly (no extra IPC
      // round-trip; a later remount refetches the same value).
      queryClient.setQueryData(sessionKeys.authMode(sessionId), next);
    } catch (e) {
      // Keep the server posture: refetch so the chip re-reads the backend
      // truth instead of showing a toggled face the write never granted.
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

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(CHIP_BASE, noConfirmation ? CHIP_NO_CONFIRMATION : CHIP_PER_CALL)}
          aria-label={ariaLabel}
          aria-pressed={noConfirmation}
          disabled={switching}
          onClick={() => void toggle()}
        >
          {modeLabel}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
