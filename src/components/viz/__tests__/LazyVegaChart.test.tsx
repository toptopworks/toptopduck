import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderI18n } from "../../common/__tests__/helpers";
import { VizChartSlot } from "../LazyVegaChart";

// A throwing factory makes the lazy door's dynamic import reject -- the
// chunk-load failure this module's boundary exists to scope. VegaChart itself
// routes its failures through onError instead of throwing, so this is the one
// render throw the slot can produce.
vi.mock("../VegaChart", () => {
  throw new Error("chunk failed to load");
});

describe("VizChartSlot chunk-load failure (ADR-0058 element-level scoping)", () => {
  it("degrades one chart to the load disclosure instead of bubbling", async () => {
    const onError = vi.fn();
    renderI18n(<VizChartSlot spec={{ mark: "bar" }} onError={onError} />);
    // The rejection propagates through the lazy door on a microtask, so the
    // boundary's swap lands on the waitFor tick. The zh catalog value (the
    // suites render under zh-CN): the disclosure says the chart could not
    // load, in the active locale.
    await waitFor(() =>
      expect(screen.getByText(/图表无法加载/)).toBeInTheDocument(),
    );
    // The render-failure channel stays untouched: a load failure is not a
    // Vega render failure, so no typed reason is reported to the caller.
    expect(onError).not.toHaveBeenCalled();
  });
});
