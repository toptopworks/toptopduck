import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";

import { DelegationTraceDialog } from "../DelegationTraceDialog";
import { TraceRowList } from "../TraceRow";
import type { TraceEntry, TraceRound } from "../../../types/thread";

// The delegation row's thin summary + modal viewer (issue #934; the modal
// form was decided on the issue in triage): a delegation trace row stays one
// line with a "Sub-trace" affordance; the dialog opens the sub-agent's
// rounds -- thinking folds, connective prose, and the tool string rendered
// by the same row list the settled trace uses.

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

describe("DelegationTraceDialog", () => {
  it("opens the modal on the affordance and renders the sub-rounds", () => {
    renderWithProviders(<DelegationTraceDialog entry={DELEGATION} />);
    // Closed by default: the sub-trace content is not in the document.
    expect(screen.queryByText("Checking the sheet first.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /sub-trace/i }));
    // The title names the delegating sub-agent; the description carries the
    // task head (the row's own summary).
    expect(screen.getByText("Sub-agent trace · analyst")).toBeInTheDocument();
    expect(screen.getByText("clean the sheet")).toBeInTheDocument();
    // The sub-round's prose and its tool string render (the failed sub-call
    // keeps its bounded excerpt -- the cross-turn failure anchor).
    expect(screen.getByText("Checking the sheet first.")).toBeInTheDocument();
    expect(screen.getByText("SELECT count(*) AS n FROM result_1")).toBeInTheDocument();
    expect(screen.getByText("no such table")).toBeInTheDocument();
  });
});

describe("TraceRowList delegation affordance (issue #934)", () => {
  it("shows the injected sub-trace affordance only where the caller supplies it", () => {
    const { container } = renderWithProviders(
      <>
        {/* The settled trace's composition (TurnCard): every row gets the
            affordance; only the delegation entry's renders non-null. */}
        <TraceRowList
          entries={[DELEGATION]}
          renderSubTrace={(entry) => <DelegationTraceDialog entry={entry} />}
        />
        <TraceRowList
          entries={[
            {
              name: "explore",
              operation_kind: "read",
              summary: "SELECT 1",
              success: true,
              result_excerpt: "",
            },
          ]}
          renderSubTrace={(entry) => <DelegationTraceDialog entry={entry} />}
        />
      </>,
    );
    const affordances = container.querySelectorAll(".subtrace-open");
    expect(affordances).toHaveLength(1);
  });

  // The affordance's click isolation (PR #946 review): the whole summary
  // line is the row fold's click target, so opening the modal must not
  // also toggle the fold. The positive control first -- clicking the
  // summary line grows the expand block, proving the fold path is live in
  // this composition (otherwise the negative half would be vacuous).
  it("opening the modal leaves the row's summary fold collapsed", () => {
    const { container } = renderWithProviders(
      <TraceRowList
        entries={[DELEGATION]}
        renderSubTrace={(entry) => <DelegationTraceDialog entry={entry} />}
      />,
    );
    // The chevron toggle's click bubbles to the line's one toggle handler
    // (TraceSummaryFold's contract); it stays addressable once the fold's
    // block duplicates the summary text.
    const toggles = container.querySelectorAll(".summary-fold-toggle");
    expect(toggles).toHaveLength(1);
    fireEvent.click(toggles[0]);
    expect(container.querySelector(".summary-fold-block")).not.toBeNull();
    fireEvent.click(toggles[0]);
    expect(container.querySelector(".summary-fold-block")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /sub-trace/i }));
    expect(screen.getByText("Sub-agent trace · analyst")).toBeInTheDocument();
    // Opening the modal must not also toggle the row's summary fold.
    expect(container.querySelector(".summary-fold-block")).toBeNull();
  });
});
