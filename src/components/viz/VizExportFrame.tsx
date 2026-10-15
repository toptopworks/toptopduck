// The export-bearing chart frame (issue #1093): the chart slot with one
// export anchor in its corner. The result card's chart and the stage's viz
// view share this wrapper; the fence never mounts it -- the stream carries
// click-to-stage only (the ADR-0120 calibration's export matrix).
//
// The anchor borrows vega-embed's native affordance shape (2026-09-27
// re-adjudication): ONE corner trigger behind a dropdown whose items carry
// words -- twin bare icons read as noise on a chart. The reveal keeps the
// retired enlarge affordance's shape (hidden until the chart host is
// hovered or the anchor gains focus; general-sibling selector), and the
// anchor stays lit while the menu is open (focus rides the portal, so
// focus-within alone would drop the anchor with the menu still floating).
// Exports walk the embedded Vega view -- the SAME render the user
// sees, never a second embed: SVG serializes via view.toSVG() into a Blob,
// PNG rasterizes via view.toCanvas() -> canvas.toBlob. Both land through the
// native save dialog + the Rust write command (re-adjudicated 2026-09-27):
// the first lane -- an anchor click on a blob: URL riding the WebView2
// default download channel -- completed silently into the OS Downloads
// folder with zero in-app feedback, reading as a dead button. The file name
// is the spec's `title` through the one naming rule (vizExportName); a
// title-less spec falls back to the catalog word.

import { useRef, useState } from "react";
import { useIntl } from "react-intl";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Download, FileCode, FileImage } from "lucide-react";
import type { Result } from "vega-embed";
import { writeExportFile } from "../../api";
import { log } from "../../lib/log";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { VizChartSlot } from "./LazyVegaChart";
import { vizExportName, type DecodedVizSpec, type VizFailureReason } from "./viz";

// The export lane (issue #1093, re-adjudicated 2026-09-27): the native save
// dialog hands back an explicit destination, then the Rust write command
// lands the bytes there -- the click's first effect is a dialog the user
// cannot miss. A cancelled picker is a quiet no-op (the exportRowsCsv
// precedent); a write or serialization failure after a CONFIRMED pick
// surfaces on the in-frame notice (the ResultActions onError twin -- a
// confirmed destination that never appears must not read as a dead click),
// with the diagnostic detail in the log sink (ADR-0029).
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
  // The menu's open flag exists for the reveal CSS alone: while the menu is
  // open, focus (and the pointer) ride the portal content, so neither
  // :hover on the host nor focus-within on the wrapper holds.
  const [menuOpen, setMenuOpen] = useState(false);
  // The export failure flag: set by the exporters' catches, cleared by the
  // next attempt -- one fixed sentence, no detail (the log carries the why).
  const [exportFailed, setExportFailed] = useState(false);

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
    setExportFailed(false);
    const view = viewRef.current;
    if (!view) return;
    try {
      const svg = await view.toSVG();
      await saveChartFile(new Blob([svg], { type: "image/svg+xml" }), stem, "svg");
    } catch (err) {
      log.warn("viz", "chart SVG export failed", err);
      setExportFailed(true);
    }
  };
  const exportPng = async () => {
    setExportFailed(false);
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
      setExportFailed(true);
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
  const menuLabel = intl.formatMessage({
    id: "viz.export.menu",
    defaultMessage: "Download chart",
  });
  const failedLabel = intl.formatMessage({
    id: "viz.export.failed",
    defaultMessage: "Chart export failed",
  });

  return (
    // `relative` is the anchor's positioning context. No margin reset here on
    // purpose: the result card and the stage keep the chart's own 0.5rem
    // rhythm (the reset is a prose concern, VizFence's wrapper).
    <div className="relative">
      <VizChartSlot spec={spec} onError={onError} onView={onView} />
      {/* Hidden until the chart is hovered, the anchor itself is hovered
          (self-held: the pointer leaving the chart for the anchor drops
          the sibling :hover, so without it the anchor would fade out from
          under the cursor), or the anchor holds a VISIBLE focus (the
          keyboard path -- plain focus-within would keep the anchor lit
          after the menu closes, because Radix returns focus to the
          trigger, and a mouse-path menu close returns a non-visible
          focus). An open menu holds it lit (focus rides the portal, so
          no focus rule would hold mid-menu). Twin item blocks, not a map:
          the exporters close over the view ref and the refs lint rule
          cannot see through a loop (the ResultActions twin-button
          precedent). */}
      <div
        className={cn(
          "absolute top-1 right-1 z-10 transition-opacity duration-150",
          menuOpen
            ? "opacity-100"
            : "opacity-0 hover:opacity-100 [&:has(:focus-visible)]:opacity-100 [.viz-chart:hover_~&]:opacity-100",
        )}
      >
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="size-7 text-foreground/70 hover:bg-accent hover:text-foreground dark:hover:bg-accent"
            >
              <Download aria-hidden="true" className="size-3.5" />
              <span className="sr-only">{menuLabel}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => {
                void exportPng();
              }}
            >
              <FileImage aria-hidden="true" />
              {pngLabel}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                void exportSvg();
              }}
            >
              <FileCode aria-hidden="true" />
              {svgLabel}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {exportFailed && (
        // The honest failure face (issue #1093): the destructive Alert's
        // assertive default role fits a user-initiated action that did not
        // land; the wording stays category-level like the degrade
        // disclosures -- the engine detail lives in the log (ADR-0029).
        <Alert variant="destructive" className="my-2">
          <AlertDescription>{failedLabel}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
