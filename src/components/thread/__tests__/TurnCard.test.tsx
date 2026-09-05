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
import type { TurnRecord } from "../../../types/thread";

// Thread chrome routes through react-intl (ADR-0052); zh-CN matches the
// shared fixture convention, and the marker's label is the raw adapter id
// (layer-4 content, untranslated) so the assertions hold under any locale.
function renderCard(record: TurnRecord) {
  return render(
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      <TooltipProvider>
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
