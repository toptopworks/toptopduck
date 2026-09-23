import { beforeEach, describe, expect, it, vi } from "vitest";
import { embedOk, renderI18n } from "../../common/__tests__/helpers";
import { screen, waitFor } from "@testing-library/react";
import embed from "vega-embed";
import { THEME_CHANGE_EVENT } from "../../../theme/useTheme";
import { VizFence, VizFencePending } from "../VizFence";

// Vega-Embed needs a real canvas; jsdom has none, so the render itself is
// mocked. The fence still drives the real decode gate (viz.ts) plus the embed
// call/catch branches -- the mock lets each test script a successful embed or
// a rejected one (ADR-0033).
vi.mock("vega-embed", () => ({ default: vi.fn() }));

describe("VizFence (ADR-0120)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a legal fence body through the chart renderer", async () => {
    vi.mocked(embed).mockResolvedValue(embedOk());
    const { container } = renderI18n(
      <VizFence spec={JSON.stringify({ mark: "bar", encoding: { x: {}, y: {} } })} />,
    );
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    expect(container.querySelector(".viz-chart")).toBeInTheDocument();
    // A rendered fence chart is not a degradation (ADR-0033).
    expect(screen.queryByText(/图表无法渲染/)).not.toBeInTheDocument();
  });

  it("hands the embed the parsed fence body with the container-width default", async () => {
    // The fence is bare JSON (no wire `kind`); the chart draws exactly what
    // the agent wrote, plus the app-level presentation default: a widthless
    // spec stretches to the container instead of vega-lite's fixed step size.
    vi.mocked(embed).mockResolvedValue(embedOk());
    const body = { mark: "bar", data: { values: [{ a: 1 }] } };
    renderI18n(<VizFence spec={JSON.stringify(body)} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    expect(vi.mocked(embed).mock.calls[0]?.[1]).toEqual({
      ...body,
      width: "container",
    });
  });

  it("respects an explicit spec width (no container override)", async () => {
    vi.mocked(embed).mockResolvedValue(embedOk());
    const body = { mark: "bar", width: 240, data: { values: [{ a: 1 }] } };
    renderI18n(<VizFence spec={JSON.stringify(body)} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    expect(vi.mocked(embed).mock.calls[0]?.[1]).toEqual(body);
  });

  it("keeps row/column-faceted specs at their default width", async () => {
    // vega-lite rejects the "container" keyword on faceted plots (row/column
    // channels or a top-level facet), so the default never applies to them.
    vi.mocked(embed).mockResolvedValue(embedOk());
    const row = { mark: "bar", encoding: { row: { field: "g" } }, data: { values: [{ a: 1 }] } };
    renderI18n(<VizFence spec={JSON.stringify(row)} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    expect(vi.mocked(embed).mock.calls[0]?.[1]).toEqual(row);
    const facet = { facet: { field: "g" }, spec: { mark: "bar" }, data: { values: [{ a: 1 }] } };
    renderI18n(<VizFence spec={JSON.stringify(facet)} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(2));
    expect(vi.mocked(embed).mock.calls[1]?.[1]).toEqual(facet);
  });

  it("renders the heatmap rect mark (Decision 3)", async () => {
    vi.mocked(embed).mockResolvedValue(embedOk());
    const { container } = renderI18n(<VizFence spec={JSON.stringify({ mark: "rect" })} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    expect(container.querySelector(".viz-chart")).toBeInTheDocument();
    expect(screen.queryByText(/图表无法渲染/)).not.toBeInTheDocument();
  });

  it("degrades with a disclosure when the fence body is not valid JSON", () => {
    // A half-written or corrupt fence body never reaches Vega-Embed: the
    // decode gate rejects first and the disclosure says so (ADR-0033).
    renderI18n(<VizFence spec="{ not json" />);
    expect(screen.getByText(/图表无法渲染/)).toBeInTheDocument();
    expect(embed).not.toHaveBeenCalled();
  });

  it("degrades with a disclosure naming a non-whitelisted mark", () => {
    renderI18n(<VizFence spec={JSON.stringify({ mark: "geoshape" })} />);
    expect(screen.getByText(/图表无法渲染/)).toBeInTheDocument();
    // The engine's mark name rides the disclosure verbatim (layer 4).
    expect(screen.getByText(/geoshape/)).toBeInTheDocument();
    expect(embed).not.toHaveBeenCalled();
  });

  it("degrades with a disclosure when the embed rejects (ADR-0033)", async () => {
    vi.mocked(embed).mockRejectedValue(new Error("vega boom"));
    renderI18n(<VizFence spec={JSON.stringify({ mark: "bar" })} />);
    await waitFor(() => expect(screen.getByText(/图表无法渲染/)).toBeInTheDocument());
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("re-embeds with the fresh palette on a theme flip (ADR-0050 bridge)", async () => {
    // The fence rides the same theme bridge as the result card: a .dark flip
    // re-derives the config and re-embeds, so the chart never drifts from the
    // shell.
    vi.mocked(embed).mockResolvedValue(embedOk());
    renderI18n(<VizFence spec={JSON.stringify({ mark: "bar" })} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    window.dispatchEvent(
      new CustomEvent(THEME_CHANGE_EVENT, { detail: { effective: "dark" } }),
    );
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(2));
  });
});

describe("VizFencePending (ADR-0120 Decision 4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names the coming chart without parsing or rendering anything", () => {
    vi.mocked(embed).mockResolvedValue(embedOk());
    const { container } = renderI18n(<VizFencePending />);
    expect(screen.getByText("图表生成中…")).toBeInTheDocument();
    // No decode attempt and no chart surface while the fence streams.
    expect(embed).not.toHaveBeenCalled();
    expect(container.querySelector(".viz-chart")).toBeNull();
    // The placeholder is not a code block either -- the half-streamed source
    // never shows.
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector("code")).toBeNull();
  });
});
