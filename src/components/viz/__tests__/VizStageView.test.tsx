import { beforeEach, describe, expect, it, vi } from "vitest";
import { embedOk, renderI18n } from "../../common/__tests__/helpers";
import { screen, waitFor } from "@testing-library/react";
import embed from "vega-embed";
import { VizStageView } from "../VizStageView";

// Vega-Embed needs a real canvas; jsdom has none, so the render itself is
// mocked (the same posture as the VizFence / VegaChart suites).
vi.mock("vega-embed", () => ({ default: vi.fn() }));

describe("VizStageView (issue #1093: the fence chart on the stage)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the staged chart through the export-bearing frame", async () => {
    vi.mocked(embed).mockResolvedValue(embedOk());
    renderI18n(<VizStageView spec={JSON.stringify({ mark: "bar" })} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    // The viz view is the chart plus its export anchor -- the stage's
    // export surface (the in-stream fence carries no export).
    expect(screen.getByRole("button", { name: "下载图表" })).toBeInTheDocument();
  });

  it("discloses a staged body that fails to decode (no empty pane)", () => {
    renderI18n(<VizStageView spec="{ not json" />);
    expect(screen.getByText(/图表无法渲染/)).toBeInTheDocument();
    expect(embed).not.toHaveBeenCalled();
  });

  it("discloses a staged body that fails to render", async () => {
    vi.mocked(embed).mockRejectedValue(new Error("vega boom"));
    renderI18n(<VizStageView spec={JSON.stringify({ mark: "bar" })} />);
    await waitFor(() =>
      expect(screen.getByText(/图表无法渲染/)).toBeInTheDocument(),
    );
  });
});
