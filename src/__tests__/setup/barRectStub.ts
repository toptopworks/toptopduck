import { vi } from "vitest";

// Shared `.question-bar` geometry stubs for the file-drop hit-test tests
// (#501). jsdom has no layout, so every drop-router test pins the composer
// bar's getBoundingClientRect before firing physical drop positions (Tauri's
// onDragDropEvent position, converted by the router via devicePixelRatio).

export interface BarRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The DOMRect mock body shared by both stubs (jsdom's DOMRect shape). */
function domRect(rect: BarRect): DOMRect {
  return {
    x: rect.left,
    y: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
    toJSON: () => ({}),
    ...rect,
  } as DOMRect;
}

/** Mount a `.question-bar` element with a stubbed rect for tests that render
 *  NO App (the hook / unit level). The caller owns removal (an afterEach body
 *  wipe or an explicit remove). Returns the element for extra assertions. */
export function mountComposerBarStub(rect: BarRect): HTMLElement {
  const bar = document.createElement("form");
  bar.className = "question-bar";
  document.body.appendChild(bar);
  vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(domRect(rect));
  return bar;
}

/** Stub the rect of the ALREADY-rendered shell composer bar (App black-box
 *  tests). Throws when the bar is absent -- the caller expects it rendered,
 *  and a missing bar is a test-setup failure, not a branch. */
export function stubRenderedComposerBar(rect: BarRect): void {
  const bar = document.querySelector(".question-bar");
  if (!(bar instanceof HTMLElement)) {
    throw new Error("stubRenderedComposerBar: .question-bar is not rendered");
  }
  vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(domRect(rect));
}
