import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Clear the rendered DOM between tests so queries never see stale components
// from a prior test (e.g. two tests rendering a dialog with the same button).
// Restore any vi.stubGlobal mocks (e.g. navigator.language) so a stub set in
// one describe cannot leak into another that reads the global without
// re-stubbing (unstubGlobals is not set in vite.config.ts).
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Radix Select (settings redesign, ADR-0075 / issue #281) exercises pointer +
// scroll + resize APIs jsdom does not implement. Stub them so the theme /
// language / preset dropdowns open and select in component tests. These are
// no-op shims -- the tests assert on the resulting DOM/state, not on layout.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (typeof Element.prototype.hasPointerCapture !== "function") {
  Element.prototype.hasPointerCapture = () => false;
}
if (typeof Element.prototype.setPointerCapture !== "function") {
  Element.prototype.setPointerCapture = () => {};
}
if (typeof Element.prototype.releasePointerCapture !== "function") {
  Element.prototype.releasePointerCapture = () => {};
}
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = () => {};
}
