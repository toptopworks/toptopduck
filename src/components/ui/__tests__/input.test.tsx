import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Input } from "../input";
import { Textarea } from "../textarea";

// Class-string pins for the #1434 focus posture: the caret is the focus
// indicator, so no focus-visible ring class may come back, and the
// aria-invalid error ring must keep both halves of its pair -- in Tailwind v4
// a ring-color utility alone emits no box-shadow, so a missing width class
// renders no ring at all (jsdom stubs CSS; these guard the class list, the
// accepted posture for CSS-only contracts).
describe("Input/Textarea focus posture (issue #1434)", () => {
  it("keeps the caret as the Input focus indicator: no focus-visible ring classes", () => {
    render(<Input aria-label="plain input" />);
    const classes = screen.getByRole("textbox", { name: "plain input" }).className.split(/\s+/);
    expect(classes).not.toContain("focus-visible:ring-[3px]");
    expect(classes).not.toContain("focus-visible:ring-ring/50");
    expect(classes).not.toContain("focus-visible:border-ring");
  });

  it("keeps the caret as the Textarea focus indicator: no focus-visible ring classes", () => {
    render(<Textarea aria-label="plain textarea" />);
    const classes = screen.getByRole("textbox", { name: "plain textarea" }).className.split(/\s+/);
    expect(classes).not.toContain("focus-visible:ring-[3px]");
    expect(classes).not.toContain("focus-visible:ring-ring/50");
    expect(classes).not.toContain("focus-visible:border-ring");
  });

  it("pairs the aria-invalid error ring's width with its color on Input", () => {
    render(<Input aria-label="invalid input" aria-invalid />);
    const classes = screen.getByRole("textbox", { name: "invalid input" }).className.split(/\s+/);
    expect(classes).toContain("aria-invalid:ring-[3px]");
    expect(classes).toContain("aria-invalid:ring-destructive/20");
  });

  it("pairs the aria-invalid error ring's width with its color on Textarea", () => {
    render(<Textarea aria-label="invalid textarea" aria-invalid />);
    const classes = screen.getByRole("textbox", { name: "invalid textarea" }).className.split(/\s+/);
    expect(classes).toContain("aria-invalid:ring-[3px]");
    expect(classes).toContain("aria-invalid:ring-destructive/20");
  });
});
