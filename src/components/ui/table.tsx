import { type ComponentProps } from "react";

import { cn } from "@/lib/utils";

// shadcn/ui v4 new-york copy-in (ADR-0049/0050, issue #109): a presentational
// styled HTML table primitive set, self-contained (ADR-0067, issue #168).
// Table wraps the <table> in an overflow-x-auto container -- the horizontal-
// scroll surface that meets ADR-0057's full-column rendering (no virtualization,
// no column cap), replacing the hand-written .table-scroll wrapper. TableRow
// carries a token-based hover highlight (hover:bg-muted/50) + row border.
//
// ADR-0067 (issue #168) retired the styles.css global `table / th / td` element
// rules. The grid border, header tint, padding, border-collapse, table margin,
// and font-size those globals used to supply now live here as token/utility
// expressions on each primitive (Table = border-collapse + mt-2 mb-4 + text-sm;
// TableHead = border + bg-muted + text-sm; TableCell = border + py-1 px-2 +
// text-sm). border-color resolves via app.css's @layer base
// `* { border-color: var(--border) }`, so the bare `border` utility paints 1px
// solid var(--border) with no extra color utility. font-size uses text-sm
// (Tailwind scale mapping of the legacy 0.9rem -- ADR-0067 Decision 2: scale
// over arbitrary values, so 0.9rem snaps to the nearest scale step). There is
// no layering invariant left -- the component renders correctly with NO global
// table CSS. Callers keep their existing class hooks (.schema / .sample /
// .result, .num numeric-align, .cell-null) -- passed through className, they
// land on the real <table>/<th>/<td> the primitives render, so the ADR-0057
// numeric right-align and NULL muted-cell rules (now the only styles.css rules
// touching table elements, scoped under .result / .schema / .privacy-cols /
// .preview caller contexts) still apply verbatim.

function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
    >
      <table
        data-slot="table"
        // border-collapse + mt-2 mb-4 absorb the legacy styles.css global
        // `table { border-collapse: collapse; width: 100%; margin: 0.5rem 0 1rem }`
        // (ADR-0067 issue #168) -- the primitive is now self-contained.
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
      // border + bg-muted + text-sm absorb the legacy styles.css global
      // `th, td { border: 1px solid var(--border); ...; font-size: 0.9rem }` +
      // `th { background: var(--muted) }` (ADR-0067 issue #168). h-10 px-2 is
      // the shadcn copy-in compact density (ADR-0050); the header's vertical
      // size is fixed by h-10, so no py utility is needed (cell vertical padding
      // is a TableCell concern).
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
      // border + py-1 px-2 + text-sm absorb the legacy styles.css global
      // `th, td { border: 1px solid var(--border); padding: 0.3rem 0.5rem; ...;
      // font-size: 0.9rem }` (ADR-0067 issue #168). py-1 px-2 keeps the compact
      // workbench density (ADR-0050) close to the legacy 0.3rem 0.5rem; the
      // prior p-2 default was shadowed by that global rule for current
      // consumers.
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
