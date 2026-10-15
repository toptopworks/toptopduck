import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Checkbox } from "../checkbox";

describe("Checkbox primitive (ADR-0049 copy-in, issue #749)", () => {
  // The guided-load skip toggle migrated from a native <input type=checkbox>
  // to this Radix copy-in. Radix renders a button-typed role="checkbox" with
  // built-in keyboard (Space) + aria-checked; these pin the toggle contract
  // the dialog's row-state tests build on. No portal is involved, so plain
  // jsdom fireEvent.click cooperates (unlike the Select primitive, which the
  // GuidedLoadDialog suite mocks for that reason).
  it("renders a role=checkbox that toggles aria-checked on click", () => {
    render(<Checkbox aria-label="skip row" />);
    const box = screen.getByRole("checkbox");
    expect(box).toHaveAttribute("aria-checked", "false");
    fireEvent.click(box);
    expect(box).toHaveAttribute("aria-checked", "true");
    fireEvent.click(box);
    expect(box).toHaveAttribute("aria-checked", "false");
  });

  it("respects controlled checked + disabled", () => {
    render(
      <Checkbox
        checked
        disabled
        onCheckedChange={() => {}}
        aria-label="skip row"
      />,
    );
    const box = screen.getByRole("checkbox");
    expect(box).toBeDisabled();
    expect(box).toHaveAttribute("aria-checked", "true");
    fireEvent.click(box);
    expect(box).toHaveAttribute("aria-checked", "true");
  });
});
