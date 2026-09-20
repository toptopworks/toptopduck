import { describe, expect, it } from "vitest";
import { decodeViz, decodeVizSpec } from "../viz";
import type { ChartKind, VizSpec } from "../../../types/thread";

// Build a VizSpec with a given spec JSON string; the kind is decorative for
// decodeViz (it reads only `spec`), but we pass the matching whitelist kind so
// the test reads as a real chart.
function viz(kind: ChartKind, spec: string): VizSpec {
  return { kind, spec };
}

describe("decodeViz", () => {
  describe("accepts a whitelisted Vega-Lite mark", () => {
    // Each v1 chart kind maps onto a Vega-Lite mark the whitelist permits
    // (ADR-0016). decodeViz reads only the spec, so all these resolve ok.
    it.each<[ChartKind, string]>([
      ["bar", "bar"],
      ["line", "line"],
      ["area", "area"],
      ["scatter", "point"],
      ["scatter", "circle"],
      ["scatter", "square"],
      ["pie", "arc"],
    ])("accepts a %s chart drawn with the %s mark", (kind, mark) => {
      const result = decodeViz(viz(kind, JSON.stringify({ mark })));
      expect(result.ok).toBe(true);
    });

    it("accepts a mark object form ({ type: 'line' })", () => {
      const result = decodeViz(viz("line", JSON.stringify({ mark: { type: "line" } })));
      expect(result.ok).toBe(true);
    });

    it("accepts a heatmap drawn with the rect mark (ADR-0120 Decision 3)", () => {
      // rect joined the whitelist as the heatmap's standard mark. The wire
      // kind stays a ChartKind member (the Rust enum does not grow a heatmap
      // variant, ADR-0120 Decision 2); decodeViz reads only the spec, so the
      // decorative kind is the closest table-ish whitelist member.
      const result = decodeViz(viz("bar", JSON.stringify({ mark: "rect" })));
      expect(result.ok).toBe(true);
    });

    it("returns the parsed spec object on success", () => {
      const result = decodeViz(viz("bar", JSON.stringify({ mark: "bar", encoding: {} })));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.spec).toEqual({ mark: "bar", encoding: {} });
      }
    });
  });

  describe("rejects a malformed spec", () => {
    it("rejects invalid JSON with a typed invalidJson reason", () => {
      const result = decodeViz(viz("bar", "not-valid-json"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toEqual({ kind: "invalidJson" });
    });

    it("rejects a JSON array with a typed notObject reason", () => {
      const result = decodeViz(viz("bar", "[1, 2, 3]"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toEqual({ kind: "notObject" });
    });

    it("rejects a JSON primitive with a typed notObject reason", () => {
      const result = decodeViz(viz("bar", "\"just a string\""));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toEqual({ kind: "notObject" });
    });

    it("rejects a JSON null with a typed notObject reason", () => {
      const result = decodeViz(viz("bar", "null"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toEqual({ kind: "notObject" });
    });
  });

  describe("rejects a non-whitelisted mark (degrades to table, ADR-0033)", () => {
    // A whitelisted kind whose spec nonetheless draws a chart v1 does not ship
    // (a geoshape, a text) degrades. v1 = table/bar/line/scatter/area/pie plus
    // the heatmap rect (ADR-0120 Decision 3).
    it.each(["geoshape", "text", "tick"])("rejects the %s mark with a typed unsupportedMark reason", (mark) => {
      const result = decodeViz(viz("bar", JSON.stringify({ mark })));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toEqual({ kind: "unsupportedMark", mark });
    });

    it("rejects a non-whitelisted mark given as an object type", () => {
      const result = decodeViz(viz("bar", JSON.stringify({ mark: { type: "geoshape" } })));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toEqual({ kind: "unsupportedMark", mark: "geoshape" });
    });
  });

  it("accepts a spec with no top-level mark (lets Vega-Embed judge it)", () => {
    // A layered spec may carry marks in `layer`, not at the top level; decodeViz
    // does not reject what it cannot classify -- the renderer makes the final
    // call and a render failure degrades via the ResultView error path.
    const result = decodeViz(viz("bar", JSON.stringify({ layer: [] })));
    expect(result.ok).toBe(true);
  });
});

describe("decodeVizSpec (the fence entry, ADR-0120)", () => {
  // A vega-lite fence in round prose is bare Vega-Lite JSON -- no wire `kind`
  // field (the result-card VizSpec carries one). Both entries share the same
  // parse + whitelist decision; this is the fence-side door into it.
  it("accepts a whitelisted mark from a bare spec string", () => {
    const result = decodeVizSpec(JSON.stringify({ mark: "bar", encoding: {} }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec).toEqual({ mark: "bar", encoding: {} });
  });

  it("accepts the heatmap rect mark", () => {
    expect(decodeVizSpec(JSON.stringify({ mark: "rect" })).ok).toBe(true);
  });

  it("rejects invalid JSON with a typed invalidJson reason", () => {
    const result = decodeVizSpec("{ not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toEqual({ kind: "invalidJson" });
  });

  it("rejects a non-object JSON value with a typed notObject reason", () => {
    const result = decodeVizSpec("[1, 2, 3]");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toEqual({ kind: "notObject" });
  });

  it("rejects a non-whitelisted mark with a typed unsupportedMark reason", () => {
    const result = decodeVizSpec(JSON.stringify({ mark: "geoshape" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toEqual({ kind: "unsupportedMark", mark: "geoshape" });
  });

  it("decides identically to the wire entry for the same spec text", () => {
    // The two doors must never drift: a fence spec and a wire spec carrying the
    // same JSON resolve the same way.
    const spec = JSON.stringify({ mark: { type: "line" } });
    expect(decodeVizSpec(spec)).toEqual(decodeViz(viz("line", spec)));
  });
});
