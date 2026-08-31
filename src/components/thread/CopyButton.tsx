// The chat projection's copy affordance (ADR-0103, issue #609): one rendering
// for the user bubble's question copy and the closing meta row's reply copy.
// Click writes to the system clipboard and acknowledges in place (no toast):
// the glyph flips to a check and the tooltip pops open on the localized
// "Copied" (accessible name follows) for the hold window -- no pointer over
// the button needed -- then revert so a repeat copy re-acknowledges. The
// idle tooltip carries the caller's type-specific label.
// A clipboard that rejects (permission denied / non-secure context) leaves
// the glyph unchanged -- an honest no-op, not a fake ack.
//
// i18n (ADR-0052): the caller passes its own localized idle label (each call
// site keeps its static-literal formatMessage for @formatjs/cli extract);
// the shared "Copied" flip label is this file's own static literal.

import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { log } from "../../lib/log";

// How long the copied acknowledgment holds before the glyph reverts (ms).
const COPIED_HOLD_MS = 1500;

export function CopyButton({ text, label }: { text: string; label: string }) {
  const intl = useIntl();
  const [copied, setCopied] = useState(false);
  // The tooltip's natural open state (hover/focus intent, tracked through
  // onOpenChange); the copied ack ORs in to force the tooltip open for the
  // hold window so the acknowledgment pops up on its own.
  const [tooltipOpen, setTooltipOpen] = useState(false);
  // The revert timer id, nulled when it fires or on a re-copy (a fresh click
  // always re-arms it). The unmount cleanup clears the timer; an in-flight
  // clipboard write's continuation may still call the setter after unmount --
  // a harmless no-op on React 18+.
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setCopied(false);
      }, COPIED_HOLD_MS);
    } catch (e) {
      // Clipboard unavailable (permissions / non-secure context): no ack
      // flip -- an honest no-op, but the lane stays diagnosable in the log
      // sink (VegaChart's precedent for a degraded user action).
      log.warn("CopyButton", "clipboard write failed", e);
    }
  }

  // The tooltip mirrors the accessible name (idle label / copied ack): the
  // type-specific verb surfaces on hover, and after a copy the ack pops the
  // tooltip open (controlled open ORs the copied flag into the natural
  // hover/focus intent) -- visible even on touch, where no hover ever opens
  // it. The sr-only span carries the accessible name (NOT aria-label),
  // matching the QuestionBar submit/stop precedent so getByLabelText stays
  // scoped.
  const copiedLabel = intl.formatMessage({
    id: "thread.copy.copied",
    defaultMessage: "Copied",
  });
  return (
    <Tooltip open={copied || tooltipOpen} onOpenChange={setTooltipOpen}>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          // Constant box: the ack never widens the button, so the meta row
          // holds still under the pointer while the flip holds.
          className="copy-button shrink-0 size-6 p-1 text-muted-foreground hover:text-foreground"
          onClick={() => {
            void copy();
          }}
        >
          {copied ? (
            <Check aria-hidden="true" className="w-3.5 h-3.5" />
          ) : (
            <Copy aria-hidden="true" className="w-3.5 h-3.5" />
          )}
          <span className="sr-only">{copied ? copiedLabel : label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? copiedLabel : label}</TooltipContent>
    </Tooltip>
  );
}
