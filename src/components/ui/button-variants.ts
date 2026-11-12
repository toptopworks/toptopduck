import { cva } from "class-variance-authority";

// shadcn/ui v4 new-york copy-in (ADR-0049, issue #105) -- split out of
// button.tsx so button.tsx exports only the Button component. The project's
// react-refresh gate (eslint-plugin-react-refresh, allowConstantExport: true)
// does not cover a cva(...) call result alongside a component export, so
// co-locating buttonVariants with Button trips only-export-components. This
// file holds the variant map only; button.tsx + alert-dialog.tsx import it.

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        destructive:
          "bg-destructive text-white shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        outline:
          // dark:border-input/60: large-control boundary rides the soft ~1.9:1
          // tier (radio/checkbox keep the full 3:1 --input border).
          // dark:bg-input/20: field fill matches the competitor-tier #2C2C2C
          // body; /30 over the raised --input ran bright.
          // Hover is the transit hue in BOTH themes -- the same grey as
          // ghost/nav/row hovers, one knob. Filled commitment buttons keep
          // their darken press semantics; grey buttons lift to transit.
          "border bg-background shadow-xs hover:bg-transit dark:bg-input/20 dark:border-input/60",
        secondary:
          "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
        ghost:
          // Grey = transit, teal = committed: hover rides the --transit ramp
          // (bg-transit covers both themes -- dark transit lifts off card
          // exactly one composer-magnitude step); accent stays reserved for
          // selected/active states. The glyph lift to foreground is the
          // brightness axis, independent of the hover hue.
          "hover:bg-transit hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);
