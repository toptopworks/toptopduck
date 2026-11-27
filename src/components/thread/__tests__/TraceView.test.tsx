import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";

import { LiveRow } from "../TraceView";
import { TraceRow, TraceStepFold } from "../TraceRow";
import type { LiveRoundRow } from "../../../session/useTurnFlow";
import type { ParamValue } from "../../../types/approval";
import type { TraceEntry } from "../../../types/thread";

// LiveRow's pending approval card (ADR-0083) + the param-value
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
      paramValues: [{ param: "code", content: "print(1)" }],
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
const UNCUT_VALUES = [{ param: "code", content: "print(1); print(2)" }];

// A three-value snapshot for the fold-stack posture (issue #1681): the
// same literal anchors the default-open and single-open assertions.
const THREE_VALUES: ParamValue[] = [
  { param: "arg0", content: "v0" },
  { param: "arg1", content: "v1" },
  { param: "arg2", content: "v2" },
];

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

  it("expands an approval-card summary in place, never a duplicate block", () => {
    // The decision face's summary is the card's body (the block posture):
    // a rest-state clamped mono block -- NOT the trace family's inline
    // truncate row -- with the whole block the click / keyboard target.
    // Expand unclamps THE SAME block (or swaps in the #1636 detail): the
    // bounded text is never rendered twice.
    const { container } = renderWithProviders(<LiveRow row={rowWith()} onRespond={vi.fn()} />);
    expect(screen.getByText(SUMMARY)).toHaveClass("approval-summary", "line-clamp-2");
    const toggle = summaryFoldToggle(container);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByText(SUMMARY));
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const block = foldBlock(container);
    expect(block).not.toBeNull();
    expect(block?.textContent).toBe(SUMMARY);
    expect(block).toHaveClass("whitespace-pre-wrap", "max-h-48");
    // The #1363 keyboard scroll region rides the unclamped face: tabbable
    // and named as a region, never a bare text dump.
    expect(block).toHaveAttribute("tabindex", "0");
    expect(block).toHaveAttribute("role", "region");
    expect(block).toHaveAttribute("aria-label");
    // In-place: exactly one copy of the summary on the page.
    expect(screen.getAllByText(SUMMARY)).toHaveLength(1);
    fireEvent.click(toggle);
    expect(foldBlock(container)).toBeNull();
    expect(screen.getByText(SUMMARY)).toHaveClass("line-clamp-2");
  });

  it("keeps the fold open while the expanded text carries a selection", () => {
    // The block posture's expanded body sits inside the click target (the
    // line variant keeps its block outside), so a drag-select or double-click
    // word-select over the full command ends with mouseup on the block and
    // fires click. An active selection never toggles: the guard reads the
    // live selection, so selecting the command the approver is vetting
    // cannot collapse the fold it was made in.
    const { container } = renderWithProviders(<LiveRow row={rowWith()} onRespond={vi.fn()} />);
    fireEvent.click(summaryFoldToggle(container));
    const toggle = summaryFoldToggle(container);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const selSpy = vi.spyOn(document, "getSelection").mockReturnValue({
      isCollapsed: false,
    } as Selection);
    fireEvent.click(screen.getByText(SUMMARY));
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    selSpy.mockRestore();
    // Collapsed selection: the plain click-to-collapse stands.
    fireEvent.click(screen.getByText(SUMMARY));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the head row outside the block's click target", () => {
    // The branch comment states the contract: the head's chrome (tool name,
    // badge, hint) rides above the block as a plain row, never part of the
    // fold toggle. Clicking the tool name must not expand.
    const { container } = renderWithProviders(<LiveRow row={rowWith()} onRespond={vi.fn()} />);
    const toggle = summaryFoldToggle(container);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByText("code-runner"));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByText(SUMMARY));
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("expands the approval-card summary to the carried detail (issue #1636)", () => {
    // The merged row's full text behind a cut summary upgrades the expand
    // block's column; the rest block stays the bounded head.
    const DETAIL = "python C:\\very\\long\\path\\cli-script.tmp --flag value";
    const { container } = renderWithProviders(
      <LiveRow row={rowWith({ summaryDetail: DETAIL })} onRespond={vi.fn()} />,
    );
    fireEvent.click(summaryFoldToggle(container));
    expect(foldBlock(container)?.textContent).toBe(DETAIL);
  });
});

describe("LiveRow caption tokens (issue #826)", () => {
  it("sizes the decision block on the code token and the badge on the caption token", () => {
    // The card's summary is the body surface (the block posture): it
    // rides the 13px code token; the badge chrome stays caption-sized.
    const { container } = renderWithProviders(<LiveRow row={rowWith()} onRespond={vi.fn()} />);
    // The code token rides the block surface (the summary span inherits it).
    expect(summaryFoldToggle(container).parentElement).toHaveClass("font-mono", "text-[13px]");
    expect(screen.getByText(SUMMARY)).toHaveClass("approval-summary", "line-clamp-2");
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
          approval: { requestId: "req-1", response: "deny", paramValues: [] },
          running: false,
          success: null,
        })}
        onRespond={vi.fn()}
      />,
    );
    expect(resolved.container.querySelector(".approval-resolved")).toHaveClass("text-xs");
  });

  it("renders the abandoned badge for a dropped call (issue #1267)", () => {
    // The external caller dropped the call: the row keeps its identity but
    // carries the terminal abandoned marker -- no answer buttons exist for
    // a call nobody is waiting on anymore.
    const abandoned = renderWithProviders(
      <LiveRow
        row={rowWith({
          approval: { requestId: "req-1", response: "abandoned", paramValues: [] },
          running: false,
          success: null,
        })}
        onRespond={vi.fn()}
      />,
    );
    expect(abandoned.container.querySelector(".approval-abandoned")).toHaveClass("text-xs");
    expect(abandoned.container.querySelector(".approval-allow-once")).toBeNull();
  });
});

describe("LiveRow excerpt gate (issue #1047, #1604)", () => {
  it("folds a capped delegation's truncation notice into the expand block", () => {
    // The one success whose excerpt survives the projection is a capped
    // delegation report's marker-bearing notice (#1047). Issue #1604 moves
    // it off the row line into the summary fold's expand block, beside the
    // argument summary: the row stays single-line.
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
    expect(capped.container.querySelector(".trace-excerpt")).toBeNull();
    fireEvent.click(summaryFoldToggle(capped.container));
    const block = foldBlock(capped.container);
    expect(block).not.toBeNull();
    expect(block).toHaveTextContent(SUMMARY);
    expect(block).toHaveTextContent("[output truncated at the token cap]");
  });

  it("keeps a failure excerpt un-folded under the row, scroll-capped", () => {
    // The failure excerpt is the cross-turn retrospection anchor (ADR-0078):
    // visible without a click, destructive-styled, now height-capped so a
    // multi-KB error cannot push the whole screen out of view (#1604).
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
    const failedExcerpt = failed.container.querySelector(".trace-excerpt");
    expect(failedExcerpt).toHaveTextContent("boom");
    expect(failedExcerpt).toHaveClass("text-destructive", "max-h-48", "overflow-y-auto");
    expect(failedExcerpt).not.toHaveClass("text-muted-foreground");
    // The cap carries the #1363 keyboard-reachable posture the other
    // height-capped regions hold: focusable, named, scrollable by arrows.
    expect(failedExcerpt).toHaveAttribute("tabindex", "0");
    expect(failedExcerpt).toHaveAttribute("role", "region");
    expect(failedExcerpt).toHaveAttribute("aria-label", "Error excerpt");
    // The success gate keeps the failure OUT of the summary fold's block
    // (#1604): expanding the row shows the argument summary alone, not a
    // second copy of the error as the block's right column.
    fireEvent.click(summaryFoldToggle(failed.container));
    expect(foldBlock(failed.container)).toHaveTextContent(SUMMARY);
    expect(foldBlock(failed.container)).not.toHaveTextContent("boom");
  });

  it("renders the full model-visible failure text over the excerpt head (issue #1610)", () => {
    // The failure anchor upgraded to the audit record (#1610): a row whose
    // completion carried a failure detail renders the full text in the
    // anchor instead of the bounded head, keeping the #1604 cap face and
    // the #1363 keyboard-reachable region posture. The no-detail fallback
    // (pre-#1610 records, no-text arms) is the excerpt face the un-folded
    // anchor test above pins.
    const withDetail = renderWithProviders(
      <LiveRow
        row={rowWith({
          approval: null,
          running: false,
          success: false,
          resultExcerpt: "boom…",
          failureDetail: "boom: relation not found (full text)",
        })}
        onRespond={vi.fn()}
      />,
    );
    const anchor = withDetail.container.querySelector(".trace-excerpt");
    expect(anchor).toHaveTextContent("relation not found (full text)");
    expect(anchor).not.toHaveTextContent("boom…");
    expect(anchor).toHaveClass("max-h-48", "overflow-y-auto", "text-destructive");
    expect(anchor).toHaveAttribute("tabindex", "0");
    expect(anchor).toHaveAttribute("role", "region");
    expect(anchor).toHaveAttribute("aria-label", "Error excerpt");
  });

  it("expands the cut argument's full text over the summary head (issue #1636)", () => {
    // The live row's fold upgrade (#1636): a call whose summary was cut
    // renders the model's original argument in the expand block while the
    // line keeps the bounded head -- the wiring must hand the row's
    // summaryDetail down, or the running row degrades to the head. The
    // no-detail fallback face is the un-folded tests above (the block
    // shows the summary itself).
    const fullText = "SELECT * FROM people WHERE name = 'ada' ORDER BY id";
    const withDetail = renderWithProviders(
      <LiveRow
        row={rowWith({
          approval: null,
          running: false,
          success: true,
          resultExcerpt: "",
          summaryDetail: fullText,
        })}
        onRespond={vi.fn()}
      />,
    );
    fireEvent.click(summaryFoldToggle(withDetail.container));
    expect(foldBlock(withDetail.container)).toHaveTextContent(fullText);
    expect(foldBlock(withDetail.container)).not.toHaveTextContent(SUMMARY);
  });

  it("renders neither excerpt face for a clean success row", () => {
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
    fireEvent.click(summaryFoldToggle(clean.container));
    expect(foldBlock(clean.container)).toHaveTextContent(SUMMARY);
  });
});

// The settled row's fold upgrade (#1636): the persisted entry's
// summary_detail must reach the fold, or a reopened session's cut rows
// expand the bounded head again -- the live face above carries the same
// upgrade through the running row's wiring.
describe("TraceRow fold upgrade (issue #1636)", () => {
  it("expands the settled row's cut argument full text over the head", () => {
    const fullText = "SELECT * FROM people WHERE name = 'ada' ORDER BY id";
    const settled = renderWithProviders(
      <TraceRow
        entry={{
          name: "sandbox_sql",
          operation_kind: "execute",
          summary: "SELECT * FROM people WHERE…",
          summary_detail: fullText,
          success: true,
          result_excerpt: "",
        }}
      />,
    );
    fireEvent.click(summaryFoldToggle(settled.container));
    expect(foldBlock(settled.container)).toHaveTextContent(fullText);
  });
});

// The step fold's head label (#1604, recalibrated on the real device):
// per-tool call counts in first-appearance order -- the tool name is the
// call's identity, the operation category alone collapses to noise on a
// single-category round. Tool names are untranslated data, so the order
// is stable across re-renders and locale switches.
describe("TraceStepFold fold label (issue #1604)", () => {
  const call = (over: Partial<TraceEntry> = {}): TraceEntry => ({
    name: "explore",
    operation_kind: "read",
    summary: "SELECT 1",
    success: true,
    result_excerpt: "",
    ...over,
  });

  it("counts each tool in first-appearance order", () => {
    const { container } = renderWithProviders(
      <TraceStepFold
        calls={[
          call(),
          call({ name: "describe", success: false, result_excerpt: "boom" }),
          call(),
        ]}
      />,
    );
    expect(container.querySelector(".trace-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(
      screen.getByRole("button", { name: "Trace · explore ×2 · describe ×1" }),
    ).toBeInTheDocument();
  });

  it("does not reorder alphabetically -- first appearance leads", () => {
    renderWithProviders(
      <TraceStepFold
        calls={[call({ name: "web_search" }), call(), call({ name: "web_search" })]}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Trace · web_search ×2 · explore ×1" }),
    ).toBeInTheDocument();
  });

  it("keeps the count form for a single tool", () => {
    renderWithProviders(
      <TraceStepFold calls={[call(), call(), call()]} />,
    );
    expect(
      screen.getByRole("button", { name: "Trace · explore ×3" }),
    ).toBeInTheDocument();
  });

  it("renders no fold for a zero-call round", () => {
    const { container } = renderWithProviders(<TraceStepFold calls={[]} />);
    expect(container.querySelector(".trace-toggle")).toBeNull();
  });
});

describe("LiveRow approval action row wrap (issue #862)", () => {
  it("keeps the awaiting hint on the head row's status slot; the action row keeps the wrap", () => {
    // The hint moved to the head row (the card's status slot): the tool
    // name is min-w-0 truncate, so the hint can never be pushed out --
    // stronger than the wrap it retires. The action row keeps flex-wrap
    // (#862): the Button base class carries whitespace-nowrap, so the
    // labels alone can still outrun a narrow column and the pairs wrap
    // instead of being cropped.
    const { container } = renderWithProviders(
      <LiveRow row={rowWith()} onRespond={vi.fn()} />,
    );
    const hint = container.querySelector(".approval-pending-hint");
    expect(hint).not.toBeNull();
    expect(hint).toHaveClass("ml-auto", "shrink-0");
    // The decision ask reads amber (the warning tint role), not the muted
    // gray the hint wore in the action-row era.
    expect(hint).toHaveClass("text-warning");
    expect(hint?.parentElement).toHaveClass("flex", "min-w-0", "items-center");
    // The action row still carries the wrap: the deny button's parent.
    const deny = container.querySelector(".approval-deny");
    expect(deny?.parentElement).toHaveClass("flex", "flex-wrap");
  });
});

// The decision surface's three usability gaps (issue #1368): the always-allow
// trust scope was invisible at the decision moment (ADR-0080 Decision 3 lifts
// this one tool to session-wide trust, the button said none of it), the deny
// answer sat one 6px gap from the allow pair it must not be mistaken for, and
// the awaiting hint was never announced to assistive technology while the
// gate suspension hides the round-trip wait line.
describe("LiveRow approval decision surface (issue #1368)", () => {
  it("renders the always-allow scope note persistently under the action row", () => {
    // Zero interaction: a resident line, not a hover disclosure -- the
    // consequence of "Always allow" must be readable at the decision moment
    // with no pointer or focus (the tooltip variant, rejected in #1368's
    // regrilling).
    const { container } = renderWithProviders(
      <LiveRow row={rowWith()} onRespond={vi.fn()} />,
    );
    const note = container.querySelector(".approval-scope-note");
    expect(note).not.toBeNull();
    expect(note).toHaveClass("m-0", "mt-2", "text-xs", "text-muted-foreground");
    expect(note).toHaveTextContent("no longer ask for the rest of the session");
    // Sits directly under the action row, after the param-value section
    // (the delivery renders between the summary block and the action row).
    expect(note?.previousElementSibling).toHaveClass("flex", "flex-wrap");
  });

  it("separates the deny answer from the allow pair with a visible group gap", () => {
    // The allow pair rides the row's gap-1.5; deny is the safety-side
    // action and reads as its own group across a wider interval -- one
    // className. The #862 wrap posture stands (the tail stays reachable,
    // never cropped); its one known artifact: a deny that wraps alone
    // carries the ml-3 as a line-start indent in the narrow band.
    const { container } = renderWithProviders(
      <LiveRow row={rowWith()} onRespond={vi.fn()} />,
    );
    expect(container.querySelector(".approval-deny")).toHaveClass("ml-3");
  });

  it("announces the pending decision through a polite live region", () => {
    // While the gate holds the turn, isRoundTripWait judges false on the
    // undecided row and the wait line vanishes -- this hint is the only
    // announcement to assistive technology that a decision is being asked
    // for, so it carries role="status" (polite, the SessionPane alert
    // convention).
    renderWithProviders(<LiveRow row={rowWith()} onRespond={vi.fn()} />);
    const status = screen.getByRole("status");
    expect(status).toHaveClass("approval-pending-hint");
    expect(status).toHaveTextContent("Awaiting approval");
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
    const approval = { requestId: "req-1", response: "deny" as const, paramValues: [] };
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

describe("LiveRow approval card param values", () => {
  // The value delivery rides the summary expand (one disclosure for the
  // call's full inputs): the one-shot #1009 pull fires on the first
  // expand, the capped preview is the load-gap / rejection face. The
  // expanded stack is a per-param
  // fold accordion, first block open by default, single-open (issue
  // #1681): the answer row stays reachable no matter how many values a
  // call carries. At rest the card carries no param signal -- the
  // summary expand is the one reveal (ruled on the ticket).
  const expandSummary = (container: HTMLElement) =>
    fireEvent.click(summaryFoldToggle(container));

  const paramFoldHeads = (container: HTMLElement) =>
    container.querySelectorAll(".approval-param-toggle");

  it("hides the value contents until the summary expands", () => {
    const { container } = renderWithProviders(
      <LiveRow row={rowWith()} onRespond={vi.fn()} />,
    );
    // The argv summary (with the temp path) is the default face.
    expect(screen.getByText(SUMMARY)).toBeInTheDocument();
    expect(screen.queryByText("print(1)")).not.toBeInTheDocument();
    expect(container.querySelector(".approval-param")).toBeNull();
    // No at-rest param signal (ruled on the ticket): the retired
    // paperclip figure and attached-file sentence must stay gone -- the
    // figure is aria-hidden decoration the catalog guard cannot see.
    expect(container.querySelector(".lucide-paperclip")).toBeNull();
    expect(screen.queryByText(/attached file/)).not.toBeInTheDocument();
    expandSummary(container);
    // The first block is open by default: the captured value shows under
    // its fold head. (The param name itself carries no text assertion:
    // it lives inside the toggle button, whose textContent equals the
    // span's, so getByText would match both and throw.)
    expect(screen.getByText("print(1)")).toBeInTheDocument();
    // The per-param fold collapses independently of the summary.
    fireEvent.click(paramFoldHeads(container)[0]);
    expect(screen.queryByText("print(1)")).not.toBeInTheDocument();
    // Collapse the summary -- the whole stack goes with it.
    expandSummary(container);
    expect(container.querySelector(".approval-param")).toBeNull();
  });

  it("opens the first block by default and keeps the rest collapsed", () => {
    const { container } = renderWithProviders(
      <LiveRow
        row={rowWith({ approval: { requestId: "req-1", response: null, paramValues: THREE_VALUES } })}
        onRespond={vi.fn()}
      />,
    );
    expandSummary(container);
    const heads = paramFoldHeads(container);
    expect(heads).toHaveLength(3);
    expect(heads[0]).toHaveAttribute("aria-expanded", "true");
    expect(heads[1]).toHaveAttribute("aria-expanded", "false");
    expect(heads[2]).toHaveAttribute("aria-expanded", "false");
    // Every head names its param, open or collapsed.
    expect(heads[1]).toHaveTextContent("arg1");
    expect(heads[2]).toHaveTextContent("arg2");
    // Only the first block's content is mounted.
    expect(screen.getByText("v0")).toBeInTheDocument();
    expect(screen.queryByText("v1")).not.toBeInTheDocument();
    expect(screen.queryByText("v2")).not.toBeInTheDocument();
    // The open block keeps the capped scroll posture: the stack itself
    // never grows a second scroll context (single-open).
    expect(container.querySelector(".approval-param-content")).toHaveClass(
      "max-h-40",
      "overflow-auto",
    );
  });

  it("collapses the open block when another opens (single-open)", () => {
    const { container } = renderWithProviders(
      <LiveRow
        row={rowWith({ approval: { requestId: "req-1", response: null, paramValues: THREE_VALUES } })}
        onRespond={vi.fn()}
      />,
    );
    expandSummary(container);
    const heads = paramFoldHeads(container);
    // Opening the second collapses the first: at most one expanded block
    // at any moment, so the answers stay reachable.
    fireEvent.click(heads[1]);
    expect(heads[0]).toHaveAttribute("aria-expanded", "false");
    expect(heads[1]).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText("v0")).not.toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    // Clicking the open head collapses it too -- all closed is a state.
    fireEvent.click(heads[1]);
    expect(heads[1]).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("v1")).not.toBeInTheDocument();
  });

  // Issue #1009: expanding pulls the FULL pre-truncation contents through
  // the loader (the broadcast snapshot is a 4 KiB budget, not the content
  // boundary) and replaces the capped preview in place -- arrival alone is
  // not replacement, so the capped text must be gone once the full text
  // lands. Three values with the second block opened by hand: the swap
  // must keep the user-opened block open across the face change, not
  // replay the first-block seed.
  it("pulls the uncut contents when the summary expands and replaces the capped preview", async () => {
    const onLoad = vi.fn().mockResolvedValue([
      { param: "arg0", content: "v0-full" },
      { param: "arg1", content: "v1-full" },
      { param: "arg2", content: "v2-full" },
    ]);
    const { container } = renderWithProviders(
      <LiveRow
        row={rowWith({ approval: { requestId: "req-1", response: null, paramValues: THREE_VALUES } })}
        onRespond={vi.fn()}
        onLoadParamValues={onLoad}
      />,
    );
    expandSummary(container);
    fireEvent.click(paramFoldHeads(container)[1]);
    expect(onLoad).toHaveBeenCalledWith("req-1");
    expect(await screen.findByText("v1-full")).toBeInTheDocument();
    // The capped text is gone and the hand-opened second block stayed
    // open through the swap.
    expect(screen.queryByText("v1")).not.toBeInTheDocument();
    expect(paramFoldHeads(container)[1]).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.queryByText("v0-full")).not.toBeInTheDocument();
  });

  it("falls back to the capped preview with an error note when the pull rejects", async () => {
    const onLoad = vi.fn().mockRejectedValue(new Error("slot released"));
    const { container } = renderWithProviders(
      <LiveRow row={rowWith()} onRespond={vi.fn()} onLoadParamValues={onLoad} />,
    );
    expandSummary(container);
    // The async fallback note is a live note (role="status") -- found by
    // text, since the pending hint carries role="status" too (issue #1368)
    // and a role finder would reject the two matches; the attribute assert
    // keeps the live-region semantics pinned.
    const note = await screen.findByText(/full contents unavailable/i);
    expect(note).toHaveAttribute("role", "status");
    // The capped broadcast snapshot stays visible as the fallback face.
    expect(screen.getByText("print(1)")).toBeInTheDocument();
  });

  // One fetch per card: the pending-window snapshot is immutable while the
  // card is up, so collapsing and re-expanding reuses the settled full view.
  it("does not refetch when collapsing and re-expanding", async () => {
    const onLoad = vi.fn().mockResolvedValue(UNCUT_VALUES);
    const { container } = renderWithProviders(
      <LiveRow row={rowWith()} onRespond={vi.fn()} onLoadParamValues={onLoad} />,
    );
    expandSummary(container);
    await screen.findByText("print(1); print(2)");
    expandSummary(container);
    expect(screen.queryByText("print(1); print(2)")).not.toBeInTheDocument();
    expandSummary(container);
    expect(await screen.findByText("print(1); print(2)")).toBeInTheDocument();
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  // The loading state is the in-flight dedup guard: collapsing and
  // re-expanding while the pull is still pending must not fire a second
  // fetch, and the capped preview stays the load-gap face until the pull
  // lands.
  it("keeps the capped preview and one call while the pull is in flight", async () => {
    let resolvePull!: (values: ParamValue[]) => void;
    const onLoad = vi.fn().mockImplementation(
      () => new Promise<ParamValue[]>((resolve) => { resolvePull = resolve; }),
    );
    const { container } = renderWithProviders(
      <LiveRow row={rowWith()} onRespond={vi.fn()} onLoadParamValues={onLoad} />,
    );
    expandSummary(container);
    // Load gap: the capped broadcast snapshot is the visible face.
    expect(screen.getByText("print(1)")).toBeInTheDocument();
    expandSummary(container);
    expandSummary(container);
    expect(onLoad).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolvePull(UNCUT_VALUES);
    });
    expect(await screen.findByText("print(1); print(2)")).toBeInTheDocument();
    expect(screen.queryByText("print(1)")).not.toBeInTheDocument();
  });

  it("fetches nothing when expanding a card without param values", () => {
    const onLoad = vi.fn().mockResolvedValue(UNCUT_VALUES);
    const { container } = renderWithProviders(
      <LiveRow
        row={rowWith({ approval: { requestId: "req-1", response: null } })}
        onRespond={vi.fn()}
        onLoadParamValues={onLoad}
      />,
    );
    expandSummary(container);
    expect(onLoad).not.toHaveBeenCalled();
    expect(container.querySelector(".approval-param")).toBeNull();
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
            paramValues: undefined,
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

// The settled live row's sub-trace fold (issue #934, inlined by #1355): a
// delegation row whose completion event carried sub_rounds renders the
// row fold -- the LiveRow composition the live exchange actually ships (the
// pure projection has its own pin in useTurnFlow's suites).
describe("LiveRow settled sub-trace fold (issue #934)", () => {
  it("renders the fold on a delegation row carrying sub-rounds and opens the inline panel", () => {
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
    expect(container.querySelector(".subtrace-toggle")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /sub-agent trace/i }));
    // The panel opens inline beneath the row; the live path carries no
    // usage subtotal (usage settles with the turn, #1270), and the settled
    // panel mounts no task head (the row line previews the task).
    expect(container.querySelector(".subtrace-task")).toBeNull();
    expect(screen.getByText("child prose")).toBeInTheDocument();
    expect(screen.queryByText(/^Used /)).not.toBeInTheDocument();
  });
});

// ADR-0135: the delegation row's live affordances -- the running row's
// status chip (step / batch counts) and the inline live panel fed from the
// delegation buffer, plus the completed row's live-only full texts.
describe("LiveRow delegation live affordances (ADR-0135)", () => {
  it("shows the chip and the inline live panel on a running delegation row", () => {
    const { container } = renderWithProviders(
      <LiveRow
        row={rowWith({
          approval: null,
          running: true,
          callId: "d1",
          delegation: {
            task: "Clean the whole sheet, report back",
            rounds: [
              {
                thinking: { duration_ms: 500, text: "child reasoning" },
                rows: [
                  {
                    key: "call-0",
                    name: "explore",
                    server: null,
                    operationKind: "read",
                    summary: "SELECT 1",
                    approval: null,
                    running: true,
                    success: null,
                    resultExcerpt: "",
                  },
                ],
              },
            ],
            step: 2,
            batch: { done: 0, running: 1, total: 1 },
          },
        })}
        onRespond={vi.fn()}
      />,
    );
    // The single-delegation chip reads the running fold's step.
    expect(screen.getByText("step 2")).toBeInTheDocument();
    // The panel stays closed until the fold opens; the task's full text and
    // the running sub-call ride inside.
    expect(screen.queryByText("Clean the whole sheet, report back")).not.toBeInTheDocument();
    // The row-line toggle rides the summary line's flex centering -- mt-0
    // cancels the block-flow breathing gap.
    expect(container.querySelector(".subtrace-toggle")).toHaveClass("mt-0");
    fireEvent.click(screen.getByRole("button", { name: /sub-agent trace/i }));
    // The task's full text opens the panel as the live task head block --
    // pre-wrap and height-capped so the task's own line structure survives
    // (the thinking-fold block's posture).
    const taskHead = document.querySelector(".subtrace-task");
    expect(taskHead?.textContent).toBe("Clean the whole sheet, report back");
    expect(taskHead).toHaveClass("whitespace-pre-wrap", "max-h-48");
    const subCall = screen.getByText("SELECT 1");
    expect(subCall).toBeInTheDocument();
    // The sub-round's thinking rides the same honest fold the settled panel
    // uses, collapsed by default.
    const thinking = container.querySelectorAll(".thinking-toggle");
    expect(thinking).toHaveLength(1);
    expect(screen.queryByText("child reasoning")).not.toBeInTheDocument();
    // The live panel's round blocks carry the trace family's max-w-full cap
    // (jsdom cannot measure; the structure is the pin, rationale at the
    // mount in TraceView).
    expect(subCall.closest(".trace-round")).toHaveClass("max-w-full");
  });

  it("does not fold the summary line when the sub-trace toggle is clicked", () => {
    const { container } = renderWithProviders(
      <LiveRow
        row={rowWith({
          approval: null,
          running: true,
          callId: "d1",
          delegation: {
            task: "Clean the whole sheet, report back",
            rounds: [],
            step: 1,
            batch: { done: 0, running: 1, total: 1 },
          },
        })}
        onRespond={vi.fn()}
      />,
    );
    const chevron = container.querySelector(".summary-fold-toggle");
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: /sub-agent trace/i }));
    // The panel opens while the summary line's own fold stays put: the
    // toggle's wrapper stops the click before it bubbles into the line's
    // fold handler.
    expect(screen.getByText("Clean the whole sheet, report back")).toBeInTheDocument();
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    // Positive control: clicking the summary line itself does fold it.
    fireEvent.click(screen.getByText(SUMMARY, { selector: ".trace-summary" }));
    expect(chevron).toHaveAttribute("aria-expanded", "true");
  });

  it("reads the batch counts on the chip when the turn carries a batch", () => {
    renderWithProviders(
      <LiveRow
        row={rowWith({
          approval: null,
          running: true,
          delegation: {
            task: "t",
            rounds: [],
            step: null,
            batch: { done: 3, running: 2, total: 5 },
          },
        })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.getByText("3 of 5 done, 2 running")).toBeInTheDocument();
  });

  it("renders the report full text, and no task head, on a completed delegation row", () => {
    const { container } = renderWithProviders(
      <LiveRow
        row={rowWith({
          approval: null,
          running: false,
          success: true,
          callId: "d1",
          delegation: {
            task: "Full task text that outran the bounded summary",
            report: "Done; 3 rows cleaned.",
            rounds: [],
            step: null,
            batch: { done: 1, running: 0, total: 1 },
          },
          subRounds: [
            {
              calls: [
                {
                  name: "explore",
                  operation_kind: "read",
                  summary: "SELECT 1",
                  success: true,
                  result_excerpt: "",
                },
              ],
            },
          ],
        })}
        onRespond={vi.fn()}
      />,
    );
    // No chip on the completed row -- the panel is the affordance.
    expect(screen.queryByText(/^step /)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /sub-agent trace/i }));
    // The tail carries the report's full text (the completion event's
    // live-only cargo); the task head is running-only -- the completed
    // panel mounts none, the row line previews the task.
    expect(document.querySelector(".subtrace-task")).toBeNull();
    expect(document.querySelector(".subtrace-report")?.textContent).toBe(
      "Done; 3 rows cleaned.",
    );
    // The landed sub_rounds render their calls behind the step fold.
    expect(container.querySelectorAll(".trace-toggle")).toHaveLength(1);
  });
});

// The landed-stats badge (issue #1621): a settled write/edit row's `+N −M`
// rides the row head beside the operation badge, each part aria-labeled;
// a row without stats (every non-write arm, a failed call) renders none.
// The edit's replacement count folds into the expand block instead.
describe("LiveRow landed-stats badge (issue #1621)", () => {
  it("renders the added and removed counts with per-part aria labels", () => {
    renderWithProviders(
      <LiveRow
        row={rowWith({
          approval: null,
          running: false,
          success: true,
          operationKind: "write",
          linesAdded: 12,
          linesRemoved: 3,
        })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.getByText("+12")).toBeInTheDocument();
    expect(screen.getByText("−3")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Added 12 lines" })).not.toBeNull();
    expect(screen.queryByRole("img", { name: "Removed 3 lines" })).not.toBeNull();
  });

  it("renders only the added count on a write (an overwrite is not a diff)", () => {
    renderWithProviders(
      <LiveRow
        row={rowWith({
          approval: null,
          running: false,
          success: true,
          operationKind: "write",
          linesAdded: 7,
        })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.getByText("+7")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Removed/ })).toBeNull();
  });

  it("renders no badge on a row without stats", () => {
    renderWithProviders(
      <LiveRow row={rowWith({ approval: null, running: false, success: true })} onRespond={vi.fn()} />,
    );
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
  });

  it("folds the edit's replacement count into the expand block", () => {
    const { container } = renderWithProviders(
      <LiveRow
        row={rowWith({
          approval: null,
          running: false,
          success: true,
          operationKind: "write",
          linesAdded: 1,
          linesRemoved: 2,
          replacements: 2,
        })}
        onRespond={vi.fn()}
      />,
    );
    fireEvent.click(summaryFoldToggle(container));
    expect(foldBlock(container)).toHaveTextContent("Replaced 2 occurrences");
  });
});
