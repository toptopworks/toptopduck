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
    summary: "/bin/py cli-code-runner-code-tu_7.tmp",
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

describe("LiveRow approval card file values", () => {
  it("hides the file contents until the approver expands them", () => {
    renderWithProviders(<LiveRow row={rowWith()} onRespond={vi.fn()} />);
    // The argv summary (with the temp path) is the default face.
    expect(
      screen.getByText("/bin/py cli-code-runner-code-tu_7.tmp"),
    ).toBeInTheDocument();
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
