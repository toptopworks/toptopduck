import { useEffect, useRef } from "react";
import { useIntl } from "react-intl";
import embed, { type VisualizationSpec } from "vega-embed";
import type { Result } from "vega-embed";

import { log } from "../lib/log";
import {
  buildVegaTheme,
  onThemeChange,
  type VegaThemeConfig,
} from "../theme/vega-theme";
import type { VizFailureReason } from "../viz";

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
//
// The decode + whitelist gate (viz.ts) and the degrade-to-table disclosure
// (ADR-0033) live in the caller (ResultView); this component renders ONE
// already-decoded spec and reports a render failure via onError so the caller
// can swap in the degradation. A try/catch here stays internal (ADR-0058 L0) --
// the ErrorBoundary (L2) is never reached over a Vega failure.

/** Map the derived token config onto a Vega-Lite config object. Single-series
 * marks paint in the teal --primary; multi-series marks draw from the Okabe-Ito
 * category range; axes/grid/legend follow the shell tokens. */
function vegaConfig(theme: VegaThemeConfig): object {
  return {
    background: theme.background,
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
    const theme = buildVegaTheme();
    embed(node, spec, { actions: false, config: vegaConfig(theme) })
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
      const theme = buildVegaTheme();
      embed(node, specRef.current, { actions: false, config: vegaConfig(theme) })
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

  // Resize-on-unhide (ADR-0051): when the pane comes back from display:none,
  // the container reports a nonzero size again and the observer fires --
  // view.resize() recomputes the layout so the chart measures correctly.
  // Observed for the component's life; harmless on visible panes (resize is
  // cheap and idempotent).
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    if (typeof ResizeObserver === "undefined") return; // jsdom
    const ro = new ResizeObserver(() => {
      void viewRef.current?.view.resize();
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
