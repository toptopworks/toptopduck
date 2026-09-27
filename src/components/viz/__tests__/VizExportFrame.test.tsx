import { beforeEach, describe, expect, it, vi } from "vitest";
import { embedOk, renderI18n } from "../../common/__tests__/helpers";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import embed from "vega-embed";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeExportFile } from "../../../api";
import { VizExportFrame } from "../VizExportFrame";

// Vega-Embed needs a real canvas; jsdom has none, so the render itself is
// mocked (the same posture as the VizFence / VegaChart suites).
vi.mock("vega-embed", () => ({ default: vi.fn() }));

// The export lane's two external doors: the native save dialog and the Rust
// write command (the ResultActions export-test precedent).
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("../../../api", () => ({ writeExportFile: vi.fn() }));

// The frame still drives the real decode-handoff shape: the slot receives
// the decoded spec, the view handle rides onView, and the exporters walk
// THAT view (the same render the user sees).

/** Opens the export dropdown (pointerDown on the trigger, Radix's open
 *  gesture -- the ui dropdown-menu suite's helper). */
async function openExportMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "下载图表" }), {
    button: 0,
    pointerType: "mouse",
  });
  await screen.findByRole("menu");
}

/** Fires the select gesture on a Radix menu item (pointerUp + click). */
function activateItem(item: HTMLElement) {
  fireEvent.pointerUp(item, { button: 0, pointerType: "mouse" });
  fireEvent.click(item);
}

describe("VizExportFrame (issue #1093: the result card / stage export anchor)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(saveDialog).mockResolvedValue("C:/out/chart.png");
  });

  it("exposes one export anchor whose dropdown names both formats", async () => {
    vi.mocked(embed).mockResolvedValue(embedOk());
    renderI18n(<VizExportFrame spec={{ mark: "bar" }} onError={vi.fn()} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    // The sr-only span carries the anchor's accessible name (the
    // ResultActions convention -- getByRole stays scoped to the span).
    expect(screen.getByRole("button", { name: "下载图表" })).toBeInTheDocument();
    await openExportMenu();
    expect(screen.getByRole("menuitem", { name: "下载 PNG 图表" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "下载 SVG 图表" })).toBeInTheDocument();
  });

  it("saves the SVG to the save-dialog destination named by the spec title", async () => {
    // The fake view's toSVG stands in for the Vega serializer; the frame
    // must walk THIS view, not re-embed.
    const view = { resize: vi.fn(), toSVG: vi.fn().mockResolvedValue("<svg/>") };
    vi.mocked(embed).mockResolvedValue({
      finalize: vi.fn(),
      view,
    } as unknown as Awaited<ReturnType<typeof embed>>);
    vi.mocked(saveDialog).mockResolvedValue("C:/out/My Chart.svg");
    renderI18n(
      <VizExportFrame spec={{ title: "My Chart", mark: "bar" }} onError={vi.fn()} />,
    );
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    await openExportMenu();
    activateItem(screen.getByRole("menuitem", { name: "下载 SVG 图表" }));
    await waitFor(() => expect(writeExportFile).toHaveBeenCalledTimes(1));
    expect(saveDialog).toHaveBeenCalledWith({
      defaultPath: "My Chart.svg",
      filters: [{ name: "SVG", extensions: ["svg"] }],
    });
    // Content-level compare: the frame's bytes come off a jsdom-realm Blob,
    // so a cross-realm Uint8Array fails toHaveBeenCalledWith's constructor
    // check even when identical.
    const [svgPath, svgBytes] = vi.mocked(writeExportFile).mock.calls[0]!;
    expect(svgPath).toBe("C:/out/My Chart.svg");
    expect(Array.from(svgBytes)).toEqual(Array.from(new TextEncoder().encode("<svg/>")));
  });

  it("saves the PNG through the view's canvas", async () => {
    const canvas = {
      toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(["png-bytes"], { type: "image/png" })),
    };
    const view = { resize: vi.fn(), toCanvas: vi.fn().mockResolvedValue(canvas) };
    vi.mocked(embed).mockResolvedValue({
      finalize: vi.fn(),
      view,
    } as unknown as Awaited<ReturnType<typeof embed>>);
    renderI18n(<VizExportFrame spec={{ mark: "bar" }} onError={vi.fn()} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    await openExportMenu();
    activateItem(screen.getByRole("menuitem", { name: "下载 PNG 图表" }));
    await waitFor(() => expect(writeExportFile).toHaveBeenCalledTimes(1));
    // A title-less spec falls back to the catalog word.
    expect(saveDialog).toHaveBeenCalledWith({
      defaultPath: "图表.png",
      filters: [{ name: "PNG", extensions: ["png"] }],
    });
    const [pngPath, pngBytes] = vi.mocked(writeExportFile).mock.calls[0]!;
    expect(pngPath).toBe("C:/out/chart.png");
    expect(Array.from(pngBytes)).toEqual(Array.from(new TextEncoder().encode("png-bytes")));
  });

  it("hands the embedded view to the chart slot (one render, one export source)", async () => {
    // The view stub carries toSVG: this test exports the SVG, and the
    // exporter must walk this stub instead of re-embedding (an embedOk view
    // would leave the click an unhandled rejection).
    const view = { resize: vi.fn(), toSVG: vi.fn().mockResolvedValue("<svg/>") };
    vi.mocked(embed).mockResolvedValue({
      finalize: vi.fn(),
      view,
    } as unknown as Awaited<ReturnType<typeof embed>>);
    renderI18n(<VizExportFrame spec={{ mark: "bar" }} onError={vi.fn()} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    // Exactly one embed for the frame's whole life: the exporters walk the
    // captured view, so an export must NOT trigger a second embed.
    await openExportMenu();
    activateItem(screen.getByRole("menuitem", { name: "下载 SVG 图表" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(embed).toHaveBeenCalledTimes(1);
    expect(writeExportFile).toHaveBeenCalledTimes(1);
  });

  it("treats a cancelled save dialog as a quiet no-op", async () => {
    // The exportRowsCsv cancel contract: no write, no error surface.
    const view = { resize: vi.fn(), toSVG: vi.fn().mockResolvedValue("<svg/>") };
    vi.mocked(embed).mockResolvedValue({
      finalize: vi.fn(),
      view,
    } as unknown as Awaited<ReturnType<typeof embed>>);
    vi.mocked(saveDialog).mockResolvedValue(null);
    renderI18n(<VizExportFrame spec={{ mark: "bar" }} onError={vi.fn()} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    await openExportMenu();
    activateItem(screen.getByRole("menuitem", { name: "下载 SVG 图表" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(writeExportFile).not.toHaveBeenCalled();
  });
});
