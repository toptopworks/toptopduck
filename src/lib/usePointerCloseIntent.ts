import { useEffect, useRef } from "react";

// Cross-surface classification of the gesture that closes an overlay (a
// dialog, a menu, the settings view): whichever input fired last wins. A
// pointer-initiated close must not yank focus back to the opener when the
// opener is a Radix Tooltip trigger -- the tooltip opens on any focus not
// mid-pointerdown, so the restore strands it open with no hover (the
// release-build gear report). Keyboard closes (ESC, Enter) keep the restore:
// focus-return is the a11y contract there, and a focus-opened tooltip on a
// keyboard user's opener is standard Tooltip semantics.
//
// The listeners sit on window at capture phase so they see gestures aimed at
// portaled content (Radix dialogs/menus) and at the shell outside the
// closing surface. jsdom's synthetic clicks fire no pointerdown, so the test
// surface defaults to the keyboard (restore-kept) branch.
//
// Consume sites pair the ref with the surface's focus-restore escape hatch:
// a hand-wired .focus() (SettingsView) or Radix's onCloseAutoFocus (the
// posture trigger's DropdownMenuContent and the runtime picker's
// PopoverContent), where event.preventDefault() drops the default trigger
// refocus.
export function usePointerCloseIntent() {
  const ref = useRef(false);
  useEffect(() => {
    const markPointer = () => {
      ref.current = true;
    };
    const markKeyboard = () => {
      ref.current = false;
    };
    window.addEventListener("pointerdown", markPointer, true);
    window.addEventListener("keydown", markKeyboard, true);
    return () => {
      window.removeEventListener("pointerdown", markPointer, true);
      window.removeEventListener("keydown", markKeyboard, true);
    };
  }, []);
  return ref;
}
