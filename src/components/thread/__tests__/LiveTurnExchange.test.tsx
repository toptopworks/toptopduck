// The live exchange's own surface pins. The head contract -- the marker's
// first-child position, its built-in / pre-id silence cells, the
// invocation-badge face -- and the round width cap ride the swap-stable
// modules now, pinned in TurnExchangeFrame.test / RoundBody.test (issue
// #1157); what stays here is what only the live side reaches through its own
// data: the marker's absence before the ask-time read lands (the runtime
// riding LiveTurn arrives late -- when it lands is useTurnFlow's contract,
// pinned in its own tests) and its presence + the staged badge names once
// they land (the adapter hand-offs -- the frame pins only the given-prop
// faces), plus the streaming prose postures (ADR-0120).

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { TooltipProvider } from "../../ui/tooltip";
import { catalogFor } from "../../../i18n";
import { LiveTurnExchange } from "../LiveTurnExchange";
import type { LiveTurn } from "../../../session/useTurnFlow";

function renderExchange(liveTurn: LiveTurn) {
  return render(
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      <TooltipProvider>
        <LiveTurnExchange
          liveTurn={liveTurn}
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
  invocationNames: [],
  step: null,
  rounds: [],
  runtime,
});

describe("LiveTurnExchange runtime attribution marker (issue #818)", () => {
  it("renders no marker before the ask-time read lands (runtime absent)", () => {
    const { container } = renderExchange(liveTurnWith(undefined));
    expect(container.querySelector(".runtime-attribution")).toBeNull();
  });

  it("mounts the marker once the read lands (the LiveTurn hand-off)", () => {
    // The frame pin covers the given-prop face; this covers the adapter
    // wiring -- the runtime rides LiveTurn, and dropping the hand-off would
    // keep the suite green while the marker vanished until the settle swap
    // (#620).
    const { container } = renderExchange(
      liveTurnWith({ kind: "external", data: { adapter_id: "claude-code" } }),
    );
    const marker = container.querySelector(".runtime-attribution");
    expect(marker).not.toBeNull();
    expect(marker).toHaveTextContent("claude-code");
  });
});

// The staged badge names ride LiveTurn.invocationNames (ADR-0119 Decision 5)
// -- the frame pins the given-prop face, this pins the adapter hand-off.
describe("LiveTurnExchange user-invocation badges (ADR-0119 Decision 5)", () => {
  it("renders the staged names above the question", () => {
    const { getByText, getByLabelText } = renderExchange({
      ...liveTurnWith(undefined),
      invocationNames: ["sql-coach"],
    });
    expect(getByText("sql-coach")).toBeInTheDocument();
    expect(getByLabelText("随此消息调用的技能")).toBeInTheDocument();
  });
});

// ADR-0120 Decision 4: the live round block threads mode="streaming" into
// RoundProse, so
// a vega-lite fence decodes only after the settle swap. While the round
// streams, a half-written fence body must never show as source and must never
// flash a degradation banner.
describe("LiveTurnExchange vega-lite fence placeholder (ADR-0120)", () => {
  it("shows the placeholder for a streaming fence, never the source", () => {
    const { container } = renderExchange({
      ...liveTurnWith(undefined),
      rounds: [{ text: "```vega-lite\n{\"mark\": \"ba", rows: [] }],
    });
    expect(screen.getByText("图表生成中…")).toBeInTheDocument();
    expect(container.textContent).not.toContain("mark");
    expect(container.querySelector("pre")).toBeNull();
  });

  it("still streams other fence languages as plain code blocks", () => {
    // The placeholder rule is vega-lite-only (Decision 6) -- a python fence
    // keeps its source visible while it streams.
    const { container } = renderExchange({
      ...liveTurnWith(undefined),
      rounds: [{ text: "```python\nprint(1)", rows: [] }],
    });
    expect(screen.queryByText("图表生成中…")).not.toBeInTheDocument();
    expect(container.querySelector("pre")?.textContent).toContain("print(1)");
  });
});
