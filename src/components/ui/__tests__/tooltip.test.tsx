import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../tooltip";

// Inverted-surface pin (issue #1568): the tooltip face is the inverted
// floating-surface tier. Both directions pinned -- hasClass alone would
// stay green under any additive class swap, so the retired teal face is
// asserted absent too. Controlled open (no hover simulation); the Provider
// wrap is the radix-test prerequisite.

describe("ui tooltip face (issue #1568)", () => {
  it("renders the inverted surface, not the retired teal face", () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>hover me</TooltipTrigger>
          <TooltipContent>hint text</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const content = screen.getByText("hint text");
    expect(content).toHaveClass("bg-inverted", "text-inverted-foreground");
    expect(content).not.toHaveClass("bg-primary");
  });
});
