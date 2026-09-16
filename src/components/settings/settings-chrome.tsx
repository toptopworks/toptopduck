import { type ComponentProps, type ReactNode } from "react";
import { Info } from "lucide-react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

// Settings-page layout chrome (ADR-0075, issue #281). The redesign replaces the
// old single-fieldset panes with card-grouped ROWS: a card is a bordered,
// hairline-divided stack; each row carries a bold title + muted description on
// the left and either an inline-right compact control (Select / Switch) or a
// top-right Save button with its text input below (the engine number fields).
// These are presentational shells over the ADR-0050 token system (bg-card /
// border / divide-border), so they recolor with the .dark class; they hold no
// state or IPC. Kept in one file because every export is a component (react-
// refresh/only-export-components clean, cf. card.tsx) -- the tooltip skin
// constant rides along under allowConstantExport.

/** The shared settings-panel tooltip skin: a popover surface overriding the
 *  base TooltipContent's teal accent (ADR-0050). The single source for every
 *  settings tooltip (issue #554) -- call sites append their own size caps via
 *  cn(SETTINGS_TOOLTIP_CLASS, "max-w-...") rather than restyling. */
export const SETTINGS_TOOLTIP_CLASS =
  "bg-popover text-popover-foreground border shadow-md rounded-lg px-2.5 py-1.5";

/** A field or section hint: an info icon + tooltip anchored after the
 *  label or section title (the ImportSkillsDialog import-mode posture).
 *  `label` is the trigger's accessible name; `children` render as the
 *  muted body. */
export function FieldHint({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="text-muted-foreground shrink-0" aria-label={label}>
          <Info className="size-4" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        sideOffset={3}
        className={cn(SETTINGS_TOOLTIP_CLASS, "max-w-[15rem]")}
      >
        <div className="text-muted-foreground text-sm">{children}</div>
      </TooltipContent>
    </Tooltip>
  );
}

/** The settings row badge (the DESIGN.md badge-secondary token:
 *  typography.badge 12px/500 on rounded.md with 2px 8px padding, muted
 *  surface + muted-foreground text) -- the shared chrome for row badges
 *  that are not state alerts. */
export function NameBadge({ children }: { children: ReactNode }) {
  return (
    <span className="bg-muted text-muted-foreground shrink-0 rounded-md px-2 py-0.5 text-xs font-medium leading-none">
      {children}
    </span>
  );
}

/** A bordered group of hairline-divided setting rows. Rows are the direct
 *  children; `divide-y` paints the separators between them. */
export function SettingsCard({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="settings-card"
      className={cn(
        "bg-card text-card-foreground border-border divide-border divide-y overflow-hidden rounded-lg border",
        className,
      )}
      {...props}
    />
  );
}

/** One setting row inside a SettingsCard.
 *
 *  Three shapes, driven by which slots are filled:
 *  - Compact control (Select / Switch): pass the control as `action` (inline
 *    right, vertically centered against the title); leave `children` empty.
 *  - Explicit-save text field: pass the Save button as `action` (right side,
 *    vertically centered against the header row) and the Input as `children`
 *    (rendered below the header row).
 *  - Stacked form row: leave `action` empty and pass the full-width fields as
 *    `children` below the label (the profile editor's per-field rows). Pair
 *    with `dense` -- a whole form of stacked rows reads better at the tighter
 *    rhythm than the single-control default.
 *
 *  `title` is the bold label; `description` is the muted helper line under it. */
export function SettingsRow({
  title,
  description,
  action,
  children,
  className,
  dense,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Right-hand slot of the header row: an inline compact control, or a Save
   *  button for the explicit-save shape. */
  action?: ReactNode;
  /** Content below the header row (the text input for explicit-save rows, or
   *  the full-width fields of a stacked form row). */
  children?: ReactNode;
  className?: string;
  /** Tighter vertical padding (py-2.5) for stacked form rows; the default
   *  py-4 suits rows carrying one inline control. */
  dense?: boolean;
}) {
  return (
    <div
      data-slot="settings-row"
      className={cn("px-4", dense ? "py-2.5" : "py-4", className)}
    >
      {/* Always center the header row: rows whose children mount/unmount
       *  (the local CLI fold) must not shift the action controls between
       *  center- and start-aligned as the fold toggles. */}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-sm font-medium">{title}</div>
          {description && (
            <div className="text-muted-foreground text-xs leading-relaxed">
              {description}
            </div>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

/** The hero header at the top of each settings pane: a large title, a one-line
 *  muted description, and an optional top-right action (the per-pane refresh
 *  button on Profiles). Replaces the retired single settings header + the old
 *  per-pane <h3> (ADR-0075: titles promoted to pane heroes). */
export function PaneHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Top-right slot (e.g. the Profiles refresh button). */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="pane-header"
      className={cn("mb-6 flex items-start justify-between gap-4", className)}
    >
      <div className="min-w-0 space-y-1">
        <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
        {description && (
          <p className="text-muted-foreground text-sm">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
