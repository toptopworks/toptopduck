import { type ComponentProps } from "react";
import { type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { alertVariants } from "./alert-variants";

// shadcn/ui v4 new-york copy-in (ADR-0049/0050, issue #108): a presentational
// styled div + optional AlertTitle/AlertDescription (no Radix primitive). The
// variant map lives in alert-variants.ts -- split out so this file exports only
// components and stays react-refresh-clean (cf. button/badge variants from
// #105/#107). The default role is "alert" (assertive), set before {...props} so
// a caller overrides it where the disclosure semantics differ: info -> note
// (static), warning -> status (polite); a destructive disclosure would keep the
// "alert" default. See alert-variants.ts for the variant -> disclosure-surface
// mapping.

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
