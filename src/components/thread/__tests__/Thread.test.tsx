import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { TooltipProvider } from "../../ui/tooltip";
import type { ReactElement } from "react";
import { catalogFor } from "../../../i18n";
import { cancelled, failed } from "../../../session/__tests__/fixtures";
import { Thread } from "../Thread";
import type { LiveRound, LiveRoundRow, LiveTurn } from "../../../session/useTurnFlow";
import type { DatasetDescriptor } from "../../../types/dataset";
import type { SkillEntry } from "../../../types/skills";
import { skillEntry } from "../../../test-fixtures";
import type { ThreadEntry, TurnRecord } from "../../../types/thread";

// A materialized-record fixture (reference_name overridden per test) -- the
// only outcome that needs a full dataset payload. File-local per the suite
// convention: TurnCard.test.tsx carries its own descriptor (preview-card
// pins, issue #860) rather than reaching into this suite's fixture.
const mockDataset: DatasetDescriptor = {
  reference_name: "people",
  display_name: "people",
  source_path: "/x/people.csv",
  row_count: 5,
  fingerprint: "abc123def4560000000000000000000000000000000000000000000000000999",
  columns: [
    { name: "id", canonical_type: "BIGINT" },
    { name: "name", canonical_type: "VARCHAR" },
  ],
  sample: [
    ["1", "Alice"],
    ["2", "Bob"],
  ],
  rectify: { kind: "NotApplicable" },
  privacy: { send_samples: true, type_only_columns: [] },
};

// Thread chrome routes through react-intl (ADR-0052). Renders the element inside
// a zh-CN IntlProvider so the Chinese chrome assertions hold. Wraps in
// TooltipProvider too: the rail card truncation sites use Radix Tooltip
// (ADR-0050/0054, issue #106), which needs the context App normally provides.
function renderThread(ui: ReactElement) {
  return render(
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      <TooltipProvider>{ui}</TooltipProvider>
    </IntlProvider>,
  );
}

describe("Thread", () => {
  // The zh-CN accessible name of the retry button, resolved from the catalog
  // so the assertions track the wording instead of duplicating a literal
  // (issue #139 convention). Shared by the weaken test and the retry
  // describe -- one resolution per key per file.
  const RETRY_LABEL = catalogFor("zh-CN")["thread.outcome.retryLabel"];

  // A materialized record built from the shared mock descriptor (reference_name
  // overridden) -- the only outcome that needs a full dataset payload.
  function materializedRecord(
    referenceName: string,
    assumption: string | null,
    body: string | null = null,
  ): TurnRecord {
    return {
      question: `问 ${referenceName}`,
      outcome: {
        kind: "Materialized",
        data: {
          promotions: [
            { dataset: { ...mockDataset, reference_name: referenceName }, sql: "SELECT 1" },
          ],
          viz: null,
          body,
          assumption,
        },
      },
      trace: [], provenance: { skills: [] },
    };
  }

  // Wrap a TurnRecord as a ThreadEntry::Turn -- the shape conversation() now
  // returns (ADR-0040). Keeps the turn-focused tests readable.
  function turnEntry(record: TurnRecord): ThreadEntry {
    return { entry: "Turn", data: record };
  }

  it("renders a multi-promotion turn as a primary result link + a muted antecedents line (ADR-0084)", () => {
    // A result turn that materialized two results in promotion order: the chain
    // tail (result_2) is the primary -- the clickable result link; the
    // antecedent (result_1) rides a muted "derived from" line so the lineage
    // stays visible without competing with the answer.
    const record: TurnRecord = {
      question: "筛后聚合",
      outcome: {
        kind: "Materialized",
        data: {
          promotions: [
            { dataset: { ...mockDataset, reference_name: "result_1" }, sql: "SELECT 1" },
            { dataset: { ...mockDataset, reference_name: "result_2" }, sql: "SELECT 2" },
          ],
          viz: null,
          body: null,
          assumption: null,
        },
      },
      trace: [], provenance: { skills: [] },
    };
    renderThread(
      <Thread entries={[turnEntry(record)]} selectedResult={null} onSelectResult={() => {}} />,
    );

    // The primary (chain tail) is the clickable result link.
    expect(screen.getByRole("button", { name: /结果：result_2/ })).toBeInTheDocument();
    // The antecedent is NOT a result link -- it rides the muted disclosure.
    expect(screen.queryByRole("button", { name: /结果：result_1/ })).not.toBeInTheDocument();
    expect(screen.getByText(/由 result_1 派生/)).toBeInTheDocument();
  });

  it("renders a Materialized turn's terminal text as markdown prose, not a side note (#847)", () => {
    // The terminal text is the turn's prose answer: headings / code spans /
    // tables render as elements through the same RoundProse pipeline a
    // Textual body rides. It previously rode the assumption side-note slot
    // and displayed as raw markdown in a plain-text italic line.
    const record = materializedRecord(
      "result_1",
      null,
      "## 统计报告\n\n共 18 行，含 `type_1` 分组。\n\n| type_1 | cnt |\n| --- | --- |\n| Fire | 12 |",
    );
    const { container } = renderThread(
      <Thread entries={[turnEntry(record)]} selectedResult="result_1" onSelectResult={() => {}} />,
    );

    // Markdown renders structurally: the heading is a heading, the code span
    // is a code element, the table is a table -- not raw "##" / pipe text.
    expect(screen.getByRole("heading", { name: "统计报告" })).toBeInTheDocument();
    expect(container.querySelector("code")).toHaveTextContent("type_1");
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveTextContent("Fire");
    // A null assumption renders no side note at all (the mounted-note
    // coverage lives in the labeled-turn test below).
    expect(screen.queryByText(/^假设：/)).not.toBeInTheDocument();
  });

  it("orders the Materialized turn link row, prose, and side note (#847)", () => {
    // Q5 order pin: result link row -> prose -> side note -- the same
    // caption-row -> prose -> note rhythm the Textual branch uses.
    const record = materializedRecord("result_1", "按世代分组", "正文第一段。");
    const { container } = renderThread(
      <Thread entries={[turnEntry(record)]} selectedResult="result_1" onSelectResult={() => {}} />,
    );

    const seq = [...container.querySelectorAll(".result-link, .round-text, .assumption")].map(
      (el) =>
        el.classList.contains("result-link")
          ? "link"
          : el.classList.contains("round-text")
            ? "prose"
            : "note",
    );
    expect(seq.indexOf("link")).toBeLessThan(seq.indexOf("prose"));
    expect(seq.indexOf("prose")).toBeLessThan(seq.indexOf("note"));
  });

  it("renders every turn labeled by its verbatim question with its outcome kind", () => {
    // ADR-0028: all four outcomes are always visible, in order, each labeled by
    // the user's own question (ADR-0039). The assumption side note renders for
    // the outcomes that carry one (ADR-0009/0018).
    const records: TurnRecord[] = [
      materializedRecord("result_1", "把 id 当主键"),
      {
        question: "哪个名字",
        outcome: {
          kind: "Textual",
          data: { text_kind: "Clarify", body: "按产品名还是客户名？", assumption: null },
        },
        trace: [], provenance: { skills: [] },
      },
      {
        question: "预测销量",
        outcome: {
          kind: "Textual",
          data: { text_kind: "Refuse", body: "预测不在 v1 能力范围内", assumption: null },
        },
        trace: [], provenance: { skills: [] },
      },
      {
        question: "坏查询",
        outcome: { kind: "Failed", data: { kind: "Execute", data: { detail: "bad column" } } },
        trace: [], provenance: { skills: [] },
      },
      { question: "中途取消", outcome: { kind: "Cancelled", data: null }, trace: [], provenance: { skills: [] } },
    ];
    const { container } = renderThread(
      <Thread
        entries={records.map(turnEntry)}
        selectedResult="result_1"
        onSelectResult={() => {}}
      />,
    );

    // Every verbatim question is a visible label.
    expect(screen.getByText("问 result_1")).toBeInTheDocument();
    expect(screen.getByText("哪个名字")).toBeInTheDocument();
    expect(screen.getByText("预测销量")).toBeInTheDocument();
    expect(screen.getByText("坏查询")).toBeInTheDocument();
    expect(screen.getByText("中途取消")).toBeInTheDocument();

    // Result turn: a result link + the assumption side note.
    expect(screen.getByRole("button", { name: /结果：result_1/ })).toBeInTheDocument();
    expect(screen.getByText(/假设：把 id 当主键/)).toBeInTheDocument();
    // Clarify and refuse render distinctly with their kind + body.
    expect(screen.getByText("需要澄清")).toBeInTheDocument();
    // The kind badge is chrome, not discourse: it keeps the caption tier
    // (text-xs) instead of inheriting the body's conversation tier (issue
    // #727 -- the tier pin for the body itself is in the Agent textual test).
    expect(
      container.querySelector(".turn-outcome.textual.clarify .textual-kind")?.className,
    ).toContain("text-xs");
    expect(screen.getByText("按产品名还是客户名？")).toBeInTheDocument();
    expect(screen.getByText("无法处理")).toBeInTheDocument();
    expect(screen.getByText("预测不在 v1 能力范围内")).toBeInTheDocument();
    // Failed renders the typed Execute message via the locale catalog (the
    // engine detail rides the collapsed fold); cancelled renders the marker.
    expect(screen.getByText("执行失败")).toBeInTheDocument();
    expect(screen.getByText("已取消")).toBeInTheDocument();
  });

  it("renders an Agent textual turn as a bare reply with no action badge", () => {
    // ADR-0077: the tool-calling contract's terminal text rides TextKind::Agent
    // -- the body IS the reply, so the turn renders without the clarify /
    // refuse action badge; the kind still reads off the outcome icon's
    // aria-label (ADR-0050).
    const { container } = renderThread(
      <Thread
        entries={[
          turnEntry({
            question: "总共有多少客户",
            outcome: {
              kind: "Textual",
              data: { text_kind: "Agent", body: "共 128 位客户。", assumption: null },
            },
            trace: [], provenance: { skills: [] },
          }),
        ]}
        selectedResult={null}
        onSelectResult={() => {}}
      />,
    );

    // The body renders as the direct reply (through the RoundProse pipeline
    // since issue #827), labeled by its verbatim question.
    expect(screen.getByText("总共有多少客户")).toBeInTheDocument();
    expect(screen.getByText("共 128 位客户。")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "已回答" })).toBeInTheDocument();
    // The reply body rides the conversation tier (text-sm, matching the user
    // bubble's question and RoundProse) -- the answer is discourse, not
    // chrome. Since issue #827 the body renders through RoundProse, so the
    // tier pin lands on the prose root, not the outcome container.
    expect(
      container.querySelector(".turn-outcome.textual .round-text")?.className.split(/\s+/),
    ).toContain("text-sm");
    // No action-signaling badge -- neither a clarify nor a refuse.
    expect(screen.queryByText("需要澄清")).not.toBeInTheDocument();
    expect(screen.queryByText("无法处理")).not.toBeInTheDocument();
  });

  it("clicking a result turn selects it (reference name only, ADR-0051)", () => {
    const onSelectResult = vi.fn();
    renderThread(
      <Thread
        entries={[turnEntry(materializedRecord("result_2", "用了简单计数"))]}
        selectedResult={null}
        onSelectResult={onSelectResult}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /结果：result_2/ }));
    // onSelectResult carries only referenceName -- assumption/viz are derived
    // from the thread by the caller (ADR-0051), not passed through the callback.
    expect(onSelectResult).toHaveBeenCalledWith("result_2");
  });

  it("marks the selected result turn active", () => {
    renderThread(
      <Thread
        entries={[turnEntry(materializedRecord("result_1", null))]}
        selectedResult="result_1"
        onSelectResult={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /结果：result_1/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("renders nothing when the thread is empty", () => {
    const { container } = renderThread(
      <Thread entries={[]} selectedResult={null} onSelectResult={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders source lifecycle events as non-interactive markers interleaved with turns (ADR-0040)", () => {
    // A source event is first-class in the thread (always visible, occupies a
    // slot) but NOT a turn -- it shows no question/outcome, renders distinctly,
    // and is not clickable. Interleaving order is preserved.
    const entries: ThreadEntry[] = [
      { entry: "Source", data: { kind: "Added", reference_name: "people", display_name: "people" } },
      turnEntry(materializedRecord("result_1", null)),
      {
        entry: "Source",
        data: { kind: "Deleted", reference_name: "people", display_name: "people" },
      },
    ];
    renderThread(
      <Thread entries={entries} selectedResult={null} onSelectResult={() => {}} />,
    );
    // Added + Deleted markers render with their verbs, distinct from turns.
    expect(screen.getByText(/加载了「people」/)).toBeInTheDocument();
    expect(screen.getByText(/删除了「people」/)).toBeInTheDocument();
    // The turn's question still renders between them (ordering preserved).
    expect(screen.getByText("问 result_1")).toBeInTheDocument();
    // Source markers are non-interactive: no button inside a source entry --
    // the turn's result link + preview card are the only buttons (ADR-0083).
    for (const li of document.querySelectorAll(".source-entry")) {
      expect(within(li as HTMLElement).queryByRole("button")).toBeNull();
    }
    expect(screen.getByRole("button", { name: /结果：result_1/ })).toBeInTheDocument();
  });

  it("renders a Replaced source event with its own marker verb (issue #41)", () => {
    // ADR-0025 / issue #41: a re-upload under an existing reference name lands a
    // Replaced event, distinct from Added (new name) and Deleted (name gone) --
    // its marker verb is "换源了", carrying the PRD term (CONTEXT.md).
    const entries: ThreadEntry[] = [
      {
        entry: "Source",
        data: { kind: "Replaced", reference_name: "people", display_name: "员工表" },
      },
    ];
    renderThread(<Thread entries={entries} selectedResult={null} onSelectResult={() => {}} />);
    expect(screen.getByText(/换源了「员工表」/)).toBeInTheDocument();
  });

  it("ghosts a stale Materialized turn with CircleOff + a causal chip (issue #80, ADR-0041/0047)", () => {
    // A result that went stale renders as a ghost: reduced opacity (CSS on
    // .stale-ghost) + the outcome icon swapped to CircleOff, and a clickable
    // causal chip replaces the old full-sentence badge. The chip's wording
    // splits honestly by reason -- "源已更新" (Replaced: SQL still runs, v1 just
    // does not recompute) vs "上游已删除" (Deleted: the reference name is gone).
    const entries: ThreadEntry[] = [turnEntry(materializedRecord("result_1", null))];
    const staleByReference = new Map([
      ["result_1", { reference_name: "people", display_name: "员工表", reason: "Replaced" as const }],
    ]);
    const { container } = renderThread(
      <Thread
        entries={entries}
        selectedResult={null}
        onSelectResult={() => {}}
        staleByReference={staleByReference}
      />,
    );
    // Ghost marker: the turn card carries data-stale + the stale-ghost class.
    const turnCard = container.querySelector(".turn-card");
    expect(turnCard?.classList.contains("stale-ghost")).toBe(true);
    expect(turnCard?.getAttribute("data-stale")).toBe("true");
    // CircleOff is the stale glyph (aria-label "结果已失效"), not the fresh
    // Materialized's Table2 ("已出结果").
    expect(screen.getByRole("img", { name: "结果已失效" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "已出结果" })).not.toBeInTheDocument();
    // Causal chip wording for a Replaced source.
    expect(screen.getByRole("button", { name: /源已更新/ })).toBeInTheDocument();
  });

  it("the stale causal chip wording distinguishes delete vs replace (issue #80, ADR-0041)", () => {
    // ADR-0041 honest split: a Deleted upstream -> "上游已删除" (truly gone,
    // cannot recompute); a Replaced source -> "源已更新" (new backing exists,
    // re-ask would recover). The wording signals recoverability.
    const replacedAnchor = { reference_name: "people", display_name: "员工表", reason: "Replaced" as const };
    const deletedAnchor = { reference_name: "people", display_name: "员工表", reason: "Deleted" as const };

    const { unmount: unmountReplaced } = renderThread(
      <Thread
        entries={[turnEntry(materializedRecord("result_1", null))]}
        selectedResult={null}
        onSelectResult={() => {}}
        staleByReference={new Map([["result_1", replacedAnchor]])}
      />,
    );
    expect(screen.getByRole("button", { name: /源已更新/ })).toBeInTheDocument();
    unmountReplaced();

    renderThread(
      <Thread
        entries={[turnEntry(materializedRecord("result_1", null))]}
        selectedResult={null}
        onSelectResult={() => {}}
        staleByReference={new Map([["result_1", deletedAnchor]])}
      />,
    );
    expect(screen.getByRole("button", { name: /上游已删除/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /源已更新/ })).not.toBeInTheDocument();
  });

  it("clicking a stale causal chip jump-selects the nearest matching source event (issue #80, ADR-0047)", () => {
    // The chip-trace rule (ADR-0047): click a stale chip -> highlight the
    // SourceLifecycleEvent after this result's turn whose reference_name + kind
    // match the anchor. No event_id is stored; the match is derived from the
    // existing thread. Here result_1 (stale via Replaced on "people") jumps to
    // the Replaced source event after it, not the earlier Added.
    const entries: ThreadEntry[] = [
      { entry: "Source", data: { kind: "Added", reference_name: "people", display_name: "员工表" } },
      turnEntry(materializedRecord("result_1", null)),
      { entry: "Source", data: { kind: "Replaced", reference_name: "people", display_name: "员工表" } },
      { entry: "Source", data: { kind: "Deleted", reference_name: "orders", display_name: "订单表" } },
    ];
    const staleByReference = new Map([
      ["result_1", { reference_name: "people", display_name: "员工表", reason: "Replaced" as const }],
    ]);
    const { container } = renderThread(
      <Thread
        entries={entries}
        selectedResult={null}
        onSelectResult={() => {}}
        staleByReference={staleByReference}
      />,
    );
    // No source marker is highlighted before the click.
    expect(container.querySelector(`.source-entry[data-highlighted="true"]`)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /源已更新/ }));
    // The Replaced marker (after result_1) is now the highlighted jump target;
    // the Added (before) and Deleted (orders, not people) are not.
    const highlighted = container.querySelector(`.source-entry[data-highlighted="true"]`);
    expect(highlighted?.getAttribute("data-source-kind")).toBe("replaced");
  });

  it("encodes the four outcomes by data-outcome + accessible icon label (issue #80, ADR-0047/0050)", () => {
    // Black-box AC: assert visible DOM/aria, not pixels. Each outcome kind
    // rides data-outcome on the <li> (the hue attribute hook) AND an aria-label
    // on the outcome icon, so the four are distinguishable without color sight.
    const records: TurnRecord[] = [
      materializedRecord("result_1", null),
      { question: "q", outcome: { kind: "Textual", data: { text_kind: "Clarify", body: "b", assumption: null } }, trace: [], provenance: { skills: [] } },
      { question: "q", outcome: { kind: "Failed", data: { kind: "Execute", data: { detail: "boom" } } }, trace: [], provenance: { skills: [] } },
      { question: "q", outcome: { kind: "Cancelled", data: null }, trace: [], provenance: { skills: [] } },
    ];
    const { container } = renderThread(
      <Thread entries={records.map(turnEntry)} selectedResult={null} onSelectResult={() => {}} />,
    );
    const kinds = ["materialized", "textual", "failed", "cancelled"];
    const outs = container.querySelectorAll(".turn-entry");
    expect(outs).toHaveLength(4);
    expect(Array.from(outs).map((li) => li.getAttribute("data-outcome"))).toEqual(kinds);
    // Each outcome's glyph is announced via its icon aria-label.
    expect(screen.getByRole("img", { name: "已出结果" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "需要澄清" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "失败" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "已取消" })).toBeInTheDocument();
  });

  it("keeps Failed and Cancelled visible but weakened, never collapsed (issue #80, ADR-0028)", () => {
    // ADR-0028 Why 2: collapsing B/C/D would hide high-value "recent intent
    // included a failure" context. v1 only weakens (CSS opacity on the card),
    // so the question + reason/marker stay in the DOM and are queryable.
    const records: TurnRecord[] = [
      { question: "坏查询", outcome: { kind: "Failed", data: { kind: "Execute", data: { detail: "bad column" } } }, trace: [], provenance: { skills: [] } },
      { question: "中途取消", outcome: { kind: "Cancelled", data: null }, trace: [], provenance: { skills: [] } },
    ];
    const { container } = renderThread(
      <Thread entries={records.map(turnEntry)} selectedResult={null} onSelectResult={() => {}} />,
    );
    // Both are present in the DOM (not collapsed away).
    expect(screen.getByText("坏查询")).toBeInTheDocument();
    expect(screen.getByText("执行失败")).toBeInTheDocument();
    expect(screen.getByText("中途取消")).toBeInTheDocument();
    expect(screen.getByText("已取消")).toBeInTheDocument();
    // Both carry their outcome attribute (weakening is CSS opacity, asserted at
    // the style layer, not duplicated here).
    expect(container.querySelector(`.turn-entry[data-outcome="failed"]`)).not.toBeNull();
    expect(container.querySelector(`.turn-entry[data-outcome="cancelled"]`)).not.toBeNull();
    // No retry surfaces without a wired handler (honest degrade -- the
    // unwired call sites below rely on this).
    expect(screen.queryByRole("button", { name: RETRY_LABEL })).not.toBeInTheDocument();
  });

  describe("turn retry (issue #758)", () => {
    // The records come from the session fixtures (cross-directory import is
    // established); the aria-label behind RETRY_LABEL carries the fuller
    // name.

    it("the Failed outcome card's retry fires the turn's question", () => {
      // ADR-0028 Why 2: a failed turn stays visible AND continuable -- the
      // retry fires the verbatim question as a fresh turn.
      const onRetryTurn = vi.fn();
      renderThread(
        <Thread
          entries={[failed("坏查询")]}
          selectedResult={null}
          onSelectResult={() => {}}
          onRetryTurn={onRetryTurn}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: RETRY_LABEL }));
      expect(onRetryTurn).toHaveBeenCalledWith("坏查询");
    });

    it("the Cancelled outcome card's retry fires the turn's question", () => {
      const onRetryTurn = vi.fn();
      renderThread(
        <Thread
          entries={[cancelled("中途取消")]}
          selectedResult={null}
          onSelectResult={() => {}}
          onRetryTurn={onRetryTurn}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: RETRY_LABEL }));
      expect(onRetryTurn).toHaveBeenCalledWith("中途取消");
    });

    it("disables the retry buttons while a turn is in flight (busy gate)", () => {
      renderThread(
        <Thread
          entries={[failed("坏查询"), cancelled("中途取消")]}
          selectedResult={null}
          onSelectResult={() => {}}
          onRetryTurn={() => {}}
          busy
        />,
      );
      const buttons = screen.getAllByRole("button", { name: RETRY_LABEL });
      expect(buttons).toHaveLength(2);
      for (const b of buttons) expect(b).toBeDisabled();
    });
  });

  it("renders source markers as a distinct species with add/replace/delete glyphs + stale counts (issue #80)", async () => {
    // The three source lifecycle kinds render as thin markers (data-source-kind)
    // distinct from turns; Replaced/Deleted disclose how many derivatives they
    // invalidated ("失效 N"), derived by matching reference_name + kind against
    // the stale map (no event_id, ADR-0047).
    const entries: ThreadEntry[] = [
      { entry: "Source", data: { kind: "Added", reference_name: "people", display_name: "员工表" } },
      { entry: "Source", data: { kind: "Replaced", reference_name: "people", display_name: "员工表" } },
      { entry: "Source", data: { kind: "Deleted", reference_name: "orders", display_name: "订单表" } },
    ];
    const staleByReference = new Map([
      ["result_1", { reference_name: "people", display_name: "员工表", reason: "Replaced" as const }],
      ["result_2", { reference_name: "people", display_name: "员工表", reason: "Replaced" as const }],
      ["result_3", { reference_name: "orders", display_name: "订单表", reason: "Deleted" as const }],
    ]);
    const { container } = renderThread(
      <Thread
        entries={entries}
        selectedResult={null}
        onSelectResult={() => {}}
        staleByReference={staleByReference}
      />,
    );
    // Three distinct markers by kind; Added carries no stale count (adding never
    // invalidates), Replaced shows "失效 2" (two people-Replaced stale results),
    // Deleted shows "失效 1".
    const markers = container.querySelectorAll(".source-entry");
    expect(Array.from(markers).map((li) => li.getAttribute("data-source-kind"))).toEqual([
      "added",
      "replaced",
      "deleted",
    ]);
    expect(screen.getByText(/加载了「员工表」/)).toBeInTheDocument();
    expect(screen.getByText(/失效 2/)).toBeInTheDocument();
    expect(screen.getByText(/失效 1/)).toBeInTheDocument();
    // Hover recovery (ADR-0050, issue #106): a Replaced marker truncated by the
    // fixed source-row width still discloses its name + stale count on hover. The
    // tooltip text carries both the verbatim name and the "失效 N" suffix -- this
    // is the PR's flagship fix (stale count in the source tooltip), so a regression
    // to a name-only tooltip fails here. The native title is gone on every site.
    const replacedSourceText = container.querySelector(
      `.source-entry[data-source-kind="replaced"] .source-text`,
    ) as HTMLElement;
    expect(replacedSourceText.getAttribute("title")).toBeNull();
    fireEvent.pointerMove(replacedSourceText);
    await waitFor(() => {
      const tip = screen.getByRole("tooltip");
      expect(tip.textContent).toContain("员工表");
      expect(tip.textContent).toContain("失效 2");
    });
  });

  it("marks lifecycle runs first/mid/last/single; a turn always breaks the run (issue #721)", () => {
    // The run connector (issue #721): consecutive source events form maximal
    // runs, and a turn ALWAYS breaks the run. The connector expression rides
    // data-run on the marker <li>: first/mid connect down to the next node
    // (styles.css ::before), last/single draw nothing. A turn never enters a
    // run -- it carries no data-run and no node, so it neither rides nor
    // indents the line.
    const entries: ThreadEntry[] = [
      { entry: "Source", data: { kind: "Added", reference_name: "people", display_name: "员工表" } },
      { entry: "Source", data: { kind: "Deleted", reference_name: "people", display_name: "员工表" } },
      { entry: "Source", data: { kind: "Replaced", reference_name: "people", display_name: "员工表" } },
      turnEntry(materializedRecord("result_1", null)),
      { entry: "Source", data: { kind: "Replaced", reference_name: "orders", display_name: "订单表" } },
      turnEntry(materializedRecord("result_2", null)),
      { entry: "Source", data: { kind: "Deleted", reference_name: "orders", display_name: "订单表" } },
      { entry: "Source", data: { kind: "Added", reference_name: "orders", display_name: "订单表" } },
    ];
    const { container } = renderThread(
      <Thread entries={entries} selectedResult={null} onSelectResult={() => {}} />,
    );
    // The head run: first/mid/last; the lone event between the turns is
    // single; the tail pair is first/last. A regression that connects across
    // a turn or miscounts the singleton turns one of these red.
    const markers = Array.from(
      container.querySelectorAll(".source-entry"),
    ) as HTMLElement[];
    expect(markers.map((li) => li.getAttribute("data-run"))).toEqual([
      "first",
      "mid",
      "last",
      "single",
      "first",
      "last",
    ]);
    // The turns between the runs carry no data-run and no node slot.
    for (const turnLi of Array.from(container.querySelectorAll(".turn-entry"))) {
      expect(turnLi.hasAttribute("data-run")).toBe(false);
      expect(turnLi.querySelector(".source-node")).toBeNull();
    }
  });

  it("shows the active chip only when the question explicitly names a dataset (issue #80, ADR-0047)", async () => {
    // Most turns act implicitly on the prior step -> no chip; a question that
    // names a working-set dataset ("在订单表上...") lights up ->订单表. Matching
    // is on the display label first, then the reference name; stale datasets
    // are excluded (they cannot be the target of a new question).
    const labels = [
      { reference_name: "people", display_name: "员工表" },
      { reference_name: "orders", display_name: "订单表" },
    ];
    const records: TurnRecord[] = [
      { question: "在订单表上统计总销售额", outcome: { kind: "Cancelled", data: null }, trace: [], provenance: { skills: [] } },
      { question: "总共几行", outcome: { kind: "Cancelled", data: null }, trace: [], provenance: { skills: [] } },
    ];
    const { container } = renderThread(
      <Thread
        entries={records.map(turnEntry)}
        selectedResult={null}
        onSelectResult={() => {}}
        datasetLabels={labels}
      />,
    );
    // The naming turn gets a chip; the implicit one does not.
    expect(screen.getByText(/→订单表/)).toBeInTheDocument();
    expect(container.querySelectorAll(".turn-active-chip")).toHaveLength(1);
    // Hover recovery (ADR-0050, issue #106): the chip's hover Tooltip carries the
    // localized "提问点名「{name}」" label (ADR-0052), so the chip's meaning + full
    // name survive the 8rem max-width truncation. Guards the native title -> Radix
    // Tooltip migration: an orphaned i18n key, a lost {name} interpolation, or a
    // fallback to the native title, fails here.
    const chip = container.querySelector(".turn-active-chip") as HTMLElement;
    expect(chip.getAttribute("title")).toBeNull();
    fireEvent.pointerMove(chip);
    await waitFor(() => {
      expect(screen.getByRole("tooltip").textContent).toBe("提问点名「订单表」");
    });
  });

  it("falls back to the reference name when the display name is absent from the question (issue #80)", () => {
    // findMentionedDataset tries the display label first, then the technical
    // reference name, so a user who knows the id ("在 people 上") still lights
    // up the chip. The chip label always uses the display name (what most users
    // recognize), never the matched token.
    const labels = [{ reference_name: "people", display_name: "员工表" }];
    const records: TurnRecord[] = [
      { question: "在 people 上统计总销售额", outcome: { kind: "Cancelled", data: null }, trace: [], provenance: { skills: [] } },
    ];
    renderThread(
      <Thread
        entries={records.map(turnEntry)}
        selectedResult={null}
        onSelectResult={() => {}}
        datasetLabels={labels}
      />,
    );
    // Matched via reference name; chip label is still the display name.
    expect(screen.getByText(/→员工表/)).toBeInTheDocument();
  });

  it("attributes the active chip to the dataset whose name the question contains (issue #80)", () => {
    // ADR-0047 signal-vs-noise: lock the first-display-name-hit-wins rule so a
    // future refactor (flipping display/reference order, reordering labels)
    // cannot silently mis-attribute the chip to the wrong dataset.
    const labels = [
      { reference_name: "people", display_name: "员工表" },
      { reference_name: "orders", display_name: "订单表" },
    ];
    const records: TurnRecord[] = [
      { question: "在订单表上统计", outcome: { kind: "Cancelled", data: null }, trace: [], provenance: { skills: [] } },
    ];
    renderThread(
      <Thread
        entries={records.map(turnEntry)}
        selectedResult={null}
        onSelectResult={() => {}}
        datasetLabels={labels}
      />,
    );
    expect(screen.getByText(/→订单表/)).toBeInTheDocument();
    expect(screen.queryByText(/→员工表/)).not.toBeInTheDocument();
  });

  it("disables the stale causal chip when no matching source event follows the turn (issue #80, ADR-0047)", () => {
    // ADR-0047 honest control: the causal chip is clickable only when a matching
    // SourceLifecycleEvent actually follows this turn. When the stale map and the
    // thread disagree (resume / the invalidating event was filtered out), the
    // chip renders disabled with an explanatory title rather than silently
    // no-op'ing a click. The verb still names the stale reason -- only the jump
    // is withheld.
    const entries: ThreadEntry[] = [turnEntry(materializedRecord("result_1", null))];
    const staleByReference = new Map([
      ["result_1", { reference_name: "people", display_name: "员工表", reason: "Replaced" as const }],
    ]);
    const { container } = renderThread(
      <Thread
        entries={entries}
        selectedResult={null}
        onSelectResult={() => {}}
        staleByReference={staleByReference}
      />,
    );
    // The chip is present with its verb but disabled (no jump target after turn).
    const chip = screen.getByRole("button", { name: /源已更新/ });
    expect((chip as HTMLButtonElement).disabled).toBe(true);
    // No source marker is highlighted.
    expect(container.querySelector(`.source-entry[data-highlighted="true"]`)).toBeNull();
  });

  // --- ADR-0067 (issue #169): visual expression migrated to Tailwind utility
  // + ADR-0050 token on the component; the four-outcome / stale-ghost / source-
  // marker / jump-select SEMANTICS are unchanged. These pin the className
  // contract so a regression that drops a utility silently reverts to the
  // retired styles.css rules. jsdom has no layout engine, so these are
  // className assertions on the real rendered elements (cf. the Table primitive
  // tests above), split(/\s+/) + toContain so `text-primary` does not match
  // `text-primary-foreground` etc.

  it("encodes the four outcomes by text-* tone on the outcome-icon (ADR-0047/0050, issue #169)", () => {
    // The outcome color encoding (ADR-0047 A/B/C/D hues mapped to ADR-0050
    // tokens) now lives on the outcome-icon span as a text-* utility, replacing
    // the [data-outcome] hue hooks retired from styles.css.
    const records: TurnRecord[] = [
      materializedRecord("result_1", null),
      { question: "q", outcome: { kind: "Textual", data: { text_kind: "Clarify", body: "b", assumption: null } }, trace: [], provenance: { skills: [] } },
      { question: "q", outcome: { kind: "Failed", data: { kind: "Execute", data: { detail: "boom" } } }, trace: [], provenance: { skills: [] } },
      { question: "q", outcome: { kind: "Cancelled", data: null }, trace: [], provenance: { skills: [] } },
    ];
    const { container } = renderThread(
      <Thread entries={records.map(turnEntry)} selectedResult={null} onSelectResult={() => {}} />,
    );
    const tone = (outcome: string) =>
      container
        .querySelector(`.turn-entry[data-outcome="${outcome}"] .outcome-icon`)
        ?.className.split(/\s+/);
    expect(tone("materialized")).toContain("text-primary");
    // B (textual) MUST stay muted-neutral -- never warm -- so an honest refuse
    // is not misread as failure (ADR-0047 B!=C, ADR-0017).
    expect(tone("textual")).toContain("text-muted-foreground");
    expect(tone("failed")).toContain("text-destructive");
    expect(tone("cancelled")).toContain("text-muted-foreground");
    // The box-model utilities (sizing + flex-shrink, migrated from styles.css)
    // ride the same span as the tone -- pin them so a regression that drops the
    // layout collapses the icon while the tone assertions stay green.
    expect(tone("materialized")).toContain("w-4");
    expect(tone("materialized")).toContain("shrink-0");
  });

  it("ghosts a stale Materialized turn via opacity-50 + dotted line-through (ADR-0041/0047, issue #169)", () => {
    // The stale-ghost dim + question strike now ride the component as utilities
    // (opacity-50 on the card, line-through decoration-dotted on the question),
    // replacing the .stale-ghost CSS rules in styles.css.
    const entries: ThreadEntry[] = [turnEntry(materializedRecord("result_1", null))];
    const { container } = renderThread(
      <Thread
        entries={entries}
        selectedResult={null}
        onSelectResult={() => {}}
        staleByReference={
          new Map([
            ["result_1", { reference_name: "people", display_name: "员工表", reason: "Replaced" as const }],
          ])
        }
      />,
    );
    const card = container.querySelector(".turn-card");
    expect(card?.className.split(/\s+/)).toContain("opacity-50");
    const question = container.querySelector(".turn-question");
    expect(question?.className.split(/\s+/)).toContain("line-through");
    expect(question?.className.split(/\s+/)).toContain("decoration-dotted");
  });

  it("weakens Failed + Cancelled via opacity-60, never collapsed (ADR-0028 Why 2, issue #169)", () => {
    // ADR-0028 Why 2: recent intent stays visible even when it produced nothing.
    // ADR-0103: the weakening rides the ASSISTANT stream (the failure is the
    // assistant's); the user's question bubble never dims.
    const records: TurnRecord[] = [
      { question: "坏查询", outcome: { kind: "Failed", data: { kind: "Execute", data: { detail: "bad column" } } }, trace: [], provenance: { skills: [] } },
      { question: "中途取消", outcome: { kind: "Cancelled", data: null }, trace: [], provenance: { skills: [] } },
    ];
    const { container } = renderThread(
      <Thread entries={records.map(turnEntry)} selectedResult={null} onSelectResult={() => {}} />,
    );
    const failedStream = container.querySelector(
      `.turn-entry[data-outcome="failed"] .assistant-stream`,
    );
    const cancelledStream = container.querySelector(
      `.turn-entry[data-outcome="cancelled"] .assistant-stream`,
    );
    expect(failedStream?.className.split(/\s+/)).toContain("opacity-60");
    expect(cancelledStream?.className.split(/\s+/)).toContain("opacity-60");
    const bubble = container.querySelector(`.turn-entry[data-outcome="failed"] .user-bubble`);
    expect(bubble?.className.split(/\s+/)).not.toContain("opacity-60");
  });

  it("encodes the three source lifecycle kinds by glyph tone (ADR-0047, issue #169)", () => {
    // The three-way hue (Added=primary / Replaced=accent-foreground /
    // Deleted=destructive) rides the marker's glyph as a literal text-*
    // utility (the mapping is unchanged, only the carrier moved -- the
    // retired bar's border-l prefix line, then the #721 circle's border).
    // The source species keeps its own kind mapping; it does NOT unify with
    // the skill tiers.
    const entries: ThreadEntry[] = [
      { entry: "Source", data: { kind: "Added", reference_name: "people", display_name: "员工表" } },
      { entry: "Source", data: { kind: "Replaced", reference_name: "people", display_name: "员工表" } },
      { entry: "Source", data: { kind: "Deleted", reference_name: "orders", display_name: "订单表" } },
    ];
    const { container } = renderThread(
      <Thread entries={entries} selectedResult={null} onSelectResult={() => {}} />,
    );
    const node = (kind: string) =>
      container.querySelector(
        `.source-entry[data-source-kind="${kind}"] .source-node`,
      ) as HTMLElement;
    // The glyph is an SVG: className is an SVGAnimatedString, so read the
    // class attribute instead.
    const tone = (kind: string) =>
      node(kind).querySelector(".source-icon")?.getAttribute("class")?.split(/\s+/);
    expect(tone("added")).toContain("text-primary");
    expect(tone("replaced")).toContain("text-accent-foreground");
    expect(tone("deleted")).toContain("text-destructive");
    // The node box keeps no circle chrome (the border + bg-background punch
    // retired with the #721 circle) except rounded-full, which stays so the
    // jump-select ring reads round. Geometry-contract symmetry with the skill
    // side: the connector offsets in styles.css are computed for BOTH species
    // from node h-4 w-4 + row py-0.5, so a source-only resize or
    // row-spacing change would silently misalign only the source connectors.
    expect(node("added").className.split(/\s+/)).not.toContain("border");
    expect(node("added").className.split(/\s+/)).not.toContain("bg-background");
    expect(node("added").className.split(/\s+/)).toContain("rounded-full");
    expect(node("added").className.split(/\s+/)).toContain("h-4");
    expect(node("added").className.split(/\s+/)).toContain("w-4");
    const row = container.querySelector(
      `.source-entry[data-source-kind="added"] .source-lifecycle`,
    ) as HTMLElement;
    // The node leads the row (children[0] identity, verb text right).
    expect(row.children[0].className.split(/\s+/)).toContain("source-node");
    expect(row.className.split(/\s+/)).not.toContain("border-l-2");
    expect(row.className.split(/\s+/)).not.toContain("bg-muted");
    expect(row.className.split(/\s+/)).toContain("py-0.5");
    expect(row.className.split(/\s+/)).not.toContain("px-1.5");
  });

  it("jump-select lifts the matched source marker via node ring + row bg (ADR-0047 chip-trace, issue #169)", () => {
    // The jump-select highlight lands as "node ring + row wash" (issue #721):
    // ring-2 ring-primary rides the node box, the row keeps the bg-accent
    // wash; the ring never lands on the whole row. The wrapping <li> still
    // carries data-highlighted (the caller-derived flag) for selector
    // stability + the scrollIntoView hookup.
    const entries: ThreadEntry[] = [
      { entry: "Source", data: { kind: "Added", reference_name: "people", display_name: "员工表" } },
      turnEntry(materializedRecord("result_1", null)),
      { entry: "Source", data: { kind: "Replaced", reference_name: "people", display_name: "员工表" } },
    ];
    const staleByReference = new Map([
      ["result_1", { reference_name: "people", display_name: "员工表", reason: "Replaced" as const }],
    ]);
    const { container } = renderThread(
      <Thread
        entries={entries}
        selectedResult={null}
        onSelectResult={() => {}}
        staleByReference={staleByReference}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /源已更新/ }));
    const row = container.querySelector(`.source-entry[data-highlighted="true"] .source-lifecycle`);
    expect(row?.className.split(/\s+/)).toContain("bg-accent");
    expect(row?.className.split(/\s+/)).not.toContain("ring-2");
    const node = container.querySelector(`.source-entry[data-highlighted="true"] .source-node`);
    expect(node?.className.split(/\s+/)).toContain("ring-2");
    expect(node?.className.split(/\s+/)).toContain("ring-primary");
  });

  it("encodes result-link active vs stale by tone + border utility (ADR-0050/0041, issue #169)", () => {
    // The result-link is the migration's only path that swaps BOTH color
    // (primary -> muted-foreground) AND border style (solid -> dashed) on the
    // same element, so a regression that drops the staleAnchor branch or swaps
    // the token renders wrong with no other signal. The active state lands on a
    // Materialized turn whose reference_name matches selectedResult; the stale
    // state lands on one carrying a staleAnchor (the result-link still renders).
    const entries: ThreadEntry[] = [
      turnEntry(materializedRecord("result_1", null)),
      turnEntry(materializedRecord("result_2", null)),
    ];
    renderThread(
      <Thread
        entries={entries}
        selectedResult="result_1"
        onSelectResult={() => {}}
        staleByReference={
          new Map([
            ["result_2", { reference_name: "people", display_name: "员工表", reason: "Replaced" as const }],
          ])
        }
      />,
    );
    const linkClasses = (name: RegExp) =>
      screen.getByRole("button", { name }).className.split(/\s+/);
    // Active: selectedResult == result_1 -> bold + primary solid border.
    const active = linkClasses(/结果：result_1/);
    expect(active).toContain("font-semibold");
    expect(active).toContain("border-primary");
    expect(active).not.toContain("border-dashed");
    // Stale: result_2 carries a staleAnchor -> muted tone + dashed border.
    const stale = linkClasses(/结果：result_2/);
    expect(stale).toContain("text-muted-foreground");
    expect(stale).toContain("border-dashed");
  });

  it("dims the inert stale-chip via opacity-[0.55] + cursor-not-allowed (ADR-0050, issue #169)", () => {
    // A stale chip with no matching source event after its turn (resume /
    // stale-map inconsistency) renders disabled. The disabled dim is the
    // arbitrary opacity-[0.55] step (between Tailwind v4's 0.4/0.5/0.6 scale);
    // pinned here because it is the value the migration documented.
    const entries: ThreadEntry[] = [turnEntry(materializedRecord("result_1", null))];
    const { container } = renderThread(
      <Thread
        entries={entries}
        selectedResult={null}
        onSelectResult={() => {}}
        staleByReference={
          new Map([
            ["result_1", { reference_name: "people", display_name: "员工表", reason: "Replaced" as const }],
          ])
        }
      />,
    );
    const chip = container.querySelector(".stale-chip");
    expect(chip?.className.split(/\s+/)).toContain("disabled:opacity-[0.55]");
    expect(chip?.className.split(/\s+/)).toContain("disabled:cursor-not-allowed");
  });

  describe("collapsible execution trace (ADR-0078, issue #297)", () => {
    // A failed explore + a successful materialize: the failure excerpt is the
    // retrospection anchor the expanded trace exists for (ADR-0078); the
    // success row carries no excerpt (persisted shape).
    function tracedRecord(): TurnRecord {
      return {
        question: "多少行",
        outcome: { kind: "Cancelled", data: null },
        trace: [
          {
            calls: [
              {
                name: "explore",
                operation_kind: "read",
                summary: "SELECT count(*) FROM people",
                success: false,
                result_excerpt: "no such table",
              },
              {
                name: "materialize",
                operation_kind: "write",
                summary: "SELECT 1",
                success: true,
                result_excerpt: "",
              },
            ],
          },
        ],
        provenance: { skills: [] },
      };
    }

    it("defaults COLLAPSED: question + outcome always visible, trace rows hidden", () => {
      renderThread(
        <Thread
          entries={[turnEntry(tracedRecord())]}
          selectedResult={null}
          onSelectResult={() => {}}
        />,
      );
      // The question + outcome stay visible (ADR-0039 handle, ADR-0028 always-
      // visible); the trace toggle advertises the call count, rows hidden.
      expect(screen.getByText("多少行")).toBeInTheDocument();
      const toggle = screen.getByRole("button", { name: /轨迹 · 2 次调用/ });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText("no such table")).not.toBeInTheDocument();
      expect(screen.queryByText("SELECT count(*) FROM people")).not.toBeInTheDocument();
    });

    it("expands to the full tool-call chain on toggle (args, badge, failure excerpt)", () => {
      renderThread(
        <Thread
          entries={[turnEntry(tracedRecord())]}
          selectedResult={null}
          onSelectResult={() => {}}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /轨迹 · 2 次调用/ }));
      const toggle = screen.getByRole("button", { name: /轨迹 · 2 次调用/ });
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      // Both calls render with their summaries + operation badges.
      expect(screen.getByText("explore")).toBeInTheDocument();
      expect(screen.getByText("materialize")).toBeInTheDocument();
      expect(screen.getByText("SELECT count(*) FROM people")).toBeInTheDocument();
      expect(screen.getByText("读")).toBeInTheDocument(); // read badge
      expect(screen.getByText("写")).toBeInTheDocument(); // write badge
      // The failure excerpt is the retrospection anchor; success carries none.
      expect(screen.getByText("no such table")).toBeInTheDocument();
    });

    it("omits the toggle for a zero-call turn (no trace to expand)", () => {
      renderThread(
        <Thread
          entries={[turnEntry({ question: "q", outcome: { kind: "Cancelled", data: null }, trace: [], provenance: { skills: [] } })]}
          selectedResult={null}
          onSelectResult={() => {}}
        />,
      );
      expect(screen.queryByRole("button", { name: /轨迹/ })).not.toBeInTheDocument();
    });
  });

  describe("chat projection rendering (ADR-0103, issue #609)", () => {
    // A two-round record exercising every projection surface: round 1 carries
    // thinking + prose + two calls, round 2 prose + one call. asked_at /
    // settled_at stamp the bubble + the closing meta row (honest degrade:
    // both absent on pre-v5 turns).
    const ASKED_AT = 1724232000000;
    const SETTLED_AT = 1724232060000;

    function chatRecord(over: Partial<TurnRecord> = {}): TurnRecord {
      return {
        question: "第一行问话\n第二行问话",
        outcome: {
          kind: "Textual",
          data: { text_kind: "Agent", body: "答复正文", assumption: null },
        },
        trace: [
          {
            thinking: { duration_ms: 1500, text: "先推理一下" },
            text: "我先查一下数据",
            calls: [
              { name: "explore", operation_kind: "read", summary: "SELECT 1", success: true, result_excerpt: "" },
              { name: "materialize", operation_kind: "write", summary: "SELECT 2", success: false, result_excerpt: "boom" },
            ],
          },
          {
            text: "再聚合一次",
            calls: [
              { name: "explore", operation_kind: "read", summary: "SELECT 3", success: true, result_excerpt: "" },
            ],
          },
        ],
        provenance: { skills: [] },
        asked_at: ASKED_AT,
        settled_at: SETTLED_AT,
        ...over,
      };
    }

    function renderChat(record: TurnRecord) {
      return renderThread(
        <Thread entries={[turnEntry(record)]} selectedResult={null} onSelectResult={() => {}} />,
      );
    }

    it("renders the question as a right-aligned user bubble: full text wrapped, no truncation", () => {
      // ADR-0103 retires the ADR-0054 single-line posture: the bubble carries
      // the question in full (pre-wrap keeps the newline visible) and the
      // bubble container owns the right alignment.
      const { container } = renderChat(chatRecord());
      const bubble = container.querySelector(".user-bubble");
      expect(bubble).not.toBeNull();
      expect(bubble!.className.split(/\s+/)).toContain("items-end");
      const q = bubble!.querySelector(".turn-question");
      expect(q).not.toBeNull();
      expect(q!.textContent).toBe("第一行问话\n第二行问话");
      const classes = q!.className.split(/\s+/);
      expect(classes).toContain("whitespace-pre-wrap");
      expect(classes).not.toContain("truncate");
    });

    it("stamps asked_at on the bubble + settled_at on the closing meta; omits both for pre-v5 turns", () => {
      const { container } = renderChat(chatRecord());
      // <time> carries the machine-readable stamp; the visible text is the
      // locale time (TZ-dependent in CI, so only the shape is asserted).
      const asked = container.querySelector(".user-bubble time");
      expect(asked?.getAttribute("datetime")).toBe(new Date(ASKED_AT).toISOString());
      expect(asked?.textContent).toMatch(/^\d{1,2}:\d{2}/);
      const settled = container.querySelector(".turn-meta time");
      expect(settled?.getAttribute("datetime")).toBe(new Date(SETTLED_AT).toISOString());
      // Honest degrade: no recorded stamp -> no time element, never synthetic.
      const old = renderChat(chatRecord({ asked_at: undefined, settled_at: undefined }));
      expect(old.container.querySelectorAll(".turn-card time")).toHaveLength(0);
    });

    it("copies the question and the textual reply via the clipboard", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      // stubGlobal (not Object.assign) so the setup file's unstubAllGlobals
      // restores the navigator between tests.
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      renderChat(chatRecord());
      fireEvent.click(screen.getByRole("button", { name: "复制消息" }));
      expect(writeText).toHaveBeenCalledWith("第一行问话\n第二行问话");
      // The flip lands after the awaited clipboard write (async state); the
      // accessible name follows it via the sr-only span.
      expect(await screen.findByRole("button", { name: "已复制" })).toBeInTheDocument();
      // The ack pops the tooltip open on its own -- no hover/focus needed
      // (touch never opens a hover tooltip otherwise).
      expect(screen.getByRole("tooltip").textContent).toBe("已复制");
      fireEvent.click(screen.getByRole("button", { name: "复制回复" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("答复正文"));
    });

    it("copies the reply's markdown source verbatim, never the rendered text", async () => {
      // Since issue #827 the DOM text and the source diverge (a heading
      // renders without its hash); the copy affordance must keep returning
      // the source string, so a DOM-derived refactor cannot silently strip
      // markdown from every copied reply.
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      const body = "# 结论\n\n```sql\nSELECT 1\n```";
      renderChat(
        chatRecord({
          outcome: { kind: "Textual", data: { text_kind: "Agent", body, assumption: null } },
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "复制回复" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(body));
    });

    it("reverts the copied ack after the hold and re-arms it on a repeat copy", async () => {
      // shouldAdvanceTime lets findByRole/waitFor's own timers keep ticking
      // while the hold is under fake-time control.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      renderChat(chatRecord());
      fireEvent.click(screen.getByRole("button", { name: "复制消息" }));
      expect(await screen.findByRole("button", { name: "已复制" })).toBeInTheDocument();
      // Halfway through the hold the ack is still up (no early revert).
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument();
      // A repeat copy during the hold re-arms it: the old timer's
      // remaining 500ms elapse and the ack survives them...
      fireEvent.click(screen.getByRole("button", { name: "已复制" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument();
      // ...then the re-armed hold expires and everything reverts: glyph,
      // accessible name, and the popped tooltip (nothing holds it open).
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByRole("button", { name: "复制消息" })).toBeInTheDocument();
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      vi.useRealTimers();
    });

    it("leaves the copy glyph unchanged when the clipboard rejects (honest no-op)", async () => {
      const writeText = vi.fn().mockRejectedValue(new Error("denied"));
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      renderChat(chatRecord());
      fireEvent.click(screen.getByRole("button", { name: "复制消息" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      // No ack flip: the accessible name stays the idle label.
      expect(screen.queryByRole("button", { name: "已复制" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "复制消息" })).toBeInTheDocument();
      // And no popped tooltip -- a denial must not fabricate an ack.
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });

    it("omits the reply copy on a turn with no textual reply (Materialized)", () => {
      renderChat(chatRecord({ outcome: materializedRecord("result_1", null).outcome }));
      // The question copy is the bubble's conversation fact -- always present.
      expect(screen.getByRole("button", { name: "复制消息" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "复制回复" })).not.toBeInTheDocument();
    });

    it("hover-reveals the meta stamps + copy affordances on both sides (glyph stays)", () => {
      const { container } = renderChat(chatRecord());
      // Both conversation-fact rows carry the reveal contract: hidden at
      // rest, shown on the side's hover / focus-within, always shown on
      // no-hover pointers. Pure CSS choreography -- asserted as the class
      // contract on the meta-reveal hooks.
      const reveals = container.querySelectorAll(".meta-reveal");
      expect(reveals).toHaveLength(2);
      reveals.forEach((el) => {
        expect(el.className).toContain("opacity-0");
        expect(el.className).toContain("group-hover:opacity-100");
        expect(el.className).toContain("group-focus-within:opacity-100");
        expect(el.className).toContain("[@media(hover:none)]:opacity-100");
      });
      // The reveal rides each side's group marker -- both anchors are part
      // of the contract (drop one and its side's hover/focus reveal dies
      // silently in the browser; jsdom cannot notice).
      expect(container.querySelector(".user-bubble")?.className.split(/\s+/)).toContain("group");
      expect(container.querySelector(".assistant-stream")?.className.split(/\s+/)).toContain("group");
      // The outcome glyph is state, not chrome: it lives outside the reveal.
      expect(container.querySelector(".meta-reveal .outcome-icon")).toBeNull();
      expect(container.querySelector(".turn-meta .outcome-icon")).not.toBeNull();
    });

    it("tooltips the copy affordance by type (message vs reply)", () => {
      renderChat(chatRecord());
      fireEvent.focus(screen.getByRole("button", { name: "复制消息" }));
      expect(screen.getByRole("tooltip").textContent).toBe("复制消息");
      fireEvent.focus(screen.getByRole("button", { name: "复制回复" }));
      expect(screen.getByRole("tooltip").textContent).toBe("复制回复");
    });

    it("renders each round's prose always expanded with thinking + steps folds default collapsed", () => {
      renderChat(chatRecord());
      // Connective prose is the readability mainstay -- always visible.
      expect(screen.getByText("我先查一下数据")).toBeInTheDocument();
      expect(screen.getByText("再聚合一次")).toBeInTheDocument();
      // Thinking + steps folds are per round, both default collapsed.
      const thinking = screen.getByRole("button", { name: "思考 · 1.5s" });
      expect(thinking).toHaveAttribute("aria-expanded", "false");
      const round1 = screen.getByRole("button", { name: "轨迹 · 2 次调用" });
      const round2 = screen.getByRole("button", { name: "轨迹 · 1 次调用" });
      expect(round1).toHaveAttribute("aria-expanded", "false");
      expect(round2).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText("先推理一下")).not.toBeInTheDocument();
      expect(screen.queryByText("SELECT 1")).not.toBeInTheDocument();
    });

    it("expands each round's thinking + steps folds independently", () => {
      renderChat(chatRecord());
      fireEvent.click(screen.getByRole("button", { name: "思考 · 1.5s" }));
      expect(screen.getByText("先推理一下")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "轨迹 · 2 次调用" }));
      expect(screen.getByText("SELECT 1")).toBeInTheDocument();
      expect(screen.getByText("SELECT 2")).toBeInTheDocument();
      // Round 2's fold stays collapsed -- its call is still hidden.
      expect(screen.queryByText("SELECT 3")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "轨迹 · 1 次调用" }));
      expect(screen.getByText("SELECT 3")).toBeInTheDocument();
    });

    it("renders an all-prose round (no calls, no thinking) as bare prose with no fold chrome", () => {
      renderChat(
        chatRecord({
          trace: [
            { text: "直接答复", calls: [] },
          ],
        }),
      );
      expect(screen.getByText("直接答复")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /轨迹/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /思考/ })).not.toBeInTheDocument();
    });

    it("renders an entirely empty round as nothing (no chrome)", () => {
      const { container } = renderChat(chatRecord({ trace: [{ calls: [] }] }));
      expect(container.querySelector(".trace-round")).toBeNull();
      // The exchange still closes with the meta row.
      expect(container.querySelector(".turn-meta")).not.toBeNull();
    });

    it("closes the assistant stream with the outcome glyph + settled_at in the meta row", () => {
      const { container } = renderChat(chatRecord());
      const stream = container.querySelector(".assistant-stream");
      expect(stream).not.toBeNull();
      const glyph = stream!.querySelector(".turn-meta .outcome-icon");
      expect(glyph?.getAttribute("aria-label")).toBe("已回答");
      expect(stream!.querySelector(".turn-meta time")).not.toBeNull();
    });

    it("integrates Failed into one destructive tint card: glyph head + reason + fold (issue #720)", () => {
      const { container } = renderChat(
        chatRecord({
          outcome: { kind: "Failed", data: { kind: "Execute", data: { detail: "bad column" } } },
        }),
      );
      const card = container.querySelector(".turn-outcome.failed");
      expect(card).not.toBeNull();
      // The tinted card takes the shadcn Alert destructive variant's treatment
      // (border-destructive/40 bg-destructive/10, per the DESIGN.md Alerts note).
      const classes = card!.className.split(/\s+/);
      expect(classes).toContain("bg-destructive/10");
      expect(classes).toContain("border-destructive/40");
      // The bare border (width) rides in the shared card shell -- dropping it
      // would leave the color tokens on an invisible border.
      expect(classes).toContain("border");
      // The card hugs its content (the draft posture): no width utility that
      // would stretch it across the items-start stream.
      expect(classes).not.toContain("w-full");
      // One container: the glyph at the card head with the reason on the same
      // line, the technical fold inside the card below them.
      expect(card!.querySelector(".outcome-icon")?.getAttribute("aria-label")).toBe("失败");
      const head = card!.querySelector(".outcome-icon")!.parentElement;
      expect(head?.querySelector(".failed-reason")?.textContent).toBe("执行失败");
      expect(card!.querySelector(".error-details")).not.toBeNull();
      // The fold sits below the glyph head: it is the card's second child,
      // after the head row (same element as the .error-details query).
      expect(card!.children[1]).toBe(card!.querySelector(".error-details"));
      // The closing meta row no longer repeats the glyph; the stamp
      // hover-reveal survives (chatRecord carries a settled_at).
      expect(container.querySelector(".turn-meta .outcome-icon")).toBeNull();
      expect(container.querySelector(".turn-meta time")).not.toBeNull();
      expect(container.querySelector(".turn-meta .meta-reveal")).not.toBeNull();
    });

    it("renders the Runtime failure reason via its catalog id with the diagnostic riding the fold (issue #852)", () => {
      // #852 split TurnFailure::Runtime out of Execute: the reason points at
      // the external runtime, not the SQL. The id-level pin lives here, not in
      // the unit suite -- a createIntl message map mirrors the defaultMessage
      // strings, so a mistyped id silently falls back and the unit stays green
      // (issue #857); resolving through the real zh-CN catalog is what turns a
      // wrong id red. The hardcoded zh literal below is deliberate, contra the
      // retry-label catalog-tracking convention (issue #139): the pin's
      // subject is the id-to-wording binding, so the expectation must not
      // track the catalog.
      const { container } = renderChat(
        chatRecord({
          outcome: {
            kind: "Failed",
            data: {
              kind: "Runtime",
              data: { detail: "external runtime `cli-a` not found on PATH" },
            },
          },
        }),
      );
      const card = container.querySelector(".turn-outcome.failed");
      expect(card).not.toBeNull();
      expect(card!.querySelector(".failed-reason")?.textContent).toBe("外部运行时连接失败");
      // The runtime diagnostic rides the technical fold (audited to hold no
      // API key, ADR-0029), never the reason line. The card here is the
      // thread's latest settled failure, so the fold mounts already open
      // (issue #1005) -- the diagnostic is readable without the second click.
      const fold = card!.querySelector(".error-details");
      expect(fold).not.toBeNull();
      expect(fold).toHaveAttribute("open");
      expect(fold!.querySelector(".error-stack")?.textContent).toBe(
        "external runtime `cli-a` not found on PATH",
      );
    });

    it("renders Cancelled as a same-shape muted card whose glyph head is the whole body (issue #720)", () => {
      const { container } = renderChat(chatRecord({ outcome: { kind: "Cancelled", data: null } }));
      const card = container.querySelector(".turn-outcome.cancelled");
      expect(card).not.toBeNull();
      expect(card!.className.split(/\s+/)).toContain("bg-muted");
      expect(card!.querySelector(".outcome-icon")?.getAttribute("aria-label")).toBe("已取消");
      // No fold on the muted sibling -- nothing technical to disclose.
      expect(card!.querySelector(".error-details")).toBeNull();
      expect(container.querySelector(".turn-meta .outcome-icon")).toBeNull();
      expect(container.querySelector(".turn-meta time")).not.toBeNull();
    });

    it("omits the closing meta row entirely when Failed/Cancelled records no stamp (issue #720)", () => {
      // Honest degrade: with neither a glyph (it moved to the card head) nor a
      // settle stamp, the row would render as an empty line -- no content
      // means no row; the outcome card alone closes the exchange.
      const { container } = renderChat(
        chatRecord({ outcome: { kind: "Cancelled", data: null }, settled_at: undefined }),
      );
      expect(container.querySelector(".turn-meta")).toBeNull();
      expect(container.querySelector(".turn-outcome.cancelled")).not.toBeNull();
    });

    it("weakens Failed/Cancelled on the assistant side only -- the user bubble stays full", () => {
      // ADR-0103 attribution: the failure is the assistant's, so the
      // weakening lands on the stream; the user's own question never dims.
      const { container } = renderChat(
        chatRecord({ outcome: { kind: "Failed", data: { kind: "Execute", data: { detail: "bad column" } } } }),
      );
      const stream = container.querySelector(".assistant-stream");
      expect(stream!.className.split(/\s+/)).toContain("opacity-60");
      const bubble = container.querySelector(".user-bubble");
      expect(bubble!.className.split(/\s+/)).not.toContain("opacity-60");
    });
  });

  describe("in-flight live chat exchange (ADR-0103 live, issues #297/#610)", () => {
    // Fixed submit stamp: the bubble's <time> PRESENCE is asserted, not its
    // locale-rendered text.
    const ASKED_AT = 1_700_000_000_000;

    function liveRow(over: Partial<LiveRoundRow> = {}): LiveRoundRow {
      return {
        key: "call-0",
        name: "explore",
        server: null,
        operationKind: "read",
        summary: "SELECT 1",
        approval: null,
        running: true,
        success: null,
        resultExcerpt: "",
        ...over,
      };
    }

    function liveRound(over: Partial<LiveRound> = {}): LiveRound {
      return { rows: [], ...over };
    }

    it("mounts the user bubble at submit with the thinking status (chat live form)", () => {
      const liveTurn: LiveTurn = {
        question: "统计一下",
        askedAt: ASKED_AT,
        invocationNames: [],
        step: null,
        rounds: [],
      };
      const { container } = renderThread(
        <Thread entries={[]} selectedResult={null} onSelectResult={() => {}} liveTurn={liveTurn} />,
      );
      expect(screen.getByText("统计一下")).toBeInTheDocument();
      expect(screen.getByText("思考中…")).toBeInTheDocument();
      // The bubble is the settled chat form's own component (#610): the full
      // question + the ask stamp + copy, mounted before any progress event.
      const bubble = container.querySelector(".user-bubble");
      expect(bubble).not.toBeNull();
      expect(bubble?.querySelector("time")).not.toBeNull();
      // No thinking data -> no thinking fold (honest degrade).
      expect(container.querySelector(".thinking-toggle")).toBeNull();
      // The old progressive card form is retired.
      expect(container.querySelector(".live-turn-card")).toBeNull();
    });

    it("surfaces the step on a multi-round-trip turn (honest step N)", () => {
      const liveTurn: LiveTurn = {
        question: "q",
        askedAt: ASKED_AT,
        invocationNames: [],
        step: 2,
        rounds: [],
      };
      renderThread(
        <Thread entries={[]} selectedResult={null} onSelectResult={() => {}} liveTurn={liveTurn} />,
      );
      expect(screen.getByText("思考中（第 2 步）…")).toBeInTheDocument();
    });

    it("streams round prose, the thinking fold and rows grouped by round", () => {
      const liveTurn: LiveTurn = {
        question: "q",
        askedAt: ASKED_AT,
        invocationNames: [],
        step: 2,
        rounds: [
          liveRound({
            thinking: { duration_ms: 900, text: "推理" },
            text: "先看一眼数据。",
            rows: [
              liveRow({ key: "call-0", running: false, success: false, resultExcerpt: "boom" }),
            ],
          }),
          liveRound({
            rows: [
              liveRow({
                key: "call-1",
                name: "materialize",
                operationKind: "write",
                summary: "SELECT 2",
              }),
            ],
          }),
        ],
      };
      const { container } = renderThread(
        <Thread entries={[]} selectedResult={null} onSelectResult={() => {}} liveTurn={liveTurn} />,
      );
      // Prose renders always-expanded and the thinking fold with its honest
      // duration label (collapsed) -- both identical to the settled form, so
      // the settle swap does not move them.
      expect(screen.getByText("先看一眼数据。")).toBeInTheDocument();
      expect(screen.getByText("思考 · 0.9s")).toBeInTheDocument();
      // The grouping itself is the contract (liveRoundsToTrace projects the
      // same rounds at settle): one block per round, each row inside ITS
      // round.
      const roundBlocks = container.querySelectorAll(".trace-round");
      expect(roundBlocks).toHaveLength(2);
      const round1 = within(roundBlocks[0] as HTMLElement);
      expect(round1.getByText("explore")).toBeInTheDocument();
      expect(round1.getByText("先看一眼数据。")).toBeInTheDocument();
      const round1Toggle = roundBlocks[0]?.querySelector(".thinking-toggle") ?? null;
      expect(round1Toggle).not.toBeNull();
      // The live thinking fold defaults to collapsed (the settled posture).
      expect(round1Toggle?.getAttribute("aria-expanded")).toBe("false");
      // Round 2 had no thinking (null slot): no thinking fold, just its row.
      const round2 = within(roundBlocks[1] as HTMLElement);
      expect(round2.getByText("materialize")).toBeInTheDocument();
      expect(round2.queryByText("思考 · 0.9s")).not.toBeInTheDocument();
      expect(round2.queryByText("先看一眼数据。")).not.toBeInTheDocument();
      expect(roundBlocks[1]?.querySelector(".thinking-toggle")).toBeNull();
      // A dispatched row carries the motion, so the trailing thinking
      // status steps aside (no second spinner row).
      expect(screen.queryByText("思考中…")).not.toBeInTheDocument();
      expect(screen.queryByText("思考中（第 2 步）…")).not.toBeInTheDocument();
    });

    it("renders rounds whose rows lead the slot arrays (a round with rows but no prose)", () => {
      // The single derivation (buildLiveRounds) already spanned by step; this
      // pins the rendering side: a round carrying only rows renders its own
      // block after the prose round, so the newest call still lands in its
      // own block (the DOM contract the derivation's unit test asserts
      // structurally).
      const liveTurn: LiveTurn = {
        question: "q",
        askedAt: ASKED_AT,
        invocationNames: [],
        step: 3,
        rounds: [
          liveRound({ text: "先看一眼数据。" }),
          liveRound({
            rows: [
              liveRow({
                key: "call-2",
                name: "materialize",
                operationKind: "write",
                summary: "SELECT 3",
              }),
            ],
          }),
        ],
      };
      const { container } = renderThread(
        <Thread entries={[]} selectedResult={null} onSelectResult={() => {}} liveTurn={liveTurn} />,
      );
      const roundBlocks = container.querySelectorAll(".trace-round");
      expect(roundBlocks).toHaveLength(2);
      expect(within(roundBlocks[0] as HTMLElement).getByText("先看一眼数据。")).toBeInTheDocument();
      expect(within(roundBlocks[1] as HTMLElement).getByText("materialize")).toBeInTheDocument();
    });

    it("brings the thinking status back between rounds once every row settles", () => {
      // Every row completed (no running dispatch, no gate wait) at step 2:
      // the turn is back on an LLM round-trip, so the trailing status must
      // return naming the step -- the gate predicate reads row state, not row
      // count (a `rows.length > 0` regression drops the spinner on every
      // multi-round turn and stays green against the rest of the suite).
      const liveTurn: LiveTurn = {
        question: "q",
        askedAt: ASKED_AT,
        invocationNames: [],
        step: 2,
        rounds: [liveRound({ rows: [liveRow({ key: "call-0", running: false, success: true })] })],
      };
      renderThread(
        <Thread entries={[]} selectedResult={null} onSelectResult={() => {}} liveTurn={liveTurn} />,
      );
      expect(screen.getByText("思考中（第 2 步）…")).toBeInTheDocument();
    });

    it("renders a pending approval card whose three buttons answer by request id", () => {
      const liveTurn: LiveTurn = {
        question: "q",
        askedAt: ASKED_AT,
        invocationNames: [],
        step: 1,
        rounds: [
          liveRound({
            rows: [
              liveRow({
                key: "req-1",
                name: "fetch",
                server: "acme",
                operationKind: "network",
                summary: "GET /x",
                approval: { requestId: "req-1", response: null },
                running: false,
              }),
            ],
          }),
        ],
      };
      const onRespondApproval = vi.fn();
      renderThread(
        <Thread
          entries={[]}
          selectedResult={null}
          onSelectResult={() => {}}
          liveTurn={liveTurn}
          onRespondApproval={onRespondApproval}
        />,
      );
      expect(screen.getByText("等待审批")).toBeInTheDocument();
      // The pending gate wait carries the motion itself, so the trailing
      // thinking status steps aside (no second spinner beside the card -- a
      // predicate regression to `running` alone renders both).
      expect(screen.queryByText("思考中…")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
      expect(onRespondApproval).toHaveBeenCalledWith("req-1", "allow_once");
      fireEvent.click(screen.getByRole("button", { name: "始终允许" }));
      expect(onRespondApproval).toHaveBeenCalledWith("req-1", "always_allow");
      fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
      expect(onRespondApproval).toHaveBeenCalledWith("req-1", "deny");
    });

    it("flips an answered approval to its resolved badge in place", () => {
      const liveTurn: LiveTurn = {
        question: "q",
        askedAt: ASKED_AT,
        invocationNames: [],
        step: 1,
        rounds: [
          liveRound({
            rows: [
              liveRow({
                key: "req-1",
                name: "fetch",
                server: "acme",
                operationKind: "network",
                summary: "GET /x",
                approval: { requestId: "req-1", response: "deny" },
                running: false,
                success: false,
                resultExcerpt: "denied by approval gateway",
              }),
            ],
          }),
        ],
      };
      renderThread(
        <Thread entries={[]} selectedResult={null} onSelectResult={() => {}} liveTurn={liveTurn} />,
      );
      // Resolved in place: the badge names the answer, the denial excerpt
      // rides the row -- no buttons remain.
      expect(screen.getByText("已拒绝")).toBeInTheDocument();
      expect(screen.getByText("denied by approval gateway")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "允许一次" })).not.toBeInTheDocument();
    });

    it("appends after recorded entries and renders alone on a first-turn session", () => {
      const liveTurn: LiveTurn = {
        question: "第一问",
        askedAt: ASKED_AT,
        invocationNames: [],
        step: null,
        rounds: [],
      };
      // entries empty (a brand-new session's first ask): the live exchange
      // still renders (the empty-thread bail-out must not swallow it).
      const { container } = renderThread(
        <Thread entries={[]} selectedResult={null} onSelectResult={() => {}} liveTurn={liveTurn} />,
      );
      expect(screen.getByText("第一问")).toBeInTheDocument();
      expect(container.querySelector(".live-turn-exchange")).not.toBeNull();
    });

    it("renders the dataset chip on the live side; the settle swap keeps the chip set unchanged (issue #620)", () => {
      // The live stream header opens with the same active chip the settled
      // header renders (the same findMentionedDataset read), so the settle
      // swap adds no element: the chip count before and after is one and the
      // same.
      const labels = [{ reference_name: "people", display_name: "员工表" }];
      const liveTurn: LiveTurn = {
        question: "在员工表上统计总销售额",
        askedAt: ASKED_AT,
        invocationNames: [],
        step: null,
        rounds: [],
      };
      const record: TurnRecord = {
        question: "在员工表上统计总销售额",
        outcome: { kind: "Cancelled", data: null },
        trace: [],
        provenance: { skills: [] },
      };
      const { container, rerender } = renderThread(
        <Thread
          entries={[]}
          selectedResult={null}
          onSelectResult={() => {}}
          datasetLabels={labels}
          liveTurn={liveTurn}
        />,
      );
      // The live side carries the chip (the header renders before any
      // progress event).
      expect(screen.getByText(/→员工表/)).toBeInTheDocument();
      expect(container.querySelectorAll(".turn-active-chip")).toHaveLength(1);
      // The settle swap: the live exchange folds away as the optimistic
      // record appends -- the chip count stays one, now on the settled side.
      rerender(
        <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
          <TooltipProvider>
            <Thread
              entries={[turnEntry(record)]}
              selectedResult={null}
              onSelectResult={() => {}}
              datasetLabels={labels}
              liveTurn={null}
            />
          </TooltipProvider>
        </IntlProvider>,
      );
      expect(screen.getByText(/→员工表/)).toBeInTheDocument();
      expect(container.querySelectorAll(".turn-active-chip")).toHaveLength(1);
    });

    it("renders no chip and no stream header on the live side when the question names no dataset (issue #620)", () => {
      // The live chip read's negative branch (the mirror of the settled
      // side's no-chip case): a question naming no dataset renders neither
      // the chip nor the header row, so the settle swap removes no element
      // either.
      const labels = [{ reference_name: "people", display_name: "员工表" }];
      const liveTurn: LiveTurn = {
        question: "随便看看",
        askedAt: ASKED_AT,
        invocationNames: [],
        step: null,
        rounds: [],
      };
      const { container } = renderThread(
        <Thread
          entries={[]}
          selectedResult={null}
          onSelectResult={() => {}}
          datasetLabels={labels}
          liveTurn={liveTurn}
        />,
      );
      expect(container.querySelectorAll(".turn-active-chip")).toHaveLength(0);
      expect(container.querySelector(".live-turn-exchange .stream-header")).toBeNull();
    });

    it("keeps the live-opened thinking fold + prose across the settle swap (issue #620)", () => {
      // The settle continuity: the exchange reports its open folds, and the
      // swap frame seeds the appended entry's thinking folds with them. The
      // prose stays by shared markup; the fold the user opened stays open,
      // the one they left closed stays closed. The thinking blocks are the
      // SAME references on both sides (the projection carries them), which
      // is what the reference-keyed seed matches on.
      const openedThinking = { duration_ms: 900, text: "推理一" };
      const closedThinking = { duration_ms: 1200, text: "推理二" };
      const liveTurn: LiveTurn = {
        question: "q",
        askedAt: ASKED_AT,
        invocationNames: [],
        step: 2,
        rounds: [
          liveRound({ thinking: openedThinking, text: "先看一眼数据。" }),
          liveRound({ thinking: closedThinking }),
        ],
      };
      const record: TurnRecord = {
        question: "q",
        outcome: { kind: "Textual", data: { text_kind: "Agent", body: "答", assumption: null } },
        trace: [
          { thinking: openedThinking, text: "先看一眼数据。", calls: [] },
          { thinking: closedThinking, calls: [] },
        ],
        provenance: { skills: [] },
        asked_at: ASKED_AT,
        settled_at: ASKED_AT,
      };
      const { rerender } = renderThread(
        <Thread entries={[]} selectedResult={null} onSelectResult={() => {}} liveTurn={liveTurn} />,
      );
      // Open round 1's fold only; round 2's stays collapsed.
      fireEvent.click(screen.getByRole("button", { name: "思考 · 0.9s" }));
      expect(screen.getByText("推理一")).toBeInTheDocument();
      expect(screen.queryByText("推理二")).not.toBeInTheDocument();
      // The settle swap in one commit: the live turn nulls AND the
      // optimistic record appends (the same single rerender the hook's batch
      // produces).
      rerender(
        <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
          <TooltipProvider>
            <Thread
              entries={[turnEntry(record)]}
              selectedResult={null}
              onSelectResult={() => {}}
              liveTurn={null}
            />
          </TooltipProvider>
        </IntlProvider>,
      );
      // The prose stays (identical markup) and the opened fold stays open;
      // the untouched fold stays collapsed. The answer body closes the turn.
      expect(screen.getByText("先看一眼数据。")).toBeInTheDocument();
      expect(screen.getByText("答")).toBeInTheDocument();
      const toggles = document.querySelectorAll(".turn-entry .thinking-toggle");
      expect(toggles).toHaveLength(2);
      expect(toggles[0]?.getAttribute("aria-expanded")).toBe("true");
      expect(toggles[1]?.getAttribute("aria-expanded")).toBe("false");
      expect(screen.getByText("推理一")).toBeInTheDocument();
      expect(screen.queryByText("推理二")).not.toBeInTheDocument();
    });

    it("maps the settle seed through the projection's round drop (issue #620)", () => {
      // The seed keys on the thinking block's reference, not an array index:
      // a gate-cancelled round (rows all unsettled, no prose, no thinking)
      // renders on the live side but the projection drops it, shifting the
      // settled trace's indices -- the reference key still finds the same
      // fold. An index-keyed seed flips these assertions (the opened fold
      // snaps shut, the next round's fold pops open).
      const openedThinking = { duration_ms: 900, text: "推理一" };
      const closedThinking = { duration_ms: 1200, text: "推理二" };
      const liveTurn: LiveTurn = {
        question: "q",
        askedAt: ASKED_AT,
        invocationNames: [],
        step: 3,
        rounds: [
          // The round the projection drops: a pending card that never
          // settled (denied at the gate, no dispatch).
          liveRound({
            rows: [
              liveRow({
                key: "req-1",
                name: "fetch",
                server: "acme",
                operationKind: "network",
                summary: "GET /x",
                approval: { requestId: "req-1", response: null },
                running: false,
                success: null,
              }),
            ],
          }),
          liveRound({ thinking: openedThinking }),
          liveRound({ thinking: closedThinking }),
        ],
      };
      const record: TurnRecord = {
        question: "q",
        outcome: { kind: "Cancelled", data: null },
        trace: [
          { thinking: openedThinking, calls: [] },
          { thinking: closedThinking, calls: [] },
        ],
        provenance: { skills: [] },
      };
      const { rerender } = renderThread(
        <Thread entries={[]} selectedResult={null} onSelectResult={() => {}} liveTurn={liveTurn} />,
      );
      // Open the middle round's fold (live index 1).
      fireEvent.click(screen.getByRole("button", { name: "思考 · 0.9s" }));
      rerender(
        <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
          <TooltipProvider>
            <Thread
              entries={[turnEntry(record)]}
              selectedResult={null}
              onSelectResult={() => {}}
              liveTurn={null}
            />
          </TooltipProvider>
        </IntlProvider>,
      );
      // The opened fold now sits at trace index 0 (the gate round dropped);
      // the reference seed keeps it open and leaves the other collapsed.
      const toggles = document.querySelectorAll(".turn-entry .thinking-toggle");
      expect(toggles).toHaveLength(2);
      expect(toggles[0]?.getAttribute("aria-expanded")).toBe("true");
      expect(toggles[1]?.getAttribute("aria-expanded")).toBe("false");
      expect(screen.getByText("推理一")).toBeInTheDocument();
      expect(screen.queryByText("推理二")).not.toBeInTheDocument();
    });

    it("keeps an opened live thinking fold mounted when new rows land in its round (issue #620)", () => {
      // The round block's key is the round number: a row landing in the same
      // round re-derives the rounds array but never remounts the block, so
      // the fold's local state (open) survives the growth.
      const thinking = { duration_ms: 900, text: "推理" };
      const liveTurn: LiveTurn = {
        question: "q",
        askedAt: ASKED_AT,
        invocationNames: [],
        step: 1,
        rounds: [liveRound({ thinking })],
      };
      const { rerender } = renderThread(
        <Thread entries={[]} selectedResult={null} onSelectResult={() => {}} liveTurn={liveTurn} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "思考 · 0.9s" }));
      expect(screen.getByText("推理")).toBeInTheDocument();
      // A call starts in the same round: the fold must not snap shut.
      rerender(
        <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
          <TooltipProvider>
            <Thread
              entries={[]}
              selectedResult={null}
              onSelectResult={() => {}}
              liveTurn={{
                ...liveTurn,
                rounds: [liveRound({ thinking, rows: [liveRow({ key: "call-0" })] })],
              }}
            />
          </TooltipProvider>
        </IntlProvider>,
      );
      const toggle = document.querySelector(".live-turn-exchange .thinking-toggle");
      expect(toggle?.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByText("推理")).toBeInTheDocument();
      expect(screen.getByText("explore")).toBeInTheDocument();
    });

    it("keeps the live-opened thinking fold across progress events landing after the open (issue #620)", () => {
      // The collector's reset edge keys on the submit stamp, NOT the liveTurn
      // identity: the memoized liveTurn takes a NEW identity on every
      // progress event, so an identity-keyed reset would wipe the collector
      // mid-turn and the settle seed would arrive empty -- the opened fold
      // would snap shut. Open, then a progress event, then the settle: the
      // exact sequence the swap tests above leave uncovered.
      const openedThinking = { duration_ms: 900, text: "推理一" };
      const liveTurn: LiveTurn = {
        question: "q",
        askedAt: ASKED_AT,
        invocationNames: [],
        step: 1,
        rounds: [liveRound({ thinking: openedThinking })],
      };
      const record: TurnRecord = {
        question: "q",
        outcome: { kind: "Cancelled", data: null },
        trace: [{ thinking: openedThinking, calls: [] }],
        provenance: { skills: [] },
      };
      const { rerender } = renderThread(
        <Thread entries={[]} selectedResult={null} onSelectResult={() => {}} liveTurn={liveTurn} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "思考 · 0.9s" }));
      // A later progress event (same turn -- the SAME submit stamp, a NEW
      // liveTurn object: the memo rebuilds on every event): the collector
      // must survive it.
      rerender(
        <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
          <TooltipProvider>
            <Thread
              entries={[]}
              selectedResult={null}
              onSelectResult={() => {}}
              liveTurn={{
                ...liveTurn,
                step: 2,
                rounds: [
                  liveRound({ thinking: openedThinking }),
                  liveRound({ rows: [liveRow({ key: "call-0" })] }),
                ],
              }}
            />
          </TooltipProvider>
        </IntlProvider>,
      );
      // The settle swap in one commit: the opened fold still seeds.
      rerender(
        <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
          <TooltipProvider>
            <Thread
              entries={[turnEntry(record)]}
              selectedResult={null}
              onSelectResult={() => {}}
              liveTurn={null}
            />
          </TooltipProvider>
        </IntlProvider>,
      );
      const toggles = document.querySelectorAll(".turn-entry .thinking-toggle");
      expect(toggles).toHaveLength(1);
      expect(toggles[0]?.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByText("推理一")).toBeInTheDocument();
    });

    it("keeps the fold open across the settle when a same-round repeated completion swaps the thinking block (issue #620)", () => {
      // Last-wins: a repeated ThinkingCompleted for the same round overwrites
      // the slot with a NEW block. The live fold keeps its open posture (the
      // round block is position-keyed), and the fold re-reports against the
      // replacement reference so the settle seed still hits -- without the
      // re-report the collector holds the dead reference and the fold snaps
      // shut at the swap.
      const firstThinking = { duration_ms: 900, text: "推理一版" };
      const replacedThinking = { duration_ms: 900, text: "推理二版" };
      const liveTurn: LiveTurn = {
        question: "q",
        askedAt: ASKED_AT,
        invocationNames: [],
        step: 1,
        rounds: [liveRound({ thinking: firstThinking })],
      };
      const record: TurnRecord = {
        question: "q",
        outcome: { kind: "Cancelled", data: null },
        trace: [{ thinking: replacedThinking, calls: [] }],
        provenance: { skills: [] },
      };
      const { rerender } = renderThread(
        <Thread entries={[]} selectedResult={null} onSelectResult={() => {}} liveTurn={liveTurn} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "思考 · 0.9s" }));
      expect(screen.getByText("推理一版")).toBeInTheDocument();
      // The same round completes again (last-wins): the slot now carries the
      // replacement block and the fold stays open on it.
      rerender(
        <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
          <TooltipProvider>
            <Thread
              entries={[]}
              selectedResult={null}
              onSelectResult={() => {}}
              liveTurn={{ ...liveTurn, rounds: [liveRound({ thinking: replacedThinking })] }}
            />
          </TooltipProvider>
        </IntlProvider>,
      );
      const liveToggle = document.querySelector(".live-turn-exchange .thinking-toggle");
      expect(liveToggle?.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByText("推理二版")).toBeInTheDocument();
      // The settle swap: the seed keys on the replacement reference.
      rerender(
        <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
          <TooltipProvider>
            <Thread
              entries={[turnEntry(record)]}
              selectedResult={null}
              onSelectResult={() => {}}
              liveTurn={null}
            />
          </TooltipProvider>
        </IntlProvider>,
      );
      const settledToggle = document.querySelector(".turn-entry .thinking-toggle");
      expect(settledToggle?.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByText("推理二版")).toBeInTheDocument();
    });

    it("keeps a fold the user re-closed before the settle collapsed (issue #620)", () => {
      // The collector tracks both directions: re-closing removes the block
      // from the set, so the settle seeds nothing and the fold mounts
      // collapsed -- a growing-only collector would wrongly mount it open.
      const thinking = { duration_ms: 900, text: "推理" };
      const liveTurn: LiveTurn = {
        question: "q",
        askedAt: ASKED_AT,
        invocationNames: [],
        step: 1,
        rounds: [liveRound({ thinking })],
      };
      const record: TurnRecord = {
        question: "q",
        outcome: { kind: "Cancelled", data: null },
        trace: [{ thinking, calls: [] }],
        provenance: { skills: [] },
      };
      const { rerender } = renderThread(
        <Thread entries={[]} selectedResult={null} onSelectResult={() => {}} liveTurn={liveTurn} />,
      );
      const toggle = screen.getByRole("button", { name: "思考 · 0.9s" });
      fireEvent.click(toggle); // open
      fireEvent.click(toggle); // re-close before the settle
      rerender(
        <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
          <TooltipProvider>
            <Thread
              entries={[turnEntry(record)]}
              selectedResult={null}
              onSelectResult={() => {}}
              liveTurn={null}
            />
          </TooltipProvider>
        </IntlProvider>,
      );
      const settledToggle = document.querySelector(".turn-entry .thinking-toggle");
      expect(settledToggle?.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByText("推理")).not.toBeInTheDocument();
    });

    it("resets the collected posture on a fresh turn so its folds mount collapsed (issue #620)", () => {
      // Turn A's opened fold settles open (its card mounts seeded); the NEXT
      // turn's folds mount collapsed -- the collector resets on the fresh
      // turn's submit stamp, so turn B never inherits turn A's set.
      const thinkingA = { duration_ms: 900, text: "推理甲" };
      const thinkingB = { duration_ms: 1200, text: "推理乙" };
      const recordA: TurnRecord = {
        question: "问甲",
        outcome: { kind: "Cancelled", data: null },
        trace: [{ thinking: thinkingA, calls: [] }],
        provenance: { skills: [] },
      };
      const recordB: TurnRecord = {
        question: "问乙",
        outcome: { kind: "Cancelled", data: null },
        trace: [{ thinking: thinkingB, calls: [] }],
        provenance: { skills: [] },
      };
      const { rerender } = renderThread(
        <Thread
          entries={[]}
          selectedResult={null}
          onSelectResult={() => {}}
          liveTurn={{
            question: "问甲",
            askedAt: ASKED_AT,
            invocationNames: [],
            step: 1,
            rounds: [liveRound({ thinking: thinkingA })],
          }}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "思考 · 0.9s" }));
      // Turn A settles: its fold mounts already open.
      rerender(
        <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
          <TooltipProvider>
            <Thread
              entries={[turnEntry(recordA)]}
              selectedResult={null}
              onSelectResult={() => {}}
              liveTurn={null}
            />
          </TooltipProvider>
        </IntlProvider>,
      );
      expect(document.querySelector(".turn-entry .thinking-toggle")?.getAttribute("aria-expanded")).toBe(
        "true",
      );
      // Turn B goes live (a NEW submit stamp) with its own thinking block,
      // then settles: B's fold mounts collapsed, A's stays open.
      rerender(
        <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
          <TooltipProvider>
            <Thread
              entries={[turnEntry(recordA)]}
              selectedResult={null}
              onSelectResult={() => {}}
              liveTurn={{
                question: "问乙",
                askedAt: ASKED_AT + 1000,
                invocationNames: [],
                step: 1,
                rounds: [liveRound({ thinking: thinkingB })],
              }}
            />
          </TooltipProvider>
        </IntlProvider>,
      );
      rerender(
        <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
          <TooltipProvider>
            <Thread
              entries={[turnEntry(recordA), turnEntry(recordB)]}
              selectedResult={null}
              onSelectResult={() => {}}
              liveTurn={null}
            />
          </TooltipProvider>
        </IntlProvider>,
      );
      const toggles = document.querySelectorAll(".turn-entry .thinking-toggle");
      expect(toggles).toHaveLength(2);
      expect(toggles[0]?.getAttribute("aria-expanded")).toBe("true");
      expect(toggles[1]?.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByText("推理乙")).not.toBeInTheDocument();
    });
  });

  describe("result preview card (ADR-0083 / ADR-0026, issue #298)", () => {
    // A Materialized turn carries an inline preview card: the windowed sample
    // (first rows frozen at copy-in, ADR-0026) of the PRIMARY result, so a
    // rail scan shows what the answer looks like without opening the
    // workspace. The full wide table stays workspace-only.

    it("renders the windowed sample of the primary result with a row-count footer", () => {
      // mockDataset: columns id/name, 2 sample rows, row_count 5.
      renderThread(
        <Thread
          entries={[turnEntry(materializedRecord("result_1", null))]}
          selectedResult={null}
          onSelectResult={() => {}}
        />,
      );
      const card = screen.getByRole("button", { name: /result_1 的预览/ });
      expect(card).toBeInTheDocument();
      // Column headers + every sample cell render.
      expect(within(card as HTMLElement).getByText("id")).toBeInTheDocument();
      expect(within(card as HTMLElement).getByText("name")).toBeInTheDocument();
      expect(within(card as HTMLElement).getByText("Alice")).toBeInTheDocument();
      expect(within(card as HTMLElement).getByText("Bob")).toBeInTheDocument();
      // The footer names the window: first {shown} of {total} rows.
      expect(within(card as HTMLElement).getByText("首 2 行，共 5 行")).toBeInTheDocument();
    });

    it("renders only the PRIMARY result's preview on a multi-promotion turn (ADR-0084)", () => {
      const record: TurnRecord = {
        question: "筛后聚合",
        outcome: {
          kind: "Materialized",
          data: {
            promotions: [
              {
                dataset: {
                  ...mockDataset,
                  reference_name: "result_1",
                  sample: [["x"]],
                  columns: [{ name: "mid", canonical_type: "VARCHAR" }],
                },
                sql: "SELECT 1",
              },
              { dataset: { ...mockDataset, reference_name: "result_2" }, sql: "SELECT 2" },
            ],
            viz: null,
            body: null,
            assumption: null,
          },
        },
        trace: [], provenance: { skills: [] },
      };
      renderThread(
        <Thread entries={[turnEntry(record)]} selectedResult={null} onSelectResult={() => {}} />,
      );
      // Exactly one preview card -- the chain tail (result_2). The antecedent
      // (result_1) rides the muted "derived from" line, not a second card.
      expect(screen.getByRole("button", { name: /result_2 的预览/ })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /result_1 的预览/ })).not.toBeInTheDocument();
    });

    it("clicking the preview card selects its result (dual-view seam)", () => {
      const onSelectResult = vi.fn();
      renderThread(
        <Thread
          entries={[turnEntry(materializedRecord("result_2", null))]}
          selectedResult={null}
          onSelectResult={onSelectResult}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /result_2 的预览/ }));
      expect(onSelectResult).toHaveBeenCalledWith("result_2");
    });

    it("marks the preview card of the viewed result active (dual-view linkage)", () => {
      renderThread(
        <Thread
          entries={[turnEntry(materializedRecord("result_1", null))]}
          selectedResult="result_1"
          onSelectResult={() => {}}
        />,
      );
      expect(screen.getByRole("button", { name: /result_1 的预览/ })).toHaveAttribute(
        "aria-current",
        "true",
      );
    });

    it("renders an empty-state footer when the result has no rows", () => {
      const record: TurnRecord = {
        question: "空结果",
        outcome: {
          kind: "Materialized",
          data: {
            promotions: [
              {
                dataset: { ...mockDataset, reference_name: "result_1", row_count: 0, sample: [] },
                sql: "SELECT 1 WHERE false",
              },
            ],
            viz: null,
            body: null,
            assumption: null,
          },
        },
        trace: [], provenance: { skills: [] },
      };
      renderThread(
        <Thread entries={[turnEntry(record)]} selectedResult={null} onSelectResult={() => {}} />,
      );
      const card = screen.getByRole("button", { name: /result_1 的预览/ });
      expect(within(card as HTMLElement).getByText("无数据行")).toBeInTheDocument();
      // No header / cell grid for a rowless result.
      expect(within(card as HTMLElement).queryByText("id")).not.toBeInTheDocument();
    });

    it("renders no preview card for non-materialized outcomes", () => {
      renderThread(
        <Thread
          entries={[
            turnEntry({
              question: "纯文本回答",
              outcome: {
                kind: "Textual",
                data: { text_kind: "Agent", body: "答案正文", assumption: null },
              },
              trace: [], provenance: { skills: [] },
            }),
          ]}
          selectedResult={null}
          onSelectResult={() => {}}
        />,
      );
      expect(screen.queryByRole("button", { name: /的预览/ })).not.toBeInTheDocument();
    });

    it("ghosts the preview card on a stale turn", () => {
      const staleByReference = new Map([
        [
          "result_1",
          { reference_name: "people", display_name: "员工表", reason: "Replaced" as const },
        ],
      ]);
      const { container } = renderThread(
        <Thread
          entries={[turnEntry(materializedRecord("result_1", null))]}
          selectedResult={null}
          onSelectResult={() => {}}
          staleByReference={staleByReference}
        />,
      );
      const card = container.querySelector(".result-preview");
      expect(card?.classList.contains("stale")).toBe(true);
    });

    it("renders gracefully when a sample row is shorter than the columns (wire mismatch)", () => {
      // ADR-0026 sample is frozen at copy-in from the same columns, so a short
      // row is a wire-contract violation -- the card degrades to empty cells
      // (row[c] ?? "") rather than crashing, so a malformed IPC payload never
      // blanks the whole rail.
      const record: TurnRecord = {
        question: "错位样本",
        outcome: {
          kind: "Materialized",
          data: {
            promotions: [
              {
                dataset: {
                  ...mockDataset,
                  reference_name: "result_1",
                  columns: [
                    { name: "a", canonical_type: "VARCHAR" },
                    { name: "b", canonical_type: "VARCHAR" },
                  ],
                  sample: [["x"]],
                },
                sql: "SELECT 1",
              },
            ],
            viz: null,
            body: null,
            assumption: null,
          },
        },
        trace: [], provenance: { skills: [] },
      };
      renderThread(
        <Thread entries={[turnEntry(record)]} selectedResult={null} onSelectResult={() => {}} />,
      );
      const card = screen.getByRole("button", { name: /result_1 的预览/ });
      // Both column headers render; column a's cell has the value, column b's
      // missing cell degrades to empty (no crash, no "undefined" leak).
      expect(within(card as HTMLElement).getByText("a")).toBeInTheDocument();
      expect(within(card as HTMLElement).getByText("b")).toBeInTheDocument();
      expect(within(card as HTMLElement).getByText("x")).toBeInTheDocument();
      // The footer still names the window by row count (mockDataset row_count 5).
      expect(within(card as HTMLElement).getByText("首 1 行，共 5 行")).toBeInTheDocument();
    });
  });

  // Issue #381: TurnCard surfaces a "modified" badge for skills whose content_hash drifted
  // since the turn was recorded. The check compares each turn.provenance.skills
  // entry against the registry's current SkillEntry.content_hash.
  describe("TurnCard skill provenance drift (issue #381)", () => {
    function turnWithSkill(name: string, contentHash: string): TurnRecord {
      return {
        question: "q",
        outcome: { kind: "Cancelled", data: null },
        trace: [],
        provenance: { skills: [{ name, content_hash: contentHash }] },
      };
    }
    function skillIndex(...skills: SkillEntry[]): Map<string, SkillEntry> {
      return new Map(skills.map((s) => [s.name, s]));
    }

    it("surfaces the modified badge when the skill's content_hash changed since the turn", () => {
      const index = skillIndex(skillEntry("sql-coach", { content_hash: "registry-hash" }));
      renderThread(
        <Thread
          entries={[{ entry: "Turn", data: turnWithSkill("sql-coach", "turn-hash") }]}
          selectedResult={null}
          onSelectResult={() => {}}
          skillIndex={index}
        />,
      );
      expect(screen.getByText(/sql-coach/)).toBeInTheDocument();
      expect(screen.getByText(/答案产生后已修改/)).toBeInTheDocument();
    });

    it("hides the drift badge when content_hash matches the registry", () => {
      const index = skillIndex(skillEntry("sql-coach", { content_hash: "same-hash" }));
      renderThread(
        <Thread
          entries={[{ entry: "Turn", data: turnWithSkill("sql-coach", "same-hash") }]}
          selectedResult={null}
          onSelectResult={() => {}}
          skillIndex={index}
        />,
      );
      expect(screen.queryByText(/答案产生后已修改/)).not.toBeInTheDocument();
    });

    it("hides the drift badge when content_hash is empty (v3->v4 migration, no baseline)", () => {
      const index = skillIndex(skillEntry("sql-coach", { content_hash: "registry-hash" }));
      renderThread(
        <Thread
          entries={[{ entry: "Turn", data: turnWithSkill("sql-coach", "") }]}
          selectedResult={null}
          onSelectResult={() => {}}
          skillIndex={index}
        />,
      );
      expect(screen.queryByText(/答案产生后已修改/)).not.toBeInTheDocument();
    });

    it("hides the drift badge when the skill is no longer in the registry", () => {
      // A name the registry no longer carries is the drift badge's "no longer
      // exists" case (#366), not a content drift -- the TurnCard omits it.
      const index = skillIndex();
      renderThread(
        <Thread
          entries={[{ entry: "Turn", data: turnWithSkill("ghost", "turn-hash") }]}
          selectedResult={null}
          onSelectResult={() => {}}
          skillIndex={index}
        />,
      );
      expect(screen.queryByText(/答案产生后已修改/)).not.toBeInTheDocument();
    });

    it("hides the drift badge when skillIndex is not wired (honest degrade)", () => {
      renderThread(
        <Thread
          entries={[{ entry: "Turn", data: turnWithSkill("sql-coach", "turn-hash") }]}
          selectedResult={null}
          onSelectResult={() => {}}
        />,
      );
      expect(screen.queryByText(/答案产生后已修改/)).not.toBeInTheDocument();
    });
  });

  describe("runtime attribution markers (issue #818, per-turn)", () => {
    // A textual record with an explicit runtime attribution -- the minimal
    // TurnRecord shape the marker logic reads.
    function runtimeTurn(runtime: TurnRecord["provenance"]["runtime"]): TurnRecord {
      return {
        question: "问",
        outcome: {
          kind: "Textual",
          data: { text_kind: "Agent", body: "答", assumption: null },
        },
        trace: [],
        provenance: { skills: [], runtime },
      };
    }

    it("marks every external turn in a mixed thread; built-in turns stay unmarked", () => {
      renderThread(
        <Thread
          entries={[
            turnEntry(runtimeTurn({ kind: "built_in" })),
            turnEntry(runtimeTurn({ kind: "built_in" })),
            turnEntry(
              runtimeTurn({ kind: "external", data: { adapter_id: "gemini-cli" } }),
            ),
            turnEntry(
              runtimeTurn({ kind: "external", data: { adapter_id: "gemini-cli" } }),
            ),
          ]}
          selectedResult={null}
          onSelectResult={() => {}}
        />,
      );
      // Per-turn attribution: both external turns carry the marker (an
      // unmarked stretch reads as the default runtime), never the built-in.
      expect(screen.getAllByText("gemini-cli")).toHaveLength(2);
      expect(screen.queryByText("内置")).not.toBeInTheDocument();
    });

    it("renders no markers at all for a purely built-in thread", () => {
      renderThread(
        <Thread
          entries={[turnEntry(runtimeTurn({ kind: "built_in" }))]}
          selectedResult={null}
          onSelectResult={() => {}}
        />,
      );
      expect(screen.queryByText("内置")).not.toBeInTheDocument();
    });

    it("stays silent for a pre-attribution external turn (no not-recorded fallback)", () => {
      const { container } = renderThread(
        <Thread
          entries={[turnEntry(runtimeTurn({ kind: "external", data: { adapter_id: null } }))]}
          selectedResult={null}
          onSelectResult={() => {}}
        />,
      );
      // Count elements, not text: a regression rendering a marker with an
      // empty label would evade every queryByText.
      expect(container.querySelectorAll(".runtime-attribution")).toHaveLength(0);
    });

    it("keeps an unrecorded stretch silent without silencing its neighbors", () => {
      renderThread(
        <Thread
          entries={[
            turnEntry(runtimeTurn({ kind: "external", data: { adapter_id: "codex" } })),
            // Optimistic / pre-extension row: no runtime field.
            turnEntry(runtimeTurn(undefined)),
            turnEntry(runtimeTurn({ kind: "external", data: { adapter_id: "codex" } })),
          ]}
          selectedResult={null}
          onSelectResult={() => {}}
        />,
      );
      // The unrecorded middle renders nothing, but per-turn attribution
      // needs no segment bookkeeping to keep the neighbors marked.
      expect(screen.getAllByText("codex")).toHaveLength(2);
    });
  });

  // Issue #737: consecutive same-kind lifecycle runs at/above the threshold
  // fold into one collapsed disclosure row. The pure segmentation pins live
  // in turnVisual.test.ts; these cover the DOM contract -- the
  // default-collapsed posture, the accessible disclosure (expand keeps the
  // head in place, members carry no connector), the aggregate suffixes, and
  // the jump contract's expand-before-scroll (ADR-0047 exact-event semantics
  // preserved against the group swallowing the target).

  describe("lifecycle fold (issue #737)", () => {
    const added = (name: string, display: string): ThreadEntry => ({
      entry: "Source",
      data: { kind: "Added", reference_name: name, display_name: display },
    });
    const replaced = (name: string, display: string): ThreadEntry => ({
      entry: "Source",
      data: { kind: "Replaced", reference_name: name, display_name: display },
    });

    it("folds a same-kind run at the threshold into one collapsed row; below it stays scatter", () => {
      // Three Added events (a sequential ingest) collapse to ONE row
      // carrying the count text; two never fold -- the boundary is the
      // threshold pin (the constant off by one in either direction turns
      // this red).
      const { container } = renderThread(
        <Thread
          entries={[added("a", "甲"), added("b", "乙"), added("c", "丙")]}
          selectedResult={null}
          onSelectResult={() => {}}
        />,
      );
      expect(container.querySelectorAll(".lifecycle-fold-entry")).toHaveLength(1);
      expect(container.querySelectorAll(".source-entry")).toHaveLength(0);
      const foldBtn = screen.getByRole("button", { name: /加载了 3 个数据源/ });
      expect(foldBtn.getAttribute("aria-expanded")).toBe("false");

      const { container: below } = renderThread(
        <Thread
          entries={[added("a", "甲"), added("b", "乙")]}
          selectedResult={null}
          onSelectResult={() => {}}
        />,
      );
      expect(below.querySelectorAll(".lifecycle-fold-entry")).toHaveLength(0);
      expect(below.querySelectorAll(".source-entry")).toHaveLength(2);
    });

    it("expands to ONE combined member-name row under the kept-in-place head, then collapses again", () => {
      const { container } = renderThread(
        <Thread
          entries={[added("a", "甲"), added("b", "乙"), added("c", "丙")]}
          selectedResult={null}
          onSelectResult={() => {}}
        />,
      );
      const foldBtn = screen.getByRole("button", { name: /加载了 3 个数据源/ });
      fireEvent.click(foldBtn);
      expect(foldBtn.getAttribute("aria-expanded")).toBe("true");
      // The head stays in place; the members render as ONE combined row (the
      // combined-member ruling: a long stretch never re-stretches the
      // timeline N rows deep) naming every member side by side -- never as
      // scatter rows again.
      expect(container.querySelectorAll(".lifecycle-fold-entry")).toHaveLength(1);
      const combined = container.querySelectorAll(".lifecycle-fold-members");
      expect(combined).toHaveLength(1);
      expect(combined[0].textContent).toBe("甲乙丙");
      expect(container.querySelectorAll(".source-entry")).toHaveLength(0);
      // The combined row carries no connector: the fold row keeps the
      // segment's line, so expanding never moves it.
      expect(combined[0].hasAttribute("data-run")).toBe(false);
      fireEvent.click(foldBtn);
      expect(foldBtn.getAttribute("aria-expanded")).toBe("false");
      expect(container.querySelectorAll(".lifecycle-fold-members")).toHaveLength(0);
    });

    it("conducts the run connector through an expanded fold that sits mid-run (issue #737)", () => {
      // The fold's members only ever form a run with OTHER markers around
      // them (a turn breaks), so a mid-run head is the [marker | fold |
      // marker] shape. Expanded, the combined row must carry the
      // through-segment (data-run-continue) so the line does not break
      // across it; a lone fold (single) carries none -- there is no line to
      // conduct.
      const midRunEntries: ThreadEntry[] = [
        replaced("a", "甲"),
        added("a", "甲"),
        added("b", "乙"),
        added("c", "丙"),
        replaced("b", "乙"),
      ];
      const midRun = renderThread(
        <Thread
          entries={midRunEntries}
          selectedResult={null}
          onSelectResult={() => {}}
        />,
      );
      fireEvent.click(midRun.container.querySelector(".lifecycle-fold-entry button") as HTMLElement);
      expect(
        midRun.container.querySelector(".lifecycle-fold-members")?.getAttribute("data-run-continue"),
      ).toBe("true");
      // The fold head itself is the segment's single node: it carries the run
      // position the connector rule keys on (mid here -- [marker | fold |
      // marker]), pinned in the DOM like the scatter rows' data-run.
      expect(
        midRun.container.querySelector(".lifecycle-fold-entry")?.getAttribute("data-run"),
      ).toBe("mid");

      const loneEntries: ThreadEntry[] = [
        turnEntry(materializedRecord("result_1", null)),
        added("a", "甲"),
        added("b", "乙"),
        added("c", "丙"),
      ];
      const lone = renderThread(
        <Thread
          entries={loneEntries}
          selectedResult={null}
          onSelectResult={() => {}}
        />,
      );
      fireEvent.click(lone.container.querySelector(".lifecycle-fold-entry button") as HTMLElement);
      expect(
        lone.container.querySelector(".lifecycle-fold-members")?.hasAttribute("data-run-continue"),
      ).toBe(false);
      // A lone fold is its run's only node: single, no line either way.
      expect(
        lone.container.querySelector(".lifecycle-fold-entry")?.getAttribute("data-run"),
      ).toBe("single");
    });

    it("sums the invalidation counts onto the fold row; expanded members keep their counts", () => {
      // a:Replaced invalidates 2 results, b none, c 1 -- the fold carries 3,
      // and each expanded member names its own count beside its name.
      const staleByReference = new Map([
        ["result_1", { reference_name: "a", display_name: "甲", reason: "Replaced" as const }],
        ["result_2", { reference_name: "a", display_name: "甲", reason: "Replaced" as const }],
        ["result_3", { reference_name: "c", display_name: "丙", reason: "Replaced" as const }],
      ]);
      const { container } = renderThread(
        <Thread
          entries={[replaced("a", "甲"), replaced("b", "乙"), replaced("c", "丙")]}
          selectedResult={null}
          onSelectResult={() => {}}
          staleByReference={staleByReference}
        />,
      );
      const foldBtn = screen.getByRole("button", { name: /换源了 3 个数据源.*失效 3/ });
      expect(foldBtn).toBeInTheDocument();
      fireEvent.click(foldBtn);
      const names = container.querySelectorAll(
        ".lifecycle-fold-members span[data-entry-idx]",
      );
      expect(Array.from(names).map((n) => n.textContent)).toEqual([
        "甲 · 失效 2",
        "乙",
        "丙 · 失效 1",
      ]);
    });

    it("expands a collapsed group before a stale-chip jump lands on the exact member (ADR-0047)", () => {
      const entries: ThreadEntry[] = [
        turnEntry(materializedRecord("result_1", null)),
        replaced("a", "甲"),
        replaced("b", "乙"),
        replaced("c", "丙"),
      ];
      const staleByReference = new Map([
        ["result_1", { reference_name: "a", display_name: "甲", reason: "Replaced" as const }],
      ]);
      const { container } = renderThread(
        <Thread
          entries={entries}
          selectedResult={null}
          onSelectResult={() => {}}
          staleByReference={staleByReference}
        />,
      );
      // Collapsed: the target row is not even in the DOM yet.
      expect(container.querySelectorAll(".source-entry")).toHaveLength(0);
      // The chip's target is the first Replaced after the turn (the 甲
      // member) -- inside the collapsed group. The jump must expand the
      // group AND highlight the exact member, never degrade to the fold row.
      fireEvent.click(screen.getByRole("button", { name: /源已更新/ }));
      // The group auto-expands to the combined row and the highlight lands
      // on the exact member NAME (ADR-0047), not the row.
      expect(container.querySelectorAll(".lifecycle-fold-members")).toHaveLength(1);
      expect(
        container.querySelector(".lifecycle-fold-entry button")?.getAttribute("aria-expanded"),
      ).toBe("true");
      const highlighted = container.querySelector(
        `.lifecycle-fold-members span[data-highlighted="true"]`,
      );
      expect(highlighted?.textContent).toContain("甲");
    });
  });

  // Issue #1005: the latest failure card's technical-details fold mounts
  // already open -- the same "latest settled turn is Failed" predicate the
  // sidebar dot derives from. Historical cards and non-Failed landings keep
  // the collapsed default.
  describe("Thread failed-card default-open technical details (issue #1005)", () => {
    function sourceAdded(name: string): ThreadEntry {
      return {
        entry: "Source",
        data: { kind: "Added", reference_name: name, display_name: name },
      };
    }

    it("mounts the latest failure card's fold already open", () => {
      const entries: ThreadEntry[] = [
        turnEntry(materializedRecord("result_1", null)),
        failed("boom"),
      ];
      const { container } = renderThread(
        <Thread entries={entries} selectedResult={null} onSelectResult={() => {}} />,
      );
      const details = container.querySelector("details.error-details");
      expect(details).not.toBeNull();
      expect(details?.hasAttribute("open")).toBe(true);
    });

    it("opens only the LAST failure card when failures stack (historical cards stay collapsed)", () => {
      const entries: ThreadEntry[] = [failed("first"), failed("second")];
      const { container } = renderThread(
        <Thread entries={entries} selectedResult={null} onSelectResult={() => {}} />,
      );
      const details = container.querySelectorAll("details.error-details");
      expect(details).toHaveLength(2);
      expect(details[0]?.hasAttribute("open")).toBe(false);
      expect(details[1]?.hasAttribute("open")).toBe(true);
    });

    it("keeps the latest failure card open across trailing source events (tail-scan skips lifecycle)", () => {
      const entries: ThreadEntry[] = [
        turnEntry(materializedRecord("result_1", null)),
        failed("boom"),
        sourceAdded("people"),
      ];
      const { container } = renderThread(
        <Thread entries={entries} selectedResult={null} onSelectResult={() => {}} />,
      );
      expect(container.querySelector("details.error-details")?.hasAttribute("open")).toBe(true);
    });

    it("keeps every fold collapsed once a newer turn settles non-Failed", () => {
      const entries: ThreadEntry[] = [
        failed("boom"),
        turnEntry(materializedRecord("result_1", null)),
      ];
      const { container } = renderThread(
        <Thread entries={entries} selectedResult={null} onSelectResult={() => {}} />,
      );
      expect(container.querySelector("details.error-details")?.hasAttribute("open")).toBe(false);
    });

    it("keeps folds collapsed when the latest turn is Cancelled (a user action, not an error)", () => {
      const entries: ThreadEntry[] = [failed("boom"), cancelled("stop")];
      const { container } = renderThread(
        <Thread entries={entries} selectedResult={null} onSelectResult={() => {}} />,
      );
      expect(container.querySelector("details.error-details")?.hasAttribute("open")).toBe(false);
    });

    it("renders no fold for a self-contained NotWired failure (nothing to default-open)", () => {
      const notWired: ThreadEntry = {
        entry: "Turn",
        data: {
          question: "q",
          outcome: { kind: "Failed", data: { kind: "NotWired" } },
          trace: [],
          provenance: { skills: [] },
        },
      };
      const entries: ThreadEntry[] = [
        turnEntry(materializedRecord("result_1", null)),
        notWired,
      ];
      const { container } = renderThread(
        <Thread entries={entries} selectedResult={null} onSelectResult={() => {}} />,
      );
      expect(container.querySelector("details.error-details")).toBeNull();
    });

    it("renders no fold for a StaleReference failure either (same self-contained family)", () => {
      const stale: ThreadEntry = {
        entry: "Turn",
        data: {
          question: "q",
          outcome: {
            kind: "Failed",
            data: { kind: "StaleReference", data: { reference_name: "result_1" } },
          },
          trace: [],
          provenance: { skills: [] },
        },
      };
      const entries: ThreadEntry[] = [
        turnEntry(materializedRecord("result_1", null)),
        stale,
      ];
      const { container } = renderThread(
        <Thread entries={entries} selectedResult={null} onSelectResult={() => {}} />,
      );
      expect(container.querySelector("details.error-details")).toBeNull();
    });
  });
});
