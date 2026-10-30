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
        "border-input placeholder:text-muted-foreground aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive flex field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
