import { type ComponentProps } from "react";
import { Slot } from "@radix-ui/react-slot";
import { type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { buttonVariants } from "./button-variants";

// shadcn/ui v4 new-york copy-in (ADR-0049, issue #105). The variant map lives
// in button-variants.ts (split so this file exports only a component and stays
// react-refresh-clean); the variants ride the app.css teal token system through
// var-based utilities (bg-primary / text-primary-foreground / bg-background /
// border-input etc.), so a button recolors with the .dark class.

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button };
