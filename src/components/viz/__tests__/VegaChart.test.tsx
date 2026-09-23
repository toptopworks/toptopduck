import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderI18n, withIntl } from "../../common/__tests__/helpers";
import { VegaChart } from "../VegaChart";
import embed, { type VisualizationSpec } from "vega-embed";

// Vega-Embed needs a real canvas; jsdom has none, so the render is mocked. Each
// test scripts a successful embed (finalize on unmount/spec change) or a rejected
// one (onError path) -- ADR-0033.
vi.mock("vega-embed", () => ({ default: vi.fn() }));

describe("VegaChart (ADR-0016/0033/0050)", () => {
  // VegaChart owns the embed lifecycle: it renders one decoded spec, finalizes
  // the prior view on re-embed/unmount (no canvas leak, ADR-0033), and forwards
  // a render failure via onError so ResultView can degrade honestly. The
  // ResultView viz tests above drive the same mock through ResultView; these
  // cover VegaChart's own viewRef cleanup + onError path directly.
  const barSpec = { mark: "bar" } as unknown as VisualizationSpec;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("embeds the spec and finalizes the view on unmount", async () => {
    const finalize = vi.fn();
    vi.mocked(embed).mockResolvedValue({ finalize } as unknown as Awaited<ReturnType<typeof embed>>);
    const { unmount } = renderI18n(<VegaChart spec={barSpec} onError={() => {}} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    unmount();
    await waitFor(() => expect(finalize).toHaveBeenCalledTimes(1));
  });

  it("forwards a render failure as a typed render reason via onError so the caller degrades", async () => {
    // ADR-0033: a Vega-Embed rejection routes to onError so ResultView degrades.
    // The failure is forwarded as a typed { kind: "render" } reason, unified with
    // the decode-failure path (ADR-0052 i18n closeout, issue #138); the full error
    // is log.warn'd for diagnostics (the bare "渲染出错" used to be silently
    // discarded -- silent-failure finding on PR #115, preserved at the log layer).
    vi.mocked(embed).mockRejectedValue(new Error("vega boom"));
    const onError = vi.fn();
    renderI18n(<VegaChart spec={barSpec} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledWith({ kind: "render" }));
  });

  it("finalizes the prior view when the spec changes (no leak across results)", async () => {
    const finalizeA = vi.fn();
    vi.mocked(embed).mockResolvedValue(
      { finalize: finalizeA } as unknown as Awaited<ReturnType<typeof embed>>,
    );
    const { rerender } = renderI18n(<VegaChart spec={barSpec} onError={() => {}} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    // A new spec identity re-runs the embed effect; the prior view is finalized
    // (cancelled branch if A is still pending, or overwrite-finalize if resolved).
    const lineSpec = { mark: "line" } as unknown as VisualizationSpec;
    rerender(withIntl(<VegaChart spec={lineSpec} onError={() => {}} />));
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(finalizeA).toHaveBeenCalled());
  });

  it("restores auto-tooltip in the embed config (vega-lite 6 dropped the default)", async () => {
    // vega-lite 6 no longer attaches tooltip data to marks without an explicit
    // tooltip channel; the shared config turns it back on for every chart.
    vi.mocked(embed).mockResolvedValue({ finalize: vi.fn() } as unknown as Awaited<ReturnType<typeof embed>>);
    renderI18n(<VegaChart spec={barSpec} onError={() => {}} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    const opts = vi.mocked(embed).mock.calls[0]?.[2] as {
      config: { mark?: { tooltip?: boolean } };
    };
    expect(opts.config.mark?.tooltip).toBe(true);
  });

  describe("host resize (container-width tracking, #1051)", () => {
    // jsdom has no ResizeObserver, so the component skips observing entirely.
    // Stub one the test can fire by hand with a measured host width.
    function stubResizeObserver(): (width: number) => void {
      let fire: ((width: number) => void) | null = null;
      class RO {
        constructor(cb: ResizeObserverCallback) {
          fire = (width) =>
            cb([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
        }

        observe() {}
        unobserve() {}
        disconnect() {}
      }
      vi.stubGlobal("ResizeObserver", RO);
      return (width) => fire?.(width);
    }
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function embedResultWith(view: unknown) {
      return { view, finalize: vi.fn() } as unknown as Awaited<ReturnType<typeof embed>>;
    }

    it("re-feeds the measured host width to a container-width view", async () => {
      const view = {
        signal: vi.fn(),
        runAsync: vi.fn().mockResolvedValue(undefined),
        resize: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(embed).mockResolvedValue(embedResultWith(view));
      const fire = stubResizeObserver();
      renderI18n(<VegaChart spec={barSpec} onError={() => {}} />);
      await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
      fire(283);
      await waitFor(() => expect(view.signal).toHaveBeenCalledWith("width", 283));
      await waitFor(() => expect(view.runAsync).toHaveBeenCalled());
      expect(view.resize).not.toHaveBeenCalled();
    });

    it("keeps the plain resize for a fixed-width view", async () => {
      const view = {
        signal: vi.fn(),
        runAsync: vi.fn().mockResolvedValue(undefined),
        resize: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(embed).mockResolvedValue(embedResultWith(view));
      const fire = stubResizeObserver();
      renderI18n(
        <VegaChart spec={{ mark: "bar", width: 240 } as unknown as VisualizationSpec} onError={() => {}} />,
      );
      await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
      fire(283);
      await waitFor(() => expect(view.resize).toHaveBeenCalled());
      expect(view.signal).not.toHaveBeenCalled();
    });
  });
});
