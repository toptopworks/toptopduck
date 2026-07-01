// Viz spec decoding + whitelist gate (ADR-0016/0033, issue #26).
//
// The provider's viz spec is presentation layer (ADR-0033): the Rust orchestrator
// carries it verbatim and never validates it. This module is the frontend's
// deterministic, side-effect-free, DOM-free pre-check -- parse the Vega-Lite
// JSON and confirm its mark is one v1 ships. The ResultView then renders the
// parsed spec via Vega-Embed and catches any further render failure as a
// degradation. Keeping the decision in a pure function makes the degradation
// behavior unit-testable without Vega's canvas-dependent renderer.

import type { VizSpec } from "./types";

// The Vega-Lite marks the v1 chart whitelist (ADR-0016) maps onto. v1 ships
// table / bar / line / scatter / area / pie only; a spec that draws anything
// else (a heatmap "rect", a "geoshape", a "text") degrades to a table. ChartKind
// itself is already whitelisted by the closed Rust enum -- this guards a
// whitelisted kind whose spec nonetheless draws a non-whitelisted chart.
const WHITELISTED_MARKS: ReadonlySet<string> = new Set([
  "bar", // bar
  "line", // line
  "area", // area
  "point", // scatter
  "circle", // scatter
  "square", // scatter
  "arc", // pie
]);

/** The outcome of decoding one provider viz spec. The `ok` variant carries the
 * parsed Vega-Lite object ready to render; the failure variant carries the
 * user-facing reason the chart could not be shown (so the ResultView can
 * disclose it honestly, ADR-0033 -- silent degradation is a silent lie). */
export type DecodeResult =
  | { ok: true; spec: object }
  | { ok: false; reason: string };

/** Parse + whitelist-check a provider viz spec (ADR-0016/0033). A null/missing
 * viz is the default table turn (NOT a degradation) and is handled by the
 * caller -- this function takes an emitted spec and decides whether it is
 * renderable. */
export function decodeViz(viz: VizSpec): DecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(viz.spec);
  } catch {
    return { ok: false, reason: "规格不是合法的 JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "规格不是 Vega-Lite 对象" };
  }
  const mark = readMark(parsed);
  if (mark !== null && !WHITELISTED_MARKS.has(mark)) {
    return {
      ok: false,
      reason: `图表类型「${mark}」不在支持的范围内（仅支持柱/线/面积/散点/饼图）`,
    };
  }
  return { ok: true, spec: parsed };
}

/** Read a Vega-Lite spec's top-level mark type, whether `mark` is a string
 * ("bar") or a mark object ({"type":"bar"}). `null` when there is no top-level
 * mark (a layered spec, or one relying on a default) -- decodeViz lets such a
 * spec through so Vega-Embed can judge it, with a render failure degrading via
 * the ResultView error path. */
function readMark(spec: object): string | null {
  const mark = (spec as Record<string, unknown>).mark;
  if (typeof mark === "string") return mark;
  if (typeof mark === "object" && mark !== null && !Array.isArray(mark)) {
    const type = (mark as Record<string, unknown>).type;
    if (typeof type === "string") return type;
  }
  return null;
}
