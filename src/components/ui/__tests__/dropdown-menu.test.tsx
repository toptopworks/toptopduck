import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../dropdown-menu";

// Real-Radix smoke (issue #592): every composer-side consumer of these
// primitives is tested through the always-open dropdownMenuMock, whose
// aria-checked computation and keep-open contract are a re-implementation of
// Radix's. This suite mounts the REAL primitives (no module mock) so the
// equivalence the mock claims is pinned against Radix itself: the radio
// item's checked state follows the group value, and an item's onSelect
// preventDefault keeps the menu open. Scoped to the two primitives the mock
// re-implements beyond the plain wrappers -- the Sub cascade stays mock-only
// (Radix's pointer-event handling recurses under jsdom, the known limitation
// that motivated the mock).

function renderRadioMenu({ value, onSelect }: { value: string; onSelect?: (e: Event) => void }) {
  render(
    <DropdownMenu>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup value={value}>
          <DropdownMenuRadioItem value="a" onSelect={onSelect}>
            Alpha
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="b" onSelect={onSelect}>
            Beta
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuItem>Plain</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

/** Opens the menu (pointerDown on the trigger, Radix's open gesture). */
async function openMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Open" }), {
    button: 0,
    pointerType: "mouse",
  });
  await screen.findByRole("menu");
}

/** Fires the select gesture on a Radix menu item (pointerUp + click). */
function activateItem(item: HTMLElement) {
  fireEvent.pointerUp(item, { button: 0, pointerType: "mouse" });
  fireEvent.click(item);
}

describe("ui dropdown-menu real-Radix smoke (issue #592)", () => {
  it("checks the radio item matching the group value", async () => {
    renderRadioMenu({ value: "b" });
    await openMenu();
    expect(
      screen.getByRole("menuitemradio", { name: "Beta" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("menuitemradio", { name: "Alpha" }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("keeps the menu open when the item's onSelect calls preventDefault", async () => {
    const onSelect = vi.fn((e: Event) => e.preventDefault());
    renderRadioMenu({ value: "a", onSelect });
    await openMenu();
    activateItem(screen.getByRole("menuitemradio", { name: "Beta" }));
    await waitFor(() => expect(onSelect).toHaveBeenCalled());
    // The keep-open contract: the menu (and the item) stay mounted, and the
    // controlled group value keeps its own checked position -- what the
    // composer's mock re-implements for its logic tests.
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(
      screen.getByRole("menuitemradio", { name: "Alpha" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("menuitemradio", { name: "Beta" }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("closes the menu when the item's onSelect lets the default run", async () => {
    renderRadioMenu({ value: "a" });
    await openMenu();
    activateItem(screen.getByRole("menuitem", { name: "Plain" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});
