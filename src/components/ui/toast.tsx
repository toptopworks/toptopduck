import {
  type ComponentProps,
  type ReactElement,
  useLayoutEffect,
  useState,
} from "react";
import * as ToastPrimitives from "@radix-ui/react-toast";
import { type VariantProps } from "class-variance-authority";
import { CircleCheck, CircleX, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { toastVariants } from "./toast-variants";

// shadcn radix-toast copy-in (ADR-0142, issue #1494): the radix-family
// toast primitives on the repo's token system. The viewport mounts once
// at the shell root via toaster.tsx (never inside the main area's
// transforming subtree -- the collapse-slide transforms on its bar-slot
// descendants would trap a fixed child) and follows the
// main-area column -- the conversation pane host, ADR-0092's stable
// `.main-area` class -- at its horizontal center and top edge. Measured
// in JS because a fixed element cannot read sibling geometry from CSS;
// ResizeObserver keeps the center through rail folds (sub-second drift
// during a fold animation is accepted, ADR-0142 Decision 3). z-[100]
// sits above the z-50 overlay family so a failure landing under an open
// dialog still shows. Wording-free (ADR-0142 Decision 5): this face
// carries no copy and no i18n keys; title/description come from the
// consumer. The close button's sr-only label and focus-ring width ride
// the dialog.tsx close-button precedent -- control chrome, not message
// copy (the ADR's consequences note carves it out).

function useMainAreaAnchor(): { centerX: number; top: number } | null {
  const [anchor, setAnchor] = useState<{ centerX: number; top: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    const mainArea = document.querySelector("main.main-area");
    if (!mainArea) return;
    const measure = () => {
      const rect = mainArea.getBoundingClientRect();
      // The settings-mode display swap (styles.css) hides the shell's
      // non-exempt children, main area included -- its rect collapses
      // to zero, and the naive midpoint would park the viewport at
      // left:0 top:0, half-translated offscreen. A zero-sized main
      // area has no column to anchor to: hold the last measured
      // anchor instead of re-anchoring, so an in-flight toast neither
      // jumps to the viewport center nor leaves the screen -- the
      // swap must be invisible to it. The RO re-fires when the swap
      // reverts, re-measuring the restored rect. A toast born while
      // no anchor exists yet keeps the viewport-centered fallback.
      if (rect.width === 0 || rect.height === 0) {
        return;
      }
      setAnchor({ centerX: rect.left + rect.width / 2, top: rect.top });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(mainArea);
    return () => observer.disconnect();
    // ponytail: ResizeObserver watches SIZE only -- a position-only shift
    // (a header-row alert mounting and pushing the main area down without
    // resizing it) leaves a stale top until the next resize. Upgrade to
    // ancestor observation if that edge ever bites.
  }, []);

  return anchor;
}

function ToastViewport({
  className,
  style,
  ...props
}: ComponentProps<typeof ToastPrimitives.Viewport>) {
  const anchor = useMainAreaAnchor();
  return (
    <ToastPrimitives.Viewport
      data-slot="toast-viewport"
      style={{
        ...style,
        ...(anchor ? { left: anchor.centerX, top: anchor.top } : {}),
      }}
      className={cn(
        "fixed top-16 left-1/2 z-[100] flex max-h-screen w-fit max-w-[420px] -translate-x-1/2 flex-col gap-2 p-4",
        className,
      )}
      {...props}
    />
  );
}

function Toast({
  className,
  variant,
  ...props
}: ComponentProps<typeof ToastPrimitives.Root> &
  VariantProps<typeof toastVariants>) {
  return (
    <ToastPrimitives.Root
      data-slot="toast"
      className={cn(toastVariants({ variant }), className)}
      {...props}
    />
  );
}

function ToastIcon({
  variant,
}: {
  variant?: VariantProps<typeof toastVariants>["variant"];
}) {
  // The variant-led status glyph (decorative -- the title/description
  // carry the semantics, hence aria-hidden). Both variants are solid
  // discs with the glyph stroked in the inverse hue -- outline-only
  // glyphs read as thin scratchwork on the solid toast faces (issue
  // #1589). Default rides a success green (#22c55e); the brand teal
  // disc sat too dark against the inverted face to read as a success
  // mark. One-off hex, not a token: the inverted face is dark in BOTH
  // themes so no light/dark flip is needed; promote to a --success
  // token (the #108 warning precedent) if a second consumer appears,
  // which is a DESIGN.md color-table edit, not a toast-local one.
  if (variant === "destructive") {
    return (
      <CircleX
        data-slot="toast-icon"
        aria-hidden="true"
        className="size-5 shrink-0 fill-destructive-foreground text-destructive"
      />
    );
  }
  return (
    <CircleCheck
      data-slot="toast-icon"
      aria-hidden="true"
      className="size-5 shrink-0 fill-[#22c55e] text-inverted-foreground"
    />
  );
}

function ToastTitle({
  className,
  ...props
}: ComponentProps<typeof ToastPrimitives.Title>) {
  return (
    <ToastPrimitives.Title
      data-slot="toast-title"
      // font-medium, not the recipe's font-semibold: DESIGN.md's weight
      // discipline keeps 600 for the 16-22px headline family; the 14px
      // family rides 400/500 (the AlertTitle precedent).
      className={cn("text-sm font-medium", className)}
      {...props}
    />
  );
}

function ToastDescription({
  className,
  ...props
}: ComponentProps<typeof ToastPrimitives.Description>) {
  return (
    <ToastPrimitives.Description
      data-slot="toast-description"
      // Dimmed on the inverted surface through inverted-foreground/75
      // (issue #1568), not the recipe's opacity-90 nor the muted token:
      // page-ground grays go muddy on the dark face (issue #1568); the
      // destructive surface re-tints through the group marker, the same
      // mechanism ToastClose/ToastAction ride.
      className={cn(
        "text-inverted-foreground/75 text-sm group-[.destructive]:text-destructive-foreground/90",
        className,
      )}
      {...props}
    />
  );
}

function ToastClose({
  className,
  ...props
}: ComponentProps<typeof ToastPrimitives.Close>) {
  return (
    <ToastPrimitives.Close
      data-slot="toast-close"
      className={cn(
        "ring-offset-inverted text-inverted-foreground/50 hover:text-inverted-foreground focus:ring-inverted-foreground/60 absolute top-1 right-1 rounded-md p-1 opacity-0 transition-opacity focus:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-none group-hover:opacity-100 group-[.destructive]:text-destructive-foreground/70 group-[.destructive]:hover:text-destructive-foreground group-[.destructive]:focus:ring-destructive-foreground/60",
        className,
      )}
      toast-close=""
      {...props}
    >
      <X data-slot="toast-close-icon" className="size-4" />
      <span className="sr-only">Close</span>

    </ToastPrimitives.Close>
  );
}

function ToastAction({
  className,
  ...props
}: ComponentProps<typeof ToastPrimitives.Action>) {
  return (
    <ToastPrimitives.Action
      data-slot="toast-action"
      className={cn(
        "focus:ring-inverted-foreground/60 inline-flex h-8 shrink-0 items-center justify-center rounded-md border border-inverted-foreground/25 bg-transparent px-3 text-sm font-medium transition-colors hover:bg-inverted-foreground/10 focus:outline-none focus:ring-1 disabled:pointer-events-none disabled:opacity-50 group-[.destructive]:border-muted/40 group-[.destructive]:hover:border-destructive/30 group-[.destructive]:hover:bg-destructive group-[.destructive]:hover:text-destructive-foreground group-[.destructive]:focus:ring-destructive",
        className,
      )}
      {...props}
    />
  );
}

type ToastProps = ComponentProps<typeof Toast>;
type ToastActionElement = ReactElement<typeof ToastAction>;

export {
  type ToastActionElement,
  type ToastProps,
  Toast,
  ToastAction,
  ToastClose,
  ToastDescription,
  ToastIcon,
  ToastTitle,
  ToastViewport,
};
