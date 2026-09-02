// The copied-acknowledgment state machine shared by the copy affordances
// (CopyButton, ResultActions' copy-all): flips `copied` on demand and reverts
// it after the hold window. A fresh acknowledge re-arms the timer (a repeat
// copy re-acknowledges); unmount clears it. Each consumer keeps its own
// tooltip-open state -- only the ack flag + timer live here.

import { useEffect, useRef, useState } from "react";

// How long the copied acknowledgment holds before the glyph reverts (ms).
const COPIED_HOLD_MS = 1500;

export function useCopiedAck(): {
  copied: boolean;
  /** Flip the ack on and (re-)arm the hold timer. */
  acknowledge: () => void;
} {
  const [copied, setCopied] = useState(false);
  // The revert timer id, nulled when it fires or on a re-acknowledge. The
  // unmount cleanup clears the timer; an in-flight clipboard write's
  // continuation may still call the setter after unmount -- a harmless no-op
  // on React 18+.
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  function acknowledge() {
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setCopied(false);
    }, COPIED_HOLD_MS);
  }
  return { copied, acknowledge };
}
