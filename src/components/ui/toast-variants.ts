import { cva } from "class-variance-authority";

// shadcn radix-toast copy-in (ADR-0142, issue #1494) -- split out of
// toast.tsx so toast.tsx exports only components, same react-refresh
// rationale as button/badge/alert variants. Two variants start the set
// (ADR-0142 Decision 4): default is the inverted face (issue #1568) -- the
// transient-hint tier that stays dark in both themes (see the --inverted
// comment in app.css; the page-ground bg-background face drowned against
// its own ground); destructive is the
// offscreen-failure attribution variant, taking the solid destructive
// surface of the DESIGN.md alert-destructive mapping (destructive bg +
// destructive-foreground text) rather than the tinted /40 shape the
// in-panel alert uses -- a toast has no surrounding panel context, so the
// solid read is the honest one. The bare `destructive` class is the marker
// ToastClose/ToastAction/ToastDescription key their group-[.destructive]
// overrides off (the recipe's mechanism). Shadow rides the DESIGN.md floating-popover tier
// (shadow-md), radius the compact --radius token (rounded-md = 6px). The
// enter/exit animations key off the column-top placement (ADR-0142
// Decision 3): enter from the top edge, exit fades up out of it
// (swipeDirection="up" in toaster.tsx).

export const toastVariants = cva(
  "group pointer-events-auto relative flex w-full items-center justify-between gap-2 overflow-hidden rounded-md border p-4 pr-6 shadow-md transition-all data-[swipe=cancel]:translate-y-0 data-[swipe=end]:translate-y-(--radix-toast-swipe-end-y) data-[swipe=move]:translate-y-(--radix-toast-swipe-move-y) data-[swipe=move]:transition-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[swipe=end]:animate-out data-[state=closed]:fade-out-80 data-[state=closed]:slide-out-to-top-full data-[state=open]:slide-in-from-top-full",
  {
    variants: {
      variant: {
        default: "bg-inverted text-inverted-foreground",
        destructive:
          "border-destructive bg-destructive text-destructive-foreground destructive",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);
