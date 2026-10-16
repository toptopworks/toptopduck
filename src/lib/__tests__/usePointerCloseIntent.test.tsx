import { describe, expect, it } from "vitest";
import { fireEvent, renderHook } from "@testing-library/react";

import { usePointerCloseIntent } from "../usePointerCloseIntent";

// The close-gesture classifier shared by the settings overlay, the posture
// menu, and the runtime popover. The branch logic lives here; the
// SettingsView and ComposerProviderPicker suites pin each consumer's
// restore-gating (the posture trigger's own suite mocks the Radix dropdown
// module, so its gate rides these pins plus the picker's).
describe("usePointerCloseIntent", () => {
  it("marks the last gesture: pointerdown sets, keydown clears, in either order", () => {
    const { result } = renderHook(() => usePointerCloseIntent());
    // jsdom's synthetic clicks fire no pointerdown, so the resting default
    // reads keyboard (restore-kept) -- the test surface's branch.
    expect(result.current.current).toBe(false);
    fireEvent.pointerDown(document.body);
    expect(result.current.current).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(result.current.current).toBe(false);
    // The classification is last-gesture-wins, not first.
    fireEvent.pointerDown(document.body);
    expect(result.current.current).toBe(true);
  });

  it("stops listening on unmount", () => {
    const { result, unmount } = renderHook(() => usePointerCloseIntent());
    fireEvent.pointerDown(document.body);
    expect(result.current.current).toBe(true);
    unmount();
    // The keydown no longer clears: the value is stale, the listener gone.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(result.current.current).toBe(true);
  });
});
