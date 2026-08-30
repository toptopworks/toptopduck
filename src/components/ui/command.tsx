import { type ComponentProps } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";

import { cn } from "@/lib/utils";

// shadcn/ui v4 new-york copy-in (issue #735). Serves as the option-list layer
// of the profile model combobox: a Popover carries the panel, the form-side
// Input stays the always-editable value surface, and this component provides
// the in-panel search + keyboard navigation (arrow/Enter cycle) + selected
// highlighting on top of cmdk. Token consumption is via the var-based
// utilities (bg-popover / text-muted-foreground / data-[selected=true]
// variants), which resolve to the app.css teal token set and flip with .dark.
// Only the four pieces with a consumer here are carried over; the upstream
// file's CommandDialog composition, CommandShortcut, CommandSeparator,
// CommandEmpty, and CommandGroup are not (re-copy them when a use appears).

function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "bg-popover text-popover-foreground flex h-full w-full flex-col overflow-hidden rounded-md",
        className,
      )}
      {...props}
    />
  );
}

function CommandInput({ className, ...props }: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="cmdk-input-wrapper flex h-9 items-center gap-2 border-b px-3">
      <Search className="size-4 shrink-0 opacity-50" aria-hidden />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "placeholder:text-muted-foreground flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "cmdk-list max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto",
        className,
      )}
      {...props}
    />
  );
}

function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "cmdk-item data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
};
