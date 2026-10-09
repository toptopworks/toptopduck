import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { embedOk, renderI18n, withIntl } from "../../common/__tests__/helpers";
import { VegaChart } from "../VegaChart";
import embed from "vega-embed";
import type { TopLevelSpec } from "vega-lite";
import { log } from "../../../lib/log";
import { THEME_CHANGE_EVENT } from "../../../theme/useTheme";

// Vega-Embed needs a real canvas; jsdom has none, so the render is mocked. Each
// test scripts a successful embed (finalize on unmount/spec change) or a rejected
// one (onError path) -- ADR-0033.
vi.mock("vega-embed", () => ({ default: vi.fn() }));

// The unmount-in-flight rejection tests (#1054) assert the shared log sink;
// mocking it also keeps the plugin-log IPC from firing under jsdom (issue #98).
vi.mock("../../../lib/log", () => ({
  log: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("VegaChart (ADR-0016/0033/0050)", () => {
  // VegaChart owns the embed lifecycle: it renders one decoded spec, finalizes
  // the prior view on re-embed/unmount (no canvas leak, ADR-0033), and forwards
  // a render failure via onError so ResultView can degrade honestly. The
  // ResultView viz tests above drive the same mock through ResultView; these
  // cover VegaChart's own viewRef cleanup + onError path directly.
  const barSpec = { mark: "bar" } as unknown as TopLevelSpec;

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
    // One failure, one log line -- the diagnostic must not double-fire (#1054).
    // Counted by message: the mocked sink also carries vega-theme's unrelated
    // CSS-token fallback warns (one per embed's token reads).
    const renderFailWarns = vi.mocked(log.warn).mock.calls.filter(
      ([, message]) => message === "vega-embed render failed",
    );
    expect(renderFailWarns).toHaveLength(1);
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
    const lineSpec = { mark: "line" } as unknown as TopLevelSpec;
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

  describe("unmount-in-flight rejection logging (#1054)", () => {
    // A slow-failing embed (heavy spec, canvas blowup) that rejects after the
    // component unmounts -- the enlarge overlay made close-equals-unmount a
    // regular path (#1050). The rejection must leave its diagnostic trace in
    // the log; only the onError state update stays gated so React never sees
    // a setter on a gone component.
    function deferredEmbed() {
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<Awaited<ReturnType<typeof embed>>>(
        (_, rej) => (reject = rej),
      );
      return { promise, reject };
    }

    it("logs a spec-effect rejection landing after unmount, without onError", async () => {
      const d = deferredEmbed();
      vi.mocked(embed).mockReturnValueOnce(d.promise);
      const onError = vi.fn();
      const { unmount } = renderI18n(<VegaChart spec={barSpec} onError={onError} />);
      await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
      unmount();
      d.reject(new Error("slow spec boom"));
      await waitFor(() =>
        expect(log.warn).toHaveBeenCalledWith("viz", "vega-embed render failed", expect.any(Error)),
      );
      expect(onError).not.toHaveBeenCalled();
    });

    it("logs a theme re-embed rejection landing after unmount, without onError", async () => {
      vi.mocked(embed).mockResolvedValueOnce(
        { finalize: vi.fn() } as unknown as Awaited<ReturnType<typeof embed>>,
      );
      const d = deferredEmbed();
      vi.mocked(embed).mockReturnValueOnce(d.promise);
      const onError = vi.fn();
      const { unmount } = renderI18n(<VegaChart spec={barSpec} onError={onError} />);
      await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
      window.dispatchEvent(
        new CustomEvent(THEME_CHANGE_EVENT, { detail: { effective: "dark" } }),
      );
      await waitFor(() => expect(embed).toHaveBeenCalledTimes(2));
      unmount();
      d.reject(new Error("theme re-embed boom"));
      await waitFor(() =>
        expect(log.warn).toHaveBeenCalledWith(
          "viz",
          "vega-embed theme re-embed failed",
          expect.any(Error),
        ),
      );
      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe("zero-baseline clamp (#1245: explicit non-zero y domain blows up the canvas)", () => {
    // Vega encodes a bar/area baseline as y2 = scale(0). An explicit y domain
    // excluding 0 linearly extrapolates that baseline outside the range and the
    // autosize canvas height blows up (measured 3487px for a 300px view).
    // prepareEmbed injects scale.clamp so the baseline pins to the range floor
    // -- the truncated-axis look the spec author asked for, at a sane canvas
    // size. The spec reaching embed carries the injection.
    function embedSpec(): TopLevelSpec {
      return vi.mocked(embed).mock.calls[0]?.[1] as TopLevelSpec;
    }

    const scaleOf = (spec: TopLevelSpec) =>
      (spec as { encoding?: { y?: { scale?: { clamp?: boolean } } } }).encoding?.y
        ?.scale;

    function renderSpec(spec: unknown) {
      vi.mocked(embed).mockResolvedValue(embedOk());
      renderI18n(<VegaChart spec={spec as TopLevelSpec} onError={() => {}} />);
      return waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    }

    it("injects scale.clamp for a bar with an explicit non-zero y domain", async () => {
      await renderSpec({
        mark: "bar",
        width: 560,
        encoding: { y: { type: "quantitative", scale: { domain: [3.7, 4.05] } } },
      });
      expect(scaleOf(embedSpec())?.clamp).toBe(true);
      // The numeric width normalizes to "container" on the same spec (#1245's
      // measured case carries both fields at once).
      expect((embedSpec() as { width?: unknown }).width).toBe("container");
    });

    it("normalizes a numeric width to the container", async () => {
      // A declared number freezes the chart at a size the host may not match
      // -- narrow it overflowed, wide it floats in whitespace. The host clamp
      // owns the paint either way, so the embed goes full-width and the
      // observer's re-feed chain follows resizes.
      await renderSpec({ mark: "bar", width: 240, data: { values: [{ a: 1 }] } });
      expect((embedSpec() as { width?: unknown }).width).toBe("container");
    });

    it("leaves a signal-form width untouched", async () => {
      // An expr-driven width is the spec author's own responsive rule --
      // normalizing it would overwrite a decision, not a freeze.
      const width = { expr: "bandStep('x')" };
      await renderSpec({ mark: "bar", width, data: { values: [{ a: 1 }] } });
      expect((embedSpec() as { width?: unknown }).width).toEqual(width);
    });

    it("keeps a numeric width on a composite layout (the keyword would be dropped)", async () => {
      // vega-lite warns and DROPS width "container" on composite layouts, so
      // normalizing the number there would silently discard the author's
      // width and leave the observer re-feeding a signal the compiled view
      // does not carry.
      await renderSpec({
        width: 560,
        vconcat: [{ mark: "bar" }, { mark: "line" }],
      });
      expect((embedSpec() as { width?: unknown }).width).toBe(560);
    });

    it("injects through a mark-object form", async () => {
      await renderSpec({
        mark: { type: "area" },
        encoding: { y: { type: "quantitative", scale: { domain: [10, 50] } } },
      });
      expect(scaleOf(embedSpec())?.clamp).toBe(true);
    });

    it("injects for a negative domain (zero above the domain)", async () => {
      await renderSpec({
        mark: "bar",
        encoding: { y: { scale: { domain: [-10, -1] } } },
      });
      expect(scaleOf(embedSpec())?.clamp).toBe(true);
    });

    it("leaves a domain that includes zero untouched", async () => {
      await renderSpec({
        mark: "bar",
        encoding: { y: { scale: { domain: [-1, 4.05] } } },
      });
      expect(scaleOf(embedSpec())?.clamp).toBeUndefined();
    });

    it("leaves a spec without an explicit domain untouched", async () => {
      await renderSpec({
        mark: "bar",
        encoding: { y: { type: "quantitative" } },
      });
      expect(scaleOf(embedSpec())?.clamp).toBeUndefined();
    });

    it("leaves a non-linear scale untouched (a log domain must exclude zero anyway)", async () => {
      await renderSpec({
        mark: "bar",
        encoding: { y: { scale: { type: "log", domain: [1, 100] } } },
      });
      expect(scaleOf(embedSpec())?.clamp).toBeUndefined();
    });

    it("leaves marks without a zero baseline (line) untouched", async () => {
      await renderSpec({
        mark: "line",
        encoding: { y: { type: "quantitative", scale: { domain: [3.7, 4.05] } } },
      });
      expect(scaleOf(embedSpec())?.clamp).toBeUndefined();
    });

    it("respects an explicit clamp already in the spec", async () => {
      await renderSpec({
        mark: "bar",
        encoding: { y: { scale: { domain: [3.7, 4.05], clamp: false } } },
      });
      expect(scaleOf(embedSpec())?.clamp).toBe(false);
    });

    // #1247: the gate originally read only the top-level mark + encoding, so
    // two same-mechanism gaps passed through: a bar layer inside spec.layer
    // (no top-level mark at all) and pow/sqrt scales (continuous scales that
    // extrapolate the baseline harder than linear on a tight domain --
    // measured -21.6 vs -10.6 plot heights on [3.7, 4.05]).
    const layerScaleOf = (spec: TopLevelSpec, index: number) =>
      (
        spec as {
          layer?: Array<{
            encoding?: { y?: { scale?: { clamp?: boolean } } };
          }>;
        }
      ).layer?.[index]?.encoding?.y?.scale;

    it("injects into a bar layer carrying its own explicit non-zero domain", async () => {
      await renderSpec({
        layer: [
          {
            mark: "bar",
            encoding: {
              y: { type: "quantitative", scale: { domain: [3.7, 4.05] } },
            },
          },
          {
            mark: "line",
            encoding: {
              y: { type: "quantitative", scale: { domain: [3.7, 4.05] } },
            },
          },
        ],
      });
      expect(layerScaleOf(embedSpec(), 0)?.clamp).toBe(true);
      // The line layer has no baseline to pin.
      expect(layerScaleOf(embedSpec(), 1)?.clamp).toBeUndefined();
    });

    it("injects at the top level when a bar layer inherits the shared encoding", async () => {
      // A layer without its own encoding.y takes the top-level one (vega-lite
      // encoding inheritance), so the shared y is judged against its baseline
      // layers and patched where it is declared -- the place it takes effect.
      await renderSpec({
        encoding: {
          y: { type: "quantitative", scale: { domain: [3.7, 4.05] } },
        },
        layer: [{ mark: "bar" }, { mark: "line" }],
      });
      expect(scaleOf(embedSpec())?.clamp).toBe(true);
      // The patch lands at the top only: the entries stay mark-only, no
      // per-layer y encoding is minted (the injection point IS the ruling).
      const entries = (
        embedSpec() as { layer?: Array<{ encoding?: unknown }> }
      ).layer;
      expect(entries?.[0]?.encoding).toBeUndefined();
      expect(entries?.[1]?.encoding).toBeUndefined();
    });

    it("injects at both levels when one layer owns its y and another inherits", async () => {
      // Mixed inheritance: the bar layer's own domain patches inside its
      // entry while the mark-only area layer triggers the shared top-level
      // y -- both patches land in one pass.
      await renderSpec({
        encoding: {
          y: { type: "quantitative", scale: { domain: [10, 50] } },
        },
        layer: [
          {
            mark: "bar",
            encoding: {
              y: { type: "quantitative", scale: { domain: [3.7, 4.05] } },
            },
          },
          { mark: "area" },
        ],
      });
      expect(layerScaleOf(embedSpec(), 0)?.clamp).toBe(true);
      expect(scaleOf(embedSpec())?.clamp).toBe(true);
    });

    it("leaves a layer without an explicit domain untouched", async () => {
      await renderSpec({
        layer: [{ mark: "bar", encoding: { y: { type: "quantitative" } } }],
      });
      expect(layerScaleOf(embedSpec(), 0)?.clamp).toBeUndefined();
    });

    it("leaves a layer whose domain includes zero untouched", async () => {
      await renderSpec({
        layer: [
          {
            mark: "bar",
            encoding: {
              y: { type: "quantitative", scale: { domain: [-1, 4.05] } },
            },
          },
        ],
      });
      expect(layerScaleOf(embedSpec(), 0)?.clamp).toBeUndefined();
    });

    it("keeps a malformed layer entry while injecting its valid neighbor", async () => {
      // The decode gate admits malformed JSON on purpose, so the walk hands
      // a non-record entry to vega-embed untouched instead of throwing
      // inside the effect (prepareEmbed runs outside the embed catch).
      await renderSpec({
        layer: [
          null,
          {
            mark: "bar",
            encoding: {
              y: { type: "quantitative", scale: { domain: [3.7, 4.05] } },
            },
          },
        ],
      });
      expect((embedSpec() as { layer?: unknown[] }).layer?.[0]).toBeNull();
      expect(layerScaleOf(embedSpec(), 1)?.clamp).toBe(true);
    });

    it("injects for a pow scale on an explicit non-zero domain", async () => {
      await renderSpec({
        mark: "bar",
        encoding: {
          y: {
            type: "quantitative",
            scale: { type: "pow", exponent: 2, domain: [3.7, 4.05] },
          },
        },
      });
      expect(scaleOf(embedSpec())?.clamp).toBe(true);
    });

    it("injects for a sqrt scale on an explicit non-zero domain", async () => {
      await renderSpec({
        mark: "bar",
        encoding: {
          y: {
            type: "quantitative",
            scale: { type: "sqrt", domain: [3.7, 4.05] },
          },
        },
      });
      expect(scaleOf(embedSpec())?.clamp).toBe(true);
    });

    it("leaves a symlog scale untouched (released conservatively)", async () => {
      await renderSpec({
        mark: "bar",
        encoding: {
          y: {
            type: "quantitative",
            scale: { type: "symlog", domain: [1, 100] },
          },
        },
      });
      expect(scaleOf(embedSpec())?.clamp).toBeUndefined();
    });

    // #1249: the #1247 walk descended exactly one level, so two same-mechanism
    // gaps passed through: a layer entry that is itself a layer group (vega-lite
    // admits {layer: [...]} entries, which carry no mark) and composite wrappers
    // (facet/repeat subviews, concat entries). The walk recurses through the
    // whole spec tree; a child without its own encoding.y inherits the nearest
    // declared one up the chain and the patch lands at that declaration -- the
    // place it takes effect.
    const yScaleAt = (spec: TopLevelSpec, path: (string | number)[]) =>
      path.reduce<unknown>(
        (node, key) => (node as Record<string, unknown>)[key],
        spec,
      ) as { clamp?: boolean } | undefined;

    it("injects into a bar nested inside a layer-in-layer entry", async () => {
      await renderSpec({
        layer: [
          {
            layer: [
              {
                mark: "bar",
                encoding: {
                  y: { type: "quantitative", scale: { domain: [3.7, 4.05] } },
                },
              },
            ],
          },
        ],
      });
      expect(
        yScaleAt(embedSpec(), [
          "layer",
          0,
          "layer",
          0,
          "encoding",
          "y",
          "scale",
        ])?.clamp,
      ).toBe(true);
    });

    it("injects at the group level when the nested group declares the shared encoding", async () => {
      // The group is the declaration point: its y is judged against the inner
      // baseline layers and patched there -- not at the outer top.
      await renderSpec({
        layer: [
          {
            encoding: {
              y: { type: "quantitative", scale: { domain: [3.7, 4.05] } },
            },
            layer: [{ mark: "bar" }],
          },
        ],
      });
      expect(
        yScaleAt(embedSpec(), ["layer", 0, "encoding", "y", "scale"])?.clamp,
      ).toBe(true);
      // The outer top declares nothing and mints nothing.
      expect((embedSpec() as { encoding?: unknown }).encoding).toBeUndefined();
    });

    it("injects at the top when an inner bar inherits through a nested group", async () => {
      // A nested group with no encoding of its own: the declared top-level y
      // reaches the innermost bar through vega-lite inheritance, so the patch
      // lands at that declaration -- the entries stay mark-only.
      await renderSpec({
        encoding: {
          y: { type: "quantitative", scale: { domain: [3.7, 4.05] } },
        },
        layer: [{ layer: [{ mark: "bar" }] }],
      });
      expect(scaleOf(embedSpec())?.clamp).toBe(true);
      const group = (
        embedSpec() as {
          layer?: Array<{ layer?: Array<{ encoding?: unknown }> }>;
        }
      ).layer?.[0];
      expect(group?.layer?.[0]?.encoding).toBeUndefined();
    });

    it("injects at the top through a three-level inheritance chain", async () => {
      await renderSpec({
        encoding: {
          y: { type: "quantitative", scale: { domain: [3.7, 4.05] } },
        },
        layer: [{ layer: [{ layer: [{ mark: "bar" }] }] }],
      });
      expect(scaleOf(embedSpec())?.clamp).toBe(true);
      // The declaration is the only patch point: no intermediate group and
      // no innermost entry carries its own y encoding.
      type Group = { encoding?: unknown; layer?: Group[] };
      const outer = (embedSpec() as { layer?: Group[] }).layer?.[0];
      expect(outer?.encoding).toBeUndefined();
      expect(outer?.layer?.[0]?.encoding).toBeUndefined();
      expect(outer?.layer?.[0]?.layer?.[0]?.encoding).toBeUndefined();
    });

    it.each([
      { key: "facet", layout: { field: "a", type: "nominal" } },
      { key: "repeat", layout: { row: ["a", "b"] } },
    ] as const)("injects into the $key subview", async ({ key, layout }) => {
      await renderSpec({
        [key]: layout,
        spec: {
          mark: "bar",
          encoding: {
            y: { type: "quantitative", scale: { domain: [3.7, 4.05] } },
          },
        },
      });
      // The subview rides the top-level "spec" key for both layouts.
      expect(
        yScaleAt(embedSpec(), ["spec", "encoding", "y", "scale"])?.clamp,
      ).toBe(true);
    });

    it.each(["vconcat", "hconcat", "concat"] as const)(
      "injects into a %s entry with an explicit non-zero domain",
      async (key) => {
        await renderSpec({
          [key]: [
            {
              mark: "bar",
              encoding: {
                y: { type: "quantitative", scale: { domain: [3.7, 4.05] } },
              },
            },
          ],
        });
        expect(
          yScaleAt(embedSpec(), [key, 0, "encoding", "y", "scale"])?.clamp,
        ).toBe(true);
      },
    );

    it("injects at the top when a layered view also carries a top-level mark", async () => {
      // vega-lite's normalize compiles a mark+layer pairing by the layer
      // and drops the top-level mark, so the walk judges the composite: the
      // declared top-level y reaches the bar layer and patches there.
      await renderSpec({
        mark: "line",
        encoding: {
          y: { type: "quantitative", scale: { domain: [3.7, 4.05] } },
        },
        layer: [{ mark: "bar" }],
      });
      expect(scaleOf(embedSpec())?.clamp).toBe(true);
      const entries = (embedSpec() as { layer?: Array<{ encoding?: unknown }> })
        .layer;
      expect(entries?.[0]?.encoding).toBeUndefined();
    });

    it("patches at the top when a facet wrapper carries the declared encoding", async () => {
      // Off the engine's grammar: vega-lite honors a shared encoding only
      // inside layer specs -- the facet/repeat/concat wrapper types carry
      // no encoding member. The pin holds the walk's declaration-point
      // judgment over the decode gate's arbitrary-JSON latitude.
      await renderSpec({
        facet: { field: "a", type: "nominal" },
        encoding: {
          y: { type: "quantitative", scale: { domain: [3.7, 4.05] } },
        },
        spec: { mark: "bar" },
      });
      expect(scaleOf(embedSpec())?.clamp).toBe(true);
    });

    it("patches at the top when a concat wrapper carries the declared encoding", async () => {
      // Two entries hit one shared declaration -- it patches once, at the
      // top; both entries stay mark-only. Same off-grammar shape as the
      // facet pin above: the wrapper judgment is defensive.
      await renderSpec({
        encoding: {
          y: { type: "quantitative", scale: { domain: [3.7, 4.05] } },
        },
        vconcat: [{ mark: "bar" }, { mark: "bar" }],
      });
      expect(scaleOf(embedSpec())?.clamp).toBe(true);
      const entries = (
        embedSpec() as { vconcat?: Array<{ encoding?: unknown }> }
      ).vconcat;
      expect(entries?.[0]?.encoding).toBeUndefined();
      expect(entries?.[1]?.encoding).toBeUndefined();
    });

    it("leaves nested layers without a triggering pair untouched", async () => {
      await renderSpec({
        layer: [
          {
            layer: [
              {
                mark: "line",
                encoding: {
                  y: { type: "quantitative", scale: { domain: [3.7, 4.05] } },
                },
              },
              {
                mark: "bar",
                encoding: {
                  y: { type: "quantitative", scale: { domain: [-1, 4.05] } },
                },
              },
            ],
          },
        ],
      });
      // A non-baseline mark and a baseline whose domain spans 0: neither
      // triggers, at any depth.
      expect(
        yScaleAt(embedSpec(), [
          "layer",
          0,
          "layer",
          0,
          "encoding",
          "y",
          "scale",
        ])?.clamp,
      ).toBeUndefined();
      expect(
        yScaleAt(embedSpec(), [
          "layer",
          0,
          "layer",
          1,
          "encoding",
          "y",
          "scale",
        ])?.clamp,
      ).toBeUndefined();
    });

    it("leaves concat entries without a triggering pair untouched", async () => {
      await renderSpec({
        vconcat: [
          { mark: "area", encoding: { y: { type: "quantitative" } } },
          {
            mark: "line",
            encoding: {
              y: { type: "quantitative", scale: { domain: [3.7, 4.05] } },
            },
          },
        ],
      });
      // A single-key fixture: the concat branch actually walks these
      // entries (a layer sibling would win the branch order first).
      expect(
        yScaleAt(embedSpec(), ["vconcat", 0, "encoding", "y", "scale"])?.clamp,
      ).toBeUndefined();
      // A composite wrapper around a non-baseline mark passes through too.
      expect(
        yScaleAt(embedSpec(), ["vconcat", 1, "encoding", "y", "scale"])?.clamp,
      ).toBeUndefined();
    });

    it("hands a no-hit spec through by reference", async () => {
      // The injection is structural: no hit, no rebuild -- the caller's spec
      // object is the object embed receives. width "container" takes the
      // early-return branch so the width pass cannot mint a fresh wrapper.
      const spec = {
        width: "container" as const,
        layer: [{ layer: [{ mark: "line" }] }],
      };
      await renderSpec(spec);
      expect(embedSpec()).toBe(spec);
    });

    it("hands a composite no-hit spec through by reference", async () => {
      // The concat branch rebuilds nothing either -- the no-hit contract
      // holds for composite keys the same as for nested layers.
      const spec = {
        width: "container" as const,
        vconcat: [{ mark: "line" }],
      };
      await renderSpec(spec);
      expect(embedSpec()).toBe(spec);
    });
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

    it("re-feeds a normalized numeric width through the observer (#1245)", async () => {
      // A numeric width no longer pins a fixed-width view -- prepareEmbed
      // normalizes it to "container", so the observer owns the resize just
      // like any other full-width chart.
      const view = {
        signal: vi.fn(),
        runAsync: vi.fn().mockResolvedValue(undefined),
        resize: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(embed).mockResolvedValue(embedResultWith(view));
      const fire = stubResizeObserver();
      renderI18n(
        <VegaChart spec={{ mark: "bar", width: 240 } as unknown as TopLevelSpec} onError={() => {}} />,
      );
      await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
      fire(283);
      await waitFor(() => expect(view.signal).toHaveBeenCalledWith("width", 283));
      expect(view.resize).not.toHaveBeenCalled();
    });

    it("re-feeds an explicitly container-width spec (the keyword is honored)", async () => {
      // An engine-written `width: "container"` compiles to the same
      // window:resize-only signal as the injected default, so the observer
      // must own it here too instead of filing it under fixed width.
      const view = {
        signal: vi.fn(),
        runAsync: vi.fn().mockResolvedValue(undefined),
        resize: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(embed).mockResolvedValue(embedResultWith(view));
      const fire = stubResizeObserver();
      renderI18n(
        <VegaChart spec={{ mark: "bar", width: "container" } as unknown as TopLevelSpec} onError={() => {}} />,
      );
      await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
      fire(283);
      await waitFor(() => expect(view.signal).toHaveBeenCalledWith("width", 283));
      expect(view.resize).not.toHaveBeenCalled();
    });

    it("keeps the current width signal when the host reports zero width", async () => {
      // ADR-0051 hide: the observer delivers width 0 while the pane is
      // display:none -- the guard holds the last real width instead of
      // feeding a zero in.
      const view = {
        signal: vi.fn(),
        runAsync: vi.fn().mockResolvedValue(undefined),
        resize: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(embed).mockResolvedValue(embedResultWith(view));
      const fire = stubResizeObserver();
      renderI18n(<VegaChart spec={barSpec} onError={() => {}} />);
      await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
      fire(0);
      expect(view.signal).not.toHaveBeenCalledWith("width", 0);
      expect(view.signal).not.toHaveBeenCalled();
    });

    it("keeps the plain resize for a keeps-default-width view (#1245)", async () => {
      // A faceted spec keeps vega's default per-band width (a numeric width
      // stays declared on it too), so the observer takes the plain resize
      // reflow -- not the width-signal re-feed a container view needs.
      const view = {
        signal: vi.fn(),
        runAsync: vi.fn().mockResolvedValue(undefined),
        resize: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(embed).mockResolvedValue(embedResultWith(view));
      const fire = stubResizeObserver();
      renderI18n(
        <VegaChart
          spec={
            {
              mark: "bar",
              width: 560,
              encoding: { row: { field: "g", type: "nominal" } },
            } as unknown as TopLevelSpec
          }
          onError={() => {}}
        />,
      );
      await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
      // The declared number survives on the faceted spec (same ruling as the
      // composite-layout case in the clamp describe above).
      expect(
        (vi.mocked(embed).mock.calls[0]?.[1] as { width?: unknown }).width,
      ).toBe(560);
      fire(283);
      await waitFor(() => expect(view.resize).toHaveBeenCalled());
      expect(view.signal).not.toHaveBeenCalled();
    });
  });
});

describe("VegaChart onView (issue #1093: the export's view handle)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hands the embedded view to onView once the embed resolves", async () => {
    const result = embedOk();
    vi.mocked(embed).mockResolvedValue(result);
    const onView = vi.fn();
    renderI18n(
      <VegaChart
        spec={{ mark: "bar", data: { values: [{ a: 1 }] } } as TopLevelSpec}
        onError={vi.fn()}
        onView={onView}
      />,
    );
    await waitFor(() =>
      expect(onView).toHaveBeenCalledWith(
        (result as unknown as { view: unknown }).view,
      ),
    );
  });

  it("clears onView on unmount (no export through a dead view)", async () => {
    vi.mocked(embed).mockResolvedValue(embedOk());
    const onView = vi.fn();
    const { unmount } = renderI18n(
      <VegaChart
        spec={{ mark: "bar", data: { values: [{ a: 1 }] } } as TopLevelSpec}
        onError={vi.fn()}
        onView={onView}
      />,
    );
    await waitFor(() => expect(onView).toHaveBeenCalledTimes(1));
    unmount();
    await waitFor(() => expect(onView).toHaveBeenLastCalledWith(null));
  });
});
