import { type ComponentProps } from "react";

import { cn } from "@/lib/utils";

// shadcn/ui v4 new-york copy-in (ADR-0049/0050, issue #109): a presentational
// styled HTML table primitive set. Table wraps the <table> in an overflow-x-
// auto container (ADR-0057 full-column horizontal scroll, no virtualization).
// TableRow carries a token-based hover highlight (hover:bg-muted/50) + row
// border.
//
// Self-contained (ADR-0067, issue #168): each primitive carries its own
// border / bg-muted / padding / border-collapse / margin / text-sm as utility
// expressions, so the component renders correctly with NO global table CSS
// (border-color comes from app.css's @layer base `* { border-color: var(--border) }`).
// Caller class hooks (.schema / .result / .privacy-cols / .preview, .num /
// .cell-null) pass through cn() to the rendered <table>/<th>/<td>. ADR-0067
// (issue #173): the result caller-scoped styles.css rules (.num right-align,
// .cell-null muted bg) retired onto ResultView's cells as utility alongside
// the hooks; the still-caller-scoped rules (.schema td code wrap, .privacy-cols
// last-column width) live on in styles.css until their owners migrate.

function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
    >
      <table
        data-slot="table"
        // border-collapse + w-full + mt-2 mb-4 self-contain what ADR-0067
        // removed from styles.css's global `table` rule.
        className={cn(
          "w-full caption-bottom text-sm border-collapse mt-2 mb-4",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className,
      )}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      // border + bg-muted self-contain what ADR-0067 removed from styles.css's
      // global `th` rule. h-10 px-2 is the shadcn copy-in compact density
      // (ADR-0050); h-10 fixes the header height, so no py utility is needed
      // (cell vertical padding is a TableCell concern).
      className={cn(
        "border bg-muted h-10 px-2 text-sm text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      // border + py-1 px-2 self-contain what ADR-0067 removed from styles.css's
      // global `td` rule. py-1 px-2 keeps the compact workbench density
      // (ADR-0050) close to the legacy 0.3rem 0.5rem.
      className={cn(
        "border py-1 px-2 text-sm align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({
  className,
  ...props
}: ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
};
