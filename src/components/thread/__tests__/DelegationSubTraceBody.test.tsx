import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import embed from "vega-embed";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";

import { DelegationSubTraceBody } from "../DelegationSubTraceBody";
import { TraceRowList } from "../TraceRow";
import type { TraceEntry, TraceRound } from "../../../types/thread";

// A fence chart may ride the sub-agent's prose; jsdom cannot run vega-embed,
// so its render is mocked (a resolved embed = the chart surface draws) --
// the pin below is then meaningful, not vacuous.
vi.mock("vega-embed", () => ({
  default: vi.fn().mockResolvedValue({ finalize: vi.fn(), view: { resize: vi.fn() } }),
}));

// The delegation row's inline sub-trace (issue #1355, retiring the #934
// modal): the row head carries the fold toggle, and the open fold renders
// the panel full width beneath the row -- identity + task head, the usage
// subtotal, and the sub-agent's rounds in the main trace's folding posture.

function renderWithProviders(ui: ReactElement) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      {ui}
    </IntlProvider>,
  );
}

// A delegation entry carrying one nested sub-round: prose + a succeeded and
// a failed sub-call, the same shape the Rust slim projection persists.
const SUB_ROUND: TraceRound = {
  text: "Checking the sheet first.",
  calls: [
    {
      name: "explore",
      operation_kind: "read",
      summary: "SELECT count(*) AS n FROM result_1",
      success: true,
      result_excerpt: "",
    },
    {
      name: "materialize",
      operation_kind: "write",
      summary: "SELECT * FROM missing",
      success: false,
      result_excerpt: "no such table",
    },
  ],
};

const DELEGATION: TraceEntry = {
  name: "analyst",
  operation_kind: "execute",
  summary: "clean the sheet",
  success: true,
  result_excerpt: "",
  sub_rounds: [SUB_ROUND],
};

// The settled composition (TurnCard): every row gets the panel body; only
// the delegation entry's row carries the fold.
function renderSettledTrace(
  renderSubTrace: (entry: TraceEntry) => ReactElement = (entry) => (
    <DelegationSubTraceBody name={entry.name} task={entry.summary} subRounds={entry.sub_rounds} />
  ),
) {
  return renderWithProviders(
    <TraceRowList entries={[DELEGATION]} renderSubTrace={renderSubTrace} />,
  );
}

describe("DelegationSubTraceBody inline panel (issue #1355)", () => {
  it("keeps the panel closed until the row fold opens it, then renders the sub-rounds", () => {
    renderSettledTrace();
    // Closed by default: neither the panel head nor the sub-round content
    // is in the document.
    expect(screen.queryByText("Sub-agent trace · analyst")).not.toBeInTheDocument();
    expect(screen.queryByText("Checking the sheet first.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /sub-agent trace/i }));
    // The panel head names the delegating sub-agent and carries the task
    // head (the row's own summary -- which also reads on the line, so the
    // head anchors by its hook class).
    expect(screen.getByText("Sub-agent trace · analyst")).toBeInTheDocument();
    expect(document.querySelector(".subtrace-task")?.textContent).toBe("clean the sheet");
    // The sub-round's prose renders; its tool string sits behind the round's
    // step fold (the main trace's posture), collapsed by default.
    expect(screen.getByText("Checking the sheet first.")).toBeInTheDocument();
    expect(screen.queryByText("SELECT count(*) AS n FROM result_1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /trace · 2 calls/i }));
    expect(screen.getByText("SELECT count(*) AS n FROM result_1")).toBeInTheDocument();
    // The failed sub-call keeps its bounded excerpt -- the cross-turn
    // failure anchor.
    expect(screen.getByText("no such table")).toBeInTheDocument();
    // The fold closes: a second click unmounts the panel (and its inner
    // step fold with it) -- the ephemerality the settle-swap collapse
    // leans on (#1355's known limitation).
    fireEvent.click(screen.getByRole("button", { name: /sub-agent trace/i }));
    expect(screen.queryByText("Sub-agent trace · analyst")).not.toBeInTheDocument();
    expect(screen.queryByText("Checking the sheet first.")).not.toBeInTheDocument();
  });

  it("renders the round's thinking fold collapsed, expandable beneath the fold", () => {
    const thinkingRound: TraceRound = {
      thinking: { duration_ms: 1200, text: "inner reasoning" },
      text: "Checking the sheet first.",
      calls: [],
    };
    const { container } = renderSettledTrace(() => (
      <DelegationSubTraceBody
        name={DELEGATION.name}
        task={DELEGATION.summary}
        subRounds={[thinkingRound]}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: /sub-agent trace/i }));
    // The honest fold head is present; the raw text stays folded until the
    // fold opens (the main trace's collapsed posture, per round).
    const toggles = container.querySelectorAll(".thinking-toggle");
    expect(toggles).toHaveLength(1);
    expect(toggles[0].getAttribute("aria-expanded")).toBe("false");
    // A sub-round with no calls renders no step fold at all -- the "Trace
    // · 0 calls" head must not appear (TraceStepFold's empty guard, the
    // only line of defense on this face).
    expect(container.querySelectorAll(".trace-toggle")).toHaveLength(0);
    expect(screen.queryByText("inner reasoning")).not.toBeInTheDocument();
    fireEvent.click(toggles[0]);
    expect(screen.getByText("inner reasoning")).toBeInTheDocument();
  });

  it("shows the fold only where the entry carries a sub-trace", () => {
    const plain: TraceEntry = {
      name: "explore",
      operation_kind: "read",
      summary: "SELECT 1",
      success: true,
      result_excerpt: "",
    };
    const { container } = renderWithProviders(
      <TraceRowList
        entries={[DELEGATION, plain]}
        renderSubTrace={(entry) => (
          <DelegationSubTraceBody name={entry.name} task={entry.summary} subRounds={entry.sub_rounds} />
        )}
      />,
    );
    const toggles = container.querySelectorAll(".subtrace-toggle");
    expect(toggles).toHaveLength(1);
  });

  // The fold's click isolation (carried from the modal's PR #946 review):
  // the whole summary line is the row fold's click target, so folding the
  // sub-trace must not also toggle the summary. The positive control first
  // -- clicking the summary line grows the expand block, proving the fold
  // path is live in this composition (otherwise the negative half would be
  // vacuous).
  it("folding the sub-trace leaves the row's summary fold collapsed", () => {
    const { container } = renderSettledTrace();
    const toggles = container.querySelectorAll(".summary-fold-toggle");
    expect(toggles).toHaveLength(1);
    fireEvent.click(toggles[0]);
    expect(container.querySelector(".summary-fold-block")).not.toBeNull();
    fireEvent.click(toggles[0]);
    expect(container.querySelector(".summary-fold-block")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /sub-agent trace/i }));
    expect(screen.getByText("Sub-agent trace · analyst")).toBeInTheDocument();
    // Opening the panel must not also toggle the row's summary fold.
    expect(container.querySelector(".summary-fold-block")).toBeNull();
  });
});

it("keeps a vega-lite fence in the sub-trace static (issue #1093 pin)", async () => {
  // The panel mounts RoundProse bare -- never through Thread's stage link
  // -- so its fences are static content: the chart itself draws, but no
  // click affordance may exist.
  const fenceRound: TraceRound = {
    ...SUB_ROUND,
    text: "```vega-lite\n{\"mark\": \"bar\"}\n```",
  };
  renderSettledTrace(() => (
    <DelegationSubTraceBody
      name={DELEGATION.name}
      task={DELEGATION.summary}
      subRounds={[fenceRound]}
    />
  ));
  fireEvent.click(screen.getByRole("button", { name: /sub-agent trace/i }));
  await waitFor(() => expect(vi.mocked(embed)).toHaveBeenCalledTimes(1));
  expect(
    screen.queryByRole("button", { name: "View chart in the results pane" }),
  ).not.toBeInTheDocument();
});

// The panel's usage subtotal row (ADR-0129 Decision 6, issue #1270): a
// built-in turn's delegation row carries the sub-agent's subtotal in the
// panel head; absent for external-runtime turns (their process aggregate
// never splits).
describe("DelegationSubTraceBody usage subtotal (ADR-0129, issue #1270)", () => {
  // The shared subtotal fixture: one delegation entry whose sub-agent
  // carried input 40 + output 10 (no cache buckets).
  function renderSubtotalTrace() {
    renderSettledTrace((entry) => (
      <DelegationSubTraceBody
        name={entry.name}
        task={entry.summary}
        subRounds={entry.sub_rounds}
        usage={{
          input_tokens: 40,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          output_tokens: 10,
        }}
      />
    ));
  }

  it("renders the sub-agent's subtotal when provided", () => {
    renderSubtotalTrace();
    fireEvent.click(screen.getByRole("button", { name: /sub-agent trace/i }));
    // The pill form (issue #1278): the subtotal reads as the derived total
    // (input 40 + output 10); the buckets ride the pill's Popover.
    const footer = document.querySelector(".usage-footer");
    expect(footer?.textContent).toContain("Used 50");
  });

  it("opens the subtotal pill's bucket detail from the panel head", () => {
    renderSubtotalTrace();
    fireEvent.click(screen.getByRole("button", { name: /sub-agent trace/i }));
    fireEvent.click(screen.getByRole("button", { name: "Used 50" }));
    // The detail portals to body (Radix); the zero-cache fixture keeps the
    // rows to input and output.
    const detail = screen
      .getByText("Turn usage")
      .closest("[data-slot=\"popover-content\"]");
    expect(detail).not.toBeNull();
    expect(detail?.textContent).toContain("Input 40");
    expect(detail?.textContent).toContain("Output 10");
  });

  it("renders no subtotal when the turn carried none", () => {
    renderSettledTrace();
    fireEvent.click(screen.getByRole("button", { name: /sub-agent trace/i }));
    expect(screen.queryByText(/^Used /)).not.toBeInTheDocument();
  });
});
