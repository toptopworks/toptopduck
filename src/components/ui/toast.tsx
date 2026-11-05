import {
  type ComponentProps,
  type ReactElement,
  useLayoutEffect,
  useState,
} from "react";
import * as ToastPrimitives from "@radix-ui/react-toast";
import { type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";

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
        "fixed top-16 left-1/2 z-[100] flex max-h-screen w-full -translate-x-1/2 flex-col gap-2 p-4 md:max-w-[420px]",
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
      // The muted token, not the recipe's opacity-90 dimming: DESIGN.md
      // routes subdued text through --muted-foreground (the
      // AlertDescription precedent).
      className={cn("text-muted-foreground text-sm", className)}
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
        "ring-offset-background text-foreground/50 hover:text-foreground focus:ring-ring absolute top-1 right-1 rounded-md p-1 opacity-0 transition-opacity focus:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-none group-hover:opacity-100 group-[.destructive]:text-destructive-foreground/70 group-[.destructive]:hover:text-destructive-foreground group-[.destructive]:focus:ring-destructive-foreground/60",
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
        "focus:ring-ring inline-flex h-8 shrink-0 items-center justify-center rounded-md border bg-transparent px-3 text-sm font-medium transition-colors hover:bg-muted focus:outline-none focus:ring-1 disabled:pointer-events-none disabled:opacity-50 group-[.destructive]:border-muted/40 group-[.destructive]:hover:border-destructive/30 group-[.destructive]:hover:bg-destructive group-[.destructive]:hover:text-destructive-foreground group-[.destructive]:focus:ring-destructive",
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
  ToastTitle,
  ToastViewport,
};
