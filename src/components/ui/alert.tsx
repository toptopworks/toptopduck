import { type ComponentProps } from "react";
import { type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { alertVariants } from "./alert-variants";

// shadcn/ui v4 new-york copy-in (ADR-0049/0050, issue #108). The variant map
// lives in alert-variants.ts (split so this file exports only components and
// stays react-refresh-clean, cf. button/badge variants from #105/#107). Alert
// is a presentational surface (no Radix primitive, unlike AlertDialog) -- a
// styled div + optional AlertTitle/AlertDescription. ADR-0050 maps it to the
// disclosure surfaces. The shadcn default role is "alert" (assertive), set on
// the div before {...props} so a caller can override it; callers do so where
// the disclosure's semantics differ: info disclosures pass role="note" (static
// reference, not announced), warning disclosures pass role="status" (polite --
// important but not an interrupting emergency), and a destructive disclosure
// would keep the "alert" default.

function Alert({
  className,
  variant,
  ...props
}: ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("col-start-2 font-medium leading-none tracking-tight", className)}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-muted-foreground col-start-2 text-sm [&_p]:leading-relaxed",
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertDescription, AlertTitle };
