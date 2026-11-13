import { useEffect } from "react";

// The shell's context-menu policy (ADR-0149): one document-level `contextmenu`
// listener keeps the WebView's native menu only where it is a capability --
// text editing surfaces and live text selections -- and everywhere else
// prevents it, so browser items (reload / print) never surface in the shell.
// Custom menus never need shell-side registration: their triggers prevent the
// event before this listener runs, and the defaultPrevented exemption below
// makes the two layers mutually exclusive.

const EDITABLE_SELECTOR = "[contenteditable]";

// Text editing surfaces keep the native editing menu (copy / paste / IME).
function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && (target.isContentEditable || target.closest(EDITABLE_SELECTOR) !== null))
  );
}

// A live selection keeps the native menu: right-click copy on message text is
// the habitual gesture, and the shell has no custom selection surface yet.
function hasTextSelection(): boolean {
  return (window.getSelection()?.toString() ?? "").length > 0;
}

// The whitelist read. Exported for the policy's branch pins; the hook is the
// only runtime consumer.
export function allowsNativeContextMenu(target: EventTarget | null, defaultPrevented: boolean): boolean {
  return defaultPrevented || isEditableTarget(target) || hasTextSelection();
}

export function useContextMenuPolicy(): void {
  useEffect(() => {
    const handle = (event: MouseEvent): void => {
      if (allowsNativeContextMenu(event.target, event.defaultPrevented)) return;
      event.preventDefault();
    };
    document.addEventListener("contextmenu", handle);
    return () => document.removeEventListener("contextmenu", handle);
  }, []);
}
