import { cva } from "class-variance-authority";

// shadcn/ui v4 new-york copy-in (ADR-0049/0050, issue #108) -- split out of
// alert.tsx so alert.tsx exports only components. Same react-refresh rationale
// as button-variants.ts / badge-variants.ts (issues #105/#107): co-locating a
// cva(...) result with a component export trips only-export-components. This
// file holds the variant map only.
//
// The variants ride the app.css token system via var-based utilities, so an
// alert recolors with the .dark class. ADR-0050 maps Alert to the disclosure
// surfaces: stale result / viz degradation (ADR-0033) / large-result &
// many-columns hints (ADR-0057) / session-count soft-cap (ADR-0046) + the
// privacy disclosure (issue #108):
// - default (bg-card, the shadcn info surface) carries the informational
//   disclosures (privacy, ADR-0057 large-result / many-columns hints);
// - warning (text-/bg-/border-warning, amber) carries the cautionary
//   disclosures (a stale result, a viz that failed to render, the ADR-0046
//   session-count soft-cap) -- the bespoke amber tint the legacy styles.css
//   owned is promoted to a --warning token so the variant consumes a token
//   rather than a hardcoded hex;
// - destructive is the standard shadcn destructive variant, carrying the
//   session-level query-failure disclosure (issue #763).

export const alertVariants = cva(
  "relative w-full rounded-lg border px-4 py-3 text-sm grid gap-y-0.5 items-start grid-cols-[0_1fr] has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        warning:
          "border-warning/40 bg-warning/10 text-warning [&>svg]:text-current *:data-[slot=alert-description]:text-warning/80",
        destructive:
          "border-destructive/40 bg-destructive/10 text-destructive [&>svg]:text-current *:data-[slot=alert-description]:text-destructive/80",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);
