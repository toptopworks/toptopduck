import { useEffect, useRef } from "react";
import { useIntl } from "react-intl";
import embed, { type VisualizationSpec } from "vega-embed";
import type { Result } from "vega-embed";

import { log } from "../../lib/log";
import {
  buildVegaTheme,
  onThemeChange,
  type VegaThemeConfig,
} from "../../theme/vega-theme";
import type { VizFailureReason } from "./viz";

// Vega-Lite chart renderer (ADR-0016/0033/0050). Owns three concerns that the
// old inline ResultView logic did not:
//  1. CSS-var theme bridge (ADR-0050 Q12): the Vega config is derived at runtime
//     from the same shadcn tokens the shell uses, rebuilt on each theme-change
//     event so the chart flips with the .dark class.
//  2. resize-on-unhide (ADR-0051 hidden-pane): a ResizeObserver calls
//     view.resize() when the container goes from 0 -> nonzero size (pane unhide)
//     so a chart rendered while hidden measures correctly once shown.
//  3. finalize-on-unmount: every embed result is finalized so no Vega view /
//     canvas leaks across result or theme switches.
//  4. interactive defaults (vega-lite 6): vega-lite 6 dropped v5's default
//     auto-tooltip and default-size charts at a fixed ~20px ordinal step, so
//     the embed config restores the tooltip and widthless specs stretch to
//     the container.
//
// The decode + whitelist gate (viz.ts) and the degradation disclosure
// (ADR-0033) live in the callers (the result card's ResultView and the prose
// fence's VizFence); this component renders ONE already-decoded spec and
// reports a render failure via onError so the caller can swap in its own
// degradation -- the table swap on the result card, a bare disclosure under a
// fence. A try/catch here stays internal (ADR-0058 L0) -- the ErrorBoundary
// (L2) is never reached over a Vega failure.

/** Map the derived token config onto a Vega-Lite config object. Single-series
 * marks paint in the teal --primary; multi-series marks draw from the Okabe-Ito
 * category range; axes/grid/legend follow the shell tokens. */
function vegaConfig(theme: VegaThemeConfig): object {
  return {
    background: theme.background,
    // vega-lite 6 no longer emits tooltip data for specs without an explicit
    // tooltip channel (v5's auto-tooltip default), which leaves every engine-
    // produced chart inert under hover. Restore it config-wide -- the embed's
    // default tooltip handler is already attached and only lacked data.
    mark: { tooltip: true },
    // Single-series default mark color = teal primary (ADR-0050).
    arc: { fill: theme.primary },
    area: { fill: theme.primary },
    bar: { fill: theme.primary },
    line: { stroke: theme.primary },
    point: { fill: theme.primary },
    rect: { fill: theme.primary },
    shape: { fill: theme.primary },
    symbol: { fill: theme.primary },
    axis: {
      domainColor: theme.domain,
      gridColor: theme.grid,
      tickColor: theme.domain,
      labelColor: theme.text,
      titleColor: theme.text,
    },
    legend: {
      labelColor: theme.text,
      titleColor: theme.text,
    },
    title: { color: theme.text },
    // Multi-series category range (ADR-0050 Okabe-Ito).
    range: { category: theme.category },
  };
}

/** Prepare one spec for embedding: the spec to pass (widthless ones stretch
 * to the container instead of vega-lite's fixed per-band step) plus whether
 * the embedded view is container-width, so the resize observer and the embed
 * call read the same decision from one place. Faceted specs (row/column
 * channels or a top-level facet) keep their default width -- vega-lite
 * rejects the "container" keyword there. */
function prepareEmbed(spec: VisualizationSpec): {
  spec: VisualizationSpec;
  containerWidth: boolean;
} {
  const faceted =
    ((): boolean => {
      if ("width" in spec) return true;
      const encoding = (spec as { encoding?: Record<string, unknown> }).encoding;
      return Boolean(
        encoding && ("row" in encoding || "column" in encoding),
      ) || "facet" in spec;
    })();
  if (faceted) return { spec, containerWidth: false };
  // vega-embed 7 types VisualizationSpec as vega's Spec (width: number |
  // SignalRef), but the actual compiler here is vega-lite, whose top-level
  // width also accepts the "container" keyword.
  return {
    spec: { ...spec, width: "container" } as VisualizationSpec,
    containerWidth: true,
  };
}

interface VegaChartProps {
  spec: VisualizationSpec;
  /** Fired when Vega-Embed rejects (render failure). The caller swaps in the
   * degradation disclosure (ADR-0033). Carries a typed `{ kind: "render" }`
   * reason so the disclosure renders via the same catalog path as a decode
   * failure (ADR-0052 i18n closeout, issue #138). Stable identity keeps the
   * embed effect from re-running; a useState setter is naturally stable. */
  onError: (reason: VizFailureReason) => void;
}

export function VegaChart({ spec, onError }: VegaChartProps) {
  const intl = useIntl();
  const containerRef = useRef<HTMLDivElement>(null);
  // The most recent embed result; finalized on re-embed / unmount / theme swap.
  const viewRef = useRef<Result | null>(null);
  // Whether the embedded spec is a container-width one (prepareEmbed decided
  // it). The resize observer branches on this: a container view's width
  // signal only re-evaluates on window:resize, so flex-driven host changes
  // must be re-fed by hand; a fixed-width view only needs the plain resize.
  const isContainerWidthRef = useRef(false);
  // Keep the latest spec + onError reachable from the long-lived theme listener
  // without re-subscribing on every identity change. Written in an effect (not
  // during render) so the ref-update does not trip the react-hooks rule.
  const specRef = useRef(spec);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    specRef.current = spec;
    onErrorRef.current = onError;
  });

  // Embed (or re-embed) the spec, deriving the config from the live tokens.
  // Re-runs when the spec changes (a new result/viz). A render failure routes
  // to onError so the caller degrades honestly (ADR-0033).
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    let cancelled = false;
    const prepared = prepareEmbed(spec);
    isContainerWidthRef.current = prepared.containerWidth;
    const theme = buildVegaTheme();
    embed(node, prepared.spec, { actions: false, config: vegaConfig(theme) })
      .then((result) => {
        if (cancelled) {
          result.finalize();
          return;
        }
        viewRef.current?.finalize();
        viewRef.current = result;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Log the full error for diagnostics (ADR-0029): the disclosure only
        // carries a typed { kind: "render" } reason (ADR-0052 i18n closeout), so
        // the engine detail that distinguishes a bad spec from a canvas/WebGL
        // failure lives here in the log, not in the user-facing banner.
        log.warn("viz", "vega-embed render failed", err);
        onErrorRef.current({ kind: "render" });
      });
    return () => {
      cancelled = true;
      viewRef.current?.finalize();
      viewRef.current = null;
    };
  }, [spec]);

  // Theme bridge (ADR-0050 Q12): rebuild the config when the effective appearance
  // flips (.dark class toggled by useTheme). The old view is finalized and a new
  // one embedded with the fresh palette. Subscribed once for the component's
  // life; spec/onError are read through refs so the listener never goes stale.
  // An `unmounted` flag mirrors the spec effect's `cancelled` guard: a theme-
  // triggered embed that resolves after unmount finalizes its orphan result
  // instead of leaking, and a rejection after unmount skips the setter so React
  // never sees a state update on a gone component.
  useEffect(() => {
    let unmounted = false;
    const unsubscribe = onThemeChange(() => {
      const node = containerRef.current;
      if (!node) return;
      const prepared = prepareEmbed(specRef.current);
      isContainerWidthRef.current = prepared.containerWidth;
      const theme = buildVegaTheme();
      embed(node, prepared.spec, { actions: false, config: vegaConfig(theme) })
        .then((result) => {
          if (unmounted) {
            result.finalize();
            return;
          }
          viewRef.current?.finalize();
          viewRef.current = result;
        })
        .catch((err: unknown) => {
          if (unmounted) return;
          log.warn("viz", "vega-embed theme re-embed failed", err);
          onErrorRef.current({ kind: "render" });
        });
    });
    return () => {
      unmounted = true;
      unsubscribe();
    };
  }, []);

  // Resize tracking (ADR-0051 + container-width): when the host changes size
  // (pane unhide, workspace fold/unfold, window resize), a container-width
  // view needs its width signal re-fed -- vega-lite compiles that signal to
  // re-evaluate only on window:resize, which a flex fold/unfold never fires.
  // Setting it to the measured host width (the same containerSize() value the
  // compiled update reads) and running the view recomputes the layout. A
  // fixed-width view keeps the plain resize (see the branch below).
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    if (typeof ResizeObserver === "undefined") return; // jsdom
    const ro = new ResizeObserver((entries) => {
      const view = viewRef.current?.view;
      if (!view) return;
      if (isContainerWidthRef.current) {
        const width = entries[0]?.contentRect.width ?? node.clientWidth;
        if (width > 0) view.signal("width", width);
        void view.runAsync();
      } else {
        // A fixed-width view keeps the plain resize: runAsync() re-renders
        // but skips the layout recompute the unhide path relied on.
        void view.resize();
      }
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className="viz-chart"
      aria-label={intl.formatMessage({ id: "viz.chartLabel", defaultMessage: "Chart" })}
    />
  );
}
