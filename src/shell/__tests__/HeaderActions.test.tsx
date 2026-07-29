import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";

import { HeaderActions } from "../HeaderActions";

// Empty-catalog English IntlProvider so FormattedMessage / useIntl resolve to
// their defaultMessage (the canonical English source, ADR-0052). onError is
// silenced -- the ids intentionally resolve via defaultMessage, not the empty
// catalog. Mirrors the shell-test renderShell pattern.
function renderShell(ui: ReactElement) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      {ui}
    </IntlProvider>,
  );
}

describe("HeaderActions (issue #282 retirement: Open / Save only)", () => {
  // The key-state badge + the settings gear moved to the shared
  // ConnectionStatus footer at the session sidebar's bottom (ADR-0075
  // cross-view unification). The topbar cluster keeps exactly the two
  // session-scoped file actions.
  function renderActions({
    disabled = false,
    onOpenDuck = vi.fn(),
    onSaveAs = vi.fn(),
  }: {
    disabled?: boolean;
    onOpenDuck?: () => void;
    onSaveAs?: () => void;
  } = {}) {
    const result = renderShell(
      <HeaderActions disabled={disabled} onOpenDuck={onOpenDuck} onSaveAs={onSaveAs} />,
    );
    return { ...result, onOpenDuck, onSaveAs };
  }

  it("renders exactly the Open + Save buttons (no settings entry, no key badge)", () => {
    const { container } = renderActions();
    const buttons = container.querySelectorAll(".header-actions [data-slot='button']");
    expect(buttons).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Open .duck" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save as .duck" })).toBeInTheDocument();
    // The retired chrome carries no residue: no settings-labelled button, no
    // key-state badge hooks (.key-ok / .key-missing), no Badge host at all.
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(container.querySelector(".key-ok")).toBeNull();
    expect(container.querySelector(".key-missing")).toBeNull();
    expect(container.querySelector("[data-slot='badge']")).toBeNull();
  });

  it("fires the matching action per button when enabled", () => {
    const { onOpenDuck, onSaveAs } = renderActions();
    fireEvent.click(screen.getByRole("button", { name: "Open .duck" }));
    expect(onOpenDuck).toHaveBeenCalledOnce();
    expect(onSaveAs).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save as .duck" }));
    expect(onSaveAs).toHaveBeenCalledOnce();
  });

  it("disables both buttons together (no active session / busy shell)", () => {
    const { onOpenDuck, onSaveAs } = renderActions({ disabled: true });
    const open = screen.getByRole("button", { name: "Open .duck" });
    const save = screen.getByRole("button", { name: "Save as .duck" });
    expect(open).toBeDisabled();
    expect(save).toBeDisabled();
    fireEvent.click(open);
    fireEvent.click(save);
    expect(onOpenDuck).not.toHaveBeenCalled();
    expect(onSaveAs).not.toHaveBeenCalled();
  });

  it("keeps the native title tooltips alive on the disabled buttons (pointer-events override)", () => {
    // disabled:pointer-events-auto overrides the shadcn base's
    // disabled:pointer-events-none so the native title still surfaces on the
    // disabled buttons (ADR-0067 note); a disabled <button> still never
    // dispatches click, asserted above.
    const { container } = renderActions({ disabled: true });
    const buttons = container.querySelectorAll(".header-actions [data-slot='button']");
    buttons.forEach((btn) => {
      expect(btn.className.split(/\s+/)).toContain("disabled:pointer-events-auto");
      expect(btn.getAttribute("title")).toBeTruthy();
    });
    // The disabled Save carries the "open or create a session first" hint.
    expect(screen.getByRole("button", { name: "Save as .duck" }).getAttribute("title")).toBe(
      "Open or create a session first",
    );
  });
});
