import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowsNativeContextMenu, useContextMenuPolicy } from "../useContextMenuPolicy";

// The whitelist predicate behind the shell's context-menu policy (ADR-0149):
// native editing surfaces, live text selections, and events another surface
// already claimed (defaultPrevented) keep the native menu; everything else is
// suppressed so the shell never shows browser items (reload / print).
function el(tag: string, attrs: Record<string, string> = {}): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  document.body.append(element);
  return element;
}

function contextMenuEvent(): MouseEvent {
  return new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("allowsNativeContextMenu", () => {
  it("denies a plain element", () => {
    expect(allowsNativeContextMenu(el("div"), false)).toBe(false);
  });

  it("allows form fields and editable surfaces", () => {
    expect(allowsNativeContextMenu(el("input"), false)).toBe(true);
    expect(allowsNativeContextMenu(el("textarea"), false)).toBe(true);
    expect(allowsNativeContextMenu(el("div", { contenteditable: "true" }), false)).toBe(true);
    // An editable surface's descendants inherit the native menu.
    const editable = el("div", { contenteditable: "true" });
    const child = document.createElement("span");
    editable.append(child);
    expect(allowsNativeContextMenu(child, false)).toBe(true);
  });

  it("allows an event another surface already claimed", () => {
    // The Radix trigger's preventDefault precedes the document listener, so
    // the policy must not double-claim custom-menu surfaces.
    expect(allowsNativeContextMenu(el("div"), true)).toBe(true);
  });

  it("allows a live text selection and denies an empty one", () => {
    vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "selected text" } as unknown as Selection);
    expect(allowsNativeContextMenu(el("div"), false)).toBe(true);
    vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "" } as unknown as Selection);
    expect(allowsNativeContextMenu(el("div"), false)).toBe(false);
  });

  it("reads no selection when the API yields nothing", () => {
    vi.spyOn(window, "getSelection").mockReturnValue(null);
    expect(allowsNativeContextMenu(el("div"), false)).toBe(false);
  });
});

describe("useContextMenuPolicy", () => {
  it("suppresses the native menu on plain elements", () => {
    renderHook(() => useContextMenuPolicy());
    const target = el("div");
    const event = contextMenuEvent();
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("keeps the native menu on form fields", () => {
    renderHook(() => useContextMenuPolicy());
    const target = el("input");
    const event = contextMenuEvent();
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("keeps the native menu while text is selected", () => {
    renderHook(() => useContextMenuPolicy());
    vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "selected" } as unknown as Selection);
    const target = el("div");
    const event = contextMenuEvent();
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("respects a surface that already prevented the event", () => {
    renderHook(() => useContextMenuPolicy());
    const target = el("div");
    // The custom-menu trigger claims the event first (Radix's own handler in
    // production); the policy layer must leave it alone.
    target.addEventListener("contextmenu", (e) => e.preventDefault());
    const event = contextMenuEvent();
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("detaches on unmount", () => {
    const { unmount } = renderHook(() => useContextMenuPolicy());
    const target = el("div");
    unmount();
    const event = contextMenuEvent();
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
