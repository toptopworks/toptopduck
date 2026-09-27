import { beforeEach, describe, expect, it, vi } from "vitest";
import { embedOk, renderI18n } from "../../common/__tests__/helpers";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import embed from "vega-embed";
import { VizExportFrame } from "../VizExportFrame";

// Vega-Embed needs a real canvas; jsdom has none, so the render itself is
// mocked (the same posture as the VizFence / VegaChart suites).
vi.mock("vega-embed", () => ({ default: vi.fn() }));

// The frame still drives the real decode-handoff shape: the slot receives
// the decoded spec, the view handle rides onView, and the exporters walk
// THAT view (the same render the user sees).

// jsdom has neither blob: URL minting nor real downloads; the tests stub
// the URL registry and capture the anchor's click (the `this` inside click
// is the anchor itself, carrying href/download).
function stubDownload() {
  const created: { href: string; download: string }[] = [];
  let counter = 0;
  vi.stubGlobal("URL", Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:fake-${++counter}`),
    revokeObjectURL: vi.fn(),
  }));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    created.push({ href: this.href, download: this.download });
  });
  return created;
}

describe("VizExportFrame (issue #1093: the result card / stage export pair)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("exposes the PNG / SVG pair beside the rendered chart", async () => {
    vi.mocked(embed).mockResolvedValue(embedOk());
    renderI18n(<VizExportFrame spec={{ mark: "bar" }} onError={vi.fn()} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    // The sr-only spans carry the accessible names (the ResultActions
    // convention -- getByLabelText/getByRole stay scoped to the span).
    expect(screen.getByRole("button", { name: "下载 PNG 图表" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载 SVG 图表" })).toBeInTheDocument();
  });

  it("downloads the SVG as a blob anchor named by the spec title", async () => {
    // The fake view's toSVG stands in for the Vega serializer; the frame
    // must walk THIS view, not re-embed.
    const view = { resize: vi.fn(), toSVG: vi.fn().mockResolvedValue("<svg/>") };
    vi.mocked(embed).mockResolvedValue({
      finalize: vi.fn(),
      view,
    } as unknown as Awaited<ReturnType<typeof embed>>);
    const created = stubDownload();
    renderI18n(
      <VizExportFrame spec={{ title: "My Chart", mark: "bar" }} onError={vi.fn()} />,
    );
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "下载 SVG 图表" }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]?.download).toBe("My Chart.svg");
    expect(created[0]?.href).toMatch(/^blob:fake-/);
  });

  it("downloads the PNG through the view's canvas", async () => {
    const canvas = {
      toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(["png-bytes"], { type: "image/png" })),
    };
    const view = { resize: vi.fn(), toCanvas: vi.fn().mockResolvedValue(canvas) };
    vi.mocked(embed).mockResolvedValue({
      finalize: vi.fn(),
      view,
    } as unknown as Awaited<ReturnType<typeof embed>>);
    const created = stubDownload();
    renderI18n(<VizExportFrame spec={{ mark: "bar" }} onError={vi.fn()} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "下载 PNG 图表" }));
    await waitFor(() => expect(created).toHaveLength(1));
    // A title-less spec falls back to the catalog word.
    expect(created[0]?.download).toBe("图表.png");
  });

  it("hands the embedded view to the chart slot (one render, one export source)", async () => {
    // The view stub carries toSVG: this test CLICKS the SVG export, and the
    // exporter must walk this stub instead of re-embedding (an embedOk view
    // would leave the click an unhandled rejection).
    const view = { resize: vi.fn(), toSVG: vi.fn().mockResolvedValue("<svg/>") };
    vi.mocked(embed).mockResolvedValue({
      finalize: vi.fn(),
      view,
    } as unknown as Awaited<ReturnType<typeof embed>>);
    const created = stubDownload();
    renderI18n(<VizExportFrame spec={{ mark: "bar" }} onError={vi.fn()} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    // Exactly one embed for the frame's whole life: the exporters walk the
    // captured view, so a click must NOT trigger a second embed.
    fireEvent.click(screen.getByRole("button", { name: "下载 SVG 图表" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(embed).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
  });
});
