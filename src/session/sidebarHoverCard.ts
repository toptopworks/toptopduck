import { useEffect, useRef, useState, type FocusEvent, type RefObject } from "react";

// The sidebar row hover-card machine and its per-row bridge (issue #1325):
// the two halves of the controlled metadata-card choreography, collected out
// of SessionSidebar into one species module (the rowHints.ts precedent).
//
// The LIST-LEVEL machine (useSidebarHoverCard, issue #1175): the OPEN key is
// owned by the sidebar, not per row, so at most one metadata card exists at
// any moment -- moving to a new row swaps the card (unmounting the old
// portal) instead of stacking fading ones behind the pointer. A per-row
// boolean cannot guarantee that: a pointerleave lost to the pill's
// pointer-events toggling strands that row's card open forever; here a lost
// leave self-heals the moment any other row is entered, and the list-level
// leave is the final backstop. Delays keep the old posture: 300 ms to open
// (sweep-proof), 200 ms grace on leave (cancelled by entering the card
// itself -- read-only per ADR-0127, but the pointer may still sweep onto it
// to read).
//
// hoverKey rides a ref, not state: render consumes only cardKey (the shown
// card), while hoverKey feeds the stale-leave guard and the list backstop --
// handler-only reads. State here would re-render every row at
// pointer-crossing frequency with no visible change.
//
// The ROW-LEVEL bridge (useSidebarHoverCardBridge, issue #1321): the
// controlled HoverCard open state -- the machine owns the boolean instead of
// Radix's uncontrolled trigger state machine. Sweeping the pointer down the
// pills toggles a pill's pointer-events as each row's :hover flips, which
// desyncs Radix's trigger/content bookkeeping and strands stuck-open
// metadata cards; a controlled open cannot strand. The bridge classifies
// each row's intents so only genuine interaction opens the card:
//
// - Pointer-on-row marker (ptrInRef): set by the li's own pointer handlers.
// - Keyboard-focus marker (kbFocusRef): :focus-visible at the li's focusin
//   (set in onFocus, cleared in onBlur). With ptrInRef this forms the
//   bridge's two legitimate intents; a focusin matching NEITHER (a
//   programmatic restore) leaves both false, silencing the bridge.
// - Native pointerleave backstop. CDP-measured: when the pointer leaves the
//   row into a PORTAL layer (the row menu), the native pointerleave fires
//   but React's synthetic onPointerLeave can fail to derive -- leaving
//   ptrInRef and the machine's hoverKey stuck "on", which let every later
//   Radix intent (e.g. a dialog's focus restore) bridge through as a
//   genuine hover. The native event is authoritative; a double-run
//   (synthetic + native) is absorbed by the machine's stale-leave guard.
// - The three-state gate on Radix's own intents. OPEN intents pass only for
//   genuine interaction: the pointer on the row (ptrInRef) or keyboard
//   focus on the row (kbFocusRef, :focus-visible at the focusin). Radix
//   drives handleOpen from BOTH trigger pointer-enters and trigger focus,
//   and every programmatic restore the shell performs (menu close, dialog
//   close -- CDP-measured for the Rename dialog, whose close-restore
//   refocused the trigger and popped the card) arrives as an intent with
//   NEITHER marker on the row -- those are the spurious pops the gate
//   exists to silence. CLOSE intents pass UNCONDITIONALLY: Radix defers
//   every intent through a timer even at closeDelay 0, while the li's
//   onBlur clears kbFocusRef synchronously during the focusout dispatch --
//   a gated close would read both markers false and strand an open card
//   the instant a keyboard user Tabs off the row (the Escape dismiss feeds
//   this same handler and would die there too). The leave is idempotent
//   and stale-key guarded, so an unconditional close cannot mis-close
//   anything.
// - The focusin classifier. A pointer-modality (:focus-visible false)
//   focusin on the row is always a PROGRAMMATIC restore (dialog/menu
//   close-restore -- CDP round 7: the Rename dialog's restore landed here
//   and its follow-up Radix intent popped the card): clear the pointer
//   markers AND run the leave so the intent Radix fires right after cannot
//   bridge through as a hover. Keyboard modality (Tab / Escape flows) sets
//   kbFocusRef instead, keeping the bridge open -- trigger focus is the
//   non-pointer user's only path to the card. Chromium answers
//   :focus-visible correctly at the focusin instant; the try/catch is the
//   jsdom guard (older jsdom throws on the selector, and jsdom's own loose
//   implementation returning true just means the markers stay -- the
//   keyboard branch is what tests never reach).
//
// Cf. rowHints.ts (issue #1325, deliberately NOT converged): the working-set
// row-hint protocol is the same-family artifact -- both fight Chromium's
// synthetic pointerEnter after a modal unlock (same-source artifact, tuned
// per surface at 250 ms here vs 300 ms there) -- but the protocols'
// lifetimes fork (dwell/grace timers vs restore gate + trigger capture), so
// a forced merge would be a false seam; each stays its protocol's owner.

// How long the row-menu enter suppression (menuArmRef) stays armed after its
// last refresh: wide enough to cover Radix's post-mount open intent (~17 ms,
// CDP-measured) and the browser's synthetic pointerEnter on menu close, far
// below any genuine hover re-entry.
export const MENU_REENTRY_GRACE_MS = 250;

// The list-level single-flight machine's verbs. Consumers hold the verbs,
// never the guard refs.
export interface SidebarHoverCardMachine {
  /** Whether this key's card is the one currently shown. */
  isOpen(key: string): boolean;
  /** A row entry intent (the li's pointer enter, or a gated Radix open
   *  bridged by useSidebarHoverCardBridge). Suppressed for the row's own
   *  open menu. */
  enter(key: string): void;
  /** A row leave intent (synthetic or native backstop; idempotent and
   *  stale-key guarded). */
  leave(key: string): void;
  /** Cancels the close grace while the pointer is ON the card itself. */
  cardEnter(): void;
  /** Schedules the card's own close (the row-leave guard cannot serve this
   *  path -- hoverKey is already null once the pointer is on the card). */
  cardLeave(): void;
  /** The row menu's open flips: opening retires the card (the pointer is
   *  necessarily on the row, so the two row-tail overlays would stack),
   *  marks the row's menu open (silencing ALL enter intents for the row --
   *  pointer and Radix's bridge ones alike), and arms the re-entry window;
   *  close clears the open mark and refreshes the arm for the browser's
   *  synthetic pointerEnter at the pointer's position. */
  menuOpenChange(key: string, open: boolean): void;
  /** The .session-list leave backstop: a pointerleave lost to the pill's
   *  pointer-events toggling never reaches the row; the list-level leave
   *  is the final backstop. */
  listLeave(): void;
}

export function useSidebarHoverCard(): SidebarHoverCardMachine {
  const hoverKeyRef = useRef<string | null>(null);
  const [cardKey, setCardKey] = useState<string | null>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  // Close-burst re-entry suppression: the modal menu swallows the row's
  // pointer event stream, and on close the browser re-dispatches a synthetic
  // pointerEnter at the pointer's position -- the pointer never left the
  // row (Escape close) -- which must not re-arm the 300 ms dwell. The arm
  // expires MENU_REENTRY_GRACE_MS after its last refresh, so a genuine
  // later re-entry opens the card again; a real pointer leave also clears
  // it outright. (Enter intents DURING the open menu are menuOpenKeyRef's
  // job -- this one only owns the post-close burst.)
  const menuArmRef = useRef<{ key: string; at: number } | null>(null);
  // The row whose actions menu is currently OPEN: every enter intent for
  // that row -- the pointer's and, CDP-verified, Radix's own bridge intents
  // fired on focus hand-off into the portal content (with NO underlying DOM
  // event, possibly several, AFTER the row's pointerleave already cleared
  // menuArmRef) -- is suppressed for the menu's whole lifetime. Cleared at
  // close; menuArmRef then takes over for the close-burst window.
  const menuOpenKeyRef = useRef<string | null>(null);
  const clearHoverTimers = () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  };
  const rowHoverEnter = (key: string) => {
    const arm = menuArmRef.current;
    if (arm && arm.key === key) {
      // Within the grace window the enter is a menu-interaction artifact;
      // past it, the arm is stale and a real re-entry must open the card.
      // The wall-clock read is an EVENT-instant measurement, not a render
      // side effect -- this closure only ever runs from pointer/focus
      // handlers inside the hook's verbs, outside the render path.
      if (Date.now() - arm.at < MENU_REENTRY_GRACE_MS) return;
      menuArmRef.current = null;
    }
    clearHoverTimers();
    hoverKeyRef.current = key;
    // Entering a DIFFERENT row retires the shown card immediately. The
    // 200 ms close grace belongs to the row->card read path only; clearing
    // the previous row's leave timer without this kept the OLD card on
    // screen the whole time the pointer traveled (each new row's enter
    // cancelled the pending close, and the new card only opens after a
    // 300 ms dwell) -- the card must vanish while moving and reappear
    // only once the pointer settles.
    if (cardKey !== null && cardKey !== key) setCardKey(null);
    openTimer.current = window.setTimeout(() => {
      // The dwell only fires while the pointer still rides the row
      // (hoverKeyRef is nulled by the leave). Intents that slip past every
      // entry gate -- CDP-traced Radix internal ones re-fire long after the
      // pointer left, e.g. after a dialog's focus restore -- must not open
      // a card for a row the pointer has left.
      if (hoverKeyRef.current !== key) return;
      setCardKey(key);
    }, 300);
  };
  const rowHoverLeave = (key: string) => {
    // A real leave disarms the suppression outright (see menuArmRef).
    if (menuArmRef.current?.key === key) menuArmRef.current = null;
    // A stale leave from a row the pointer already left is ignored.
    if (hoverKeyRef.current !== key) return;
    clearHoverTimers();
    hoverKeyRef.current = null;
    closeTimer.current = window.setTimeout(() => setCardKey(null), 200);
  };
  const cardHoverEnter = () => window.clearTimeout(closeTimer.current);
  // Leaving the CARD schedules its own close -- it must NOT reuse
  // rowHoverLeave: by the time the pointer reached the card, the row's
  // leave already nulled hoverKey, so rowHoverLeave's stale-key guard would
  // swallow the close and strand the card open forever.
  const cardHoverLeave = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setCardKey(null), 200);
  };
  useEffect(() => clearHoverTimers, []);
  return {
    isOpen: (key) => cardKey === key,
    enter: (key) => {
      // Suppressed for the row's own open menu (menuOpenKeyRef): this verb
      // is BOTH the li's pointer entry and, via the bridge, Radix's
      // internal intent entry.
      if (menuOpenKeyRef.current === key) return;
      rowHoverEnter(key);
    },
    leave: rowHoverLeave,
    cardEnter: cardHoverEnter,
    cardLeave: cardHoverLeave,
    menuOpenChange: (key, open) => {
      if (open) {
        menuOpenKeyRef.current = key;
        menuArmRef.current = { key, at: Date.now() };
        clearHoverTimers();
        setCardKey(null);
      } else {
        menuOpenKeyRef.current = null;
        menuArmRef.current = { key, at: Date.now() };
      }
    },
    listLeave: () => {
      if (hoverKeyRef.current !== null) rowHoverLeave(hoverKeyRef.current);
    },
  };
}

// The per-row bridge the row holds: the li's handlers, the HoverCard root's
// controlled open + intent gate, and the card content's handlers. The li ref
// stays with the row (it renders the element); the bridge takes it as an
// argument for the native pointerleave backstop.
interface SidebarHoverCardBridge {
  /** Controlled card visibility for this row (the machine's single slot,
   *  read against this row's key). */
  cardOpen: boolean;
  /** Spread onto the li (the HoverCardTrigger child). */
  liProps: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    onFocus: (e: FocusEvent<HTMLElement>) => void;
    onBlur: () => void;
  };
  /** The HoverCard root's onOpenChange: the machine's intent gate. */
  hoverOpenChange: (open: boolean) => void;
  /** Spread onto the HoverCardContent. */
  cardProps: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
  };
}

export function useSidebarHoverCardBridge(
  machine: SidebarHoverCardMachine,
  key: string,
  liRef: RefObject<HTMLLIElement | null>,
): SidebarHoverCardBridge {
  const ptrInRef = useRef(false);
  const kbFocusRef = useRef(false);
  useEffect(() => {
    const li = liRef.current;
    if (!li) return;
    const onNativeLeave = () => {
      ptrInRef.current = false;
      machine.leave(key);
    };
    li.addEventListener("pointerleave", onNativeLeave);
    return () => li.removeEventListener("pointerleave", onNativeLeave);
  }, [machine, key, liRef]);
  return {
    cardOpen: machine.isOpen(key),
    liProps: {
      onPointerEnter: () => {
        ptrInRef.current = true;
        machine.enter(key);
      },
      onPointerLeave: () => {
        ptrInRef.current = false;
        machine.leave(key);
      },
      onFocus: (e) => {
        // Classifies the focusin for the bridge (see the module header).
        try {
          if (e.target.matches(":focus-visible")) {
            kbFocusRef.current = true;
          } else {
            ptrInRef.current = false;
            machine.leave(key);
          }
        } catch {
          /* jsdom lacks the selector -- keep the markers untouched */
        }
      },
      onBlur: () => {
        kbFocusRef.current = false;
      },
    },
    hoverOpenChange: (open) => {
      // Bridge Radix's own open/close intents into the machine through the
      // three-state gate (see the module header).
      if (open && !ptrInRef.current && !kbFocusRef.current) return;
      if (open) machine.enter(key);
      else machine.leave(key);
    },
    cardProps: {
      onPointerEnter: machine.cardEnter,
      onPointerLeave: machine.cardLeave,
    },
  };
}
