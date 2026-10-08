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
// RoundProse for the round still growing, so that round's vega-lite fence
// decodes only once its text is final -- at the round's close or the settle
// swap. While the round streams, a half-written fence body must never show
// as source and must never flash a degradation banner.
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

// The caret is the round-is-alive signal (RoundProse's streaming contract),
// and the rounds array is append-only: only the tail round's text can still
// grow, so only its prose arms the caret -- arming every round painted a
// block glyph after every closed prose block for the turn's whole run.
describe("LiveTurnExchange tail-round streaming posture", () => {
  // Same two conditions the RoundProse suite pins: the after-content
  // utility class plus the quoted CSS custom property the pseudo element
  // reads (jsdom cannot paint pseudo elements).
  const CARET_CLASS = "after:content-[var(--streamdown-caret)]";

  function caretArmed(prose: Element): boolean {
    return (
      prose.className.includes(CARET_CLASS) &&
      (prose as HTMLElement).style.getPropertyValue("--streamdown-caret") !== ""
    );
  }

  it("arms the caret on the tail round only; closed rounds render static", () => {
    const { container } = renderExchange({
      ...liveTurnWith(undefined),
      rounds: [
        { text: "第一轮已收口。", rows: [] },
        { text: "第二轮正在流式。", rows: [] },
      ],
    });
    const proses = container.querySelectorAll(".round-text");
    expect(proses).toHaveLength(2);
    expect(caretArmed(proses[0])).toBe(false);
    expect(caretArmed(proses[1])).toBe(true);
  });

  it("keeps the single-round turn armed (the only round is the tail)", () => {
    const { container } = renderExchange({
      ...liveTurnWith(undefined),
      rounds: [{ text: "唯一一轮。", rows: [] }],
    });
    expect(caretArmed(container.querySelector(".round-text")!)).toBe(true);
  });
});

// The trailing thinking status yields twice over: a dispatched row carries
// its own motion (the rowInProgress arm, issue #297), and once #1163 streams
// the current round's call-less prose the visible text + caret carry the
// turn's liveness by themselves -- a spinner still claiming 思考中 over
// visibly streaming text is a doubled, misleading signal. A round beside
// rows has its prose SEALED (prose after a call opens the next round), so
// its text is not liveness -- the status reads honestly only while nothing
// else on the tail carries the CURRENT round's liveness: ask start, the
// inter-round wait (a Thinking bumps only the step, so the tail is still
// the previous round's sealed prose), the current round's pre-prose moment,
// and the current round's post-settle round trip.
describe("LiveTurnExchange trailing thinking status (issue #1167)", () => {
  it("keeps the status through the inter-round wait (the tail is a sealed earlier round)", () => {
    renderExchange({
      ...liveTurnWith(undefined),
      step: 2,
      rounds: [{ text: "第一轮已收口。", rows: [] }],
    });
    expect(screen.getByText("思考中（第 2 步）…")).toBeInTheDocument();
  });

  it("keeps the status while the current round has no prose yet (its thinking landed)", () => {
    renderExchange({
      ...liveTurnWith(undefined),
      step: 2,
      rounds: [
        { text: "第一轮已收口。", rows: [] },
        { thinking: { duration_ms: 900, text: "推理" }, rows: [] },
      ],
    });
    expect(screen.getByText("思考中（第 2 步）…")).toBeInTheDocument();
  });

  it("keeps the status while the current round's sealed prose waits beside a settled call (the round-trip wait)", () => {
    // A round that has landed a call cannot grow more prose (prose after a
    // call opens the next round), so a text-bearing tail with a settled row
    // and no running row is the LLM round-trip wait -- the status must name
    // it, not defer to the sealed text's caret (the fake-hang window).
    renderExchange({
      ...liveTurnWith(undefined),
      step: 1,
      rounds: [
        {
          text: "再按网关前缀搜索工具：",
          rows: [
            {
              key: "call-0",
              name: "ToolSearch",
              server: "tools",
              operationKind: "read",
              summary: "query=toptopduck",
              approval: null,
              running: false,
              success: true,
              resultExcerpt: "",
            },
          ],
        },
      ],
    });
    expect(screen.getByText("思考中…")).toBeInTheDocument();
  });

  it("yields nothing while the call-less tail's prose streams (the caret carries liveness)", () => {
    // The suppression arm's own pin: a still-growing tail keeps the status
    // away, so a regression to "never show" cannot pass the suite silently.
    renderExchange({
      ...liveTurnWith(undefined),
      step: 1,
      rounds: [{ text: "正文正在流出。", rows: [] }],
    });
    expect(screen.queryByText(/思考中/)).not.toBeInTheDocument();
  });

  it("keeps the status when the current round's prose is sealed by its settled rows (the round-trip wait)", () => {
    // Prose after a call opens the next round, so a text-bearing round beside
    // settled rows is NOT streaming prose -- it is the round-trip wait, and
    // the status must name it (the sealed-tail correction of the #1167 pin).
    renderExchange({
      ...liveTurnWith(undefined),
      step: 2,
      rounds: [
        { text: "第一轮已收口。", rows: [] },
        {
          text: "第二轮正文已封口。",
          rows: [
            {
              key: "call-0",
              name: "explore",
              server: null,
              operationKind: "read",
              summary: "SELECT 1",
              approval: null,
              running: false,
              success: true,
              resultExcerpt: "",
            },
          ],
        },
      ],
    });
    expect(screen.getByText("思考中（第 2 步）…")).toBeInTheDocument();
  });
});
