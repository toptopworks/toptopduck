// Issue #818: the live side of the runtime attribution marker -- the same
// first-child position the settled TurnCard renders, so a marker present
// on the live side is re-hosted in place at the settle swap (#620; a read
// landing only after the settle lets the settled card add it). The runtime
// riding LiveTurn is the ask-time choice (it may be absent until the read
// lands); when it lands is useTurnFlow's contract, pinned in its own tests.

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { TooltipProvider } from "../../ui/tooltip";
import { catalogFor } from "../../../i18n";
import { LiveTurnExchange } from "../LiveTurnExchange";
import type { ReactNode } from "react";
import type { LiveTurn } from "../../../session/useTurnFlow";

function renderExchange(liveTurn: LiveTurn, agentHead?: ReactNode) {
  return render(
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      <TooltipProvider>
        <LiveTurnExchange
          liveTurn={liveTurn}
          agentHead={agentHead}
          mentionedDataset={null}
          onRespondApproval={() => {}}
          onThinkingExpandedChange={() => {}}
        />
      </TooltipProvider>
    </IntlProvider>,
  );
}

const liveTurnWith = (runtime: LiveTurn["runtime"]): LiveTurn => ({
  question: "问",
  askedAt: 0,
  step: null,
  rounds: [],
  runtime,
});

describe("LiveTurnExchange runtime attribution marker (issue #818)", () => {
  it("opens the assistant stream with the marker naming the adapter", () => {
    const { container } = renderExchange(
      liveTurnWith({ kind: "external", data: { adapter_id: "claude-code" } }),
    );
    const stream = container.querySelector(".assistant-stream");
    expect(stream).not.toBeNull();
    // The same first-child contract as the settled TurnCard: the settle
    // swap re-hosts the marker without moving it (#620).
    expect(stream?.firstElementChild).toHaveClass("runtime-attribution");
    expect(stream?.firstElementChild).toHaveTextContent("claude-code");
  });

  it("keeps the marker ahead of the agent-activation head (adjudication 4)", () => {
    const { container } = renderExchange(
      liveTurnWith({ kind: "external", data: { adapter_id: "claude-code" } }),
      <span data-agent-head>act</span>,
    );
    const stream = container.querySelector(".assistant-stream");
    // Mirrors the settled TurnCard's pin: attribution first, then the
    // activations the actor triggered.
    expect(stream?.firstElementChild).toHaveClass("runtime-attribution");
    expect(stream?.firstElementChild?.nextElementSibling).toHaveAttribute("data-agent-head");
  });

  it("renders no marker before the ask-time read lands (runtime absent)", () => {
    const { container } = renderExchange(liveTurnWith(undefined));
    expect(container.querySelector(".runtime-attribution")).toBeNull();
  });

  it("renders no marker for the built-in default", () => {
    const { container } = renderExchange(liveTurnWith({ kind: "built_in" }));
    expect(container.querySelector(".runtime-attribution")).toBeNull();
  });

  it("renders no marker for a pre-id external runtime", () => {
    const { container } = renderExchange(
      liveTurnWith({ kind: "external", data: { adapter_id: null } }),
    );
    expect(container.querySelector(".runtime-attribution")).toBeNull();
  });
});

describe("LiveTurnExchange trace round width cap (issue #826)", () => {
  it("caps the live trace round at the stream width so summaries can truncate", () => {
    // Same cap as the settled TurnCard round: a non-stretched flex item's
    // fit-content width floors at min-content, so the cap is what lets a
    // nowrap summary hit the row's truncate instead of stretching the card.
    const { container } = renderExchange({
      ...liveTurnWith(undefined),
      rounds: [{ text: "流", rows: [] }],
    });
    expect(container.querySelector(".trace-round")).toHaveClass("max-w-full");
  });
});
