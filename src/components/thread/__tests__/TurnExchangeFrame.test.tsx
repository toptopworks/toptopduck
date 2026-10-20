// The frame's own contract pins (issue #1157): the runtime attribution
// marker's first-child position, its built-in / pre-id silence cells, and
// the invocation-badge face, pinned here instead of per-side on TurnCard /
// LiveTurnExchange (the twin tests retired with the swap). The
// absent-runtime cell stays per-side -- each side reaches it through its own
// data path (the card's provenance silence, the live before-ask-time-read
// silence) -- and the adapters' hand-offs carry their own pins in their
// suites; the full visibility matrix also lives in turnVisual.test.ts
// (runtimeMarkerName).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { renderI18n } from "../../common/__tests__/helpers";
import { TurnExchangeFrame } from "../TurnExchangeFrame";
import { adapterKeys } from "../../../session/queryKeys";
import type { AdapterEntry } from "../../../types/runtime";
import type { TurnRuntime } from "../../../types/thread";

// The marker's live-name tier reads the shared adapter table cache, so the
// frame needs a QueryClient; suites that pin the silence cells leave the
// cache empty (the resolve then floors at the tombstone / raw id).
function renderFrame(
  runtime: TurnRuntime | undefined,
  invokedSkills?: string[],
  adapters?: AdapterEntry[],
) {
  const queryClient = new QueryClient();
  if (adapters) queryClient.setQueryData(adapterKeys.all(), adapters);
  return renderI18n(
    <QueryClientProvider client={queryClient}>
      <TurnExchangeFrame
        question="问"
        askedAt={0}
        invokedSkills={invokedSkills}
        runtime={runtime}
        mentionedDataset={null}
      >
        <p>轮</p>
      </TurnExchangeFrame>
    </QueryClientProvider>,
  );
}

const adapterRow = (id: string, display_name: string): AdapterEntry => ({
  id,
  display_name,
  detected: true,
  binary_path: null,
  stream_format: "acp",
});

describe("TurnExchangeFrame runtime attribution marker (issue #818)", () => {
  it("opens the assistant stream with the marker naming the adapter", () => {
    const { container } = renderFrame({
      kind: "external",
      data: { adapter_id: "claude-code" },
    });
    const stream = container.querySelector(".assistant-stream");
    expect(stream).not.toBeNull();
    // The position contract: attribution (who answers) precedes everything
    // the actor did -- activations, annotations, rounds.
    expect(stream?.firstElementChild).toHaveClass("runtime-attribution");
    expect(stream?.firstElementChild).toHaveTextContent("claude-code");
  });

  it("renders no marker for the built-in default", () => {
    const { container } = renderFrame({ kind: "built_in" });
    expect(container.querySelector(".runtime-attribution")).toBeNull();
  });

  it("renders no marker for a pre-id external runtime", () => {
    const { container } = renderFrame({ kind: "external", data: { adapter_id: null } });
    expect(container.querySelector(".runtime-attribution")).toBeNull();
  });

  it("prefers the live registry name over the persisted one (issue #1351 rename-follow)", () => {
    // Current name wins while the adapter resolves: a rename follows in
    // real time even on turns stamped under the old name.
    const { container } = renderFrame(
      { kind: "external", data: { adapter_id: "user:ba3b2de2", display_name: "Old name" } },
      undefined,
      [adapterRow("user:ba3b2de2", "Renamed CLI")],
    );
    expect(container.querySelector(".runtime-attribution")).toHaveTextContent("Renamed CLI");
  });

  it("falls back to the persisted stamp-time name when the adapter row is gone", () => {
    // Deleted or disabled adapter: the tombstone name rides the turn.
    const { container } = renderFrame({
      kind: "external",
      data: { adapter_id: "user:ba3b2de2", display_name: "My local CLI" },
    });
    expect(container.querySelector(".runtime-attribution")).toHaveTextContent("My local CLI");
  });
});

// The bubble badge face rides the frame now (ADR-0119 Decision 5): the
// settled card and the live exchange pass their own name sources, the frame
// renders one list.
describe("TurnExchangeFrame user-invocation badges (ADR-0119 Decision 5, review I3, #991)", () => {
  it("renders the names above the question", () => {
    const { getByText, getByLabelText } = renderFrame(undefined, ["sql-coach"]);
    expect(getByText("sql-coach")).toBeInTheDocument();
    // The badge list is decorative with one accessible group label.
    expect(getByLabelText("随此消息调用的技能")).toBeInTheDocument();
  });

  it("renders no badge list with an empty staging", () => {
    const { queryByLabelText } = renderFrame(undefined);
    expect(queryByLabelText("随此消息调用的技能")).not.toBeInTheDocument();
  });
});
