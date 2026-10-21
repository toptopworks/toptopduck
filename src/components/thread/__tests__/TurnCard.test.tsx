// The settled card's own surface pins. The head contract -- the marker's
// first-child position, its built-in / pre-id silence cells, the
// invocation-badge face -- and the round width cap ride the swap-stable
// modules now, pinned in TurnExchangeFrame.test / RoundBody.test (issue
// #1157); what stays here is what only the card reaches through its own
// data: the Failed marker variant (a weakened stream keeps its attribution),
// the unrecorded-runtime silence (the card's provenance path), the
// User-actor badge derivation hand-off, the per-outcome width caps, the
// folds, the cancel-reason split (#883), and the textual markdown (#827).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { TooltipProvider } from "../../ui/tooltip";
import { catalogFor, type EffectiveLocale } from "../../../i18n";
import { TurnCard } from "../TurnCard";
import type { DatasetDescriptor } from "../../../types/dataset";
import type { TextKind, TraceEntry, TurnRecord } from "../../../types/thread";

// The attribution marker reads the shared adapter-table cache (issue #1351),
// so the card tree needs a QueryClient like the app tree provides. The api
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

// Thread chrome routes through react-intl (ADR-0052); zh-CN matches the
// shared fixture convention, and the marker's label is the raw adapter id
// (layer-4 content, untranslated) so the assertions hold under any locale.
// Split element / render so the default-open pins (#1005) can rerender the
// same tree.
function cardEl(record: TurnRecord, defaultOpenDetail?: boolean, locale: EffectiveLocale = "zh-CN") {
  return (
    <IntlProvider locale={locale} messages={catalogFor(locale)}>
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <TurnCard
            record={record}
            selectedResult={null}
            onSelectResult={() => {}}
            staleAnchor={undefined}
            hasJumpTarget={false}
            onStaleChipJump={undefined}
            mentionedDataset={null}
            skillIndex={undefined}
            onRetryTurn={undefined}
            busy={false}
            defaultOpenDetail={defaultOpenDetail}
          />
        </QueryClientProvider>
      </TooltipProvider>
    </IntlProvider>
  );
}

function renderCard(record: TurnRecord, defaultOpenDetail?: boolean, locale: EffectiveLocale = "zh-CN") {
  return render(cardEl(record, defaultOpenDetail, locale));
}

function recordWith(runtime: TurnRecord["provenance"]["runtime"]): TurnRecord {
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

// The materialized-outcome family's shared dataset fixture: a complete,
// type-clean descriptor so the link row and the preview card render off the
// same shape (#860 introduced it; #872 reuses it for the link-row caps).
const previewDataset: DatasetDescriptor = {
  reference_name: "result_1",
  display_name: "result_1",
  source_path: "/x/r.csv",
  row_count: 1,
  fingerprint: "abc123def4560000000000000000000000000000000000000000000000000999",
  columns: [
    { name: "平均HP", canonical_type: "DOUBLE" },
    { name: "平均攻击", canonical_type: "DOUBLE" },
  ],
  sample: [["69.3", "79.0"]],
  rectify: { kind: "NotApplicable" },
  privacy: { send_samples: true, type_only_columns: [] },
};

describe("TurnCard runtime attribution marker (issue #818)", () => {
  it("keeps the marker on a Failed turn, in the muted caption family", () => {
    const record: TurnRecord = {
      ...recordWith({ kind: "external", data: { adapter_id: "claude-code", display_name: null } }),
      outcome: { kind: "Failed", data: { kind: "Execute", data: { detail: "boom" } } },
    };
    const { container } = renderCard(record);
    const marker = container.querySelector(".runtime-attribution");
    expect(marker).not.toBeNull();
    expect(marker).toHaveClass("text-muted-foreground");
  });

  it("renders no marker when provenance carries no runtime", () => {
    const { container } = renderCard(recordWith(undefined));
    expect(container.querySelector(".runtime-attribution")).toBeNull();
  });
});

// The card derives the badge names (userInvocationNames filters to the User
// actor, ADR-0119 Decision 5) -- the frame pins the given-prop face, this
// pins the derivation hand-off: an agent-side skill never lands on the bubble.
describe("TurnCard user-invocation badges (ADR-0119 Decision 5)", () => {
  it("renders only the User-actor derivation above the question", () => {
    const record: TurnRecord = {
      ...recordWith(undefined),
      invocations: [
        { name: "pdf-tools", body: "", actor: "Agent", content_hash: "" },
        { name: "charting", body: "", actor: "User", content_hash: "" },
      ],
    };
    const { getByText, queryByText, getByLabelText } = renderCard(record);
    expect(getByText("charting")).toBeInTheDocument();
    expect(queryByText("pdf-tools")).not.toBeInTheDocument();
    expect(getByLabelText("随此消息调用的技能")).toBeInTheDocument();
  });
});

describe("TurnCard narrow-column width caps (issue #860)", () => {
  function materializedRecord(body: string | null): TurnRecord {
    return {
      ...recordWith(undefined),
      outcome: {
        kind: "Materialized",
        data: {
          promotions: [{ dataset: previewDataset, sql: "SELECT 1" }],
          viz: null,
          body,
          assumption: null,
        },
      },
    };
  }

  it("caps the textual outcome container at the stream width", () => {
    // The outcome rides the stream as a non-stretched flex item -- the
    // #826 trace-round twin. The cap must sit here: the prose root's own
    // max-w-full cannot reach this layer (its containing block IS this
    // container, so clamping the child leaves the blown parent in place).
    const { container } = renderCard(recordWith(undefined));
    expect(container.querySelector(".turn-outcome.textual")).toHaveClass("max-w-full");
  });

  it("caps the materialized terminal prose at the stream width", () => {
    // #847 hangs the terminal prose directly off the stream as a flex
    // item; its min-content (a wide markdown table) stretches the whole
    // item past the card, and the rail's overflow-x: hidden crops it. The
    // RoundProse root carries the cap for every consumer (live rounds,
    // settled rounds, the materialized terminal, the textual body)
    // through the single pipeline point.
    const { container } = renderCard(
      materializedRecord("| 很长的列名一 | 很长的列名二 |\n| --- | --- |\n| a | b |"),
    );
    expect(container.querySelector(".round-text")).toHaveClass("max-w-full");
  });

  it("aligns the preview card with the prose column and paces its top gap", () => {
    // ml-6 was the #298 anchor to the trace-call gutter; since #847 put
    // terminal prose between the link row and the card, the visual
    // neighbors (prose, tables, meta icons) all sit at the column edge --
    // the indent made the card the stream's only offset item, and in
    // narrow columns the margin rides past the max-w-full cap outright.
    // mt-4 joins the prose root's 16px block rhythm (space-y-4) instead
    // of hugging the last block at 6px.
    const { container } = renderCard(materializedRecord(null));
    const preview = container.querySelector(".result-preview");
    expect(preview).not.toBeNull();
    // The card is itself a stream flex item: its own cap keeps the sample
    // grid's min-content inside the column -- the margin-past-cap clause
    // above leans on this class.
    expect(preview).toHaveClass("max-w-full");
    expect(preview).not.toHaveClass("ml-6");
    expect(preview).toHaveClass("mt-4");
  });
});

describe("TurnCard outcome-card narrow-column caps (issue #862)", () => {
  function failedRecord(): TurnRecord {
    return {
      ...recordWith(undefined),
      outcome: { kind: "Failed", data: { kind: "Execute", data: { detail: "boom" } } },
    };
  }

  it("caps the outcome card at the stream width", () => {
    // The outcome card rides the stream as a non-stretched flex item
    // (flex-col items-start), so its min-content -- its longest unbreakable
    // run -- stretches it past the column and the rail's overflow-x crop
    // makes the spill unreachable: the #860 cap's non-table twin, moved onto
    // the Failed/Cancelled card from the prose containers.
    const failed = renderCard(failedRecord());
    expect(failed.container.querySelector(".turn-outcome.failed")).toHaveClass("max-w-full");
    const cancelled = renderCard({ ...recordWith(undefined), outcome: { kind: "Cancelled", data: null } });
    expect(cancelled.container.querySelector(".turn-outcome.cancelled")).toHaveClass("max-w-full");
  });

  it("lets a long reason token break inside the card head", () => {
    // The reason span is a flex item of the card-head row: min-width:auto
    // floors its shrink at the longest unbreakable run, and break-words
    // only joins the laid-out line, not the intrinsic-size math -- min-w-0
    // lifts the floor so a locale reason carrying a long unbroken detail
    // string can actually wrap inside the capped card.
    const { container } = renderCard(failedRecord());
    expect(container.querySelector(".failed-reason")).toHaveClass("min-w-0", "break-words");
  });
});

// Issue #1005: the latest failure card's technical-details fold mounts
// already open; every other posture keeps the collapsed default.
describe("TurnCard failed-card default-open technical details (issue #1005)", () => {
  function failedRecord(): TurnRecord {
    return {
      ...recordWith(undefined),
      outcome: { kind: "Failed", data: { kind: "Execute", data: { detail: "boom" } } },
    };
  }

  it("mounts the fold already open when the flag rides the card", () => {
    const { container } = renderCard(failedRecord(), true);
    const details = container.querySelector("details.error-details");
    expect(details).not.toBeNull();
    expect(details?.hasAttribute("open")).toBe(true);
  });

  it("keeps the collapsed default without the flag (historical card / other callers)", () => {
    const { container } = renderCard(failedRecord());
    const details = container.querySelector("details.error-details");
    expect(details).not.toBeNull();
    expect(details?.hasAttribute("open")).toBe(false);
  });

  it("never clobbers a manual collapse while the prop value is steady", () => {
    const view = renderCard(failedRecord(), true);
    const details = view.container.querySelector<HTMLDetailsElement>("details.error-details");
    expect(details).not.toBeNull();
    // The user collapses the fold (React does not own the toggle), then the
    // card re-renders with an unchanged flag: React skips the open-attribute
    // write, so the manual collapse survives.
    details!.open = false;
    view.rerender(cardEl(failedRecord(), true));
    expect(details!.open).toBe(false);
  });

  it("collapses the fold again when the flag flips back (the turn stops being latest)", () => {
    const view = renderCard(failedRecord(), true);
    const details = view.container.querySelector<HTMLDetailsElement>("details.error-details");
    expect(details).not.toBeNull();
    expect(details?.hasAttribute("open")).toBe(true);
    // A newer turn settles non-Failed: Thread recomputes the flag to
    // undefined, the prop VALUE changes, and React removes the open
    // attribute -- the documented state-style extinguish (the flip back
    // returns the fold to the collapsed posture, not the manual-toggle
    // no-op of the steady-value case above).
    view.rerender(cardEl(failedRecord(), undefined));
    expect(details?.hasAttribute("open")).toBe(false);
  });
});

describe("TurnCard cancelled reason split (issue #883)", () => {
  it("presents a watchdog kill as the no-progress timeout, not a plain cancel", () => {
    // The honest reaction to a system-side abort is retry or report
    // -- "已取消" alone hides which landing happened, so the reason rides the
    // outcome payload and the card head splits on it.
    const { getByText, queryByText, container } = renderCard({
      ...recordWith(undefined),
      outcome: { kind: "Cancelled", data: "NoProgress" },
    });
    expect(getByText("无进展超时")).toBeInTheDocument();
    expect(queryByText("已取消")).not.toBeInTheDocument();
    // The longer watchdog copy wraps like the Failed reason (#862), not
    // stretch past the capped card.
    expect(container.querySelector(".cancelled-reason")).toHaveClass("min-w-0", "break-words");
  });

  it("keeps a manual stop presenting as cancelled", () => {
    const { getByText } = renderCard({
      ...recordWith(undefined),
      outcome: { kind: "Cancelled", data: null },
    });
    expect(getByText("已取消")).toBeInTheDocument();
  });
});

describe("TurnCard materialized link-row narrow-column caps (issue #872)", () => {
  function namedDataset(reference_name: string): DatasetDescriptor {
    return { ...previewDataset, reference_name, display_name: reference_name };
  }

  function linkRowRecord(): TurnRecord {
    return {
      ...recordWith(undefined),
      outcome: {
        kind: "Materialized",
        data: {
          promotions: [
            { dataset: namedDataset("intermediate_step_one_output_table"), sql: "SELECT 1" },
            { dataset: namedDataset("final_result_with_a_long_unbroken_name"), sql: "SELECT 2" },
          ],
          viz: null,
          body: null,
          assumption: null,
        },
      },
    };
  }

  it("caps the link-row paragraph at the stream width and lets long names break", () => {
    // The link row's paragraph is the last stretch-prone stream item the
    // earlier caps left uncovered: the antecedents line and the result-link
    // button both ride it, and a long unbroken dataset name stretches the
    // paragraph's min-content past the column, where the rail's overflow-x
    // crop eats it with no scroll path (#860 capped the prose twin; #862 the
    // outcome card -- this branch is #872's residue). The cap + break sit on
    // the paragraph itself.
    const { container } = renderCard(linkRowRecord());
    expect(container.querySelector(".turn-outcome")).toHaveClass("max-w-full", "break-words");
    // The result-link is an inline-block: break-words only joins the
    // laid-out line, not the intrinsic-size math, so the button needs its
    // own element-level cap before the cascaded break can engage inside it.
    // inline-block joins the pin because the pair is what a rogue
    // all-unset-style arbitrary property would clobber first.
    expect(container.querySelector(".result-link")).toHaveClass("inline-block", "max-w-full");
  });
});

describe("TurnCard textual outcome markdown (issue #827)", () => {
  function textualRecord(
    text_kind: TextKind,
    body: string,
    assumption: string | null = null,
  ): TurnRecord {
    return {
      ...recordWith(undefined),
      outcome: { kind: "Textual", data: { text_kind, body, assumption } },
    };
  }

  it("renders the terminal reply through the shared RoundProse pipeline", () => {
    // The Agent kind's terminal text (ADR-0077) is the longest markdown
    // carrier -- headings, code fences -- and now rides the same pipeline
    // the round prose uses instead of a plain text span.
    const { container } = renderCard(
      textualRecord("Agent", "# 结论\n\n```sql\nSELECT 1\n```"),
    );
    const prose = container.querySelector(".turn-outcome.textual .round-text");
    expect(prose).not.toBeNull();
    expect(prose?.querySelector("h1")).toHaveTextContent("结论");
    expect(prose?.querySelector("pre code")).toHaveTextContent("SELECT 1");
  });

  it("keeps the Clarify kind badge on its own caption row outside the prose", () => {
    const { container } = renderCard(textualRecord("Clarify", "按产品名还是客户名？"));
    const outcome = container.querySelector(".turn-outcome.textual");
    const badge = outcome?.querySelector(".textual-kind") ?? null;
    // Chrome, not discourse: the badge is a block-level caption row (a <p>
    // sibling, issue #727's tier pin lives on) that never nests inside the
    // markdown pipeline's root.
    expect(badge?.tagName).toBe("P");
    expect(badge).toHaveClass("text-xs");
    const prose = outcome?.querySelector(".round-text") ?? null;
    expect(prose?.contains(badge)).toBe(false);
  });

  it.each(["Agent", "Clarify", "Refuse"] as const)(
    "routes the %s kind through the same prose path with the note after it",
    (text_kind) => {
      const { container } = renderCard(textualRecord(text_kind, "同一正文", "把 id 当主键"));
      const outcome = container.querySelector(".turn-outcome.textual");
      // The lowercase kind rides the container as a hook class for every
      // kind, not just the one Thread.test happens to select on (.clarify).
      expect(outcome, `kind=${text_kind}`).toHaveClass(text_kind.toLowerCase());
      const prose = outcome?.querySelector(".round-text") ?? null;
      expect(prose, `kind=${text_kind}`).not.toBeNull();
      // The assumption side note trails the prose as a sibling, not a child.
      const note = container.querySelector(".assumption");
      // Guard first: a silently-unrendered note would otherwise satisfy both
      // sibling assertions vacuously (null contains nothing, null === null).
      expect(note).not.toBeNull();
      expect(prose?.contains(note)).toBe(false);
      expect(prose?.nextElementSibling).toBe(note);
    },
  );

  it("pins the outcome container's tag and the rows' self-pacing classes", () => {
    // jsdom cannot see margins, so the spacing contract rides class pins
    // (the #826 max-w-full precedent): the container's div tag (block-level
    // markdown cannot nest in a <p>) with its mt-1 offset, the badge row's
    // m-0 (half the space-y argument -- the browser's default <p> margin
    // would double-space the caption row), and the note's mt-0.5.
    const { container } = renderCard(textualRecord("Clarify", "正文", "假设"));
    const outcome = container.querySelector(".turn-outcome.textual");
    expect(outcome?.tagName).toBe("DIV");
    expect(outcome).toHaveClass("mt-1");
    expect(outcome?.querySelector(".textual-kind")).toHaveClass("m-0");
    expect(container.querySelector(".assumption")).toHaveClass("mt-0.5");
  });
});

// The turn card's usage pill surface (ADR-0129 Decision 5, issue #1270;
// the pill form is issue #1278's recalibration): a usage-bearing turn
// mounts the always-visible total pill on the closing meta row; a turn
// without usage (fail-closed, or recorded before the field) renders none
// -- the honest-degrade rule. The pins read the pill's text via the
// usage-footer hook.
const usageLines = () =>
  Array.from(document.querySelectorAll(".usage-footer")).map((el) => el.textContent);
const expectUsageLine = (text: string) => {
  expect(usageLines().some((t) => t?.includes(text))).toBe(true);
};
describe("TurnCard usage footer (ADR-0129, issue #1270)", () => {
  it("renders the usage pill when the record carries usage", () => {
    const record = recordWith(undefined);
    record.usage = {
      total: {
        input_tokens: 1500,
        cache_read_tokens: 1000,
        cache_write_tokens: 0,
        output_tokens: 300,
      },
    };
    renderCard(record);
    // zh-CN catalog wording (the suite's fixture locale): the pill label
    // resolves from the catalog, not literals, so the pin tracks the
    // wording (issue #139 convention).
    // ADR-0130: the fixed K/M scale (1500 + 300 = 1800 -> "1.8K"); the
    // bucket detail rides the pill's Popover (issue #1278), not the line.
    expectUsageLine("已用 1.8K");
  });

  it("renders no usage pill for a turn without usage", () => {
    renderCard(recordWith(undefined));
    expect(document.querySelector(".usage-footer")).toBeNull();
  });
});

// The sub-agent subtotal pairing (ADR-0129 Decision 6, issue #1270): the
// name-ordinal walk runs at TURN scope -- a same-spec re-delegation in a
// later round must reach the SECOND table entry (a per-round cursor reads
// the first again), and a refused row (no sub-trace) consumes no ordinal.
// Each delegation row's expansion annotates its own run's subtotal, never a
// same-name sibling's.
describe("TurnCard sub-agent subtotal pairing (ADR-0129, issue #1270)", () => {
  const analystRun = (): TraceEntry => ({
    name: "analyst",
    operation_kind: "execute",
    summary: "count the rows",
    success: true,
    result_excerpt: "",
    sub_rounds: [{ calls: [] }],
  });
  const analystRefusal = (): TraceEntry => ({
    name: "analyst",
    operation_kind: "execute",
    summary: "count the rows",
    success: false,
    result_excerpt: "refused",
  });
  const usageOf = (input: number, output: number) => ({
    input_tokens: input,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: output,
  });
  // The turn total stays visually distinct from both subtotals (999).
  const dualRunRecord = (): TurnRecord => {
    const record = recordWith(undefined);
    record.trace = [{ calls: [analystRun()] }, { calls: [analystRun()] }];
    record.usage = {
      total: usageOf(999, 500),
      subagents: [
        { name: "analyst", usage: usageOf(30, 10) },
        { name: "analyst", usage: usageOf(5, 5) },
      ],
    };
    return record;
  };
  const openSubtrace = (roundIndex: number) => {
    renderCard(dualRunRecord());
    // Issue #1282: the per-round folds live inside the turn-level process
    // fold -- the head opens first.
    fireEvent.click(screen.getByRole("button", { name: /已回答/ }));
    screen.getAllByText("轨迹 · 1 次调用").forEach((t) => fireEvent.click(t));
    fireEvent.click(screen.getAllByText("子智能体轨迹")[roundIndex]);
  };

  it("round 1's expansion carries the first run's subtotal", () => {
    openSubtrace(0);
    expectUsageLine("已用 40");
  });

  it("a same-spec re-delegation in a later round reaches the second entry", () => {
    openSubtrace(1);
    // The pairing bug reads the first entry again (入 30); the turn-scope
    // ordinal must reach the second run.
    expectUsageLine("已用 10");
  });

  it("a refused row (no sub-trace) consumes no ordinal", () => {
    const record = recordWith(undefined);
    // One round: the refusal lands a trace row without a table entry; the
    // real run behind it must still pair with the FIRST table entry.
    record.trace = [{ calls: [analystRefusal(), analystRun()] }];
    record.usage = {
      total: usageOf(999, 500),
      subagents: [{ name: "analyst", usage: usageOf(30, 10) }],
    };
    renderCard(record);
    // Issue #1282: the head opens first; the per-round fold lives inside it.
    fireEvent.click(screen.getByRole("button", { name: /已回答/ }));
    fireEvent.click(screen.getByText("轨迹 · 2 次调用"));
    // The refusal renders no sub-trace fold (the row's own gate) --
    // exactly one openable expansion remains.
    const buttons = screen.getAllByText("子智能体轨迹");
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expectUsageLine("已用 40");
  });
});

// The turn-level process fold (issue #1282): the settled card's process face
// (per-round thinking folds + connective prose + step folds) tucks behind ONE
// collapsed head, so the card reads question -> one head -> answer. The head
// speaks the outcome vocabulary (the meta row glyph's aria-label word) and
// the frozen wall clock -- the scan face of a rail of collapsed cards. The
// head is the settle swap's resting posture (the live exchange streams
// unfurled, ADR-0078).
describe("TurnCard turn process fold (issue #1282)", () => {
  const tracedRecord = (): TurnRecord => {
    const record = recordWith(undefined);
    record.asked_at = 1_000_000;
    record.settled_at = 1_040_000; // 40s of wall clock
    record.trace = [
      {
        thinking: { duration_ms: 3200, text: "推理" },
        text: "先看表",
        calls: [
          {
            name: "explore",
            operation_kind: "read",
            summary: "SELECT 1",
            success: true,
            result_excerpt: "",
          },
        ],
      },
      {
        calls: [
          {
            name: "materialize",
            operation_kind: "write",
            summary: "SELECT 2",
            success: true,
            result_excerpt: "",
          },
        ],
      },
    ];
    return record;
  };

  it("collapses the whole process behind one head; the answer stays out", () => {
    const { container } = renderCard(tracedRecord());
    const head = container.querySelector("button.process-toggle");
    expect(head).not.toBeNull();
    expect(head).toHaveAttribute("aria-expanded", "false");
    // The per-round face mounts inside the fold on expand -- none of it at rest.
    expect(screen.queryByText("轨迹 · 1 次调用")).not.toBeInTheDocument();
    expect(screen.queryByText("先看表")).not.toBeInTheDocument();
    // The answer is the reading mainstay -- outside the fold.
    expect(container.querySelector(".turn-outcome.textual")).not.toBeNull();
  });

  it("heads the fold with the outcome word and the frozen duration", () => {
    renderCard(tracedRecord());
    // The head's face joins into one text run (the outcome label and the
    // #1280 tier face are bare text nodes), so the pin reads the button's
    // own text: the Textual Agent outcome word, seconds tier, fed by
    // settled_at - asked_at.
    const head = document.querySelector("button.process-toggle");
    expect(head?.textContent).toBe("已回答 · 40秒");
  });

  it("expands to the incumbent per-round face (thinking, prose, steps)", () => {
    renderCard(tracedRecord());
    fireEvent.click(screen.getByRole("button", { name: /已回答/ }));
    expect(screen.getByText("先看表")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "思考 · 3.2s" })).toBeInTheDocument();
    expect(screen.getAllByText("轨迹 · 1 次调用")).toHaveLength(2);
  });

  it("renders no head when the trace carries no content at all", () => {
    const { container } = renderCard(recordWith(undefined));
    expect(container.querySelector("button.process-toggle")).toBeNull();
    // The migrated empty-round shape (every member missing) guards the same.
    const emptyRound = renderCard({ ...recordWith(undefined), trace: [{ calls: [] }] });
    expect(emptyRound.container.querySelector("button.process-toggle")).toBeNull();
  });

  it("mounts the head for the pre-v5 migrated single round of bare calls", () => {
    const record = recordWith(undefined);
    record.trace = [
      {
        calls: [
          {
            name: "explore",
            operation_kind: "read",
            summary: "SELECT 1",
            success: true,
            result_excerpt: "",
          },
        ],
      },
    ];
    const { container } = renderCard(record);
    expect(container.querySelector("button.process-toggle")).not.toBeNull();
  });

  it("renders the en face with the latin tier suffix", () => {
    renderCard(tracedRecord(), undefined, "en-US");
    expect(document.querySelector("button.process-toggle")?.textContent).toBe("Answered · 40s");
  });

  it("keeps the collapsed head on a Failed turn with the failure card outside", () => {
    const record = tracedRecord();
    record.outcome = { kind: "Failed", data: { kind: "Execute", data: { detail: "boom" } } };
    const { container } = renderCard(record);
    const head = container.querySelector("button.process-toggle");
    expect(head).toHaveAttribute("aria-expanded", "false");
    // The head word follows the outcome: the failure vocabulary.
    expect(head?.textContent).toBe("失败 · 40秒");
    // The terminal story stays outside: the failure card with its reason.
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("degrades honestly without stamps: the head carries no duration", () => {
    const record = tracedRecord();
    delete record.asked_at;
    delete record.settled_at;
    renderCard(record);
    expect(document.querySelector("button.process-toggle")?.textContent).toBe("已回答");
  });

  it("degrades honestly with one stamp missing: the head still carries no duration", () => {
    const record = tracedRecord();
    delete record.settled_at;
    renderCard(record);
    expect(document.querySelector("button.process-toggle")?.textContent).toBe("已回答");
  });

  it("degrades honestly on inverted stamps: no floor-seconds face", () => {
    const record = tracedRecord();
    record.asked_at = 1e12;
    record.settled_at = 1e12 - 1500;
    renderCard(record);
    expect(document.querySelector("button.process-toggle")?.textContent).toBe("已回答");
  });
});
