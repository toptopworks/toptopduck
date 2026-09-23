import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";

import { LiveRow } from "../TraceView";
import type { LiveRoundRow } from "../../../session/useTurnFlow";
import type { FileAttachment } from "../../../types/approval";

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

// The uncut full view the loader resolves with (issue #1009): the same
// literal anchors the replace, refetch, and in-flight assertions.
const UNCUT_FILES = [{ param: "code", content: "print(1); print(2)" }];

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

describe("LiveRow excerpt gate (issue #1047)", () => {
  it("renders a capped delegation's truncation notice under a success row, muted", () => {
    // The one success whose excerpt survives the projection is a capped
    // delegation report's marker-bearing notice (#1047): it renders under
    // the check glyph muted -- the call completed, the answer was just cut
    // -- while the failure excerpt keeps the destructive anchor styling.
    const capped = renderWithProviders(
      <LiveRow
        row={rowWith({
          approval: null,
          running: false,
          success: true,
          resultExcerpt: "report head…\n\n[output truncated at the token cap]",
        })}
        onRespond={vi.fn()}
      />,
    );
    const notice = capped.container.querySelector(".trace-excerpt");
    expect(notice).not.toBeNull();
    expect(notice).toHaveTextContent("[output truncated at the token cap]");
    expect(notice).toHaveClass("text-muted-foreground");
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
    expect(failed.container.querySelector(".trace-excerpt")).toHaveClass(
      "text-destructive",
    );
    const clean = renderWithProviders(
      <LiveRow
        row={rowWith({
          approval: null,
          running: false,
          success: true,
          resultExcerpt: "",
        })}
        onRespond={vi.fn()}
      />,
    );
    expect(clean.container.querySelector(".trace-excerpt")).toBeNull();
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

describe("LiveRow approval resolved badge shrink (issue #876)", () => {
  it("lets the resolved badge truncate as the row's last resort, in both row states", () => {
    // The row's unshrinkable chrome (spinner, op-badge, chevron) caps the
    // min-content near the narrowest column's line box, so a running row
    // with a resolved approval paints its tail 2-16px into the rail gutter
    // (#876). The badge's label joins the truncate family (#826): negative
    // space is absorbed in proportion to base size, so the far wider
    // summary and tool name collapse first and the badge truncates only
    // near the narrowest columns. `shrink` overrides the Badge base
    // class's own shrink-0 (twMerge keeps the later same-group class),
    // which would otherwise pin the badge wide and silently defeat
    // min-w-0. The remaining single-word chrome stays shrink-0 by the
    // ticket's locked scope (rationale, not an assertion this test makes).
    const approval = { requestId: "req-1", response: "deny" as const, fileAttachments: [] };
    // Branch discriminator: each sub-case pins the branch it walks (the
    // settled case renders the success glyph, the running case the
    // spinner), so a fixture-state regression cannot silently swap sites
    // and leave one render site unpinned.
    const settled = renderWithProviders(
      <LiveRow
        row={rowWith({ approval, running: false, success: true })}
        onRespond={vi.fn()}
      />,
    );
    expect(settled.container.querySelector(".trace-success")).not.toBeNull();
    const settledBadge = settled.container.querySelector(".approval-resolved");
    expect(settledBadge).not.toBeNull();
    expect(settledBadge).toHaveClass("min-w-0", "shrink", "truncate");
    const running = renderWithProviders(
      <LiveRow row={rowWith({ approval, running: true })} onRespond={vi.fn()} />,
    );
    expect(running.container.querySelector(".animate-spin")).not.toBeNull();
    const runningBadge = running.container.querySelector(".approval-resolved");
    expect(runningBadge).not.toBeNull();
    expect(runningBadge).toHaveClass("min-w-0", "shrink", "truncate");
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

  // Issue #1009: expanding pulls the FULL pre-truncation contents through
  // the loader (the broadcast snapshot is a 4 KiB budget, not the content
  // boundary) and replaces the capped preview in place -- arrival alone is
  // not replacement, so the capped text must be gone once the full text
  // lands.
  it("pulls the uncut contents when expanded and replaces the capped preview", async () => {
    const onLoad = vi.fn().mockResolvedValue(UNCUT_FILES);
    renderWithProviders(
      <LiveRow row={rowWith()} onRespond={vi.fn()} onLoadAttachments={onLoad} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "View file values (1)" }));
    expect(onLoad).toHaveBeenCalledWith("req-1");
    expect(await screen.findByText("print(1); print(2)")).toBeInTheDocument();
    expect(screen.queryByText("print(1)")).not.toBeInTheDocument();
  });

  it("falls back to the capped preview with an error note when the pull rejects", async () => {
    const onLoad = vi.fn().mockRejectedValue(new Error("slot released"));
    renderWithProviders(
      <LiveRow row={rowWith()} onRespond={vi.fn()} onLoadAttachments={onLoad} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "View file values (1)" }));
    // The async fallback note is a live note (role="status").
    const note = await screen.findByRole("status");
    expect(note).toHaveTextContent(/Full contents unavailable/i);
    // The capped broadcast snapshot stays visible as the fallback face.
    expect(screen.getByText("print(1)")).toBeInTheDocument();
  });

  // One fetch per card: the pending-window snapshot is immutable while the
  // card is up, so collapsing and re-expanding reuses the settled full view.
  it("does not refetch when collapsing and re-expanding", async () => {
    const onLoad = vi.fn().mockResolvedValue(UNCUT_FILES);
    renderWithProviders(
      <LiveRow row={rowWith()} onRespond={vi.fn()} onLoadAttachments={onLoad} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "View file values (1)" }));
    await screen.findByText("print(1); print(2)");
    fireEvent.click(screen.getByRole("button", { name: "Hide file values" }));
    expect(screen.queryByText("print(1); print(2)")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View file values (1)" }));
    expect(await screen.findByText("print(1); print(2)")).toBeInTheDocument();
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  // The loading state is the in-flight dedup guard: collapsing and
  // re-expanding while the pull is still pending must not fire a second
  // fetch, and the capped preview stays the load-gap face until the pull
  // lands.
  it("keeps the capped preview and one call while the pull is in flight", async () => {
    let resolvePull!: (files: FileAttachment[]) => void;
    const onLoad = vi.fn().mockImplementation(
      () => new Promise<FileAttachment[]>((resolve) => { resolvePull = resolve; }),
    );
    renderWithProviders(
      <LiveRow row={rowWith()} onRespond={vi.fn()} onLoadAttachments={onLoad} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "View file values (1)" }));
    // Load gap: the capped broadcast snapshot is the visible face.
    expect(screen.getByText("print(1)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide file values" }));
    fireEvent.click(screen.getByRole("button", { name: "View file values (1)" }));
    expect(onLoad).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolvePull(UNCUT_FILES);
    });
    expect(await screen.findByText("print(1); print(2)")).toBeInTheDocument();
    expect(screen.queryByText("print(1)")).not.toBeInTheDocument();
  });
});

// The approval card's originator annotation (issue #934): a sub-agent's
// call names its delegator above the card head ("sub-agent X wants to call
// Y"); a main-loop call renders no annotation row.
describe("LiveRow approval originator annotation (issue #934)", () => {
  it("names the delegating sub-agent above the card head", () => {
    renderWithProviders(
      <LiveRow
        row={rowWith({
          approval: {
            requestId: "req-1",
            response: null,
            fileAttachments: undefined,
            originAgent: "analyst",
          },
        })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.getByText("Sub-agent analyst wants to call:")).toBeInTheDocument();
    // The card head still renders the tool + its summary.
    expect(screen.getByText(SUMMARY)).toBeInTheDocument();
  });

  it("renders no annotation for a main-loop call", () => {
    const { container } = renderWithProviders(
      <LiveRow row={rowWith()} onRespond={vi.fn()} />,
    );
    expect(container.querySelector(".approval-origin")).toBeNull();
  });
});

// The settled live row's sub-trace affordance (issue #934, PR #946 review):
// a delegation row whose completion event carried sub_rounds renders the
// modal affordance -- the LiveRow composition the live exchange actually
// ships (the pure projection has its own pin in useTurnFlow's suites).
describe("LiveRow settled sub-trace affordance (issue #934)", () => {
  it("renders the affordance on a delegation row carrying sub-rounds", () => {
    const { container } = renderWithProviders(
      <LiveRow
        row={rowWith({
          name: "analyst",
          approval: null,
          running: false,
          success: true,
          resultExcerpt: "",
          subRounds: [{ text: "child prose", calls: [] }],
        })}
        onRespond={vi.fn()}
      />,
    );
    expect(container.querySelector(".subtrace-open")).not.toBeNull();
  });
});
