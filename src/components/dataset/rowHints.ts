import { useRef, useState, type RefObject } from "react";

// The working-set row-hint protocol (issues #865 and #759, converged into
// this one owner by issue #1073): every tooltip on a working-set row -- the
// three action hints (rename / replace / delete) and the stale chip -- is a
// controlled Radix Tooltip driven by ONE open slot keyed by row + kind.
// This module is the protocol's sole owner: the pure
// transfer rules (reduceTip / sameTipKey / the suppression-window predicate)
// and the useRowHints hook that wires them to state, refs and the
// dialog-close handoff live here, and consumers hold the controls object,
// never the underlying refs. The protocol's five transfer sequences:
//
// 1. Mutex. A second tooltip opening necessarily closes the first. The
//    hints themselves are controlled Radix Tooltips per #865, which
//    rejected OS-native titles for them (chrome follows the OS, not the
//    theme tokens) -- and the controlled opens are what need this slot.
//    Two mechanisms share the job. Radix-internal opens (the pointermove path
//    every trigger carries; the stale chip is the only row tooltip without
//    our own handlers) broadcast a document tooltip.open event that every
//    MOUNTED TooltipContent answers by closing itself -- peers are gone
//    before the opener's onOpenChange reaches the slot. Our direct opens
//    (the hints' pointer handlers) set the slot without broadcasting (the
//    dispatch sits inside Radix's own state setter, so a prop-driven open
//    never emits it), and the single-source key is what excludes those. The
//    pointermove path is also transit-gated by the provider
//    (isPointerInTransit, set while the pointer crosses a HOVERABLE
//    tooltip's exit grace area -- the stale chip's, the one row tooltip
//    without disableHoverableContent), so a sweep can silently swallow a
//    Radix-side open; the direct handlers are what actually open the hints.
//    Opens take the slot unconditionally: Radix's own opens arrive on an
//    empty slot anyway (the broadcast has already closed the mounted peers),
//    and the hints' direct opens are ordered pointer-leave-then-enter by the
//    event sequence, so a moving pointer releases the old hint before the
//    next one asks -- which also self-heals the ghost key of a row that
//    unmounted mid-hover without a pointerleave. Closes are keyed: a
//    stale-timer close for another tooltip must not clear the one that is
//    open now.
// 2. Suppression window. Closing a dialog lifts Radix's modal pointer-events
//    lock on <body>, and Chromium answers that by re-dispatching a pointer
//    enter at the pointer's current position -- which would re-open the hint
//    that was showing before the click. Hints ignore pointer enters within
//    300ms of a dialog close; real pointer travel always arrives later.
// 3. Focus-restore gate. The dialog-close programmatic focus restore is not
//    user navigation, but the keyboard heuristic makes the restored focus
//    :focus-visible, so it must not re-open a hint on EITHER open path: the
//    hint's own focus handler and Radix's internal any-focus open (focus
//    events are non-cancelable, so it cannot be refused at the handler) both
//    drop opens while the restore is in flight.
// 4. Trigger capture. Radix's close-time focus restore targets the
//    DialogTrigger context ref, but the openers are the list's per-row
//    buttons (not DialogTrigger), so the restore is wired by hand: captured
//    on open, re-focused on close (issue #759 focus-management AC).
// 5. Deferred close handoff. closeDialog clears the dialog target first,
//    then restores focus one setTimeout(0) out -- deferred past the focus
//    trap, which re-focuses the dialog content on any focus-out while the
//    scope is mounted, and past Radix's own unmount-time restore (also a
//    setTimeout(0), targeting the DialogTrigger ref the row buttons never
//    fill). On Save / Delete-confirm the mutation's loading gate has already
//    disabled the opener (the mutation fires before the close and the
//    loading flip is batched into the same commit), and focus() on a
//    disabled button is ignored -- the restore falls back to the list
//    container (focusable programmatically only) so keyboard users keep a
//    place in the working-set region.
//
// Not converged here, on purpose: the dialog mounting (the rename / delete
// targets and their components) stays with the list -- the dialogs are pure
// presentation consumers of the closeDialog handoff, not protocol -- and the
// replace path's Tauri file picker is picker adaptation, not hint protocol
// (issue #1073 non-goals).

// The row-tooltip slot identity: which tooltip (kind) on which row owns the
// mutex.
export type RowTipKind = "rename" | "replace" | "delete" | "stale";
export interface TipKey {
  row: string;
  kind: RowTipKind;
}
export const sameTipKey = (a: TipKey, b: TipKey) => a.row === b.row && a.kind === b.kind;

// The mutex transfer (sequence 1): opens take the slot, closes are keyed.
export const reduceTip = (current: TipKey | null, key: TipKey, next: boolean): TipKey | null => {
  if (!next) return current !== null && sameTipKey(current, key) ? null : current;
  return key;
};

// Hints ignore pointer enters within this window of a dialog close
// (sequence 2).
export const POINTER_SUPPRESSION_WINDOW_MS = 300;
export const isWithinSuppressionWindow = (dialogClosedAt: number, now: number): boolean =>
  now - dialogClosedAt <= POINTER_SUPPRESSION_WINDOW_MS;

// The per-row controls the hook hands out (the rows' only view of the
// protocol -- none of the guard refs cross this surface; the fallback
// listRef below is the hook's one wiring duty). The guarded entries carry
// the hint-specific gating; setTip stays the raw, ungated transfer for the
// stale chip's Radix bridge (its opens need no restore gate: the restore
// never lands on the chip) and for the closes.
export interface RowTipControls {
  openKey: TipKey | null;
  setTip: (key: TipKey, next: boolean) => void;
  // Mouse pointer-enter open, dropped inside the suppression window
  // (sequence 2). Touch/pen pointers never open a hint.
  pointerEnter: (key: TipKey, pointerType: string) => void;
  // Keyboard-focus open, keyed off the :focus-visible heuristic and dropped
  // while the restore is in flight (sequence 3).
  focusOpen: (key: TipKey, target: Element) => void;
  // The action hints' Radix bridge: drops opens while the restore is in
  // flight (focus events are non-cancelable, so the gate cannot sit at the
  // handler), then applies the transfer (sequence 3).
  hintOpenChange: (key: TipKey, next: boolean) => void;
}

export interface RowHints {
  tip: RowTipControls;
  // The list container, focusable programmatically only (tabIndex -1): the
  // closeDialog fallback restore target (sequence 5). The consumer attaches
  // it to the list element.
  listRef: RefObject<HTMLUListElement | null>;
  // Captures the row button opening a dialog -- the hand-wired restore's
  // target (sequence 4).
  captureTrigger: (trigger: HTMLButtonElement) => void;
  // The dialog-close handoff (sequences 2-5): stamps the suppression
  // window, clears the dialog target synchronously, then restores focus one
  // setTimeout(0) out (falling back to the list when the opener is gone or
  // disabled) and clears the restore flag one tick after that.
  closeDialog: (clear: () => void) => void;
}

export function useRowHints(): RowHints {
  const [openTip, setOpenTip] = useState<TipKey | null>(null);
  const dialogClosedAtRef = useRef(0);
  const focusRestoreRef = useRef(false);
  const openTriggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const setTip = (key: TipKey, next: boolean) => setOpenTip((current) => reduceTip(current, key, next));

  const tip: RowTipControls = {
    openKey: openTip,
    setTip,
    pointerEnter: (key, pointerType) => {
      if (pointerType === "mouse" && !isWithinSuppressionWindow(dialogClosedAtRef.current, Date.now()))
        setTip(key, true);
    },
    focusOpen: (key, target) => {
      if (target.matches(":focus-visible") && !focusRestoreRef.current) setTip(key, true);
    },
    hintOpenChange: (key, next) => {
      if (next && focusRestoreRef.current) return;
      setTip(key, next);
    },
  };

  const captureTrigger = (trigger: HTMLButtonElement) => {
    openTriggerRef.current = trigger;
  };

  const closeDialog = (clear: () => void) => {
    dialogClosedAtRef.current = Date.now();
    clear();
    setTimeout(() => {
      focusRestoreRef.current = true;
      const trigger = openTriggerRef.current;
      if (trigger && trigger.isConnected && !trigger.disabled) {
        trigger.focus();
      } else {
        listRef.current?.focus();
      }
      // The focus handler consumed the flag synchronously if the restore
      // landed; clear it regardless so a later real Tab isn't suppressed.
      setTimeout(() => {
        focusRestoreRef.current = false;
      }, 0);
    }, 0);
  };

  return { tip, listRef, captureTrigger, closeDialog };
}
