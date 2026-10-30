import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "../button";

describe("Button ghost variant hover posture (issue #1437)", () => {
  // The ghost variant is the single source of the hover-brightness
  // posture (issue #1437): hover lifts the glyph to the foreground while
  // teal (accent-foreground) stays the SELECTED/ACTIVE hue. Every
  // per-call-site override was retired onto this string, so no consumer
  // suite guards it -- this pin is the guard. A revert to the stock
  // hover-teal must redden here.
  it("rides hover:text-foreground, not the stock hover-teal", () => {
    render(
      <Button type="button" variant="ghost" aria-label="ghost probe" />,
    );
    const btn = screen.getByRole("button", { name: "ghost probe" });
    expect(btn).toHaveClass("hover:text-foreground");
    expect(btn).not.toHaveClass("hover:text-accent-foreground");
  });
});
