// The chat projection's copy affordance (ADR-0103, issue #609): one rendering
// for the user bubble's question copy and the closing meta row's reply copy.
// Click writes to the system clipboard and flips the glyph to a check so the
// copy is acknowledged in place (no toast); the flip reverts after a beat so a
// repeat copy re-acknowledges. A clipboard that rejects (permission denied /
// non-secure context) leaves the glyph unchanged -- an honest no-op, not a
// fake ack.
//
// i18n (ADR-0052): the caller passes its own localized idle label (each call
// site keeps its static-literal formatMessage for @formatjs/cli extract);
// the shared "Copied" flip label is this file's own static literal.

import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

// How long the copied acknowledgment holds before the glyph reverts (ms).
const COPIED_HOLD_MS = 1500;

export function CopyButton({ text, label }: { text: string; label: string }) {
  const intl = useIntl();
  const [copied, setCopied] = useState(false);
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
    } catch {
      // Clipboard unavailable (permissions / non-secure context): no ack flip.
    }
  }

  // The sr-only span carries the accessible name (NOT aria-label), matching
  // the QuestionBar submit/stop precedent so getByLabelText stays scoped; the
  // name flips with the state so a screen reader hears the acknowledgment.
  return (
    <Button
      type="button"
      variant="ghost"
      className="copy-button size-6 shrink-0 p-1 text-muted-foreground hover:text-foreground"
      onClick={() => {
        void copy();
      }}
    >
      {copied ? (
        <Check aria-hidden="true" className="w-3.5 h-3.5" />
      ) : (
        <Copy aria-hidden="true" className="w-3.5 h-3.5" />
      )}
      <span className="sr-only">
        {copied
          ? intl.formatMessage({ id: "thread.copy.copied", defaultMessage: "Copied" })
          : label}
      </span>
    </Button>
  );
}
