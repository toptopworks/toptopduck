// The export-bearing chart frame (issue #1093): the chart slot with the
// PNG / SVG pair in its corner. The result card's chart and the stage's viz
// view share this one wrapper; the fence never mounts it -- the stream
// carries click-to-stage only (the ADR-0120 calibration's export matrix).
//
// The pair reuses the retired enlarge affordance's reveal shape: hidden
// until the chart host is hovered or the pair gains focus (general-sibling
// selector now that two buttons follow the host), each button in the
// ResultActions family form (ghost icon + tooltip + sr-only accessible
// name). Exports walk the embedded Vega view -- the SAME render the user
// sees, never a second embed: SVG serializes via view.toSVG() into a Blob,
// PNG rasterizes via view.toCanvas() -> canvas.toBlob. Both land through the
// native save dialog + the Rust write command (re-adjudicated 2026-09-27):
// the first lane -- an anchor click on a blob: URL riding the WebView2
// default download channel -- completed silently into the OS Downloads
// folder with zero in-app feedback, reading as a dead button. The file name
// is the spec's `title` through the one naming rule (vizExportName); a
// title-less spec falls back to the catalog word.

import { useRef } from "react";
import { useIntl } from "react-intl";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { FileCode, FileImage } from "lucide-react";
import type { Result } from "vega-embed";
import { writeExportFile } from "../../api";
import { log } from "../../lib/log";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { VizChartSlot } from "./LazyVegaChart";
import { vizExportName, type DecodedVizSpec, type VizFailureReason } from "./viz";

// The export lane (issue #1093, re-adjudicated 2026-09-27): the native save
// dialog hands back an explicit destination, then the Rust write command
// lands the bytes there -- the click's first effect is a dialog the user
// cannot miss. A cancelled picker is a quiet no-op (the exportRowsCsv
// precedent); a write failure routes to the caller's log-sink catch like a
// serialization failure.
async function saveChartFile(blob: Blob, stem: string, ext: "png" | "svg") {
  const target = await saveDialog({
    defaultPath: `${stem}.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (target === null) return;
  await writeExportFile(target, new Uint8Array(await blob.arrayBuffer()));
}

export function VizExportFrame({
  spec,
  onError,
}: {
  spec: DecodedVizSpec;
  onError: (reason: VizFailureReason) => void;
}) {
  const intl = useIntl();
  // The live view handle, kept current by the chart's onView: a re-embed
  // (theme flip) swaps it, a finalize nulls it -- an export can never run
  // against a dead view.
  const viewRef = useRef<Result["view"] | null>(null);
  // Identity never matters here: VegaChart reads the handler through its own
  // ref, so a plain arrow is enough.
  const onView = (view: Result["view"] | null) => {
    viewRef.current = view;
  };

  // The one naming rule: the spec title sanitized, else the catalog word.
  const stem = vizExportName(
    spec,
    intl.formatMessage({ id: "viz.export.fallbackName", defaultMessage: "chart" }),
  );

  // Serialization failures (a dead/edge-case view, a canvas reject) carry no
  // user-facing surface the spec defines, but they never vanish silently:
  // the plugin log sink is the diagnostic lane (ADR-0029), mirroring the
  // embed rejection path.
  const exportSvg = async () => {
    const view = viewRef.current;
    if (!view) return;
    try {
      const svg = await view.toSVG();
      await saveChartFile(new Blob([svg], { type: "image/svg+xml" }), stem, "svg");
    } catch (err) {
      log.warn("viz", "chart SVG export failed", err);
    }
  };
  const exportPng = async () => {
    const view = viewRef.current;
    if (!view) return;
    try {
      const canvas = await view.toCanvas();
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (blob) await saveChartFile(blob, stem, "png");
    } catch (err) {
      log.warn("viz", "chart PNG export failed", err);
    }
  };

  const pngLabel = intl.formatMessage({
    id: "viz.export.png",
    defaultMessage: "Download chart as PNG",
  });
  const svgLabel = intl.formatMessage({
    id: "viz.export.svg",
    defaultMessage: "Download chart as SVG",
  });

  return (
    // `relative` is the pair's positioning context. No margin reset here on
    // purpose: the result card and the stage keep the chart's own 0.5rem
    // rhythm (the reset is a prose concern, VizFence's wrapper).
    <div className="relative">
      <VizChartSlot spec={spec} onError={onError} onView={onView} />
      {/* Hidden until the chart is hovered or the pair gains focus
          (focus-within covers the keyboard path). The general-sibling
          selector keys on the chart HOST (the buttons follow it), so
          hovering the wrapper's empty space does not light the pair. Two
          twin blocks, not a map: the exporters close over the view ref and
          the refs lint rule cannot see through a loop (the ResultActions
          twin-button precedent). */}
      <div className="absolute top-1 right-1 z-10 flex gap-1 opacity-0 transition-opacity duration-150 [.viz-chart:hover_~&]:opacity-100 focus-within:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                void exportPng();
              }}
              className="size-7 bg-card/90 p-1 text-muted-foreground hover:text-foreground"
            >
              <FileImage aria-hidden="true" className="size-4" />
              <span className="sr-only">{pngLabel}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{pngLabel}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                void exportSvg();
              }}
              className="size-7 bg-card/90 p-1 text-muted-foreground hover:text-foreground"
            >
              <FileCode aria-hidden="true" className="size-4" />
              <span className="sr-only">{svgLabel}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{svgLabel}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
