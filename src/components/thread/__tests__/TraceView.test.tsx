import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";

import { LiveRow } from "../TraceView";
import type { LiveRoundRow } from "../../../session/useTurnFlow";

// LiveRow's pending approval card (ADR-0083) + the file-delivery
// expand-on-demand view (issue #672, ADR-0109 Decision 8): the snapshot
// rides the pending card only -- collapsed by default, a deliberate
// low-frequency action; the settled trace keeps just the argv summary.

// Empty-catalog English IntlProvider: FormattedMessage falls back to
// defaultMessage, so assertions anchor on stable English strings.
function renderWithProviders(ui: ReactElement) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      {ui}
    </IntlProvider>,
  );
}

function rowWith(over: Partial<LiveRoundRow> = {}): LiveRoundRow {
  return {
    key: "req-1",
    name: "code-runner",
    server: "CLI",
    operationKind: "execute",
    summary: SUMMARY,
    approval: {
      requestId: "req-1",
      response: null,
      fileAttachments: [{ param: "code", content: "print(1)" }],
    },
    running: false,
    success: null,
    resultExcerpt: "",
    ...over,
  };
}

// The summary in rowWith's default shape: a realistic argv-shaped summary;
// the same string anchors the fold-recovery assertions.
const SUMMARY = "/bin/py cli-code-runner-code-tu_7.tmp";

// Fold recovery (issue #826): the WHOLE line is the click target -- one
// click grows an expand block under the line (whitespace-pre-wrap keeps a
// multi-line summary's line structure, #772 posture; scroll-capped), the
// next click collapses it. The icon-only chevron reveals on row hover /
// focus (SUMMARY_ROW_REVEAL_CLASS, keyed on the row's named group) and
// pins visible while expanded; its aria-expanded names the posture.
function summaryFoldToggle(container: HTMLElement) {
  const toggle = container.querySelector(".summary-fold-toggle");
  expect(toggle).not.toBeNull();
  return toggle as HTMLElement;
}

function foldBlock(container: HTMLElement) {
  return container.querySelector(".summary-fold-block");
}

describe("LiveRow summary fold recovery (issue #826)", () => {
  it("expands a settled-row summary in a block under the line, then collapses", () => {
    const { container } = renderWithProviders(
      <LiveRow
        row={rowWith({ approval: null, running: false, success: true })}
        onRespond={vi.fn()}
      />,
    );
    // The line stays single-line truncated; the block is absent until toggled.
    expect(screen.getByText(SUMMARY)).toHaveClass("trace-summary", "truncate");
    expect(foldBlock(container)).toBeNull();
    const toggle = summaryFoldToggle(container);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // Rest posture: the chevron hides until the row is hovered / focused.
    expect(toggle).toHaveClass("opacity-0", "group-hover/summary-row:opacity-100");
    // The reveal keys on the row's own named group: pin the marker half of
    // the pairing too, so a rename of the group cannot silently kill the
    // reveal while the toggle-side class assertion stays green.
    expect(toggle.parentElement).toHaveClass("group/summary-row");
    // The whole line is the click target, not just the chevron: clicking
    // the summary text toggles too.
    fireEvent.click(screen.getByText(SUMMARY));
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveClass("opacity-100");
    const block = foldBlock(container);
    expect(block).not.toBeNull();
    expect(block?.textContent).toBe(SUMMARY);
    expect(block).toHaveClass("whitespace-pre-wrap", "max-h-48", "font-mono");
    fireEvent.click(toggle);
    expect(foldBlock(container)).toBeNull();
  });

  it("expands a running-row summary the same way", () => {
    const { container } = renderWithProviders(
      <LiveRow row={rowWith({ approval: null, running: true })} onRespond={vi.fn()} />,
    );
    expect(screen.getByText(SUMMARY)).toHaveClass("trace-summary", "truncate");
    fireEvent.click(summaryFoldToggle(container));
    expect(foldBlock(container)?.textContent).toBe(SUMMARY);
  });

  it("expands an approval-card summary the same way", () => {
    const { container } = renderWithProviders(<LiveRow row={rowWith()} onRespond={vi.fn()} />);
    expect(screen.getByText(SUMMARY)).toHaveClass("approval-summary", "truncate");
    fireEvent.click(summaryFoldToggle(container));
    expect(foldBlock(container)?.textContent).toBe(SUMMARY);
  });
});

describe("LiveRow caption tokens (issue #826)", () => {
  it("sizes the summary and badge chrome at the caption token", () => {
    renderWithProviders(<LiveRow row={rowWith()} onRespond={vi.fn()} />);
    expect(screen.getByText(SUMMARY)).toHaveClass("text-xs");
    expect(screen.getByText("execute")).toHaveClass("text-xs");
  });

  it("sizes the sibling chrome at the caption token too", () => {
    // The retirement covers the whole sub-caption family, not just the
    // decision's named faces: the failure excerpt (settled row) and the
    // resolved-deny badge (running row under a resolved card) ride text-xs
    // as well.
    const failed = renderWithProviders(
      <LiveRow
        row={rowWith({
          approval: null,
          running: false,
          success: false,
          resultExcerpt: "boom",
        })}
        onRespond={vi.fn()}
      />,
    );
    expect(failed.container.querySelector(".trace-excerpt")).toHaveClass("text-xs");
    const resolved = renderWithProviders(
      <LiveRow
        row={rowWith({
          approval: { requestId: "req-1", response: "deny", fileAttachments: [] },
          running: false,
          success: null,
        })}
        onRespond={vi.fn()}
      />,
    );
    expect(resolved.container.querySelector(".approval-resolved")).toHaveClass("text-xs");
  });
});

describe("LiveRow approval action row wrap (issue #862)", () => {
  it("wraps the action row so the trailing hint stays reachable in a narrow column", () => {
    // The Button base class carries whitespace-nowrap (button-variants.ts),
    // so each action button's min-content is its full label; three buttons
    // plus the ml-auto awaiting hint outrun the narrow rail's content box
    // and the rail's overflow-x crop eats the tail. flex-wrap drops the
    // hint to a second line and wraps button pairs if the labels alone
    // still outrun the column.
    const { container } = renderWithProviders(
      <LiveRow row={rowWith()} onRespond={vi.fn()} />,
    );
    const hint = container.querySelector(".approval-pending-hint");
    expect(hint).not.toBeNull();
    expect(hint?.parentElement).toHaveClass("flex", "flex-wrap");
  });
});

describe("LiveRow approval tool name shrink (issue #872)", () => {
  it("lets the approval head's tool name truncate instead of shoving the row", () => {
    // The tool name is the approval head's identity token, and an external
    // tool rides a server prefix + tool name that can outrun the narrow
    // column. shrink-0 refused to shrink at all, pushing the summary and
    // badge out of the card (the card carries no overflow strategy, so the
    // spill paints past the border). min-w-0 + truncate joins the same
    // row's summary family (#826): single line, tail ellipsis, the row
    // stays inside the card.
    const TOOL_NAME = "some_extremely_long_server_prefix__tool_name";
    const { container } = renderWithProviders(
      <LiveRow row={rowWith({ name: TOOL_NAME })} onRespond={vi.fn()} />,
    );
    const tool = container.querySelector(".approval-tool");
    expect(tool).toHaveTextContent(TOOL_NAME);
    expect(tool).toHaveClass("min-w-0", "truncate");
  });
});

describe("LiveRow trace name shrink (issue #874)", () => {
  it("lets the settled and running rows' tool name truncate instead of shoving the row", () => {
    // The settled and running trace rows share the approval card's (#872)
    // overflow exposure: the tool name is the row's identity token, and
    // an external tool rides a server prefix + tool name that can outrun
    // the narrow column. shrink-0 refused to shrink at all, pushing the
    // summary and badges past the row edge. min-w-0 + truncate joins the
    // same row's summary family (#826): single line, tail ellipsis. The
    // badges stay shrink-0 by the ticket's locked scope (rationale, not
    // an assertion this test makes).
    const TOOL_NAME = "some_extremely_long_server_prefix__tool_name";
    // Branch discriminator: each sub-case pins the branch it walks (the
    // settled case renders the success glyph, the running case the
    // spinner), so a fixture-state regression cannot silently swap sites
    // and leave one render site unpinned.
    const settled = renderWithProviders(
      <LiveRow
        row={rowWith({ approval: null, running: false, success: true, name: TOOL_NAME })}
        onRespond={vi.fn()}
      />,
    );
    expect(settled.container.querySelector(".trace-success")).not.toBeNull();
    const settledName = settled.container.querySelector(".trace-name");
    expect(settledName).toHaveTextContent(TOOL_NAME);
    expect(settledName).toHaveClass("min-w-0", "truncate");
    const running = renderWithProviders(
      <LiveRow
        row={rowWith({ approval: null, running: true, name: TOOL_NAME })}
        onRespond={vi.fn()}
      />,
    );
    expect(running.container.querySelector(".animate-spin")).not.toBeNull();
    const runningName = running.container.querySelector(".trace-name");
    expect(runningName).toHaveTextContent(TOOL_NAME);
    expect(runningName).toHaveClass("min-w-0", "truncate");
  });
});

describe("LiveRow approval card file values", () => {
  it("hides the file contents until the approver expands them", () => {
    renderWithProviders(<LiveRow row={rowWith()} onRespond={vi.fn()} />);
    // The argv summary (with the temp path) is the default face.
    expect(screen.getByText(SUMMARY)).toBeInTheDocument();
    expect(screen.queryByText("print(1)")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "View file values (1)" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("expands the approval-time snapshot and collapses it again", () => {
    renderWithProviders(<LiveRow row={rowWith()} onRespond={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "View file values (1)" }));
    // The snapshot names its parameter and carries the captured value.
    expect(screen.getByText("code")).toBeInTheDocument();
    expect(screen.getByText("print(1)")).toBeInTheDocument();
    const hide = screen.getByRole("button", { name: "Hide file values" });
    expect(hide).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(hide);
    expect(screen.queryByText("print(1)")).not.toBeInTheDocument();
  });

  it("renders no expand toggle for a card without file values", () => {
    renderWithProviders(
      <LiveRow
        row={rowWith({ approval: { requestId: "req-1", response: null } })}
        onRespond={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /file values/i }),
    ).not.toBeInTheDocument();
  });
});
