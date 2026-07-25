import { type ComponentProps } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "@/lib/utils";

// shadcn/ui v4 new-york copy-in (ADR-0049, issue #238). The Popover primitive
// gives portal + focus-trap + click-outside/ESC dismiss + keyboard nav for
// free (replaces the hand-written containerRef + click-outside listener in
// ProfileSwitcher). It is the click layer of the composer provider/model
// picker (ADR-0071): an icon trigger beside the QuestionBar carries a hover
// Tooltip (lightweight "{provider} . {model}" preview) and opens this Popover
// (the heavy provider/model/key/settings panel). Token consumption is via var
// utilities (bg-popover / text-popover-foreground / border); enter/exit
// animations use tw-animate-css utilities (loaded in app.css). Exports only
// components (no cva variant map), so react-refresh/only-export-components
// stays clean without a variants split (cf. button/button-variants).

function Popover({
  ...props
}: ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({
  ...props
}: ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-md border p-4 shadow-md outline-none",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

function PopoverAnchor({
  ...props
}: ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };
