// Viz spec decoding + whitelist gate (ADR-0016/0033, ADR-0120, issue #26).
//
// The provider's viz spec is presentation layer (ADR-0033): the Rust orchestrator
// carries it verbatim and never validates it. This module is the frontend's
// deterministic, side-effect-free, DOM-free pre-check -- parse the Vega-Lite
// JSON and confirm its mark is one v1 ships. The renderer (VegaChart) then draws
// the parsed spec and catches any further render failure as a degradation.
// Keeping the decision in a pure function makes the degradation behavior
// unit-testable without Vega's canvas-dependent renderer.
//
// Two doors share the parse + whitelist decision (ADR-0120): the result card's
// wire structure (a VizSpec carrying `kind` + `spec`) and the round-prose
// vega-lite fence (bare JSON, no `kind`). decodeVizSpec is the shared core;
// decodeViz is the wire-shaped wrapper over it.

import type { VizSpec } from "../../types/thread";

// The Vega-Lite marks the v1 chart whitelist (ADR-0016) maps onto. v1 ships
// table / bar / line / scatter / area / pie only, plus the heatmap drawn with
// "rect" (ADR-0120 Decision 3); a spec that draws anything else (a "geoshape",
// a "text") degrades to a table. ChartKind itself is already whitelisted by the
// closed Rust enum -- this guards a whitelisted kind whose spec nonetheless
// draws a non-whitelisted chart.
const WHITELISTED_MARKS: ReadonlySet<string> = new Set([
  "bar", // bar
  "line", // line
  "area", // area
  "point", // scatter
  "circle", // scatter
  "square", // scatter
  "arc", // pie
  "rect", // heatmap (ADR-0120)
]);

/** A typed viz-degradation reason (ADR-0052 i18n closeout, issue #138). The
 * decode pre-check produces the first three kinds; the `render` kind is added
 * by VegaChart when Vega-Embed rejects. Keeping the reason structured (not a
 * bare localized string) lets the disclosure layer pick the catalog message per
 * kind in the active locale, so no Chinese leaks into an en-US disclosure. The
 * `mark` on `unsupportedMark` is engine output (layer 4 -- never translated),
 * interpolated as-is into the catalog message. */
export type VizFailureReason =
  | { kind: "invalidJson" }
  | { kind: "notObject" }
  | { kind: "unsupportedMark"; mark: string }
  | { kind: "render" };

/** The decode pre-check can never produce `render` -- that path belongs to
 * VegaChart. Narrowing the failure variant to the decode-only subset documents
 * that boundary at the type level (and keeps the callers' exhaustiveness
 * checks honest about which kinds the decode doors can actually emit). */
export type VizDecodeReason = Exclude<VizFailureReason, { kind: "render" }>;

/** The shape the decode gate guarantees for a passed spec: JSON.parse's
 * product when it is an object and not an array (issue #1055). Naming the
 * fact single-sources every contract site that carries a decode-passed spec
 * and lets viz.ts read spec fields without a narrowing cast. It deliberately
 * stays schema-light -- the always-vega-lite fact is asserted at one door
 * (LazyVegaChart), not encoded here. */
export type DecodedVizSpec = Record<string, unknown>;

/** The outcome of decoding one provider viz spec. The `ok` variant carries the
 * parsed Vega-Lite spec (`DecodedVizSpec`) ready to render; the failure
 * variant carries the typed reason the chart could not be shown (so the
 * ResultView can disclose it honestly, ADR-0033 -- silent degradation is a
 * silent lie). */
export type DecodeResult =
  | { ok: true; spec: DecodedVizSpec }
  | { ok: false; reason: VizDecodeReason };

/** Parse + whitelist-check a Vega-Lite spec string (ADR-0016/0033, ADR-0120).
 * The shared decision core both entry doors call: the result card's wire VizSpec
 * (decodeViz) and a round-prose vega-lite fence's bare JSON. */
export function decodeVizSpec(spec: string): DecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(spec);
  } catch {
    return { ok: false, reason: { kind: "invalidJson" } };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: { kind: "notObject" } };
  }
  const mark = readMark(parsed);
  if (mark !== null && !WHITELISTED_MARKS.has(mark)) {
    return { ok: false, reason: { kind: "unsupportedMark", mark } };
  }
  return { ok: true, spec: parsed };
}

/** Parse + whitelist-check a provider viz spec (ADR-0016/0033). A null/missing
 * viz is the default table turn (NOT a degradation) and is handled by the
 * caller -- this function takes an emitted spec and decides whether it is
 * renderable. The wire structure's `kind` is decorative here: the decision
 * reads only the spec text, exactly as the fence entry does. */
export function decodeViz(viz: VizSpec): DecodeResult {
  return decodeVizSpec(viz.spec);
}

/** Narrow `unknown` to a plain record (a non-null, non-array object) -- the
 * shape `DecodedVizSpec` names. One predicate serves decodeVizSpec's gate and
 * readMark's mark-object probe, so both carry the typed value with no
 * narrowing cast. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a Vega-Lite spec's top-level mark type, whether `mark` is a string
 * ("bar") or a mark object ({"type":"bar"}). `null` when there is no top-level
 * mark (a layered spec, or one relying on a default) -- decodeVizSpec lets
 * such a spec through so Vega-Embed can judge it, with a render failure
 * degrading via the caller's disclosure (the result card's table swap, or the
 * fence's bare disclosure).
 *
 * cf. keepsDefaultWidth in VegaChart -- an orthogonal gate whose exemption
 * set rules `layer` the opposite way on purpose; never merge the two. */
function readMark(spec: DecodedVizSpec): string | null {
  const mark = spec.mark;
  if (typeof mark === "string") return mark;
  if (isRecord(mark)) {
    const type = mark.type;
    if (typeof type === "string") return type;
  }
  return null;
}
