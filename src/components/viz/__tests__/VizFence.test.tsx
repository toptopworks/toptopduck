import { beforeEach, describe, expect, it, vi } from "vitest";
import { embedOk, renderI18n, withIntl } from "../../common/__tests__/helpers";
import { fireEvent, screen, waitFor } from "@testing-library/react";
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
    // vega-lite warns and drops the "container" keyword on faceted plots
    // (row/column channels or a top-level facet) -- the warning rides the
    // logger and never reaches onError -- so the default never applies.
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

  it("keeps composite concat/repeat specs at their default width", async () => {
    // Same warn-and-drop arm as facets: composite layouts have no top-level
    // mark/encoding the faceted check could key on, so they are exempted by
    // their layout keys instead of being misclassified as stretchable.
    vi.mocked(embed).mockResolvedValue(embedOk());
    const vconcat = {
      vconcat: [{ mark: "bar" }, { mark: "point" }],
      data: { values: [{ a: 1 }] },
    };
    renderI18n(<VizFence spec={JSON.stringify(vconcat)} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    expect(vi.mocked(embed).mock.calls[0]?.[1]).toEqual(vconcat);
    const repeat = {
      repeat: { field: "g" },
      spec: { mark: "bar" },
      data: { values: [{ a: 1 }] },
    };
    renderI18n(<VizFence spec={JSON.stringify(repeat)} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(2));
    expect(vi.mocked(embed).mock.calls[1]?.[1]).toEqual(repeat);
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

  it("resets the render failure on a new fence body (a fresh body gets its own try)", async () => {
    // The gate's reset axis is the fence's raw spec text (#1085): a settled
    // body revision swaps the text in place (RoundProse re-parses the prose),
    // and the fence must try the new body, not wear the old verdict. The
    // sticky rejection closes the loop twice (reset, re-embed, degrade
    // again); the rerender repeats the render's exact tree -- a bare element
    // would remount and reset on mount, masking the axis.
    vi.mocked(embed).mockRejectedValue(new Error("vega render boom"));
    const body = (mark: string) => JSON.stringify({ mark });
    const { rerender } = renderI18n(<VizFence spec={body("bar")} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByText(/图表无法渲染/)).toBeInTheDocument(),
    );
    rerender(withIntl(<VizFence spec={body("point")} />));
    // The fresh body re-embeds; the sticky rejection degrades again.
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByText(/图表无法渲染/)).toBeInTheDocument(),
    );
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
    // The theme re-embed rides the same container-width default, not the
    // raw decoded spec.
    expect(vi.mocked(embed).mock.calls[1]?.[1]).toEqual({
      mark: "bar",
      width: "container",
    });
  });
});

describe("VizFence stage link (issue #1093: the fence chart on the workspace stage)", () => {
  const BODY = JSON.stringify({ mark: "bar", data: { values: [{ a: 1 }] } });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("promotes the fence body onto the stage on a chart-body click", async () => {
    vi.mocked(embed).mockResolvedValue(embedOk());
    const onSelectViz = vi.fn();
    renderI18n(<VizFence spec={BODY} onSelectViz={onSelectViz} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    // The click carries the RAW body text -- the stage view's identity is the
    // fence's own spec, not the decoded object.
    fireEvent.click(screen.getByRole("button", { name: "在结果页查看图表" }));
    expect(onSelectViz).toHaveBeenCalledTimes(1);
    expect(onSelectViz).toHaveBeenCalledWith(BODY);
  });

  it("carries the keyboard path (Enter and Space)", async () => {
    vi.mocked(embed).mockResolvedValue(embedOk());
    const onSelectViz = vi.fn();
    renderI18n(<VizFence spec={BODY} onSelectViz={onSelectViz} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    const host = screen.getByRole("button", { name: "在结果页查看图表" });
    fireEvent.keyDown(host, { key: "Enter" });
    expect(onSelectViz).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(host, { key: " " });
    expect(onSelectViz).toHaveBeenCalledTimes(2);
  });

  it("mirrors the staged selection with aria-current", async () => {
    vi.mocked(embed).mockResolvedValue(embedOk());
    const { rerender } = renderI18n(
      withIntl(<VizFence spec={BODY} onSelectViz={vi.fn()} selected />),
    );
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    expect(
      screen.getByRole("button", { name: "在结果页查看图表" }),
    ).toHaveAttribute("aria-current", "true");
    rerender(withIntl(<VizFence spec={BODY} onSelectViz={vi.fn()} />));
    expect(
      screen.getByRole("button", { name: "在结果页查看图表" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("renders the chart inert when no stage handler is wired (the static pin)", async () => {
    // The optional-prop default (the ArtifactCard precedent): the delegation
    // dialog and the md artifact renderer mount VizFence bare -- their charts
    // are static content, so no click affordance may exist.
    vi.mocked(embed).mockResolvedValue(embedOk());
    const { container } = renderI18n(<VizFence spec={BODY} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    // The chart itself still draws (static content, not a degrade).
    expect(container.querySelector(".viz-chart")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "在结果页查看图表" }),
    ).not.toBeInTheDocument();
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
