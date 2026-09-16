import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { Pencil, Plus, RefreshCw, Trash2, Zap } from "lucide-react";

import {
  FieldHint,
  FoldHead,
  HeaderActionButton,
  RowActionButton,
  RowRemoveButton,
} from "../settings-chrome";
import { renderSettings } from "./helpers";

// The pane-chrome action primitives (issue #958): HeaderActionButton /
// RowActionButton / FoldHead are presentational shells -- these tests pin the
// contracts the call sites rely on: one label feeding both the accessible
// name and the tooltip (no descriptor double-writes), the in-flight spin
// posture, and the controlled fold with its hint / action slots.

async function hoverOpenTooltip(trigger: HTMLElement) {
  fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
  fireEvent.pointerMove(trigger, { pointerType: "mouse" });
  return screen.findByRole("tooltip");
}

describe("HeaderActionButton", () => {
  it("derives the accessible name and the tooltip from one label", async () => {
    const onClick = vi.fn();
    renderSettings(
      <HeaderActionButton label="New agent" icon={Plus} onClick={onClick} />,
    );
    const button = screen.getByRole("button", { name: "New agent" });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    // The tooltip mirrors the same string -- the descriptor single-writes at
    // the call site instead of the aria + tooltip double-write.
    const tooltip = await hoverOpenTooltip(button);
    expect(tooltip.textContent).toBe("New agent");
  });

  it("keeps the in-flight posture: disabled button, spinning icon", () => {
    renderSettings(
      <HeaderActionButton label="Scanning…" icon={RefreshCw} disabled spinning />,
    );
    const button = screen.getByRole("button", { name: "Scanning…" });
    expect(button).toBeDisabled();
    expect(button.querySelector("svg")).toHaveClass("animate-spin");
  });
});

describe("RowActionButton", () => {
  it("renders the in-row ghost posture with the foreground hover", () => {
    const onClick = vi.fn();
    renderSettings(
      <RowActionButton
        label="Edit tool pandoc"
        icon={Pencil}
        onClick={onClick}
      />,
    );
    const button = screen.getByRole("button", { name: "Edit tool pandoc" });
    expect(button).toHaveClass("text-muted-foreground", "hover:text-foreground");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("hovers destructive, disables, and swaps in the spinner in flight", () => {
    renderSettings(
      <RowActionButton
        label="Test server demo"
        icon={Zap}
        destructive
        spinning
        disabled
      />,
    );
    const button = screen.getByRole("button", { name: "Test server demo" });
    expect(button).toHaveClass("hover:text-destructive");
    expect(button).toBeDisabled();
    // In flight the icon is a rotating Loader2, not the resting Zap.
    expect(button.querySelector("svg")).toHaveClass("animate-spin");
  });
});

describe("RowRemoveButton", () => {
  it("renders the editor row-remove posture", () => {
    const onClick = vi.fn();
    renderSettings(
      <RowRemoveButton
        label="Remove parameter (row 1)"
        icon={Trash2}
        onClick={onClick}
      />,
    );
    const button = screen.getByRole("button", {
      name: "Remove parameter (row 1)",
    });
    expect(button).toHaveClass("hover:text-destructive", "size-7");
    expect(button.querySelector("svg")).toHaveClass("size-3.5");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("FoldHead", () => {
  it("expands from the collapsed head, keeping the hint beside it", () => {
    const onExpandedChange = vi.fn();
    renderSettings(
      <FoldHead
        title="Environment variables"
        hint={<span>hint</span>}
        expanded={false}
        onExpandedChange={onExpandedChange}
      >
        <p>row editor</p>
      </FoldHead>,
    );
    const head = screen.getByRole("button", { name: "Environment variables" });
    expect(head).toHaveAttribute("aria-expanded", "false");
    // The fold keeps the field rows unmounted while collapsed.
    expect(screen.queryByText("row editor")).toBeNull();
    expect(screen.getByText("hint")).toBeInTheDocument();
    fireEvent.click(head);
    expect(onExpandedChange).toHaveBeenCalledWith(true);
  });

  it("collapses from the expanded head and carries the action", () => {
    const onExpandedChange = vi.fn();
    renderSettings(
      <FoldHead
        title="Environment variables"
        expanded
        onExpandedChange={onExpandedChange}
        action={<button type="button">Add variable</button>}
      >
        <p>row editor</p>
      </FoldHead>,
    );
    const head = screen.getByRole("button", { name: "Environment variables" });
    expect(head).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("row editor")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    fireEvent.click(head);
    expect(onExpandedChange).toHaveBeenCalledWith(false);
  });
});

describe("FieldHint", () => {
  it("renders the trigger with its accessible name and the muted body", async () => {
    renderSettings(
      <FieldHint label="Import mode explanation">Body copy</FieldHint>,
    );
    const trigger = screen.getByRole("button", {
      name: "Import mode explanation",
    });
    const tooltip = await hoverOpenTooltip(trigger);
    expect(tooltip.textContent).toBe("Body copy");
  });

  it("renders a titled body with the title in the surface foreground", async () => {
    renderSettings(
      <FieldHint label="Import mode explanation" title="Import mode">
        Body copy
      </FieldHint>,
    );
    const trigger = screen.getByRole("button", {
      name: "Import mode explanation",
    });
    const tooltip = await hoverOpenTooltip(trigger);
    expect(tooltip.textContent).toContain("Import mode");
    expect(tooltip.textContent).toContain("Body copy");
    const title = screen.getByText("Import mode");
    expect(title.tagName).toBe("P");
    expect(title).toHaveClass("text-popover-foreground", "font-medium");
  });
});
