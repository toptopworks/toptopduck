import { type ComponentProps } from "react";
import * as HoverCardPrimitive from "@radix-ui/react-hover-card";

import { cn } from "@/lib/utils";

// shadcn/ui v4 new-york copy-in (ADR-0049/0050, issue #513). The HoverCard is
// the sidebar row metadata layer (ADR-0093): hovering or focusing a session row
// surfaces the full title + source/turn/mtime key-value pairs in a fixed-width
// card positioned to the right. Token consumption is via var utilities
// (bg-popover / text-popover-foreground), so the card rides the surface tokens
// and flips with the .dark class; enter/exit animations use tw-animate-css
// utilities (loaded in app.css). Exports only components (no cva variant map),
// so react-refresh/only-export-components stays clean without a variants split
// (cf. button/button-variants).

function HoverCard({
  ...props
}: ComponentProps<typeof HoverCardPrimitive.Root>) {
  return (
    <HoverCardPrimitive.Root data-slot="hover-card" {...props} />
  );
}

function HoverCardTrigger({
  ...props
}: ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return (
    <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
  );
}

function HoverCardContent({
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal data-slot="hover-card-portal">
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-64 rounded-md border p-4 shadow-md outline-none",
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
