// The live exchange's own surface pins. The head contract -- the marker's
// first-child position, its built-in / pre-id silence cells, the
// invocation-badge face -- and the round width cap ride the swap-stable
// modules now, pinned in TurnExchangeFrame.test / RoundBody.test (issue
// #1157); what stays here is what only the live side reaches through its own
// data: the marker's absence before the ask-time read lands (the runtime
// riding LiveTurn arrives late -- when it lands is useTurnFlow's contract,
// pinned in its own tests) and its presence + the staged badge names once
// they land (the adapter hand-offs -- the frame pins only the given-prop
// faces), plus the streaming prose postures (ADR-0120), the trailing
// thinking-status postures (issue #1167), and the per-round sealed blocks
// (#1656 -- the settle-isomorphic form every finished round lands in).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { TooltipProvider } from "../../ui/tooltip";
import { catalogFor } from "../../../i18n";
import { LiveTurnExchange } from "../LiveTurnExchange";
import type { LiveRoundRow, LiveTurn } from "../../../session/useTurnFlow";

// The attribution marker reads the shared adapter-table cache (issue #1351),
// so the exchange needs a QueryClient like the app tree provides. The api
// mock resolves an empty table -- the raw-id assertions stay declared
// rather than an accident of a failed fetch; retry:false keeps a mounting
// marker from stacking background retries, staleTime:Infinity keeps a
// seeded cache from refetching under it.
vi.mock("../../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api")>()),
  listAdapters: vi.fn().mockResolvedValue([]),
}));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

// Split element / render so the posture pins can rerender the same tree
// (the cardEl convention in TurnCard.test.tsx) -- the anti-flicker pin
// rerenders with a grown streaming summary.
function exchangeEl(
  liveTurn: LiveTurn,
  onActivityExpandedChange: (expanded: boolean) => void = () => {},
) {
  return (
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <LiveTurnExchange
            liveTurn={liveTurn}
            mentionedDataset={null}
            onRespondApproval={() => {}}
            onActivityExpandedChange={onActivityExpandedChange}
          />
        </QueryClientProvider>
      </TooltipProvider>
    </IntlProvider>
  );
}

function renderExchange(
  liveTurn: LiveTurn,
  onActivityExpandedChange?: (expanded: boolean) => void,
) {
  return render(exchangeEl(liveTurn, onActivityExpandedChange));
}

const liveTurnWith = (runtime: LiveTurn["runtime"]): LiveTurn => ({
  question: "问",
  askedAt: 0,
  pausedSince: null,
  invocationNames: [],
  step: null,
  rounds: [],
  runtime,
});

// The settled-call fixture (the sibling suites' Partial-override
// convention, Thread's liveRow and TraceView's rowWith): seating a
// completed row seals the round's prose (prose after a call opens the
// next round) -- callers override the settled posture to reach other
// windows, like the mid-call one (a running row, success still null).
const settledRow = (over: Partial<LiveRoundRow> = {}): LiveRoundRow => ({
  key: "call-0",
  name: "explore",
  server: null,
  operationKind: "read",
  summary: "SELECT 1",
  approval: null,
  running: false,
  success: true,
  resultExcerpt: "",
  ...over,
});

// jsdom does no layout: hand a scroll region its geometry (the stream's
// height vs the viewport's; the scrollTop setter clamps like a real
// scroller). Returns the live scrollTop reader for assertions (#1669).
function stubScrollGeometry(region: HTMLElement, scrollHeight: number, clientHeight: number) {
  let scrollTop = 0;
  Object.defineProperty(region, "scrollHeight", {
    value: scrollHeight,
    configurable: true,
  });
  Object.defineProperty(region, "clientHeight", {
    value: clientHeight,
    configurable: true,
  });
  Object.defineProperty(region, "scrollTop", {
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = Math.min(v, scrollHeight - clientHeight);
    },
    configurable: true,
  });
  return () => scrollTop;
}

// The expand-time pin runs inside the click, before any instance-level
// stub can exist (the region only mounts on expand): this variant hands
// the geometry to the element prototype so the effect's first run already
// clamps through it. Returns the restore for the original descriptors
// (#1669).
function stubScrollGeometryOnPrototype(scrollHeight: number, clientHeight: number) {
  const proto = HTMLParagraphElement.prototype;
  const saved = ["scrollHeight", "clientHeight", "scrollTop"].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(proto, key),
  ] as const);
  let scrollTop = 0;
  Object.defineProperty(proto, "scrollHeight", {
    value: scrollHeight,
    configurable: true,
  });
  Object.defineProperty(proto, "clientHeight", {
    value: clientHeight,
    configurable: true,
  });
  Object.defineProperty(proto, "scrollTop", {
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = Math.min(v, scrollHeight - clientHeight);
    },
    configurable: true,
  });
  return () => {
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(proto, key, desc);
      else Reflect.deleteProperty(proto, key);
    }
    scrollTop = 0;
  };
}

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
      liveTurnWith({ kind: "external", data: { adapter_id: "claude-code", display_name: null } }),
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

  it("hands the sealed tail's closed fence to the settled door (no placeholder)", () => {
    // A row-bearing tail is sealed (issue #1236): its prose is final, so a
    // closed vega-lite fence leaves the streaming placeholder and goes
    // through the settled door -- the decode face (ADR-0120) whose
    // unrenderable-body arm discloses honestly (embed never runs for a
    // non-whitelisted body, so jsdom needs no canvas here).
    const { container } = renderExchange({
      ...liveTurnWith(undefined),
      step: 1,
      rounds: [
        {
          text: "报告\n\n```vega-lite\n{\"mark\": \"geoshape\"}\n```",
          rows: [settledRow()],
        },
      ],
    });
    expect(screen.queryByText("图表生成中…")).not.toBeInTheDocument();
    expect(screen.getByText(/图表无法渲染/)).toBeInTheDocument();
    expect(container.querySelector("pre")).toBeNull();
  });
});

// The caret is the round-is-alive signal (RoundProse's streaming contract),
// and the rounds array is append-only: only an unsealed tail's text can
// still grow, so only its prose arms the caret -- a row-bearing tail is
// sealed (prose after a call opens the next round, issue #1236) and retires
// the caret like every earlier round.
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

  it("retires the caret once the tail is sealed by its settled rows (the status names the wait)", () => {
    // The sealed-tail window (issue #1236): the tail's prose cannot grow
    // once a call has landed, so the caret retires with the round's
    // liveness -- an armed caret over sealed prose beside the 思考中 status
    // is the doubled, misleading signal.
    const { container } = renderExchange({
      ...liveTurnWith(undefined),
      step: 1,
      rounds: [{ text: "已封口。", rows: [settledRow()] }],
    });
    expect(caretArmed(container.querySelector(".round-text")!)).toBe(false);
    expect(screen.getByText("思考中")).toBeInTheDocument();
  });

  it("keeps the caret retired while the sealing row is still running (the mid-call window)", () => {
    // CallStart lands the row running (success still null), and the seal
    // reads rows alone -- refining the judgment to settled-only rows would
    // re-arm the caret over prose that can no longer grow.
    const { container } = renderExchange({
      ...liveTurnWith(undefined),
      step: 1,
      rounds: [{ text: "已封口。", rows: [settledRow({ running: true, success: null })] }],
    });
    expect(caretArmed(container.querySelector(".round-text")!)).toBe(false);
  });
});

// The trailing thinking status yields twice over: a dispatched row carries
// its own motion (the rowInProgress arm, issue #297), and while #1163 streams
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
      rounds: [{ text: "第一轮已收口。", rows: [settledRow()] }],
    });
    expect(screen.getByText("思考中（第 2 步）")).toBeInTheDocument();
  });

  it("keeps the status while the current round has no prose yet (its thinking landed)", () => {
    renderExchange({
      ...liveTurnWith(undefined),
      step: 2,
      rounds: [
        { text: "第一轮已收口。", rows: [settledRow()] },
        { thinking: { duration_ms: 900, text: "推理" }, rows: [] },
      ],
    });
    expect(screen.getByText("思考中（第 2 步）")).toBeInTheDocument();
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
          rows: [settledRow({ name: "ToolSearch", server: "tools", summary: "query=toptopduck" })],
        },
      ],
    });
    expect(screen.getByText("思考中")).toBeInTheDocument();
  });

  it("keeps the status while a call-bearing tail round has no prose yet (the round-trip wait)", () => {
    // A first-round call can land before any prose (rows may lead the slot
    // arrays), so the tail can be the current round with settled rows and
    // no text -- the wait discriminated through the text and row arms
    // rather than the step arm.
    renderExchange({
      ...liveTurnWith(undefined),
      step: 1,
      rounds: [{ rows: [settledRow()] }],
    });
    expect(screen.getByText("思考中")).toBeInTheDocument();
  });

  it("names the streaming window with the running face, never the thinking face", () => {
    // The recalibrated arm (#1612): the line no longer vanishes while the
    // tail prose streams -- the face claims the run (never 思考 over
    // visibly streaming text, the device ruling), and the turn clock keeps
    // its host.
    renderExchange({
      ...liveTurnWith(undefined),
      askedAt: Date.now() - 46_000,
      step: 1,
      rounds: [{ text: "正文正在流出。", rows: [] }],
    });
    expect(screen.getByText("执行中")).toBeInTheDocument();
    expect(screen.getByText("· 46秒")).toBeInTheDocument();
    expect(screen.queryByText(/思考中/)).not.toBeInTheDocument();
  });

  it("keeps the status when the current round's prose is sealed by its settled rows (the round-trip wait)", () => {
    // Prose after a call opens the next round, so a text-bearing round beside
    // settled rows is NOT streaming prose -- it is the round-trip wait, and
    // the status must name it (the sealed-tail reading of the #1167 window).
    renderExchange({
      ...liveTurnWith(undefined),
      step: 2,
      rounds: [
        { text: "第一轮已收口。", rows: [settledRow()] },
        {
          text: "第二轮正文已封口。",
          rows: [settledRow()],
        },
      ],
    });
    expect(screen.getByText("思考中（第 2 步）")).toBeInTheDocument();
  });
});

describe("LiveTurnExchange trailing wait status (the #1606 bare face)", () => {
  // The sealed-tail wait: a settled row + sealed prose beside it -- the
  // status names the round-trip wait. The thinking duration still lives on
  // the expanded face's folds, but the TURN clock rides the head since
  // #1612 re-hosted it here -- the figure is the line's constant tail.
  const sealedTailWait = (): LiveTurn => ({
    question: "问",
    askedAt: Date.now() - 46_000,
    pausedSince: null,
    invocationNames: [],
    step: 2,
    rounds: [{ text: "第一轮已收口。", rows: [settledRow()] }],
  });

  it("reads the step-named status with the turn clock riding the head", () => {
    renderExchange(sealedTailWait());
    expect(screen.getByText("思考中（第 2 步）")).toBeInTheDocument();
    expect(screen.getByText("· 46秒")).toBeInTheDocument();
  });
});

// The live activity line (issue #1606, ADR-0151): the turn's ONE rotating
// activity face -- the thinking phase and the running call rotate its
// folded head (the tool face answers a call at once, the verb repaints
// at most once per window, the face holds one window past the last
// call), the streaming tail steps it aside (the prose + caret carry the
// liveness), and expanding shows the CURRENT round's thinking fold +
// flat call rows (#1656: the line's domain is the turn tail -- every
// earlier round seals as its own settle-isomorphic block in the
// exchange). With nothing behind
// the fold the line is a plain status line (no hover, no click). The
// activity row reads the CURRENT call's summary (whole with the call's
// start event); the status row reads the phase ONLY -- never the summary
// (the anti-flicker contract); the pending approval card stays
// out at the turn tail, always visible (ADR-0083).
describe("LiveTurnExchange live activity line (issue #1606)", () => {
  // One round mid-flight: the first call completed, the second running.
  const midCallTurn = (): LiveTurn => ({
    ...liveTurnWith(undefined),
    step: 1,
    rounds: [
      {
        rows: [
          settledRow({ key: "call-0", name: "explore", summary: "SELECT 1" }),
          settledRow({
            key: "call-1",
            name: "describe",
            summary: "SELECT 2",
            running: true,
            success: null,
          }),
        ],
      },
    ],
  });

  it("rotates into the running face at entry: verb · summary with the breathing dot", () => {
    const { container } = renderExchange(midCallTurn());
    const head = container.querySelector("button.process-toggle");
    expect(head).not.toBeNull();
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(head).toHaveTextContent("读取 · SELECT 2");
    expect(head?.querySelector(".activity-live-dot")).not.toBeNull();
    // The count's retirement is pinned negatively: no completed-count
    // phrase can return to the head unnoticed.
    expect(head?.textContent).not.toContain("已完成");
    // The sweep half of the pair is pinned too: flattening the face back to
    // bare text must red here, not silently retire the liveness (DESIGN.md's
    // Indicators entry carries the sweep as the liveness carrier).
    expect(head?.querySelector(".activity-shimmer")).not.toBeNull();
    // The widened gap rides the head in both postures; the class pin keeps
    // the spacing from normalizing back to the family default. max-w-full
    // rides the same both-postures pin: the exchange stream is items-start,
    // a fit-content head sizes by the nowrap excerpt's max-content and
    // overruns the rail into the overflow-x crop without the clamp.
    expect(head).toHaveClass("mt-2");
    expect(head).toHaveClass("max-w-full");
    // The row gap rides the same call-site override (twMerge, last wins
    // over the fold chrome's gap-0.5): the pin keeps the widened pair
    // spacing from collapsing back to the chrome default.
    expect(head).toHaveClass("gap-1.5");
    // The tier pin guards the retier itself: the head rides the 13px
    // chrome tier, and falling back to the chrome default or the old
    // 12px body must red here, not silently revert.
    expect(head).toHaveClass("text-[13px]");
    // The settled row's summary stays folded; the running call's summary is
    // the activity row's own payload now (#1661) -- it rides the label's
    // span, so the row's text carries it.
    expect(screen.queryByText("SELECT 1")).not.toBeInTheDocument();
    expect(container.querySelector(".activity-preview-row")).toHaveTextContent(
      "读取 · SELECT 2",
    );
  });

  it("holds the verb through a sub-window kind switch: only the summary moves", () => {
    vi.useFakeTimers();
    try {
      const view = renderExchange(midCallTurn());
      expect(view.container.querySelector("button.process-toggle")).toHaveTextContent(
        "读取 · SELECT 2",
      );
      // The read settles; a fast network call starts running (its kind
      // differs from the verb face on the head).
      const switched = midCallTurn();
      switched.rounds = [
        {
          rows: [
            settledRow({ key: "call-0", name: "explore", summary: "SELECT 1" }),
            settledRow({ key: "call-1", name: "describe", summary: "SELECT 2" }),
            settledRow({
              key: "call-2",
              name: "fetch",
              server: "acme",
              operationKind: "network",
              summary: "GET /x",
              running: true,
              success: null,
            }),
          ],
        },
      ];
      view.rerender(exchangeEl(switched));
      // Sub-dwell: the face holds the previous verb while the new call's
      // summary rides at once -- a call that flashes by never repaints the
      // head label (the user ruling).
      expect(view.container.querySelector("button.process-toggle")).toHaveTextContent(
        "读取 · GET /x",
      );
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(view.container.querySelector("button.process-toggle")).toHaveTextContent(
        "联网 · GET /x",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rotates into the thinking face while no call runs (the wait)", () => {
    const turn = liveTurnWith(undefined);
    turn.step = 2;
    turn.rounds = [{ text: "第一轮已收口。", rows: [settledRow()] }];
    const { container } = renderExchange(turn);
    const head = container.querySelector("button.process-toggle");
    expect(head).toHaveTextContent("思考中（第 2 步）");
    expect(head?.querySelector(".activity-live-dot")).not.toBeNull();
  });

  it("streams the thinking head's excerpt and expands the streamed text (issue #1658)", () => {
    const turn = liveTurnWith(undefined);
    turn.step = 1;
    turn.rounds = [{ thinkingText: "第一段推理完毕\n第二段正在生成", rows: [] }];
    const { container } = renderExchange(turn);
    // A streaming-only round is expandable on its own (the canExpand
    // admission): the fold toggle carries the head, not the plain status
    // line.
    const head = container.querySelector("button.process-toggle");
    expect(head).not.toBeNull();
    expect(head).toHaveAttribute("aria-expanded", "false");
    // The head appends the latest completed line after the lead word --
    // the growing stretch stays out (paragraph-level progression).
    expect(container.querySelector(".thinking-head-excerpt")).toHaveTextContent(
      "第一段推理完毕",
    );
    expect(container.querySelector(".activity-preview-row")).toHaveTextContent(
      "第一段推理完毕",
    );
    expect(head).toHaveTextContent("思考中");
    // Expand: the full streamed text rides the muted region the frozen
    // ThinkingFold's body shares (custody: the stream's home is the line).
    fireEvent.click(head!);
    const region = screen.getByRole("region", { name: "智能体思考" });
    expect(region).toHaveTextContent("第一段推理完毕");
    expect(region).toHaveTextContent("第二段正在生成");
  });

  it("keeps the expanded streaming block pinned to the tail as deltas append (#1669)", () => {
    const turn = liveTurnWith(undefined);
    turn.step = 1;
    turn.rounds = [{ thinkingText: "第一段推理完毕\n第二段正在生成", rows: [] }];
    const view = renderExchange(turn);
    fireEvent.click(view.container.querySelector("button.process-toggle")!);
    const region = screen.getByRole("region", { name: "智能体思考" });
    const scrollTop = stubScrollGeometry(region, 400, 192);
    // The next append grows the stream: the follower re-pins the viewport
    // to the tail (the max scroll position).
    const grown = liveTurnWith(undefined);
    grown.step = 1;
    grown.rounds = [
      { thinkingText: "第一段推理完毕\n第二段正在生成\n第三段推理完毕", rows: [] },
    ];
    view.rerender(exchangeEl(grown));
    expect(scrollTop()).toBe(400 - 192);
  });

  it("pins to the tail at expand time itself, before any append (#1669)", () => {
    const turn = liveTurnWith(undefined);
    turn.step = 1;
    turn.rounds = [{ thinkingText: "第一段推理完毕\n第二段正在生成", rows: [] }];
    const view = renderExchange(turn);
    // The region only mounts on expand, so the expand-time pin (the
    // `expanded` half of the effect deps) fires inside the click: the
    // prototype-level geometry is what the effect's first run clamps
    // through -- an instance stub is always installed too late.
    const restore = stubScrollGeometryOnPrototype(400, 192);
    try {
      fireEvent.click(view.container.querySelector("button.process-toggle")!);
      const region = screen.getByRole("region", { name: "智能体思考" });
      expect(region.scrollTop).toBe(400 - 192);
    } finally {
      restore();
    }
  });

  it("releases the stream pin while the reader scrolls up and re-arms at the tail (#1669)", () => {
    const turn = liveTurnWith(undefined);
    turn.step = 1;
    turn.rounds = [{ thinkingText: "第一段推理完毕\n第二段正在生成", rows: [] }];
    const view = renderExchange(turn);
    fireEvent.click(view.container.querySelector("button.process-toggle")!);
    const region = screen.getByRole("region", { name: "智能体思考" });
    const scrollTop = stubScrollGeometry(region, 400, 192);
    // The reader scrolls up to read: the region's scroll event reads "past
    // the tail" and releases the pin -- the next append leaves the viewport
    // where the reader parked it.
    fireEvent.scroll(region, { target: { scrollTop: 0 } });
    const grown = liveTurnWith(undefined);
    grown.step = 1;
    grown.rounds = [
      { thinkingText: "第一段推理完毕\n第二段正在生成\n第三段推理完毕", rows: [] },
    ];
    view.rerender(exchangeEl(grown));
    expect(scrollTop()).toBe(0);
    // Scrolling back to the tail re-arms the follower; the following append
    // pins again.
    fireEvent.scroll(region, { target: { scrollTop: 400 - 192 } });
    const grownAgain = liveTurnWith(undefined);
    grownAgain.step = 1;
    grownAgain.rounds = [
      {
        thinkingText:
          "第一段推理完毕\n第二段正在生成\n第三段推理完毕\n第四段推理完毕",
        rows: [],
      },
    ];
    view.rerender(exchangeEl(grownAgain));
    expect(scrollTop()).toBe(400 - 192);
  });

  it("follows a new round's stream from its first frame without inheriting the released pin (#1669)", () => {
    const turn = liveTurnWith(undefined);
    turn.step = 1;
    turn.rounds = [{ thinkingText: "第一段推理完毕\n第二段正在生成", rows: [] }];
    const view = renderExchange(turn);
    fireEvent.click(view.container.querySelector("button.process-toggle")!);
    const region = screen.getByRole("region", { name: "智能体思考" });
    stubScrollGeometry(region, 400, 192);
    // The reader releases the pin in round 1.
    fireEvent.scroll(region, { target: { scrollTop: 0 } });
    // A new round opens with its own stream: the face remounts (keyed by
    // the round count, so the boundary does not depend on the seal's
    // branch swap), the mount arm re-arms, and the new round's next append
    // pins from the remounted face -- round 1's released pin does not
    // leak.
    const nextRound = liveTurnWith(undefined);
    nextRound.step = 2;
    nextRound.rounds = [
      { thinkingText: "第一段推理完毕\n第二段正在生成", rows: [settledRow()] },
      { thinkingText: "新一轮的流式推理文本", rows: [] },
    ];
    view.rerender(exchangeEl(nextRound));
    const freshRegion = screen.getByRole("region", { name: "智能体思考" });
    expect(freshRegion).not.toBe(region);
    const freshScroll = stubScrollGeometry(freshRegion, 400, 192);
    const more = liveTurnWith(undefined);
    more.step = 2;
    more.rounds = [
      { thinkingText: "第一段推理完毕\n第二段正在生成", rows: [settledRow()] },
      { thinkingText: "新一轮的流式推理文本\n继续推理", rows: [] },
    ];
    view.rerender(exchangeEl(more));
    expect(freshScroll()).toBe(400 - 192);
  });

  it("keeps the fold head's chevron beside the status text (the row hugs its content, #1669)", () => {
    const turn = liveTurnWith(undefined);
    turn.step = 1;
    turn.rounds = [{ thinkingText: "第一段推理完毕\n第二段正在生成", rows: [] }];
    const { container } = renderExchange(turn);
    // The chevron's ml-auto must never gain slack from the button's width:
    // the fold row hugs its content, so a full-bleed activity row above
    // cannot throw the affordance at the container's far edge. Scoped to
    // the line's own head -- the hook class rides the settled folds too.
    const head = container.querySelector("button.process-toggle");
    const chevron = head?.querySelector(".ml-auto");
    expect(chevron).not.toBeNull();
    expect(chevron?.parentElement).toHaveClass("self-start");
  });

  it("keeps the excerpt off the status row: activity row above, elapsed figure never beside it (#1661)", () => {
    const turn = liveTurnWith(undefined);
    turn.step = 1;
    turn.rounds = [{ thinkingText: "第一段推理完毕\n第二段正在生成", rows: [] }];
    const { container } = renderExchange(turn);
    // The excerpt lives in its own activity row ABOVE the fold row -- the
    // status row's shimmer never wraps it (a descendant's clip/mask cannot
    // clip the ancestor's glyph painting; the overlap this retires). The
    // excerpt span carries BOTH classes (self-painted shimmer + its own
    // clip/fade), and the row never contains the elapsed figure (the face's
    // whitespace-pre span lives on the status row alone).
    const row = container.querySelector(".activity-preview-row");
    expect(row).not.toBeNull();
    expect(row?.querySelector(".thinking-head-excerpt.activity-shimmer")).not.toBeNull();
    // Fixed label · moving content: the settled thinking fold's own word
    // anchors the row, the excerpt streams after the separator.
    expect(row).toHaveTextContent("思考 · 第一段推理完毕");
    expect(row?.querySelector(".whitespace-pre")).toBeNull();
    // The status row below reads the phase word, the figure rides it.
    const line = container.querySelector(".process-toggle");
    expect(line).toHaveTextContent("思考中");
    expect(line?.querySelector(".whitespace-pre")).not.toBeNull();
  });

  it("hides the activity row while expanded (the expand face owns both signals)", () => {
    const turn = liveTurnWith(undefined);
    turn.step = 1;
    turn.rounds = [{ thinkingText: "第一段推理完毕\n第二段正在生成", rows: [] }];
    const { container } = renderExchange(turn);
    expect(container.querySelector(".activity-preview-row")).not.toBeNull();
    fireEvent.click(container.querySelector("button.process-toggle")!);
    expect(container.querySelector(".activity-preview-row")).toBeNull();
    // The full streamed text took the excerpt's place in the expand face.
    const region = screen.getByRole("region", { name: "智能体思考" });
    expect(region).toHaveTextContent("第一段推理完毕");
  });

  it("takes the head back at the freeze and expands the ThinkingFold (issue #1658)", () => {
    const turn = liveTurnWith(undefined);
    turn.step = 2;
    // Post-freeze coexistence: the block landed, the streamed text stays
    // display-only underneath -- the head must not read it back.
    turn.rounds = [
      {
        thinkingText: "第一段推理完毕\n第二段正在生成",
        thinking: { duration_ms: 900, text: "冻结后的整段推理。" },
        rows: [],
      },
    ];
    const { container } = renderExchange(turn);
    const head = container.querySelector("button.process-toggle");
    expect(head).not.toBeNull();
    expect(head).toHaveTextContent("思考中（第 2 步）");
    // The excerpt span is gone: the frozen block owns the head (the
    // custody swap at the seal).
    expect(container.querySelector(".thinking-head-excerpt")).toBeNull();
    // Expand: the ThinkingFold (not the streamed region) carries the
    // round's thinking -- the fold's own toggle opens the frozen text.
    fireEvent.click(head!);
    expect(screen.queryByRole("region", { name: "智能体思考" })).toBeNull();
    const fold = container.querySelector("button.thinking-toggle");
    expect(fold).not.toBeNull();
    fireEvent.click(fold!);
    expect(screen.getByRole("region", { name: "智能体思考" })).toHaveTextContent(
      "冻结后的整段推理。",
    );
  });

  it("keeps the line on the streaming tail with the running face and the clock", () => {
    const turn = liveTurnWith(undefined);
    turn.askedAt = Date.now() - 46_000;
    turn.step = 1;
    turn.rounds = [{ text: "正文正在流出。", rows: [] }];
    const { container } = renderExchange(turn);
    // #1612's narrowing of the step-aside ruling: what let the line yield
    // was the thinking face doubling the prose signal -- the running face
    // beside the caret does not reproduce it, and the turn clock keeps its
    // host. The face names the run, never 思考 over growing text.
    const line = container.querySelector(".process-toggle");
    expect(line).toHaveClass("max-w-full");
    // The plain posture carries the same widened pair as the fold posture:
    // the pin keeps the gap from collapsing back to the chrome default here.
    expect(line).toHaveClass("gap-1.5");
    expect(line?.textContent).toContain("执行中");
    expect(line?.textContent).toContain("· 46秒");
    expect(line?.querySelector(".activity-live-dot")).not.toBeNull();
    expect(line?.textContent).not.toContain("思考中");
  });

  it("rides the running call's summary onto the activity row; the phase never flips (anti-flicker)", () => {
    const before = renderExchange(midCallTurn());
    expect(before.container.querySelector("button.process-toggle")?.textContent).toContain(
      "读取 · SELECT 2",
    );
    // A longer summary lands between renders (the summary arrives whole
    // with the call's start event; a later event can replace it): it
    // rides onto the row at once -- one row, one direction, the fade
    // closing it; the pin is that the growth never flips the phase face.
    const streamed = midCallTurn();
    streamed.rounds[0]!.rows[1] = {
      ...streamed.rounds[0]!.rows[1]!,
      summary: "SELECT 2 with a far longer streaming args summary riding the delta",
    };
    before.rerender(exchangeEl(streamed));
    const after = before.container.querySelector("button.process-toggle")?.textContent ?? "";
    expect(after).toContain(
      "SELECT 2 with a far longer streaming args summary riding the delta",
    );
    expect(after).toContain("执行中 ·");
    // The status row never hosts the summary -- the overlap #1661 retires.
    // The figure's whitespace-pre span lives on the status shimmer alone,
    // so its closest shimmer ancestor is that row's span.
    const statusSpan = before.container
      .querySelector("button.process-toggle .whitespace-pre")
      ?.closest(".activity-shimmer");
    expect(statusSpan?.textContent).not.toContain("SELECT 2");
  });

  it("holds the tool face one window past the last call, then reads the wait", () => {
    vi.useFakeTimers();
    try {
      const view = renderExchange(midCallTurn());
      expect(view.container.querySelector("button.process-toggle")).toHaveTextContent(
        "读取 · SELECT 2",
      );
      const done = midCallTurn();
      done.rounds = [
        {
          rows: [
            settledRow({ key: "call-0", name: "explore", summary: "SELECT 1" }),
            settledRow({ key: "call-1", name: "describe", summary: "SELECT 2" }),
          ],
        },
      ];
      view.rerender(exchangeEl(done));
      // Grace: the face holds one window past the last call -- a call that
      // just finished must not blink the line back to thinking (the user
      // ruling: a line stuck on the thinking face reads as dead). The
      // completed call's summary sample lingers the same window, then the
      // wait's thinking face takes the row back with the verb.
      expect(view.container.querySelector(".activity-preview-row")).toHaveTextContent(
        "读取 · SELECT 2",
      );
      act(() => {
        vi.advanceTimersByTime(600);
      });
      // The round-trip wait IS the thinking phase: the face rotates back
      // once the grace is spent -- and the row still reports the tail
      // round's last completed call (the linger; the status row carries
      // the honest phase).
      const head = view.container.querySelector("button.process-toggle");
      expect(head).toHaveTextContent("思考中");
      expect(head).toHaveTextContent("读取 · SELECT 2");
      expect(head?.querySelector(".activity-live-dot")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the row reporting the last completed call through the wait (the linger)", () => {
    const turn = liveTurnWith(undefined);
    turn.step = 2;
    turn.rounds = [
      {
        rows: [
          settledRow({ key: "call-0", summary: "SELECT 1" }),
          settledRow({ key: "call-1", name: "describe", summary: "SELECT 2" }),
        ],
      },
    ];
    const { container } = renderExchange(turn);
    // No running call, no streamed thinking: the face reads the wait --
    // and the row still reports the tail round's last completed call (the
    // row holds steady instead of blinking away with the face; the status
    // row carries the honest phase).
    const head = container.querySelector("button.process-toggle");
    expect(head).toHaveTextContent("思考中");
    expect(container.querySelector(".activity-preview-row")).toHaveTextContent(
      "读取 · SELECT 2",
    );
  });

  it("shows the verb alone while the running call's summary is empty (never the previous call's summary under this verb)", () => {
    const turn = liveTurnWith(undefined);
    turn.step = 2;
    turn.rounds = [
      { rows: [settledRow({ key: "call-0", summary: "SELECT 1" })] },
      {
        rows: [
          {
            ...settledRow({
              key: "call-1",
              name: "describe",
              operationKind: "network",
              summary: "",
            }),
            running: true,
            success: null,
          },
        ],
      },
    ];
    const { container } = renderExchange(turn);
    // While a call runs, the subject stays on THAT call: an empty summary
    // renders the verb alone -- the previous call's summary must not
    // speak under this call's verb (the compound misreport).
    const row = container.querySelector(".activity-preview-row");
    expect(row?.textContent).toBe("联网");
    expect(row?.querySelector(".thinking-head-excerpt")).toBeNull();
    expect(container.querySelector("button.process-toggle")).toHaveTextContent(
      "执行中（第 2 步）",
    );
  });

  it("previews the held call as the verb alone when its summary is empty (the linger never speaks for it)", () => {
    const turn = liveTurnWith(undefined);
    turn.rounds = [
      {
        rows: [
          settledRow({ key: "call-0", summary: "SELECT 1" }),
          {
            key: "req-1",
            name: "fetch",
            server: "acme",
            operationKind: "network",
            summary: "",
            approval: { requestId: "req-1", response: null },
            running: false,
            success: null,
            resultExcerpt: "",
          },
        ],
      },
    ];
    const { container } = renderExchange(turn);
    // The pending card speaks for the held call whatever its summary: the
    // activity row is suppressed outright (the retired verb-alone
    // preview), and the settled call's summary must not speak for the
    // held call either.
    expect(container.querySelector(".activity-preview-row")).toBeNull();
  });

  it("holds the tool face through the streaming window's grace, then yields the row to the caret (#1663)", () => {
    vi.useFakeTimers();
    try {
      const view = renderExchange(midCallTurn());
      expect(view.container.querySelector("button.process-toggle")).toHaveTextContent(
        "读取 · SELECT 2",
      );
      // The call drains into a streaming tail (the wait predicate's prose
      // arm -- the prose carries the liveness): the face holds one window
      // first.
      const prose = midCallTurn();
      prose.step = 2;
      prose.rounds = [
        { rows: [settledRow({ key: "call-0", name: "explore", summary: "SELECT 1" })] },
        { text: "正文正在流出。", rows: [] },
      ];
      view.rerender(exchangeEl(prose));
      // The settled call sealed into its own round; the row lingers on it
      // ACROSS the round boundary through the grace (the turn's last
      // completed call is the linger's domain, not the tail round's) --
      // grace is an inter-call gap, not the streaming window.
      expect(view.container.querySelector(".activity-preview-row")).toHaveTextContent(
        "读取 · SELECT 1",
      );
      act(() => {
        vi.advanceTimersByTime(600);
      });
      // Past the grace the streaming face owns the line (#1612's narrowing):
      // the running face + the clock keep the line alive beside the prose.
      expect(view.container.querySelector(".process-toggle")?.textContent).toContain(
        "执行中（第 2 步）",
      );
      // The steady state: the row yields to the caret -- a present-tense
      // verb over streaming prose claims a call that is not running (the
      // #1662 Advisory A misreading); the gaps the linger holds through
      // are inter-call gaps and round boundaries, never this window.
      expect(view.container.querySelector(".activity-preview-row")).toBeNull();
      // The yield retires the linger's content wholesale -- no summary can
      // leak onto the status row (the anti-flicker contract).
      expect(view.container.querySelector(".process-toggle")?.textContent).not.toContain(
        "SELECT 1",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the tool face through the gate hold; the card renders beside it", () => {
    const turn = liveTurnWith(undefined);
    turn.rounds = [
      {
        rows: [
          settledRow({ key: "call-0", name: "explore", summary: "SELECT 1" }),
          {
            key: "req-1",
            name: "fetch",
            server: "acme",
            operationKind: "network",
            summary: "GET /x",
            approval: { requestId: "req-1", response: null },
            running: false,
            success: null,
            resultExcerpt: "",
          },
        ],
      },
    ];
    const { container } = renderExchange(turn);
    // The pending hold yields the tool row: the card below names the same
    // tool, badge, and summary verbatim -- painting the held call twice
    // back to back is the stacked face this retires. The status row alone
    // keeps the line's liveness (dot + figure), the card renders beside it
    // (ADR-0083's flow face).
    expect(container.querySelector(".activity-preview-row")).toBeNull();
    const head = container.querySelector("button.process-toggle");
    expect(head).toHaveTextContent("执行中");
    expect(head?.querySelector(".activity-live-dot")).not.toBeNull();
    expect(container.querySelector(".approval-card")).not.toBeNull();
    // The tail mount's width pin: w-full, NOT the family's max-w-full cap
    // (jsdom cannot measure; toHaveClass pins the token exactly, rationale
    // at the mount in LiveTurnExchange).
    const tailMount = container
      .querySelector(".approval-card")
      ?.closest(".trace-round");
    expect(tailMount).toHaveClass("w-full");
    expect(screen.getByText("等待审批")).toBeInTheDocument();
  });

  it("is a plain status line while nothing sits behind the fold (no hover, no click)", () => {
    // A first-call gate hold: the card pends, but no thinking and no
    // settled/running row exist yet -- expanding would show nothing.
    const turn = liveTurnWith(undefined);
    turn.step = 1;
    turn.rounds = [
      {
        rows: [
          {
            key: "req-0",
            name: "fetch",
            server: "acme",
            operationKind: "network",
            summary: "GET /x",
            approval: { requestId: "req-0", response: null },
            running: false,
            success: null,
            resultExcerpt: "",
          },
        ],
      },
    ];
    const { container } = renderExchange(turn);
    // Not a button: no fold semantics, no hover, no click (the user ruling).
    expect(container.querySelector("button.process-toggle")).toBeNull();
    const line = container.querySelector(".process-toggle");
    expect(line?.tagName).toBe("DIV");
    // The pending hold yields the tool row (the card speaks for the call);
    // the plain status face keeps the liveness.
    expect(line).not.toHaveTextContent("联网");
    expect(line).toHaveTextContent("执行中");
    expect(line?.querySelector(".activity-live-dot")).not.toBeNull();
    // The plain posture carries the same widened gap (the fold posture's is
    // pinned on the head above).
    expect(line).toHaveClass("mt-2");
    // The card still renders beside the line (ADR-0083's flow face).
    expect(container.querySelector(".approval-card")).not.toBeNull();
    expect(screen.getByText("等待审批")).toBeInTheDocument();
  });

  it("seals each finished round as its own settle-isomorphic block; the line reads the tail only", () => {
    const onActivityExpandedChange = vi.fn();
    const turn = liveTurnWith(undefined);
    turn.step = 4;
    turn.rounds = [
      {
        thinking: { duration_ms: 1200, text: "推理一" },
        text: "先看一眼。",
        rows: [settledRow({ key: "call-0", name: "explorer", summary: "SELECT 1" })],
      },
      {
        rows: [settledRow({ key: "call-1", name: "fetch", server: "acme", operationKind: "network", summary: "GET /x" })],
      },
      {
        thinking: { duration_ms: 300, text: "推理二" },
        text: "数据已就绪。",
        rows: [settledRow({ key: "call-2", name: "python", server: "acme", operationKind: "execute", summary: "SELECT 3" })],
      },
      {
        rows: [
          settledRow({ key: "call-3", name: "materialize", operationKind: "write", summary: "SELECT 4" }),
          settledRow({ key: "call-4", name: "materialize", operationKind: "write", summary: "SELECT 5", running: true, success: null }),
        ],
      },
    ];
    const { container } = renderExchange(turn, onActivityExpandedChange);
    // Every round before the tail is sealed (#1656): three settle-form fold
    // heads -- one per round, never an aggregate line.
    const roundToggles = container.querySelectorAll("button.trace-toggle");
    expect(roundToggles).toHaveLength(3);
    expect(roundToggles[0]?.textContent).toBe("轨迹 · explorer ×1");
    expect(roundToggles[1]?.textContent).toBe("轨迹 · fetch ×1");
    expect(roundToggles[2]?.textContent).toBe("轨迹 · python ×1");
    // The thinking folds ride the same blocks at their settle position,
    // heads visible while collapsed (the two-lines-per-round posture).
    expect(screen.getByText("思考 · 1.2s")).toBeInTheDocument();
    expect(screen.getByText("思考 · 0.3s")).toBeInTheDocument();
    // The prose rides its own round above the fold lines.
    expect(screen.getByText("先看一眼。")).toBeInTheDocument();
    expect(screen.getByText("数据已就绪。")).toBeInTheDocument();
    // Folded by default: no row content dumps out (the height governance).
    expect(screen.queryByText("SELECT 1")).not.toBeInTheDocument();
    expect(screen.queryByText("GET /x")).not.toBeInTheDocument();
    expect(screen.queryByText("SELECT 3")).not.toBeInTheDocument();
    // The head's count reads the TAIL round only (#1656's narrowing): one
    // settled call there -- the sealed rounds' calls no longer report.
    const head = container.querySelector("button.process-toggle");
    expect(head).toHaveTextContent("写入 · SELECT 5");
    // Open the first sealed round: its call lands on the shared left-rail
    // list; the other rounds stay folded.
    fireEvent.click(roundToggles[0]!);
    expect(screen.getByText("SELECT 1")).toBeInTheDocument();
    expect(screen.queryByText("GET /x")).not.toBeInTheDocument();
    expect(screen.queryByText("SELECT 3")).not.toBeInTheDocument();
    expect(onActivityExpandedChange).not.toHaveBeenCalledWith(true);
  });

  it("seals leading rounds even under no prose (the pre-prose posture)", () => {
    const turn = liveTurnWith(undefined);
    turn.rounds = [
      { rows: [settledRow({ key: "call-0", summary: "SELECT 1" })] },
      { rows: [settledRow({ key: "call-1", name: "describe", summary: "SELECT 2" })] },
      { rows: [settledRow({ key: "call-2", summary: "SELECT 3", running: true, success: null })] },
    ];
    const { container } = renderExchange(turn);
    // No prose section anywhere: the two finished rounds still seal as their
    // own fold lines (#1656), the current round alone rides the line.
    const roundToggles = container.querySelectorAll("button.trace-toggle");
    expect(roundToggles).toHaveLength(2);
    expect(roundToggles[0]?.textContent).toBe("轨迹 · explore ×1");
    expect(roundToggles[1]?.textContent).toBe("轨迹 · describe ×1");
    // The line reads the current round only: the running call reports zero
    // completed -- the sealed calls sit behind their own folds.
    expect(container.querySelector("button.process-toggle")).toHaveTextContent(
      "读取 · SELECT 3",
    );
    expect(screen.queryByText("SELECT 1")).not.toBeInTheDocument();
    fireEvent.click(roundToggles[0]!);
    expect(screen.getByText("SELECT 1")).toBeInTheDocument();
  });

  it("keeps a resolved-deny row visible at the tail until its completion lands", () => {
    // The deny's optimistic resolve and the gateway's completion event
    // (success false) are two commits; between them the row is neither
    // pending nor settled, and the settled-only fold faces admit neither
    // -- the tail is the one surface keeping the answer marker visible
    // for that window (the marker used to vanish entirely).
    const turn = liveTurnWith(undefined);
    turn.step = 1;
    turn.rounds = [
      {
        rows: [
          {
            key: "req-1",
            name: "fetch",
            server: "acme",
            operationKind: "network",
            summary: "GET /x",
            approval: { requestId: "req-1", response: "deny" },
            running: false,
            success: null,
            resultExcerpt: "",
          },
        ],
      },
    ];
    const { container } = renderExchange(turn);
    // The deny badge rides the row at the tail immediately -- no buttons
    // remain (the card phase is over) and nothing doubles the row.
    expect(screen.getByText("已拒绝")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "允许一次" })).not.toBeInTheDocument();
    expect(container.querySelectorAll(".trace-row")).toHaveLength(1);
    // The line holds the tool face under the un-completed approval row
    // (the gate-hold extension: the deny's completion is a network window
    // away), and the head counts only settled rows -- the deny row waits
    // for its completion event. With nothing expandable behind the fold
    // the line is the plain status face.
    const line = container.querySelector(".process-toggle");
    expect(line?.tagName).toBe("DIV");
    expect(line).toHaveTextContent("联网 · GET /x");
  });

  it("keeps an abandoned call's row visible at the tail forever (#1267)", () => {
    // The dropped call never completes -- no settled face will ever admit
    // it -- so the tail keeps the abandoned marker for the rest of the
    // turn (the marker used to have no surface at all).
    const turn = liveTurnWith(undefined);
    turn.step = 1;
    turn.rounds = [
      {
        rows: [
          settledRow({ key: "call-0", summary: "SELECT 1" }),
          {
            key: "req-1",
            name: "fetch",
            server: "acme",
            operationKind: "network",
            summary: "GET /x",
            approval: { requestId: "req-1", response: "abandoned" },
            running: false,
            success: null,
            resultExcerpt: "",
          },
        ],
      },
    ];
    const { container } = renderExchange(turn);
    expect(screen.getByText("已放弃")).toBeInTheDocument();
    // The line holds the tool face under the abandoned row and keeps the
    // settled call in its fold; the abandoned row rides the tail beside
    // it, never inside the fold.
    const head = container.querySelector("button.process-toggle");
    expect(head).toHaveTextContent("联网 · GET /x");
    fireEvent.click(head!);
    expect(screen.getByText("SELECT 1")).toBeInTheDocument();
    expect(container.querySelectorAll(".trace-row")).toHaveLength(2);
  });

  it("seals a leading call-only round above the following prose (issue #1236)", () => {
    // Rows may lead the slot arrays -- a turn can open with calls before
    // any prose lands. The call-only round seals as its own fold line at
    // its own top position (#1656); the prose round after it seals as the
    // prose-only block it is.
    const turn = liveTurnWith(undefined);
    turn.step = 3;
    turn.rounds = [
      { rows: [settledRow({ key: "call-0", summary: "SELECT 1" })] },
      { text: "先看一眼。", rows: [] },
      { rows: [settledRow({ key: "call-1", summary: "SELECT 2" })] },
    ];
    const { container } = renderExchange(turn);
    const roundToggles = container.querySelectorAll("button.trace-toggle");
    expect(roundToggles).toHaveLength(1);
    expect(roundToggles[0]?.textContent).toBe("轨迹 · explore ×1");
    // The fold sits ABOVE the prose section (its own round's position).
    const prose = screen.getByText("先看一眼。");
    expect(
      roundToggles[0]!.compareDocumentPosition(prose) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Open it: the call row lands on the shared left-rail list; the line
    // keeps the current round (the count reads the one call there).
    fireEvent.click(roundToggles[0]!);
    expect(screen.getByText("SELECT 1")).toBeInTheDocument();
    expect(container.querySelector(".trace-toggle + ul.trace-list")).not.toBeNull();
    fireEvent.click(container.querySelector("button.process-toggle")!);
    expect(screen.getByText("SELECT 2")).toBeInTheDocument();
    expect(screen.getByText("SELECT 2").closest("ul")).toHaveClass("trace-list");
  });
});

// The sealed round's settle isomorphism (#1656): a finished round lands as
// the SAME per-round form the settled trace mounts -- the thinking fold
// ("Thinking · {sec}s"), the connective prose, the step fold whose head
// speaks the shared per-tool counts -- so the settle swap moves nothing.
describe("LiveTurnExchange sealed round settle form (#1656)", () => {
  it("seals a prose-less round as the thinking + trace two-line form", () => {
    // A call-only round with thinking: exactly the settle round's shape --
    // two fold lines carrying the settle heads verbatim, nothing unfurled.
    const turn = liveTurnWith(undefined);
    turn.step = 2;
    turn.rounds = [
      {
        thinking: { duration_ms: 1500, text: "推理" },
        rows: [settledRow({ key: "call-0", name: "explore", summary: "SELECT 1" })],
      },
      { text: "正文正在流出。", rows: [] },
    ];
    const { container } = renderExchange(turn);
    expect(screen.getByText("思考 · 1.5s")).toBeInTheDocument();
    const fold = container.querySelector("button.trace-toggle");
    expect(fold?.textContent).toBe("轨迹 · explore ×1");
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("SELECT 1")).not.toBeInTheDocument();
    // The prose rides the tail round above the line.
    expect(screen.getByText("正文正在流出。")).toBeInTheDocument();
  });

  it("keeps the current round's thinking in the line alone (single custody)", () => {
    // Thinking lands on a round while it is still the tail (mid-round, the
    // state layer keys it by step): the block above the line must not
    // double it -- the current round's thinking is the expand face's
    // (ADR-0151 Decision 5); custody transfers to the block only at the
    // seal.
    const turn = liveTurnWith(undefined);
    turn.step = 1;
    turn.rounds = [
      {
        thinking: { duration_ms: 700, text: "推理中" },
        text: "边想边说。",
        rows: [],
      },
    ];
    const { container } = renderExchange(turn);
    expect(screen.queryByText("思考 · 0.7s")).not.toBeInTheDocument();
    // The line's expand face carries it.
    fireEvent.click(container.querySelector("button.process-toggle")!);
    expect(screen.getByText("思考 · 0.7s")).toBeInTheDocument();
  });

  it("keeps a gate-held current round unsealed; earlier rounds still seal", () => {
    // The pending card lives in the current round: the round stays the
    // line's, the tool face holds (ADR-0083 flow face), and only the
    // earlier round seals (#1656).
    const turn = liveTurnWith(undefined);
    turn.step = 2;
    turn.rounds = [
      { rows: [settledRow({ key: "call-0", name: "explore", summary: "SELECT 1" })] },
      {
        rows: [
          settledRow({ key: "call-1", name: "describe", summary: "SELECT 2" }),
          {
            key: "req-1",
            name: "fetch",
            server: "acme",
            operationKind: "network",
            summary: "GET /x",
            approval: { requestId: "req-1", response: null },
            running: false,
            success: null,
            resultExcerpt: "",
          },
        ],
      },
    ];
    const { container } = renderExchange(turn);
    // One sealed block (the earlier round); the current round's settled
    // call stays in the line's fold, beside the pending card -- whose
    // hold also yields the tool row (the card speaks for the call).
    expect(container.querySelectorAll("button.trace-toggle")).toHaveLength(1);
    expect(container.querySelector("button.process-toggle")).toHaveTextContent(
      "执行中",
    );
    expect(container.querySelector(".activity-preview-row")).toBeNull();
    expect(container.querySelector(".approval-card")).not.toBeNull();
    // The current round's rows sit behind the line's fold, not a block fold.
    expect(screen.queryByText("SELECT 2")).not.toBeInTheDocument();
    fireEvent.click(container.querySelector("button.process-toggle")!);
    expect(screen.getByText("SELECT 2")).toBeInTheDocument();
  });

  it("keeps a sealed round's fold posture across stream updates (the rerender survival)", () => {
    // The block comment pins prose-non-remount across the tail->sealed
    // transition as load-bearing, and the fold state rides the same
    // instance: expand a sealed fold, append a stream round, and the
    // posture must survive -- a refactor that remounts the blocks (a key
    // switch, a conditional wrapper) would collapse the user's open fold
    // on every stream block with the suite green.
    const onActivityExpandedChange = vi.fn();
    const turn = liveTurnWith(undefined);
    turn.step = 3;
    turn.rounds = [
      { rows: [settledRow({ key: "call-0", name: "explore", summary: "SELECT 1" })] },
      { rows: [settledRow({ key: "call-1", name: "fetch", summary: "GET /x" })] },
      { rows: [settledRow({ key: "call-2", name: "describe", summary: "SELECT 2" })] },
    ];
    const view = renderExchange(turn, onActivityExpandedChange);
    fireEvent.click(view.container.querySelectorAll("button.trace-toggle")[0]!);
    expect(view.container.querySelectorAll("button.trace-toggle")[0]).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("SELECT 1")).toBeInTheDocument();
    // The stream appends a round (the state layer's shape: rounds grow,
    // the seal index moves with them); the tail round stays the line's.
    const grown = liveTurnWith(undefined);
    grown.step = 4;
    grown.rounds = [
      ...turn.rounds,
      { rows: [settledRow({ key: "call-3", name: "python", summary: "SELECT 3" })] },
    ];
    view.rerender(exchangeEl(grown, onActivityExpandedChange));
    const folds = view.container.querySelectorAll("button.trace-toggle");
    expect(folds).toHaveLength(3);
    // The open fold survived the rerender on the same instance.
    expect(folds[0]).toHaveAttribute("aria-expanded", "true");
    expect(folds[1]).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("SELECT 1")).toBeInTheDocument();
    // The new tail rides the line, not a block.
    expect(screen.queryByText("SELECT 3")).not.toBeInTheDocument();
  });

  it("keeps an early round carrying an unsettled row unsealed; its members go dark (the honest degrade)", () => {
    // The guard half's backstop shape: a state-layer path that opens the
    // successor while an early round still holds an unsettled row must
    // not seal around it -- the fold head would report the settled subset
    // with unwarranted confidence. The unsealed early round has no live
    // surface (the line owns the tail alone), so its members go dark
    // until the settle swap reclaims them. No current producer reaches
    // the shape (deny completions land inside their round by channel
    // ordering; abandon ends the turn) -- this pin makes the degrade
    // conscious should the state layer ever get there.
    const turn = liveTurnWith(undefined);
    turn.step = 2;
    turn.rounds = [
      {
        rows: [
          settledRow({ key: "call-0", name: "explore", summary: "SELECT 1" }),
          {
            key: "call-1",
            name: "fetch",
            server: null,
            operationKind: "network",
            summary: "GET /y",
            approval: null,
            running: true,
            success: null,
            resultExcerpt: "",
          },
        ],
      },
      { rows: [settledRow({ key: "call-2", name: "describe", summary: "SELECT 2" })] },
    ];
    const { container } = renderExchange(turn);
    // Not sealed: no block fold for the early round.
    expect(container.querySelectorAll("button.trace-toggle")).toHaveLength(0);
    // Its settled member renders on no surface (the line reads the tail
    // round alone).
    expect(screen.queryByText("SELECT 1")).not.toBeInTheDocument();
    // The tail round rides the line normally (the dark round's running
    // row still paints the tool face -- allRows spans the turn, and the
    // face reads that row's summary, the same source as the verb).
    expect(container.querySelector("button.process-toggle")).toHaveTextContent(
      "联网 · GET /y",
    );
  });
});

// The turn clock's host (issue #1264's ruling re-hosted by #1612): the
// elapsed figure rides the line's face tail in EVERY phase and posture --
// pausedSince freezes it while the gate holds, and a face rotation never
// resets it (the stamp-derived seconds heal any remount).
describe("LiveTurnExchange the turn clock on the line (#1612)", () => {
  const gateHoldTurn = (askedAt: number, pausedSince: number | null): LiveTurn => ({
    ...liveTurnWith(undefined),
    askedAt,
    pausedSince,
    step: 1,
    rounds: [
      {
        rows: [
          {
            key: "req-0",
            name: "fetch",
            server: "acme",
            operationKind: "network",
            summary: "GET /x",
            approval: { requestId: "req-0", response: null },
            running: false,
            success: null,
            resultExcerpt: "",
          },
        ],
      },
    ],
  });

  it("freezes the figure at the pause origin while the gate holds the turn", () => {
    // One now for both stamps: the 60s span stays exact (a per-call
    // Date.now() pair could straddle a millisecond and floor to 59s).
    const now = Date.now();
    renderExchange(gateHoldTurn(now - 100_000, now - 40_000));
    // 100s since the ask, the last 40s on the user: the figure reads the
    // pause origin -- user think-time stays out (60s lands on the minutes
    // tier, zero-padded).
    expect(screen.getByText("· 1分00秒")).toBeInTheDocument();
  });

  it("keeps the same figure across face rotations (streaming -> tool -> thinking)", () => {
    // Fake timers: the tool face's 600ms grace must be spent before the
    // streaming face takes over (the grace ruling is unchanged by #1612).
    vi.useFakeTimers();
    try {
      const askedAt = Date.now() - 46_000;
      const view = renderExchange(
        gateHoldTurn(askedAt, null),
      );
      // Gate hold: the pending card owns the held call's face (the tool
      // row yields); the status row keeps the line, the figure runs from
      // the ask stamp.
      expect(view.container.querySelector(".activity-preview-row")).toBeNull();
      expect(screen.getByText("· 46秒")).toBeInTheDocument();
      // A streaming tail arrives: after the grace the face rotates to the
      // running face -- the figure does not reset (one host, one stamp).
      const streaming: LiveTurn = {
        ...gateHoldTurn(askedAt, null),
        rounds: [{ text: "正文正在流出。", rows: [] }],
      };
      view.rerender(exchangeEl(streaming));
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(screen.getByText("· 46秒")).toBeInTheDocument();
      expect(view.container.querySelector(".process-toggle")?.textContent).toContain("执行中");
      // The call settles into the round-trip wait: the thinking face, the
      // same figure still.
      const settled: LiveTurn = {
        ...gateHoldTurn(askedAt, null),
        step: 2,
        rounds: [{ rows: [settledRow({ key: "call-0" })] }],
      };
      view.rerender(exchangeEl(settled));
      expect(screen.getByText("· 46秒")).toBeInTheDocument();
      expect(view.container.querySelector(".process-toggle")).toHaveTextContent("思考中");
    } finally {
      vi.useRealTimers();
    }
  });
});
