// Issue #818: the runtime attribution marker opens every turn's assistant
// stream. These pin the DOM contract the pure gate cannot: the marker is the
// stream's FIRST child (ahead of agent activations, header annotations, and
// rounds), so the live -> settled swap never moves it. The visibility matrix
// itself lives in turnVisual.test.ts (runtimeMarkerName) and Thread.test.tsx
// (per-thread rendering); a minimal record with no agent head, dataset chip,
// or rounds keeps the first-child position directly observable.

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { TooltipProvider } from "../../ui/tooltip";
import { catalogFor } from "../../../i18n";
import { TurnCard } from "../TurnCard";
import type { ReactNode } from "react";
import type { TextKind, TurnRecord } from "../../../types/thread";

// Thread chrome routes through react-intl (ADR-0052); zh-CN matches the
// shared fixture convention, and the marker's label is the raw adapter id
// (layer-4 content, untranslated) so the assertions hold under any locale.
function renderCard(record: TurnRecord, agentHead?: ReactNode) {
  return render(
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      <TooltipProvider>
        <TurnCard
          record={record}
          agentHead={agentHead}
          selectedResult={null}
          onSelectResult={() => {}}
          staleAnchor={undefined}
          hasJumpTarget={false}
          onStaleChipJump={undefined}
          mentionedDataset={null}
          skillIndex={undefined}
          onRetryTurn={undefined}
          busy={false}
        />
      </TooltipProvider>
    </IntlProvider>,
  );
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

describe("TurnCard runtime attribution marker (issue #818)", () => {
  it("opens the assistant stream with the marker naming the adapter", () => {
    const { container } = renderCard(
      recordWith({ kind: "external", data: { adapter_id: "claude-code" } }),
    );
    const stream = container.querySelector(".assistant-stream");
    expect(stream).not.toBeNull();
    // The position contract: attribution (who answers) precedes everything
    // the actor did -- activations, annotations, rounds.
    expect(stream?.firstElementChild).toHaveClass("runtime-attribution");
    expect(stream?.firstElementChild).toHaveTextContent("claude-code");
  });

  it("keeps the marker ahead of the agent-activation head (adjudication 4)", () => {
    const { container } = renderCard(
      recordWith({ kind: "external", data: { adapter_id: "claude-code" } }),
      <span data-agent-head>act</span>,
    );
    const stream = container.querySelector(".assistant-stream");
    // The full position contract the header claims: attribution first,
    // then the activations the actor triggered.
    expect(stream?.firstElementChild).toHaveClass("runtime-attribution");
    expect(stream?.firstElementChild?.nextElementSibling).toHaveAttribute("data-agent-head");
  });

  it("keeps the marker on a Failed turn, in the muted caption family", () => {
    const record: TurnRecord = {
      ...recordWith({ kind: "external", data: { adapter_id: "claude-code" } }),
      outcome: { kind: "Failed", data: { kind: "Execute", data: { detail: "boom" } } },
    };
    const { container } = renderCard(record);
    const marker = container.querySelector(".runtime-attribution");
    expect(marker).not.toBeNull();
    expect(marker).toHaveClass("text-muted-foreground");
  });

  it("renders no marker for the built-in default", () => {
    const { container } = renderCard(recordWith({ kind: "built_in" }));
    expect(container.querySelector(".runtime-attribution")).toBeNull();
  });

  it("renders no marker when provenance carries no runtime", () => {
    const { container } = renderCard(recordWith(undefined));
    expect(container.querySelector(".runtime-attribution")).toBeNull();
  });

  it("renders no marker for a pre-id external runtime", () => {
    const { container } = renderCard(
      recordWith({ kind: "external", data: { adapter_id: null } }),
    );
    expect(container.querySelector(".runtime-attribution")).toBeNull();
  });
});

describe("TurnCard trace round width cap (issue #826)", () => {
  it("caps the trace round at the stream width so summaries can truncate", () => {
    // A round rides the assistant stream as a non-stretched flex item; the
    // max-w-full cap keeps a nowrap summary from stretching the round past
    // the card (the layout breaker -- the row's truncate only engages when
    // the round stops at the stream width).
    const record: TurnRecord = {
      ...recordWith(undefined),
      trace: [{ text: "答轮", calls: [] }],
    };
    const { container } = renderCard(record);
    expect(container.querySelector(".trace-round")).toHaveClass("max-w-full");
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
