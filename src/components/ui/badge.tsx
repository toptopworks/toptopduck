import { type ComponentProps } from "react";
import { Slot } from "@radix-ui/react-slot";
import { type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { badgeVariants } from "./badge-variants";

// shadcn/ui v4 new-york copy-in (ADR-0049/0050, issue #107). The variant map
// lives in badge-variants.ts (split so this file exports only a component and
// stays react-refresh-clean, cf. button/button-variants from #105). Renders a
// <span> so it drops inline inside turn-head rows and the working-set list;
// asChild merges the variant onto a host element (the stale causal chip is a
// <button>, so Badge wraps it via Slot). ADR-0050 maps Badge to active / stale /
// correction (纠偏) chips + key state.

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "span";

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant, className }))}
      {...props}
    />
  );
}

export { Badge };
