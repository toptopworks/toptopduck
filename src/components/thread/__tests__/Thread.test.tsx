import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { TooltipProvider } from "../../ui/tooltip";
import type { ReactElement } from "react";
import { catalogFor } from "../../../i18n";
import { Thread } from "../Thread";
import type { LiveTraceRow, LiveTurn } from "../../../session/useTurnFlow";
import type { DatasetDescriptor } from "../../../types/dataset";
import type { SkillEntry } from "../../../types/skills";
import type { ThreadEntry, TurnRecord } from "../../../types/thread";

// A materialized-record fixture (reference_name overridden per test) -- the
// only outcome that needs a full dataset payload. Lives in this file because
// Thread is the sole thread-domain consumer of a full descriptor.
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
  // A materialized record built from the shared mock descriptor (reference_name
  // overridden) -- the only outcome that needs a full dataset payload.
  function materializedRecord(referenceName: string, assumption: string | null): TurnRecord {
    return {
      question: `问 ${referenceName}`,
      outcome: {
        kind: "Materialized",
        data: {
          promotions: [
            { dataset: { ...mockDataset, reference_name: referenceName }, sql: "SELECT 1" },
          ],
          viz: null,
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

  // Build a registry SkillEntry with only the fields the skill-marker render
  // path reads (name + mcp_servers). The other declaration fields are filled
  // with benign defaults -- the marker never inspects them, and keeping the
  // helper narrow keeps the tests focused on the marker behavior under test.
  function skillEntry(name: string, mcpServers: string[] = []): SkillEntry {
    return {
      name,
      description: `${name} description.`,
      acquired: "local",
      license: null,
      compatibility: null,
      mcp_servers: mcpServers,
      body: "",
      link_target: null,
      content_hash: "deadbeef",
    };
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
      { question: "中途取消", outcome: { kind: "Cancelled" }, trace: [], provenance: { skills: [] } },
    ];
    renderThread(
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
    expect(screen.getByText("按产品名还是客户名？")).toBeInTheDocument();
    expect(screen.getByText("无法处理")).toBeInTheDocument();
    expect(screen.getByText("预测不在 v1 能力范围内")).toBeInTheDocument();
    // Failed renders the typed Execute message via the locale catalog (the
    // engine detail rides the collapsed fold); cancelled renders the marker.
    expect(screen.getByText("执行查询失败")).toBeInTheDocument();
    expect(screen.getByText("已取消")).toBeInTheDocument();
  });

  it("renders an Agent textual turn as a plain answer with no action badge", () => {
    // ADR-0077: the tool-calling contract's terminal text rides TextKind::Agent
    // -- the body IS the reply, so the turn renders without the clarify /
    // refuse action badge; the kind still reads off the outcome icon's
    // aria-label (ADR-0050).
    renderThread(
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

    // The body renders as a plain answer, labeled by its verbatim question.
    expect(screen.getByText("总共有多少客户")).toBeInTheDocument();
    expect(screen.getByText("共 128 位客户。")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "已回答" })).toBeInTheDocument();
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
      { question: "q", outcome: { kind: "Cancelled" }, trace: [], provenance: { skills: [] } },
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
      { question: "中途取消", outcome: { kind: "Cancelled" }, trace: [], provenance: { skills: [] } },
    ];
    const { container } = renderThread(
      <Thread entries={records.map(turnEntry)} selectedResult={null} onSelectResult={() => {}} />,
    );
    // Both are present in the DOM (not collapsed away).
    expect(screen.getByText("坏查询")).toBeInTheDocument();
    expect(screen.getByText("执行查询失败")).toBeInTheDocument();
    expect(screen.getByText("中途取消")).toBeInTheDocument();
    expect(screen.getByText("已取消")).toBeInTheDocument();
    // Both carry their outcome attribute (weakening is CSS opacity, asserted at
    // the style layer, not duplicated here).
    expect(container.querySelector(`.turn-entry[data-outcome="failed"]`)).not.toBeNull();
    expect(container.querySelector(`.turn-entry[data-outcome="cancelled"]`)).not.toBeNull();
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

  it("renders skill lifecycle markers as thin bars distinct from turn cards (issue #366)", () => {
    // The two skill lifecycle kinds (Mount / Unmount) ride the timeline
    // isomorphic to source events but as a distinct species -- thin, non-
    // interactive markers (data-skill-kind + .skill-lifecycle), never turn
    // cards. Each carries its kind's glyph + an i18n'd verb + the spec name
    // (the stable identity the timeline carries, never a snapshot).
    const entries: ThreadEntry[] = [
      { entry: "Skill", data: { kind: "Mount", name: "pdf-tools" } },
      { entry: "Skill", data: { kind: "Unmount", name: "pdf-tools" } },
    ];
    const skillIndex = new Map([["pdf-tools", skillEntry("pdf-tools")]]);
    const { container } = renderThread(
      <Thread
        entries={entries}
        selectedResult={null}
        onSelectResult={() => {}}
        skillIndex={skillIndex}
      />,
    );
    // Two distinct markers by kind; never rendered as .turn-entry.
    const markers = container.querySelectorAll(".skill-entry");
    expect(Array.from(markers).map((li) => li.getAttribute("data-skill-kind"))).toEqual([
      "mount",
      "unmount",
    ]);
    expect(container.querySelectorAll(".turn-entry")).toHaveLength(0);
    // Each kind's i18n'd verb rides one ICU message with the spec name.
    expect(screen.getByText(/挂载技能「pdf-tools」/)).toBeInTheDocument();
    expect(screen.getByText(/卸载技能「pdf-tools」/)).toBeInTheDocument();
    // Mount = active tone (border-l-primary); Unmount = weakened tone.
    const mountBar = container.querySelector(
      `.skill-entry[data-skill-kind="mount"] .skill-lifecycle`,
    ) as HTMLElement;
    const unmountBar = container.querySelector(
      `.skill-entry[data-skill-kind="unmount"] .skill-lifecycle`,
    ) as HTMLElement;
    expect(mountBar.className.split(/\s+/)).toContain("border-l-primary");
    expect(unmountBar.className.split(/\s+/)).toContain("border-l-muted-foreground");
  });

  it("discloses a mounted skill's declared MCP servers in the marker tooltip (issue #366)", async () => {
    // A Mount marker's tooltip carries the skill's declared MCP server ids
    // (looked up from the registry, never snapshotted into the event) so a
    // long skill name does not erase which servers the mount activates. The
    // visible text still shows the verb + name; the MCP detail is hover-only.
    const entries: ThreadEntry[] = [
      { entry: "Skill", data: { kind: "Mount", name: "pdf-tools" } },
    ];
    const skillIndex = new Map([
      ["pdf-tools", skillEntry("pdf-tools", ["github-mcp", "fs-server"])],
    ]);
    const { container } = renderThread(
      <Thread
        entries={entries}
        selectedResult={null}
        onSelectResult={() => {}}
        skillIndex={skillIndex}
      />,
    );
    const markerText = container.querySelector(
      `.skill-entry[data-skill-kind="mount"] .skill-text`,
    ) as HTMLElement;
    // Native title is gone (Radix Tooltip carries it, ADR-0050).
    expect(markerText.getAttribute("title")).toBeNull();
    fireEvent.pointerMove(markerText);
    await waitFor(() => {
      const tip = screen.getByRole("tooltip");
      expect(tip.textContent).toContain("pdf-tools");
      expect(tip.textContent).toContain("github-mcp");
      expect(tip.textContent).toContain("fs-server");
    });
  });

  it("omits MCP detail from a Mount tooltip when the skill declares no servers (issue #366)", async () => {
    // A Mount whose skill is in the registry but declares zero MCP servers
    // carries no declaration to disclose, so the tooltip mirrors the bare
    // verb + name -- a regression that drops the length > 0 guard (showing
    // "Declares MCP:" with an empty list) fails here. The default registry
    // entry has no servers, so this is the common path.
    const entries: ThreadEntry[] = [
      { entry: "Skill", data: { kind: "Mount", name: "plain-skill" } },
    ];
    const skillIndex = new Map([["plain-skill", skillEntry("plain-skill")]]); // empty mcp_servers
    const { container } = renderThread(
      <Thread
        entries={entries}
        selectedResult={null}
        onSelectResult={() => {}}
        skillIndex={skillIndex}
      />,
    );
    const markerText = container.querySelector(
      `.skill-entry[data-skill-kind="mount"] .skill-text`,
    ) as HTMLElement;
    fireEvent.pointerMove(markerText);
    await waitFor(() => {
      const tip = screen.getByRole("tooltip");
      expect(tip.textContent).toContain("plain-skill");
      expect(tip.textContent).not.toContain("声明 MCP");
    });
  });

  it("does not surface MCP detail on an Unmount marker (the declaration is no longer operative)", async () => {
    // Unmount means the skill left the active set; its MCP declaration no
    // longer applies, so the tooltip carries the verb + name only -- a
    // regression that copy-pastes the Mount tooltip branch fails here.
    const entries: ThreadEntry[] = [
      { entry: "Skill", data: { kind: "Unmount", name: "pdf-tools" } },
    ];
    const skillIndex = new Map([
      ["pdf-tools", skillEntry("pdf-tools", ["github-mcp"])],
    ]);
    const { container } = renderThread(
      <Thread
        entries={entries}
        selectedResult={null}
        onSelectResult={() => {}}
        skillIndex={skillIndex}
      />,
    );
    const markerText = container.querySelector(
      `.skill-entry[data-skill-kind="unmount"] .skill-text`,
    ) as HTMLElement;
    fireEvent.pointerMove(markerText);
    await waitFor(() => {
      const tip = screen.getByRole("tooltip");
      expect(tip.textContent).toContain("pdf-tools");
      expect(tip.textContent).not.toContain("github-mcp");
    });
  });

  it("flags a skill the registry no longer carries with a missing-skill warning (issue #366)", () => {
    // Resume honest-degrade (ADR-0086): a Mount/Unmount event whose name left
    // the registry (deleted / renamed / external library uninstalled) renders
    // a destructive tone + a warning glyph + a "已不存在" suffix. The event
    // stays in the timeline (it happened) but the reader sees the skill is
    // gone; the base text keeps the verbatim name (the timeline's record).
    const entries: ThreadEntry[] = [
      { entry: "Skill", data: { kind: "Mount", name: "ghost-skill" } },
    ];
    // Empty registry: "ghost-skill" is not carried.
    const skillIndex = new Map<string, SkillEntry>();
    const { container } = renderThread(
      <Thread
        entries={entries}
        selectedResult={null}
        onSelectResult={() => {}}
        skillIndex={skillIndex}
      />,
    );
    const marker = container.querySelector(
      `.skill-entry[data-skill-kind="mount"] .skill-lifecycle`,
    ) as HTMLElement;
    expect(marker.className.split(/\s+/)).toContain("border-l-destructive");
    expect(marker.className.split(/\s+/)).toContain("text-destructive");
    expect(screen.getByText(/已不存在/)).toBeInTheDocument();
  });

  it("renders skill markers from the event alone when no registry index is wired (issue #366)", () => {
    // Honest degrade: a call site that does not pass skillIndex still gets a
    // readable marker (verb + name from the event). Without a registry to
    // check against, NO missing-skill warning is raised and NO MCP detail is
    // promised -- the timeline is always readable, the registry only enriches.
    const entries: ThreadEntry[] = [
      { entry: "Skill", data: { kind: "Mount", name: "pdf-tools" } },
    ];
    const { container } = renderThread(
      <Thread entries={entries} selectedResult={null} onSelectResult={() => {}} />,
    );
    expect(screen.getByText(/挂载技能「pdf-tools」/)).toBeInTheDocument();
    expect(screen.queryByText(/已不存在/)).not.toBeInTheDocument();
    // No tooltip provider lookup needed -- the marker text is the bare verb.
    expect(container.querySelector(".skill-entry")).not.toBeNull();
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
      { question: "在订单表上统计总销售额", outcome: { kind: "Cancelled" }, trace: [], provenance: { skills: [] } },
      { question: "总共几行", outcome: { kind: "Cancelled" }, trace: [], provenance: { skills: [] } },
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
      { question: "在 people 上统计总销售额", outcome: { kind: "Cancelled" }, trace: [], provenance: { skills: [] } },
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
      { question: "在订单表上统计", outcome: { kind: "Cancelled" }, trace: [], provenance: { skills: [] } },
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
      { question: "q", outcome: { kind: "Cancelled" }, trace: [], provenance: { skills: [] } },
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
    // The opacity-60 weak state now rides the card as a utility.
    const records: TurnRecord[] = [
      { question: "坏查询", outcome: { kind: "Failed", data: { kind: "Execute", data: { detail: "bad column" } } }, trace: [], provenance: { skills: [] } },
      { question: "中途取消", outcome: { kind: "Cancelled" }, trace: [], provenance: { skills: [] } },
    ];
    const { container } = renderThread(
      <Thread entries={records.map(turnEntry)} selectedResult={null} onSelectResult={() => {}} />,
    );
    const failedCard = container.querySelector(`.turn-entry[data-outcome="failed"] .turn-card`);
    const cancelledCard = container.querySelector(`.turn-entry[data-outcome="cancelled"] .turn-card`);
    expect(failedCard?.className.split(/\s+/)).toContain("opacity-60");
    expect(cancelledCard?.className.split(/\s+/)).toContain("opacity-60");
  });

  it("encodes the three source lifecycle kinds by border-l-* tone (ADR-0047, issue #169)", () => {
    // The three-way border-left hue (Added=primary / Replaced=accent-foreground /
    // Deleted=destructive) now rides the marker as a literal border-l-* utility,
    // replacing the .source-lifecycle.added/replaced/deleted CSS rules.
    const entries: ThreadEntry[] = [
      { entry: "Source", data: { kind: "Added", reference_name: "people", display_name: "员工表" } },
      { entry: "Source", data: { kind: "Replaced", reference_name: "people", display_name: "员工表" } },
      { entry: "Source", data: { kind: "Deleted", reference_name: "orders", display_name: "订单表" } },
    ];
    const { container } = renderThread(
      <Thread entries={entries} selectedResult={null} onSelectResult={() => {}} />,
    );
    const tone = (kind: string) =>
      container
        .querySelector(`.source-entry[data-source-kind="${kind}"] .source-lifecycle`)
        ?.className.split(/\s+/);
    expect(tone("added")).toContain("border-l-primary");
    expect(tone("replaced")).toContain("border-l-accent-foreground");
    expect(tone("deleted")).toContain("border-l-destructive");
  });

  it("jump-select lifts the matched source marker via bg-accent + ring (ADR-0047 chip-trace, issue #169)", () => {
    // The jump-select highlight now rides the marker as bg-accent + ring-2
    // ring-primary utilities, replacing the [data-highlighted] CSS rule. The
    // wrapping <li> still carries data-highlighted (the caller-derived flag) for
    // selector stability, but the visual lands on the inner .source-lifecycle.
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
    const highlighted = container.querySelector(`.source-entry[data-highlighted="true"] .source-lifecycle`);
    expect(highlighted?.className.split(/\s+/)).toContain("bg-accent");
    expect(highlighted?.className.split(/\s+/)).toContain("ring-2");
    expect(highlighted?.className.split(/\s+/)).toContain("ring-primary");
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
        outcome: { kind: "Cancelled" },
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
          entries={[turnEntry({ question: "q", outcome: { kind: "Cancelled" }, trace: [], provenance: { skills: [] } })]}
          selectedResult={null}
          onSelectResult={() => {}}
        />,
      );
      expect(screen.queryByRole("button", { name: /轨迹/ })).not.toBeInTheDocument();
    });
  });

  describe("in-flight live turn card (ADR-0078/0083, issue #297)", () => {
    function liveRow(over: Partial<LiveTraceRow> = {}): LiveTraceRow {
      return {
        key: "call-0",
        step: 1,
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

    it("renders the asking question with a running glyph + thinking hint", () => {
      const liveTurn: LiveTurn = { question: "统计一下", step: 1, rows: [], roundTexts: [] };
      renderThread(
        <Thread entries={[]} selectedResult={null} onSelectResult={() => {}} liveTurn={liveTurn} />,
      );
      expect(screen.getByText("统计一下")).toBeInTheDocument();
      expect(screen.getByText("思考中…")).toBeInTheDocument();
    });

    it("surfaces the step on a multi-round-trip turn (honest step N)", () => {
      const liveTurn: LiveTurn = { question: "q", step: 2, rows: [], roundTexts: [] };
      renderThread(
        <Thread entries={[]} selectedResult={null} onSelectResult={() => {}} liveTurn={liveTurn} />,
      );
      expect(screen.getByText("思考中（第 2 步）…")).toBeInTheDocument();
    });

    it("renders a pending approval card whose three buttons answer by request id", () => {
      const liveTurn: LiveTurn = {
        question: "q",
        step: 1,
        roundTexts: [],
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
        step: 1,
        roundTexts: [],
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
      const liveTurn: LiveTurn = { question: "第一问", step: null, rows: [], roundTexts: [] };
      // entries empty (a brand-new session's first ask): the live card still
      // renders (the empty-thread bail-out must not swallow it).
      const { container } = renderThread(
        <Thread entries={[]} selectedResult={null} onSelectResult={() => {}} liveTurn={liveTurn} />,
      );
      expect(screen.getByText("第一问")).toBeInTheDocument();
      expect(container.querySelector(".live-turn-card")).not.toBeNull();
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
        outcome: { kind: "Cancelled" },
        trace: [],
        provenance: { skills: [{ name, content_hash: contentHash }] },
      };
    }
    function registrySkill(name: string, contentHash: string): SkillEntry {
      return {
        name,
        description: `${name} description.`,
        acquired: "local",
        license: null,
        compatibility: null,
        mcp_servers: [],
        body: "",
        link_target: null,
        content_hash: contentHash,
      };
    }
    function skillIndex(...skills: SkillEntry[]): Map<string, SkillEntry> {
      return new Map(skills.map((s) => [s.name, s]));
    }

    it("surfaces the modified badge when the skill's content_hash changed since the turn", () => {
      const index = skillIndex(registrySkill("sql-coach", "registry-hash"));
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
      const index = skillIndex(registrySkill("sql-coach", "same-hash"));
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
      const index = skillIndex(registrySkill("sql-coach", "registry-hash"));
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
      // A name the registry no longer carries is the SkillMarker's "no longer
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

  describe("runtime attribution segments (ADR-0101)", () => {
    // A textual record with an explicit runtime attribution -- the minimal
    // TurnRecord shape the badge logic reads.
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

    it("renders one badge per attribution change in a mixed thread (segment-start quieting)", () => {
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
      // The built-in segment announces once (its first turn), the external
      // segment once -- continuation turns stay quiet.
      expect(screen.getAllByText("内置")).toHaveLength(1);
      expect(screen.getAllByText("gemini-cli")).toHaveLength(1);
    });

    it("renders no badges at all for a purely built-in thread (the gate)", () => {
      renderThread(
        <Thread
          entries={[turnEntry(runtimeTurn({ kind: "built_in" }))]}
          selectedResult={null}
          onSelectResult={() => {}}
        />,
      );
      expect(screen.queryByText("内置")).not.toBeInTheDocument();
    });

    it("degrades a pre-attribution external turn to the honest not-recorded note", () => {
      renderThread(
        <Thread
          entries={[turnEntry(runtimeTurn({ kind: "external", data: { adapter_id: null } }))]}
          selectedResult={null}
          onSelectResult={() => {}}
        />,
      );
      expect(screen.getByText("外部（未记录）")).toBeInTheDocument();
      expect(screen.queryByText("gemini-cli")).not.toBeInTheDocument();
    });

    it("stays silent on an unrecorded stretch but re-announces the next segment", () => {
      renderThread(
        <Thread
          entries={[
            turnEntry(runtimeTurn({ kind: "external", data: { adapter_id: "codex" } })),
            // Optimistic / pre-extension row: no runtime field.
            turnEntry(runtimeTurn(undefined)),
            turnEntry(runtimeTurn({ kind: "built_in" })),
          ]}
          selectedResult={null}
          onSelectResult={() => {}}
        />,
      );
      expect(screen.getByText("codex")).toBeInTheDocument();
      expect(screen.getByText("内置")).toBeInTheDocument();
    });

    it("re-announces the same runtime when an unrecorded stretch breaks the segment", () => {
      // Discriminating companion to the test above: codex -> unrecorded ->
      // built-in passes whether or not the unrecorded row updates the
      // segment key (built-in differs from both predecessors anyway). This
      // codex -> unrecorded -> codex thread pins the break -- the trailing
      // codex stretch re-announces; a regression that stops updating the
      // key on unrecorded rows would collapse it to a single badge.
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
      expect(screen.getAllByText("codex")).toHaveLength(2);
    });
  });
});
