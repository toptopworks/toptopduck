import { type ComponentProps } from "react";

import { cn } from "@/lib/utils";

// shadcn/ui v4 new-york copy-in (ADR-0049, issue #105). Token consumption is
// via the var-based utilities (border-input / ring-ring / bg-transparent),
// which resolve to the app.css teal token set and flip with .dark.

function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // dark:border-input/60: large-control boundary rides the soft ~1.9:1
        // tier (radio/checkbox keep the full 3:1 --input border).
        // dark:bg-input/20: field fill matches the competitor-tier #2C2C2C
        // body; /30 over the raised --input ran bright.
        "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/20 dark:border-input/60",
        // No focus-visible ring/border: the caret is the focus indicator (the
        // composer textarea's border-0 posture); the aria-invalid error ring
        // below stays -- width and color ride the same variant, since a v4
        // ring-color utility alone emits no box-shadow.
        "aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
