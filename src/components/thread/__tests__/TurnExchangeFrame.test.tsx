// The frame's own contract pins (issue #1157): the runtime attribution
// marker's first-child position + silence matrix and the invocation-badge
// face, pinned once here instead of per-side on TurnCard / LiveTurnExchange
// (the twin tests retired with the swap). The visibility matrix itself lives
// in turnVisual.test.ts (runtimeMarkerName).

import { describe, expect, it } from "vitest";
import { renderI18n } from "../../common/__tests__/helpers";
import { TurnExchangeFrame } from "../TurnExchangeFrame";
import type { TurnRuntime } from "../../../types/thread";

function renderFrame(runtime: TurnRuntime | undefined, invokedSkills?: string[]) {
  return renderI18n(
    <TurnExchangeFrame
      question="问"
      askedAt={0}
      invokedSkills={invokedSkills}
      runtime={runtime}
      mentionedDataset={null}
    >
      <p>轮</p>
    </TurnExchangeFrame>,
  );
}

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
