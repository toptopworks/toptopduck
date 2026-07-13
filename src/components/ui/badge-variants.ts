import { cva } from "class-variance-authority";

// shadcn/ui v4 new-york copy-in (ADR-0049/0050, issue #107) -- split out of
// badge.tsx so badge.tsx exports only the Badge component. Same react-refresh
// rationale as button-variants.ts (issue #105): co-locating a cva(...) result
// with a component export trips only-export-components. This file holds the
// variant map only.
//
// The variants ride the app.css token system via var-based utilities, so a
// badge recolors with the .dark class. ADR-0050 maps Badge to active / stale /
// correction (纠偏) chips + key state:
// - default (bg-primary, teal) carries the active-chip signal;
// - secondary (bg-secondary, the muted-neutral slot) carries the stale chip /
//   stale badge, aligned with ADR-0050's stale = muted semantic;
// - destructive is reserved for the future failed / 纠偏 reverse-chip surfaces
//   (ADR-0048 defers the correction chip's rendering detail to the visual ADR);
// - outline is the standard shadcn ghost variant for ad-hoc consumers.

export const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 gap-1 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3 [&_svg]:shrink-0 transition-[color,box-shadow] overflow-hidden",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-white [a&]:hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        outline:
          "text-foreground border-current [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);
