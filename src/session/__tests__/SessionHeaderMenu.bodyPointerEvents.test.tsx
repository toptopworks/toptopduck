import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DeleteSessionDialog, RenameSessionDialog } from "../SessionSidebar";
import { catalogFor } from "../../i18n";

// Regression (#518): opening Rename / Delete from the session-header dropdown
// menu, then closing the dialog, left document.body with `pointer-events: none`
// forever — the whole app froze.
//
// Root cause was a DUPLICATED @radix-ui/react-dismissable-layer in the
// dependency graph: react-menu (under the dropdown) pinned a different exact
// version than react-dialog, so each had its own module-level
// `originalBodyPointerEvents` bookkeeping AND its own `DismissableLayerContext`.
// The context split is equally essential: the dialog's
// `layersWithOutsidePointerEventsDisabled` Set was empty at mount time (menu
// registered in a separate context), so `if (size === 0)` triggered the capture
// of the menu-poisoned "none" as the "original" value. If context were shared,
// size would be 1 and the bug wouldn't fire. The fix aligned the radix packages
// on a single dismissable-layer version (one module instance, one bookkeeping
// set, one context).
//
// The sequence is driven with CONTROLLED `open` + rerenders instead of real
// menu events: Radix menu pointer/keyboard handling recurses under jsdom
// (known limitation — SessionHeaderMenu.test.tsx mocks the dropdown for the
// same reason). Only the layer mount/unmount ORDER matters for this bug, so
// rerenders reproduce it deterministically. The test mirrors the
// SessionHeaderMenu flow: menu open -> dialog mounts while the menu layer is
// still registered -> menu exits -> dialog closes.

type DialogKind = "rename" | "delete";

const noop = () => {};

// Renders the dropdown-menu + dialog pair with controlled `open` state so
// rerenders drive the exact mount/unmount order of #518 (see header).
function view(kind: DialogKind, menuOpen: boolean, dialogOpen: boolean) {
  return (
    <IntlProvider locale="en-US" messages={catalogFor("en-US")} defaultLocale="en-US">
      <DropdownMenu open={menuOpen}>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialogOpen &&
        (kind === "rename" ? (
          <RenameSessionDialog initialName="My Session" onCancel={noop} onSubmit={noop} />
        ) : (
          <DeleteSessionDialog name="My Session" onCancel={noop} onConfirm={noop} />
        ))}
    </IntlProvider>
  );
}

async function assertBodyPointerEventsRestored(kind: DialogKind) {
  const { rerender } = render(view(kind, true, false));
  // The open menu layer disables outside pointer events (modal-menu semantics).
  expect(document.body.style.pointerEvents).toBe("none");

  // Dialog mounts WHILE the menu layer is still registered -- the contamination
  // window: the dialog's DismissableLayer captures the current body value.
  rerender(view(kind, true, true));

  // Menu exits; the still-open dialog keeps the lock.
  rerender(view(kind, false, true));
  await waitFor(() => {
    expect(document.body.style.pointerEvents).toBe("none");
  });

  // Dialog closes -- the whole-app-freeze regression: body must not keep
  // `pointer-events: none`.
  rerender(view(kind, false, false));
  await waitFor(() => {
    expect(document.body.style.pointerEvents).toBe("");
  });
}

// jsdom hazard: during the menu+dialog overlap phase BOTH trapped Radix
// FocusScopes are alive at once. jsdom dispatches focus events synchronously,
// so the two scopes re-steal focus from each other in an unbreakable loop
// (vitest's testTimeout cannot interrupt a synchronous loop — the worker just
// spins). Focus plays no part in DismissableLayer's body pointer-events
// bookkeeping, so neuter it for this file.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(() => {});
  vi.spyOn(HTMLElement.prototype, "blur").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  // A failing case may leave the poisoned value on body; never leak it into
  // other tests sharing the jsdom document.
  document.body.style.pointerEvents = "";
});

describe("dropdown-menu + session dialog layer bookkeeping (#518)", () => {
  it("restores body pointer events after the Rename dialog closes", async () => {
    await assertBodyPointerEventsRestored("rename");
  });

  it("restores body pointer events after the Delete dialog closes", async () => {
    await assertBodyPointerEventsRestored("delete");
  });
});
