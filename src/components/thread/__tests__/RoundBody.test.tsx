// The round skeleton's own pin (issue #1157): the max-w-full cap that keeps
// a nowrap summary truncating instead of stretching the card (issue #826),
// pinned once here instead of per-side on TurnCard / LiveTurnExchange (the
// twin tests retired with the swap).

import { describe, expect, it } from "vitest";
import { renderI18n } from "../../common/__tests__/helpers";
import { RoundBody } from "../RoundBody";

describe("RoundBody trace round width cap (issue #826)", () => {
  it("caps the round at the stream width so summaries can truncate", () => {
    // The round rides the assistant stream as a non-stretched flex item; the
    // max-w-full cap keeps a nowrap summary from stretching the round past
    // the card (the layout breaker -- the row's truncate only engages when
    // the round stops at the stream width).
    const { container } = renderI18n(<RoundBody text="答轮">{false}</RoundBody>);
    expect(container.querySelector(".trace-round")).toHaveClass("max-w-full");
  });
});
