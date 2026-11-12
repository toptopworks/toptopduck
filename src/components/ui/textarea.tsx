import { type ComponentProps } from "react";

import { cn } from "@/lib/utils";

// shadcn/ui v4 new-york copy-in (ADR-0049, issue #105). Mirrors Input: var-based
// border-input / ring-ring utilities ride the app.css teal token set.

function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // No focus-visible ring/border (mirrors Input): the caret is the
        // focus indicator; the aria-invalid error ring stays.
        // dark:border-input/60: large-control boundary rides the soft ~1.9:1
        // tier (radio/checkbox keep the full 3:1 --input border).
        // dark:bg-input/20: field fill matches the competitor-tier #2C2C2C
        // body; /30 over the raised --input ran bright.
        "border-input placeholder:text-muted-foreground aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive flex field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/20 dark:border-input/60",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
