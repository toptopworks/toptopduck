// The chart enlarge view (#1050, ADR-0120 tail): the in-stream chart surfaces
// (the result card and the vega-lite fence) render at container width, so a
// narrow conversation column squeezes them into a thumbnail. This module is
// the shared affordance + overlay: a small corner button that reveals on
// hover/focus opens a Radix dialog that re-embeds the SAME decoded spec
// through the same chart slot -- one decode, two embeds of the same object, no
// new render path, tooltip and theme flip identical by construction.
//
// The trigger is an explicit control, not a chart-body click: the chart-body
// click stays reserved for the workspace cross-link tail (ADR-0120), and a
// button carries the role and aria-label a canvas never could. The button
// floats over the chart's corner (absolute) but stays hidden until the chart
// host itself is hovered or the button is focused -- always-visible covered
// chart content (legends, axis labels) at the corner. The mount point owns
// the positioning context (`relative`), so the two chart surfaces keep their
// own rhythm untouched.

import { useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Maximize2 } from "lucide-react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { VizChartSlot } from "./LazyVegaChart";
import { VizDegradeDisclosure } from "./VizDegradeDisclosure";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../ui/tooltip";
import type { VizFailureReason } from "./viz";

/** The dialog body: one chart re-embed, or its own honest disclosure. Lives
 *  inside DialogContent so closing unmounts it: a reopen starts with fresh
 *  failure state, the same reset a new fence body gets. */
function EnlargedChartBody({ spec }: { spec: object }) {
  const [renderError, setRenderError] = useState<VizFailureReason | null>(null);
  return (
    <>
      {renderError === null && (
        <VizChartSlot spec={spec} onError={setRenderError} />
      )}
      {renderError !== null && (
        // ADR-0033: a re-embed that fails in the overlay degrades to the
        // shared honest disclosure instead of an empty dialog.
        <VizDegradeDisclosure reason={renderError} />
      )}
    </>
  );
}

/** The enlarge affordance + overlay (#1050). `spec` is the same decode
 *  success payload the in-stream slot renders -- the caller passes the same
 *  object, so decode runs once and both embeds draw one spec. The overlay is
 *  viewport-anchored (never the conversation column): full readable width up
 *  to ~72rem, the spec's own height uncompressed, taller charts scroll. */
export function VizEnlargeDialog({ spec }: { spec: object }) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Controlled tooltip with a just-closed guard: the dialog close path
  // restores focus to the trigger (Radix's onCloseAutoFocus), and the
  // tooltip's internal onFocus opens on programmatic focus too (its
  // pointer-down gate has long cleared) -- unguarded, the tooltip pops
  // right after every close. The guard eats exactly that one open request
  // riding the restore; a real hover re-opens normally, because the
  // pointer path needs a fresh pointermove and the guard is gone by then.
  const [tipOpen, setTipOpen] = useState(false);
  const justClosedRef = useRef(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) justClosedRef.current = true;
      }}
    >
      {/* The plain ResultActions-style tooltip shape (app-wide provider):
       * hover names the control the same way its aria-label does. The
       * nested asChild chain merges both triggers' props onto the one
       * button -- tooltip on hover, dialog on click. */}
      <Tooltip
        open={tipOpen}
        onOpenChange={(next) => {
          if (next && justClosedRef.current) {
            justClosedRef.current = false;
            return;
          }
          setTipOpen(next);
        }}
      >
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            {/* Revealed when the chart host itself is hovered: the adjacent
             * sibling selector keys on `.viz-chart:hover` (the host is the
             * button's preceding sibling inside the mount point's wrapper),
             * so hovering the wrapper's empty space around a narrow chart
             * does not light the button up. The button's own hover keeps it
             * visible while the pointer is on it (otherwise it would
             * flicker: hovering the button ends the host's hover), and
             * focus-visible covers the keyboard path (opacity-0 stays in the
             * tab order and a11y tree). */}
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-1 right-1 z-10 size-7 opacity-0 transition-opacity duration-150 [.viz-chart:hover_+&]:opacity-100 hover:opacity-100 focus-visible:opacity-100"
              aria-label={intl.formatMessage({
                id: "viz.enlarge.trigger",
                defaultMessage: "Enlarge chart",
              })}
            >
              <Maximize2 className="size-4" aria-hidden="true" />
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>
          {intl.formatMessage({
            id: "viz.enlarge.trigger",
            defaultMessage: "Enlarge chart",
          })}
        </TooltipContent>
      </Tooltip>
      {/* Only the sm: half is load-bearing: the base default
       * (calc(100%-2rem) of the fixed-position viewport) already degrades to
       * near-full width on small screens; the sm: override is what lifts the
       * cap to the full readable size past the lg default. */}
      <DialogContent
        className="sm:max-w-[min(72rem,calc(100vw-2rem))]"
        onOpenAutoFocus={(event) => {
          // The chart surface has no focusable child, so the default initial
          // focus lands on the built-in close button and lights its focus
          // ring; steer it to the scroll container instead (tabindex -1 keeps
          // it out of the tab order, and focus stays inside the dialog).
          event.preventDefault();
          bodyRef.current?.focus();
        }}
      >
        {/* sr-only on purpose: an enlarged chart is a pure visual surface, and
         * the a11y name it needs is the dialog's, not a visible heading's. */}
        <DialogTitle className="sr-only">
          <FormattedMessage
            id="viz.enlarge.dialogTitle"
            defaultMessage="Enlarged chart view"
          />
        </DialogTitle>
        <div
          ref={bodyRef}
          className="max-h-[75vh] overflow-y-auto focus:outline-none"
          tabIndex={-1}
        >
          <EnlargedChartBody spec={spec} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
