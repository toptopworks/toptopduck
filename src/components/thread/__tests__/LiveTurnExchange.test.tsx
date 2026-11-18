// The live exchange's own surface pins. The head contract -- the marker's
// first-child position, its built-in / pre-id silence cells, the
// invocation-badge face -- and the round width cap ride the swap-stable
// modules now, pinned in TurnExchangeFrame.test / RoundBody.test (issue
// #1157); what stays here is what only the live side reaches through its own
// data: the marker's absence before the ask-time read lands (the runtime
// riding LiveTurn arrives late -- when it lands is useTurnFlow's contract,
// pinned in its own tests) and its presence + the staged badge names once
// they land (the adapter hand-offs -- the frame pins only the given-prop
// faces), plus the streaming prose postures (ADR-0120) and the trailing
// thinking-status postures (issue #1167).

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
    expect(screen.getByText("思考中…")).toBeInTheDocument();
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
    expect(screen.getByText("思考中（第 2 步）…")).toBeInTheDocument();
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
          rows: [settledRow({ name: "ToolSearch", server: "tools", summary: "query=toptopduck" })],
        },
      ],
    });
    expect(screen.getByText("思考中…")).toBeInTheDocument();
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
    expect(screen.getByText("思考中…")).toBeInTheDocument();
  });

  it("yields nothing while the call-less tail's prose streams (the caret carries liveness)", () => {
    // The suppression arm's own pin: a still-growing tail keeps the status
    // away, so a regression to "always show" -- the spinner leaking over
    // visibly streaming text -- cannot pass the suite silently (the keep
    // tests above own the "never show" direction).
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
    expect(screen.getByText("思考中（第 2 步）…")).toBeInTheDocument();
  });
});

describe("LiveTurnExchange trailing wait status (the #1606 bare face)", () => {
  // The sealed-tail wait: a settled row + sealed prose beside it -- the
  // status names the round-trip wait. The elapsed suffix stays retired
  // (the #1264 suffix retirement, ADR-0151): the folded head names the
  // phase without a clock -- the thinking duration lives on the expanded
  // face's folds, not here.
  const sealedTailWait: LiveTurn = {
    question: "问",
    askedAt: 0,
    invocationNames: [],
    step: 2,
    rounds: [{ text: "第一轮已收口。", rows: [settledRow()] }],
  };

  it("reads the bare step-named status; no elapsed suffix ever rides it", () => {
    renderExchange(sealedTailWait);
    expect(screen.getByText("思考中（第 2 步）…")).toBeInTheDocument();
    expect(screen.queryByText(/· \d/)).toBeNull();
  });
});

// The live activity line (issue #1606, ADR-0151): the turn's ONE rotating
// activity face -- the thinking phase and the running call rotate its
// folded head (the tool face answers a call at once, the verb repaints
// at most once per window, the face holds one window past the last
// call), the streaming tail steps it aside (the prose + caret carry the
// liveness), and expanding shows the rounds after the last prose
// section (their thinking folds + flat call rows). With nothing behind
// the fold the line is a plain status line (no hover, no click). The
// head reads the rows' kind and count ONLY -- never the streaming
// summary (the anti-flicker contract); the pending approval card stays
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

  it("rotates into the running face at entry: verb + count with the spinner", () => {
    const { container } = renderExchange(midCallTurn());
    const head = container.querySelector("button.process-toggle");
    expect(head).not.toBeNull();
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(head?.textContent).toBe("正在读取 · 已完成 1 次调用");
    expect(head?.querySelector(".animate-spin")).not.toBeNull();
    // Nothing renders unfurled: the process face is behind the line's fold.
    expect(screen.queryByText("SELECT 1")).not.toBeInTheDocument();
    expect(screen.queryByText("SELECT 2")).not.toBeInTheDocument();
  });

  it("holds the verb through a sub-window kind switch: only the count moves", () => {
    vi.useFakeTimers();
    try {
      const view = renderExchange(midCallTurn());
      expect(view.container.querySelector("button.process-toggle")?.textContent).toBe(
        "正在读取 · 已完成 1 次调用",
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
      // Sub-dwell: the face holds the previous verb while the count ticks --
      // a call that flashes by never repaints the head (the user ruling).
      expect(view.container.querySelector("button.process-toggle")?.textContent).toBe(
        "正在读取 · 已完成 2 次调用",
      );
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(view.container.querySelector("button.process-toggle")?.textContent).toBe(
        "正在联网 · 已完成 2 次调用",
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
    expect(head?.textContent).toBe("思考中（第 2 步）…");
    expect(head?.querySelector(".animate-spin")).not.toBeNull();
  });

  it("steps aside while the tail prose streams (the prose + caret carry the liveness)", () => {
    const turn = liveTurnWith(undefined);
    turn.step = 1;
    turn.rounds = [{ text: "正文正在流出。", rows: [] }];
    const { container } = renderExchange(turn);
    // The streaming face retired: an output face beside visibly streaming
    // text doubled the signal and flipped against the thinking face as
    // the stream paused (the device ruling). The prose + caret carry the
    // liveness; the line steps aside entirely.
    expect(container.querySelector(".process-toggle")).toBeNull();
  });

  it("keeps the head unchanged while the running call's args stream (anti-flicker)", () => {
    const before = renderExchange(midCallTurn());
    const headText = before.container.querySelector("button.process-toggle")?.textContent;
    expect(headText).toBe("正在读取 · 已完成 1 次调用");
    // An args delta lands: the running row's summary grows mid-stream. The
    // head reads kind + count only.
    const streamed = midCallTurn();
    streamed.rounds[0]!.rows[1] = {
      ...streamed.rounds[0]!.rows[1]!,
      summary: "SELECT 2 with a far longer streaming args summary riding the delta",
    };
    before.rerender(exchangeEl(streamed));
    expect(before.container.querySelector("button.process-toggle")?.textContent).toBe(headText);
  });

  it("holds the tool face one window past the last call, then reads the wait", () => {
    vi.useFakeTimers();
    try {
      const view = renderExchange(midCallTurn());
      expect(view.container.querySelector("button.process-toggle")?.textContent).toBe(
        "正在读取 · 已完成 1 次调用",
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
      // ruling: a line stuck on the thinking face reads as dead).
      expect(view.container.querySelector("button.process-toggle")?.textContent).toBe(
        "正在读取 · 已完成 2 次调用",
      );
      act(() => {
        vi.advanceTimersByTime(600);
      });
      // The round-trip wait IS the thinking phase: the face rotates back
      // once the grace is spent, and the completed count waits behind the
      // fold (expand to see it).
      const head = view.container.querySelector("button.process-toggle");
      expect(head?.textContent).toBe("思考中…");
      expect(head?.querySelector(".animate-spin")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the tool face through the streaming window's grace, then steps aside for the streaming tail", () => {
    vi.useFakeTimers();
    try {
      const view = renderExchange(midCallTurn());
      expect(view.container.querySelector("button.process-toggle")?.textContent).toBe(
        "正在读取 · 已完成 1 次调用",
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
      // The count reads the line's rounds only: the settled call now
      // sits in a revealed round, so the line reports zero -- and with
      // nothing left behind the fold, the line is the plain status face.
      expect(view.container.querySelector(".process-toggle")?.textContent).toBe(
        "正在读取 · 已完成 0 次调用",
      );
      act(() => {
        vi.advanceTimersByTime(600);
      });
      // Past the grace the line steps aside entirely: the prose + caret
      // carry the liveness.
      expect(view.container.querySelector(".process-toggle")).toBeNull();
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
    // The gate hold KEEPS the tool face (the call is about to run -- the
    // line vanishing entirely read as the process dying on the device);
    // the card renders beside it (ADR-0083's flow face).
    const head = container.querySelector("button.process-toggle");
    expect(head?.textContent).toBe("正在联网 · 已完成 1 次调用");
    expect(head?.querySelector(".animate-spin")).not.toBeNull();
    expect(container.querySelector(".approval-card")).not.toBeNull();
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
    expect(line?.textContent).toBe("正在联网 · 已完成 0 次调用");
    expect(line?.querySelector(".animate-spin")).not.toBeNull();
    // The card still renders beside the line (ADR-0083's flow face).
    expect(container.querySelector(".approval-card")).not.toBeNull();
    expect(screen.getByText("等待审批")).toBeInTheDocument();
  });

  it("seals each prose-bounded segment into ONE aggregate fold line; the count stays in the activity line", () => {
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
    // The stretch between the two prose sections (r0 + the call-only r1)
    // lands as ONE aggregate fold line between them -- never a block per
    // round.
    const roundToggles = container.querySelectorAll("button.round-toggle");
    expect(roundToggles).toHaveLength(1);
    expect(roundToggles[0]?.textContent).toBe("执行完成 · 2 次调用");
    // The prose renders above and below the fold; the folded thinking +
    // rows stay hidden until it opens.
    expect(screen.getByText("先看一眼。")).toBeInTheDocument();
    expect(screen.getByText("数据已就绪。")).toBeInTheDocument();
    expect(screen.queryByText("思考 · 1.2s")).not.toBeInTheDocument();
    expect(screen.queryByText("SELECT 1")).not.toBeInTheDocument();
    expect(screen.queryByText("GET /x")).not.toBeInTheDocument();
    // The last prose's segment (r2 + the tail) is NOT sealed: its rows
    // stay in the activity line's fold.
    expect(screen.queryByText("SELECT 3")).not.toBeInTheDocument();
    expect(screen.queryByText("SELECT 4")).not.toBeInTheDocument();
    // The head's count reads the line's rounds ONLY.
    const head = container.querySelector("button.process-toggle");
    expect(head?.textContent).toBe("正在写入 · 已完成 2 次调用");
    // Open the sealed segment: every round's thinking fold + call rows in
    // settle order; the count stays in the activity line.
    fireEvent.click(roundToggles[0]!);
    expect(screen.getByText("思考 · 1.2s")).toBeInTheDocument();
    expect(screen.getByText("SELECT 1")).toBeInTheDocument();
    expect(screen.getByText("GET /x")).toBeInTheDocument();
    expect(screen.queryByText("SELECT 3")).not.toBeInTheDocument();
    expect(onActivityExpandedChange).not.toHaveBeenCalledWith(true);
  });

  it("keeps everything in the line without any prose section (the pre-prose posture)", () => {
    const turn = liveTurnWith(undefined);
    turn.rounds = [
      { rows: [settledRow({ key: "call-0", summary: "SELECT 1" })] },
      { rows: [settledRow({ key: "call-1", summary: "SELECT 2" })] },
      { rows: [settledRow({ key: "call-2", summary: "SELECT 3", running: true, success: null })] },
    ];
    const { container } = renderExchange(turn);
    // No prose section anywhere: nothing reveals -- the whole history
    // rides the line (the pre-prose posture), the count reads the line's
    // two settled calls.
    expect(container.querySelector("button.process-toggle")?.textContent).toBe(
      "正在读取 · 已完成 2 次调用",
    );
    expect(screen.queryByText("SELECT 1")).not.toBeInTheDocument();
    fireEvent.click(container.querySelector("button.process-toggle")!);
    expect(screen.getByText("SELECT 1")).toBeInTheDocument();
    expect(screen.getByText("SELECT 3")).toBeInTheDocument();
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
    expect(line?.textContent).toBe("正在联网 · 已完成 0 次调用");
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
    expect(head?.textContent).toBe("正在联网 · 已完成 1 次调用");
    fireEvent.click(head!);
    expect(screen.getByText("SELECT 1")).toBeInTheDocument();
    expect(container.querySelectorAll(".trace-row")).toHaveLength(2);
  });

  it("seals a leading call-only head segment under no prose (issue #1236)", () => {
    // Rows may lead the slot arrays -- a turn can open with calls before
    // any prose lands. The head segment is prose-less; a later prose
    // section seals it into the same aggregate fold line, landing at its
    // own top position.
    const turn = liveTurnWith(undefined);
    turn.step = 3;
    turn.rounds = [
      { rows: [settledRow({ key: "call-0", summary: "SELECT 1" })] },
      { text: "先看一眼。", rows: [] },
      { rows: [settledRow({ key: "call-1", summary: "SELECT 2" })] },
    ];
    const { container } = renderExchange(turn);
    const roundToggles = container.querySelectorAll("button.round-toggle");
    expect(roundToggles).toHaveLength(1);
    expect(roundToggles[0]?.textContent).toBe("执行完成 · 1 次调用");
    // The fold sits ABOVE the prose section (its own segment's position).
    const prose = screen.getByText("先看一眼。");
    expect(
      roundToggles[0]!.compareDocumentPosition(prose) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Open it: the head segment's call row lands on the shared left-rail
    // list (the settled face's chrome); the line keeps the rounds after
    // the prose (the count reads the one call there).
    fireEvent.click(roundToggles[0]!);
    expect(screen.getByText("SELECT 1")).toBeInTheDocument();
    expect(container.querySelector(".round-toggle + ul.trace-list")).not.toBeNull();
    fireEvent.click(container.querySelector("button.process-toggle")!);
    expect(screen.getByText("SELECT 2")).toBeInTheDocument();
    expect(screen.getByText("SELECT 2").closest("ul")).toHaveClass("trace-list");
  });
});
