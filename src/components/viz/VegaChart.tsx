import { useEffect, useRef } from "react";
import { useIntl } from "react-intl";
import embed from "vega-embed";
import type { Result } from "vega-embed";
import type { TopLevelSpec } from "vega-lite";

import { log } from "../../lib/log";
import {
  buildVegaTheme,
  onThemeChange,
  type VegaThemeConfig,
} from "../../theme/vega-theme";
import { markTypeName } from "./viz";
import type { VizFailureReason } from "./viz";

// Vega-Lite chart renderer (ADR-0016/0033/0050). Owns three concerns that the
// old inline ResultView logic did not:
//  1. CSS-var theme bridge (ADR-0050 Q12): the Vega config is derived at runtime
//     from the same shadcn tokens the shell uses, rebuilt on each theme-change
//     event so the chart flips with the .dark class.
//  2. resize tracking (ADR-0051 hidden-pane + container-width): a
//     ResizeObserver follows the host's size -- a container-width view gets
//     its width signal re-fed (vega-lite re-evaluates it on window:resize
//     only, which a flex fold/unfold never fires), while a fixed-width view
//     takes the plain view.resize() reflow so a chart rendered while hidden
//     measures correctly once shown.
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

/** The slice of one measure encoding (x or y) the zero-baseline clamp
 * decision reads and patches -- kept structural (like DecodedVizSpec) so the
 * decision works on a top-level encoding and a layer entry's encoding alike. */
type ClampableChannel = {
  type?: unknown;
  scale?: { type?: unknown; domain?: unknown; clamp?: unknown };
};

/** The judged channels; the array is the single source of truth the type
 * derives from, so neither can drift from the other. */
const CHANNELS = ["x", "y"] as const;
type Channel = (typeof CHANNELS)[number];

/** An encoding's measure-channel members: a channel slice, or an explicit
 * null -- vega-lite's channel-disable form, declared but inert. */
type ClampableEncoding = Partial<Record<Channel, ClampableChannel | null>>;

/** A measure encoding whose scale object has passed the guard -- the shape
 * the decision hands back for patching. */
type ClampTarget = ClampableChannel & {
  scale: NonNullable<ClampableChannel["scale"]>;
};

/** The hits one walk hop reports up, keyed by the channel that hit. */
type ClampHits = Partial<Record<Channel, ClampTarget>>;

/** The zero-baseline clamp decision for one candidate view (a top-level
 * single view, or one layer entry): the measure encoding needing
 * `scale.clamp: true`, or null when this mark+encoding pair passes through
 * untouched. Vega draws a bar/area baseline at the measure axis' scale(0)
 * -- y2 on a vertical bar, x2 on a horizontal one (#1257); an explicit
 * domain excluding 0 makes a continuous scale extrapolate that baseline
 * outside the range (0 -> plotHeight * domainMin / span, measured -3171px),
 * which blows the autosize canvas up while the in-range render segment
 * happens to look fine (#1245). The extrapolation is a property of any
 * continuous, invertible-at-0 scale, so linear, pow, and sqrt all trigger
 * (#1247 -- on a tight domain sqrt extrapolates harder than linear,
 * measured -21.6 vs -10.6 plot heights on [3.7, 4.05]). Everything else
 * passes through untouched: a domain including 0, no explicit domain, a
 * log scale (its domain must exclude 0 by definition), a symlog scale
 * (released conservatively -- symlog is continuous and invertible at 0,
 * so the principle above would cover it too, but no measured case backs
 * judging it), a non-quantitative channel, and an already-present clamp
 * (the spec author's own decision). */
function zeroBaselineClampTarget(
  mark: string,
  channel: ClampableChannel | null | undefined,
): ClampTarget | null {
  if (mark !== "bar" && mark !== "area") return null;
  const scale = channel?.scale;
  // A missing channel, an explicit null disable, no scale object, or a
  // nested non-array domain (signal/datum form) -- the
  // numeric-extrapolation precondition cannot be judged, so leave it be.
  if (
    !channel ||
    !scale ||
    typeof scale !== "object" ||
    !Array.isArray(scale.domain)
  )
    return null;
  if (
    scale.type !== undefined &&
    scale.type !== "linear" &&
    scale.type !== "pow" &&
    scale.type !== "sqrt"
  )
    return null;
  // An unset field type with a numeric domain is quantitative in practice;
  // non-numeric domains fall to the array-shape guard below.
  if (channel.type !== undefined && channel.type !== "quantitative")
    return null;
  const domain = scale.domain;
  if (
    domain.length !== 2 ||
    typeof domain[0] !== "number" ||
    typeof domain[1] !== "number" ||
    // A domain spanning zero keeps scale(0) inside the range -- no
    // extrapolation to guard against.
    (domain[0] <= 0 && domain[1] >= 0)
  )
    return null;
  if (scale.clamp !== undefined) return null;
  return channel as ClampTarget;
}

/** Patch `clamp: true` into the decided channel encoding's scale. */
function clampedChannel(channel: ClampTarget): ClampableChannel {
  return { ...channel, scale: { ...channel.scale, clamp: true } };
}

/** The outcome of walking one view node: the (possibly patched) view, plus
 * the measure encodings a baseline child hit -- present only for a channel
 * declared above the caller, which owes the patch. */
type ClampWalk = { view: unknown; sharedHits: ClampHits };

/** Guard the zero-baseline encoding against an explicit measure-axis domain
 * that excludes 0, on either channel (#1245, #1247, #1249; #1257 -- a
 * horizontal bar's baseline lives on x, and its explicit non-zero domain
 * translated the whole compiled group out of an otherwise sane viewBox).
 * The extrapolation lives inside each baseline mark, not in the view
 * structure, so the gate recurses through the whole spec tree: layer
 * entries (including layer-in-layer groups, which carry no mark of their
 * own), facet/repeat subviews, concat entries, and a view's own
 * mark+encoding pair. Composite keys lead the unit pair because vega-lite's
 * normalize compiles a spec carrying both a mark and a composite key by the
 * composite and drops the mark -- the walk judges what the engine renders.
 * x and y are judged independently by the same predicate -- a legal
 * bar/area spec keeps at most one discrete band axis, so a quantitative
 * channel IS the measure; no direction inference is needed. A child
 * without its own copy of a channel inherits the nearest declared one up
 * the chain, is judged against its baseline marks there, and the patch
 * lands at the declaration -- the place it takes effect; a view declaring
 * its own copy is judged (and patched) in place. The inheritance is the
 * engine's own rule inside layer groups; threading it across the
 * facet/repeat/concat wrappers too is defensive -- their types carry no
 * encoding member, so the engine rejects those shapes regardless. The walk
 * sets no depth cap and needs no cycle guard (the entry chains only hand
 * over vega-lite JSON) and rebuilds nothing when nothing hits -- a no-hit
 * spec comes back by reference. Everything else passes through untouched.
 * cf. keepsDefaultWidth below -- an orthogonal gate over width semantics
 * only: this gate reaches across the full tree while that one treats a
 * composite layout like any other operable view. Different questions;
 * never merge the two gates. */
function walkClampView(
  view: unknown,
  inherited: ClampableEncoding | undefined,
): ClampWalk {
  if (!view || typeof view !== "object" || Array.isArray(view))
    return { view, sharedHits: {} };
  const s = view as {
    mark?: unknown;
    encoding?: ClampableEncoding;
    layer?: unknown;
    spec?: unknown;
    vconcat?: unknown;
    hconcat?: unknown;
    concat?: unknown;
  };
  // Children inherit per channel: the nearest declared copy of each channel
  // wins (vega-lite's own rule inside layer groups). A composite wrapper's
  // encoding is defensive -- the engine rejects those shapes -- but the walk
  // threads it the same way.
  const childInherited: ClampableEncoding | undefined = s.encoding
    ? { ...inherited, ...s.encoding }
    : inherited;
  // Split a hop's reported hits: a channel this view declares patches here;
  // anything else keeps moving up to its declarer.
  const splitHits = (hits: ClampHits): { own: ClampHits; pass: ClampHits } => {
    const own: ClampHits = {};
    const pass: ClampHits = {};
    for (const ch of CHANNELS) {
      const hit = hits[ch];
      if (!hit) continue;
      if (s.encoding?.[ch] !== undefined) own[ch] = hit;
      else pass[ch] = hit;
    }
    return { own, pass };
  };
  // rest must never carry encoding -- it spreads after the patched pair
  // and would clobber it; the never-typed member pins it at compile time.
  const patchOwn = (
    own: ClampHits,
    pass: ClampHits,
    rest?: Record<string, unknown> & { encoding?: never },
  ): ClampWalk => ({
    view: {
      ...view,
      encoding: {
        ...s.encoding,
        ...(own.x ? { x: clampedChannel(own.x) } : {}),
        ...(own.y ? { y: clampedChannel(own.y) } : {}),
      },
      ...rest,
    },
    sharedHits: pass,
  });

  // Walk an entry list, aggregating rebuilds and the first inherited hit
  // per channel (several children may hit one shared declaration; it
  // patches once).
  const walkChildren = (entries: unknown[]) => {
    const sharedHits: ClampHits = {};
    let changed = false;
    const walked = entries.map((entry) => {
      const child = walkClampView(entry, childInherited);
      if (child.view !== entry) changed = true;
      for (const ch of CHANNELS) {
        const hit = child.sharedHits[ch];
        if (hit && !sharedHits[ch]) sharedHits[ch] = hit;
      }
      return child.view;
    });
    return { entries: walked, changed, sharedHits };
  };

  // Layered and concatenated children first (#1249): a legal spec carries
  // at most one of the four list keys, and a layer-in-layer group recurses
  // here by carrying a layer array of its own and no mark.
  for (const key of ["layer", "vconcat", "hconcat", "concat"] as const) {
    if (!Array.isArray(s[key])) continue;
    const { entries, changed, sharedHits } = walkChildren(s[key]);
    const { own, pass } = splitHits(sharedHits);
    if (own.x || own.y) return patchOwn(own, pass, { [key]: entries });
    if (changed) return { view: { ...view, [key]: entries }, sharedHits: pass };
    return { view, sharedHits: pass };
  }
  // The facet/repeat subview is a single child, not a list.
  if (s.spec !== undefined) {
    const child = walkClampView(s.spec, childInherited);
    const { own, pass } = splitHits(child.sharedHits);
    if (own.x || own.y) return patchOwn(own, pass, { spec: child.view });
    if (child.view !== s.spec)
      return { view: { ...view, spec: child.view }, sharedHits: pass };
    return { view, sharedHits: pass };
  }
  // Unit view last: the own-or-inherited mark+encoding pair is the whole
  // decision, judged channel by channel. An inherited hit is reported up --
  // the declarer patches.
  const topMark = markTypeName(s.mark);
  if (topMark !== undefined) {
    const hits: ClampHits = {};
    for (const ch of CHANNELS) {
      // An explicit null disables the channel -- it is judged as the view's
      // own copy (the predicate digests it) and never falls back to the
      // inherited declaration.
      const own = s.encoding?.[ch];
      const hit = zeroBaselineClampTarget(
        topMark,
        own === undefined ? inherited?.[ch] : own,
      );
      if (hit) hits[ch] = hit;
    }
    const { own, pass } = splitHits(hits);
    if (own.x || own.y) return patchOwn(own, pass);
    return { view, sharedHits: pass };
  }
  return { view, sharedHits: {} };
}

function withZeroBaselineClamp(spec: TopLevelSpec): TopLevelSpec {
  return walkClampView(spec, undefined).view as TopLevelSpec;
}

/** Prepare one spec for embedding: the spec to pass (widthless plain specs
 * stretch to the container instead of vega-lite's fixed per-band step) plus
 * whether the embedded view is container-width, so the resize observer and
 * the embed call read the same decision from one place. A numeric width
 * falls through as if undeclared (#1245): a plain single/layered view
 * normalizes to "container" -- the host clamp owns the chart's paint either
 * way, so a declared number only froze it at a size the host may not match
 * (narrow it overflowed, wide it floated in whitespace) -- while facets
 * (row/column channels or a top-level facet) and composite concat/repeat
 * layouts keep the declared number, because vega-lite warns and DROPS the
 * "container" keyword on everything but single and layered views and the
 * warning rides the logger, never embed's rejection: an injected keyword
 * would degrade silently and leave the observer re-feeding a width signal
 * the compiled view does not carry. An expr-driven width stays untouched
 * (the author's own responsive rule). The zero-baseline clamp guard (#1245)
 * runs ahead of the width branch -- an explicit-width spec is exactly the
 * kind that also carries an explicit domain. */
function prepareEmbed(spec: TopLevelSpec): {
  spec: TopLevelSpec;
  containerWidth: boolean;
} {
  const clamped = withZeroBaselineClamp(spec);
  // A declared non-number width owns itself: the "container" keyword still
  // needs the observer's re-feed, an expr form is the author's own rule.
  const declared = (clamped as { width?: unknown }).width;
  if (declared !== undefined && typeof declared !== "number") {
    return { spec: clamped, containerWidth: declared === "container" };
  }
  const encoding = (clamped as { encoding?: Record<string, unknown> })
    .encoding;
  // cf. readMark in viz.ts -- an orthogonal gate whose exemption set rules
  // `layer` the opposite way on purpose; never merge the two.
  const keepsDefaultWidth =
    Boolean(encoding && ("row" in encoding || "column" in encoding)) ||
    "facet" in clamped ||
    "vconcat" in clamped ||
    "hconcat" in clamped ||
    "concat" in clamped ||
    "repeat" in clamped;
  if (keepsDefaultWidth) return { spec: clamped, containerWidth: false };
  // The spread over the TopLevelSpec union needs one syntax-level assertion
  // to keep the result in the union; the "container" keyword itself is a
  // legal vega-lite width on every arm that reaches here.
  return {
    spec: { ...clamped, width: "container" } as TopLevelSpec,
    containerWidth: true,
  };
}

interface VegaChartProps {
  /** Always a vega-lite spec in practice: both entry chains (the viz.ts
   * decode gate, the VizChartSlot) only ever hand over vega-lite JSON, but
   * the wire types stay bare `object` up that chain, so the fact is asserted
   * once at the lazy door. vega-embed's VisualizationSpec union also admits
   * vega's own VgSpec arm, which prepareEmbed's container-width injection
   * would miscompile -- narrowing here keeps that arm out of the contract. */
  spec: TopLevelSpec;
  /** Fired when Vega-Embed rejects (render failure). The caller swaps in the
   * degradation disclosure (ADR-0033). Carries a typed `{ kind: "render" }`
   * reason so the disclosure renders via the same catalog path as a decode
   * failure (ADR-0052 i18n closeout, issue #138). Stable identity keeps the
   * embed effect from re-running; a useState setter is naturally stable. */
  onError: (reason: VizFailureReason) => void;
  /** Issue #1093: hands the embedded Vega view out (and null once it is
   *  finalized) so an export affordance can serialize the SAME render the
   *  user sees -- never a second embed. Stable identity is not required
   *  (read through a ref, like onError). */
  onView?: (view: Result["view"] | null) => void;
}

export function VegaChart({ spec, onError, onView }: VegaChartProps) {
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
  const onViewRef = useRef(onView);
  useEffect(() => {
    specRef.current = spec;
    onErrorRef.current = onError;
    onViewRef.current = onView;
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
          onViewRef.current?.(null);
          return;
        }
        viewRef.current?.finalize();
        viewRef.current = result;
        onViewRef.current?.(result.view);
      })
      .catch((err: unknown) => {
        // Log the full error for diagnostics (ADR-0029): the disclosure only
        // carries a typed { kind: "render" } reason (ADR-0052 i18n closeout), so
        // the engine detail that distinguishes a bad spec from a canvas/WebGL
        // failure lives here in the log, not in the user-facing banner. The log
        // sits before the cancelled guard (#1054): a slow-failing embed that
        // rejects after unmount (close-equals-unmount on the enlarge overlay,
        // #1050) -- or after a spec change superseded it -- still leaves its
        // only diagnostic trace; only the onError state update stays gated so
        // React never sees a gone component.
        log.warn("viz", "vega-embed render failed", err);
        if (cancelled) return;
        onErrorRef.current({ kind: "render" });
      });
    return () => {
      cancelled = true;
      viewRef.current?.finalize();
      viewRef.current = null;
      onViewRef.current?.(null);
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
            onViewRef.current?.(null);
            return;
          }
          viewRef.current?.finalize();
          viewRef.current = result;
          onViewRef.current?.(result.view);
        })
        .catch((err: unknown) => {
          // Same ordering as the spec effect's catch (#1054): the diagnostic
          // lands even when the rejection arrives after unmount; only the
          // state update stays behind the guard.
          log.warn("viz", "vega-embed theme re-embed failed", err);
          if (unmounted) return;
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
