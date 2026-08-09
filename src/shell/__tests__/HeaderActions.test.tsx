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

describe("HeaderActions (ADR-0089: Save permanently disabled)", () => {
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
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(container.querySelector(".key-ok")).toBeNull();
    expect(container.querySelector(".key-missing")).toBeNull();
    expect(container.querySelector("[data-slot='badge']")).toBeNull();
  });

  it("fires Open but NOT Save (Save permanently disabled per ADR-0089)", () => {
    const { onOpenDuck, onSaveAs } = renderActions();
    fireEvent.click(screen.getByRole("button", { name: "Open .duck" }));
    expect(onOpenDuck).toHaveBeenCalledOnce();
    expect(onSaveAs).not.toHaveBeenCalled();
    // Save is permanently disabled — clicking it does nothing.
    fireEvent.click(screen.getByRole("button", { name: "Save as .duck" }));
    expect(onSaveAs).not.toHaveBeenCalled();
  });

  it("disables Open together with the shell gate; Save is always disabled", () => {
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

  it("Save is always disabled even when the shell is not disabled", () => {
    renderActions({ disabled: false });
    expect(screen.getByRole("button", { name: "Save as .duck" })).toBeDisabled();
  });

  it("keeps the native title tooltips alive on the disabled buttons (pointer-events override)", () => {
    const { container } = renderActions({ disabled: true });
    const buttons = container.querySelectorAll(".header-actions [data-slot='button']");
    buttons.forEach((btn) => {
      expect(btn.className.split(/\s+/)).toContain("disabled:pointer-events-auto");
      expect(btn.getAttribute("title")).toBeTruthy();
    });
    // The Save button carries the auto-save hint (ADR-0089).
    expect(screen.getByRole("button", { name: "Save as .duck" }).getAttribute("title")).toBe(
      "Sessions auto-save — no manual save needed",
    );
  });
});
