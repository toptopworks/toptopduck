import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import embed from "vega-embed";
import { embedOk, renderI18n, withIntl } from "../../common/__tests__/helpers";
import { VizEnlargeDialog } from "../VizEnlargeDialog";

// The chart enlarge view (#1050, ADR-0120 tail): every
// in-stream chart surface (the vega-lite fence and the result card) mounts
// this shared affordance on its rendered chart. Vega-Embed is mocked like the
// other chart suites (jsdom has no canvas); the dialog still drives the real
// VizChartSlot path -- same decoded spec re-embedded, same degradation
// disclosure on rejection, no new render path.

vi.mock("vega-embed", () => ({ default: vi.fn() }));

const SPEC = { mark: "bar", data: { values: [{ a: 1 }] } };

describe("VizEnlargeDialog (#1050)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the hover-revealed affordance named through the catalog", () => {
    vi.mocked(embed).mockResolvedValue(embedOk());
    renderI18n(<VizEnlargeDialog spec={SPEC} />);
    // The trigger is an explicit button, not a chart-body click: a canvas
    // carries no role or name, the button carries both. Visibility is pure
    // styling (opacity through the adjacent-sibling variant on the chart
    // host plus the button's own hover/focus-visible) and stays in the tab
    // order and the a11y tree either way.
    expect(
      screen.getByRole("button", { name: "放大查看图表" }),
    ).toBeInTheDocument();
  });

  it("opens the overlay dialog and re-embeds the same spec", async () => {
    vi.mocked(embed).mockResolvedValue(embedOk());
    renderI18n(<VizEnlargeDialog spec={SPEC} />);
    // Closed by default: no dialog, and no second embed of the spec.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(embed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "放大查看图表" }));
    // The sr-only title still names the dialog for assistive tech.
    expect(
      screen.getByRole("dialog", { name: "图表放大查看" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    // The re-embed rides the same container-width default the in-stream chart
    // applies -- one decoded spec, two embeds of it, no separate renderer.
    expect(vi.mocked(embed).mock.calls[0]?.[1]).toEqual({
      ...SPEC,
      width: "container",
    });
  });

  it("steers initial focus to the scroll container, not the close button", async () => {
    vi.mocked(embed).mockResolvedValue(embedOk());
    renderI18n(<VizEnlargeDialog spec={SPEC} />);
    fireEvent.click(screen.getByRole("button", { name: "放大查看图表" }));
    const dialog = screen.getByRole("dialog", { name: "图表放大查看" });
    const scroller = dialog.querySelector("div[tabindex=\"-1\"]");
    // The steering is this module's own logic: without it the default focus
    // lights the close button's ring, and a lost ref would drop focus
    // outside the dialog entirely. (The keyboard open arm itself is not
    // pinnable here: DialogTrigger rides the native button Enter->click
    // default, which fireEvent does not synthesize in jsdom.)
    await waitFor(() => expect(scroller).toHaveFocus());
    expect(screen.getByRole("button", { name: "Close" })).not.toHaveFocus();
  });

  it("degrades with the honest disclosure when the re-embed rejects", async () => {
    vi.mocked(embed).mockRejectedValue(new Error("vega boom"));
    renderI18n(<VizEnlargeDialog spec={SPEC} />);
    fireEvent.click(screen.getByRole("button", { name: "放大查看图表" }));
    await waitFor(() =>
      expect(screen.getByText(/图表无法渲染/)).toBeInTheDocument(),
    );
  });

  it("gives a rejected re-embed a fresh try after closing and reopening", async () => {
    vi.mocked(embed)
      .mockRejectedValueOnce(new Error("vega boom"))
      .mockResolvedValueOnce(embedOk());
    renderI18n(<VizEnlargeDialog spec={SPEC} />);
    fireEvent.click(screen.getByRole("button", { name: "放大查看图表" }));
    await waitFor(() =>
      expect(screen.getByText(/图表无法渲染/)).toBeInTheDocument(),
    );
    // Closing (the built-in X) unmounts the dialog body, so its failure
    // state dies with it; a reopen re-embeds from scratch.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByText(/图表无法渲染/)).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "放大查看图表" }));
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/图表无法渲染/)).not.toBeInTheDocument();
  });

  it("resets a landed failure in place when the spec changes while open", async () => {
    // A re-run under the same reference name swaps decoded.spec's identity
    // (#1085); with the overlay open, the gate clears the landed failure in
    // place -- the new body gets its own try without a close/reopen. The
    // close/reopen axis is the unmount reset's own test above; this pins the
    // identity-reset axis a bare-useState fallback would lose. The rerender
    // repeats the render's exact tree so the dialog stays mounted and open.
    vi.mocked(embed)
      .mockRejectedValueOnce(new Error("vega boom"))
      .mockResolvedValueOnce(embedOk());
    const { rerender } = renderI18n(
      <VizEnlargeDialog spec={{ mark: "bar" }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "放大查看图表" }));
    await waitFor(() =>
      expect(screen.getByText(/图表无法渲染/)).toBeInTheDocument(),
    );
    rerender(
      withIntl(<VizEnlargeDialog spec={{ mark: "point" }} />),
    );
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/图表无法渲染/)).not.toBeInTheDocument();
  });

  it("names the control through a tooltip on hover", async () => {
    vi.mocked(embed).mockResolvedValue(embedOk());
    renderI18n(<VizEnlargeDialog spec={SPEC} />);
    fireEvent.pointerMove(screen.getByRole("button", { name: "放大查看图表" }));
    await waitFor(() =>
      expect(screen.getByText("放大查看图表")).toBeInTheDocument(),
    );
  });

  it("does not pop the tooltip after the dialog closes", async () => {
    // The close path restores focus to the trigger (Radix's
    // onCloseAutoFocus), and the tooltip's internal onFocus opens on
    // programmatic focus too -- unguarded, the tooltip would pop right
    // after every close. The just-closed guard must eat exactly that one
    // open request.
    vi.mocked(embed).mockResolvedValue(embedOk());
    renderI18n(<VizEnlargeDialog spec={SPEC} />);
    fireEvent.click(screen.getByRole("button", { name: "放大查看图表" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("放大查看图表")).not.toBeInTheDocument();
    // A real hover afterwards still opens the tooltip (the pointer path
    // needs a fresh pointermove, and the guard is gone by then).
    fireEvent.pointerMove(screen.getByRole("button", { name: "放大查看图表" }));
    await waitFor(() =>
      expect(screen.getByText("放大查看图表")).toBeInTheDocument(),
    );
  });
});
