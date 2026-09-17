import {
  type ComponentProps,
  type ReactNode,
} from "react";
import { type LucideIcon, ArrowLeft, ChevronDown, ChevronRight, Info, Loader2 } from "lucide-react";
import { useIntl } from "react-intl";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
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
 *  label or section title (the ImportSkillsDialog import-mode posture, now
 *  itself a consumer). `label` is the trigger's accessible name; `children`
 *  render as the muted body. An optional `title` -- a plain string,
 *  resolved via formatMessage and symmetric with `label` -- promotes the
 *  body to the titled block posture: a medium-weight heading line in the
 *  popover surface foreground, then the muted body below (issue #958). */
export function FieldHint({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
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
        <div
          className={cn("text-muted-foreground text-sm", title && "space-y-1")}
        >
          {title && (
            <p className="text-popover-foreground font-medium">{title}</p>
          )}
          {children}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/** A pane-header icon action: an icon-only ghost Button whose single `label`
 *  is the one source for both the accessible name and the tooltip -- call
 *  sites resolve the message descriptor (including conditionals like
 *  Scanning…/Rescan) once and the component writes it to both, ending the
 *  aria + tooltip double-write. `spinning` adds the in-flight rotate to the
 *  icon; `onClick` is zero-arg -- pane-header actions never sit inside a
 *  clickable row, so the event is not part of the contract (issue #958). */
export function HeaderActionButton({
  label,
  icon: Icon,
  spinning,
  disabled,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  spinning?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground size-7"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          <Icon className={cn("size-4", spinning && "animate-spin")} aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className={SETTINGS_TOOLTIP_CLASS}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** The dialog-title action: a small ghost icon button beside an import
 *  dialog's title (issue #964). Deliberately its own posture -- dialogs get
 *  no tooltip (the pane-header `HeaderActionButton` skin does not apply
 *  inside a modal) and keep the compact `size="sm"` ghost shell; `label` is
 *  the single source for the accessible name, `spinning` adds the in-flight
 *  rotate. */
export function DialogHeaderButton({
  label,
  icon: Icon,
  spinning,
  disabled,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  spinning?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="text-muted-foreground"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon className={cn("size-4", spinning && "animate-spin")} aria-hidden />
    </Button>
  );
}

/** The editor form's back link: the ArrowLeft labeled-text button escaping a
 *  form pane back to its list (issue #960). `children` is the label slot --
 *  the three call sites' copy differs -- while `onClick` / `disabled` pass
 *  straight through: the chrome layer does not know the saving semantics. */
export function PaneBackLink({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground mb-4 flex items-center gap-1.5 text-sm"
      onClick={onClick}
      disabled={disabled}
    >
      <ArrowLeft className="size-4" aria-hidden />
      {children}
    </button>
  );
}

/** A row-level icon action: the small bare ghost (no tooltip) on list rows,
 *  the in-row counterpart of the pane-header posture -- Edit / Test /
 *  Restore hover to the foreground, Delete to destructive (issue #958).
 *  `spinning` swaps the icon for a rotating Loader2 (the in-flight Test
 *  button); `onClick` is the plain zero-arg action handler -- the settings
 *  rows are not whole-row click targets, so no stopPropagation duty rides
 *  on it (the #958 zero-arg contract). A DISABLED action restores
 *  hit-testing to show the not-allowed cursor: the base's
 *  pointer-events-none would strip that hint and leave a dead-looking
 *  control (a disabled control fires no click either way). */
export function RowActionButton({
  label,
  icon: Icon,
  destructive,
  spinning,
  disabled,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  /** Delete-style actions hover to destructive; the rest to the foreground. */
  destructive?: boolean;
  spinning?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={cn(
        "text-muted-foreground shrink-0",
        "disabled:pointer-events-auto disabled:cursor-not-allowed",
        destructive ? "hover:text-destructive" : "hover:text-foreground",
      )}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {spinning ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <Icon className="size-4" aria-hidden />
      )}
    </Button>
  );
}

/** A row-end icon action inside an editor: the destructive-hover icon button
 *  that removes a field row (the CLI remove-parameter / remove-env and the
 *  MCP remove-variable / remove-header buttons), no tooltip. Sibling of
 *  RowActionButton -- the editor rows run tighter than the list rows, so the
 *  hit box shrinks to size-7 with the size-3.5 glyph. Like the header
 *  posture, `onClick` is zero-arg: editor field rows sit outside clickable
 *  rows, so the event is not part of the contract (issue #958). */
export function RowRemoveButton({
  label,
  icon: Icon,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  onClick?: () => void;
}) {
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className="text-muted-foreground hover:text-destructive size-7 shrink-0"
      aria-label={label}
      onClick={onClick}
    >
      <Icon className="size-3.5" aria-hidden />
    </Button>
  );
}

/** The row-level fold toggle: the bare chevron button that expands a list
 *  row's detail panel (issue #964). The accessible name is the row name and
 *  the state rides `aria-expanded` -- no verb enters the name, mirroring the
 *  fold-head posture. The chevron swap (down when expanded, right when
 *  collapsed) is the only stateful skin. Both call sites sit outside
 *  clickable rows, so the handler takes no event. */
export function RowFoldChevron({
  label,
  expanded,
  onToggle,
}: {
  /** The row name; becomes the button's accessible name verbatim. */
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer"
      onClick={onToggle}
      aria-label={label}
      aria-expanded={expanded}
    >
      {expanded ? (
        <ChevronDown className="size-4" aria-hidden />
      ) : (
        <ChevronRight className="size-4" aria-hidden />
      )}
    </button>
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
 *  per-pane <h3> (ADR-0075: titles promoted to pane heroes). Typography rides
 *  the DESIGN.md tokens: `size="section"` (default) is `{typography.headline-lg}`
 *  (20px/600/-0.2px -- the designated settings-section header); `size="form"`
 *  is `{typography.headline-md}` (18px/600, no tracking) with the tighter
 *  mb-3 rhythm folded in, for a create/edit form's own heading one step
 *  down the scale from its section's hero. */
export function PaneHeader({
  title,
  description,
  action,
  className,
  size = "section",
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Top-right slot (e.g. the Profiles refresh button). */
  action?: ReactNode;
  className?: string;
  size?: "section" | "form";
}) {
  return (
    <div
      data-slot="pane-header"
      className={cn(
        size === "form" ? "mb-3" : "mb-6",
        "flex items-start justify-between gap-4",
        className,
      )}
    >
      <div className="min-w-0 space-y-6">
        <h3
          className={
            size === "form"
              ? "text-lg font-semibold"
              : "text-xl font-semibold tracking-[-0.2px]"
          }
        >
          {title}
        </h3>
        {description && (
          <p className="text-muted-foreground text-sm">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** A controlled chevron fold head over field rows: a muted title button with
 *  a rotating chevron, an optional hint anchored beside the title, an
 *  optional right-hand action beside the expanded head, and the field rows
 *  below -- unifying the CliToolForm SectionFold and the MCP KvEditor fold
 *  (issue #958). Drift adjudications folded in:
 *  - The fold button always carries `aria-expanded` (the KvEditor copy had
 *    none; both states of the SectionFold copy did -- the SectionFold wins).
 *  - The collapsed button keeps the KvEditor copy's full-width hit area
 *    when no hint rides beside it; with a hint the button stays
 *    content-width -- a button cannot nest the hint's button, and a
 *    `w-full` hit area would push the hint off the row.
 *  - The `px-4 py-2.5` wrapper lives here, not at the call sites.
 *
 *  `onExpandedChange` is the single expansion signal; call sites hang their
 *  expand-time side effects (seeding a blank row into an empty section) on
 *  it. */
export function FoldHead({
  title,
  hint,
  expanded,
  onExpandedChange,
  action,
  children,
}: {
  title: ReactNode;
  /** The field hint (the info-icon tooltip) anchored after the title. */
  hint?: ReactNode;
  expanded: boolean;
  onExpandedChange: (next: boolean) => void;
  /** The right-hand affordance (the Add button); rendered only expanded. */
  action?: ReactNode;
  children: ReactNode;
}) {
  // One trigger serves both states: only the chevron rotation, the
  // aria-expanded value, the toggle direction, and the collapsed full-width
  // hit area (absent when a hint rides beside the button) change.
  const renderTrigger = (fullWidth: boolean) => (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={() => onExpandedChange(!expanded)}
      className={cn(
        "flex items-center gap-1.5 text-left",
        fullWidth && "w-full",
      )}
    >
      <ChevronRight
        className={cn(
          "text-muted-foreground size-4 shrink-0",
          expanded && "rotate-90",
        )}
        aria-hidden
      />
      <span className="text-muted-foreground text-sm font-medium">{title}</span>
    </button>
  );
  return (
    <div className="px-4 py-2.5">
      {!expanded ? (
        <div className="flex items-center gap-1.5">
          {renderTrigger(!hint)}
          {hint}
        </div>
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              {renderTrigger(false)}
              {hint}
            </span>
            {action}
          </div>
          {children}
        </>
      )}
    </div>
  );
}

/** The import dialog's source fold head (issue #960): the select-all checkbox
 *  slot beside a single expand toggle carrying the source label, its optional
 *  config path, the discovered-count badge, and the trailing chevron. The
 *  expand/collapse verb rides the toggle's aria-label so the path / badge text
 *  never leaks into the accessible name; `children` renders the expanded
 *  panel below the hairline divider. The toggle handler is a plain toggler,
 *  unlike FoldHead's `onExpandedChange(next)`: the dialogs' callers only flip
 *  Set membership, with no expand-time side-effect hook to feed. */
export function SourceFold({
  label,
  path,
  count,
  expanded,
  onToggleExpand,
  selectAll,
  children,
}: {
  label: string;
  /** The mono source path after the label; hidden when absent (an MCP source
   *  whose config file was not found). */
  path?: string | null;
  count: number;
  expanded: boolean;
  onToggleExpand: () => void;
  /** The select-all checkbox slot: state, disabled, and handler pass
   *  straight through; its accessible name is the source `label`. */
  selectAll: {
    checked: boolean;
    disabled?: boolean;
    onToggleAll: () => void;
  };
  children: ReactNode;
}) {
  const intl = useIntl();
  // Both verbs resolve up front; the toggle's aria-label below is a plain
  // choice between the named labels (SidebarToggle / StatusDot posture).
  // Never fold these back into a single in-ternary call: formatjs extract
  // only matches a direct literal descriptor argument, so an in-ternary
  // descriptor is not recognized.
  const expandLabel = intl.formatMessage(
    { id: "settings.importSource.expand", defaultMessage: "Expand {label}" },
    { label },
  );
  const collapseLabel = intl.formatMessage(
    { id: "settings.importSource.collapse", defaultMessage: "Collapse {label}" },
    { label },
  );
  return (
    <div className="border-border rounded-lg border">
      <div className="hover:bg-accent/50 flex items-center gap-2 px-3 py-2.5">
        <input
          type="checkbox"
          checked={selectAll.checked}
          onChange={selectAll.onToggleAll}
          disabled={selectAll.disabled}
          aria-label={label}
          className="size-4"
        />
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-label={expanded ? collapseLabel : expandLabel}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 text-sm font-medium">{label}</span>
            {path && (
              <span
                className="text-muted-foreground truncate font-mono text-xs"
                title={path}
              >
                {path}
              </span>
            )}
          </div>
          <Badge variant="secondary" className="ml-auto shrink-0">
            {count}
          </Badge>
          <ChevronRight
            className={cn(
              "size-4 shrink-0 transition-transform",
              expanded && "rotate-90",
            )}
            aria-hidden
          />
        </button>
      </div>

      {expanded && (
        <div className="border-border border-t px-3 py-2">{children}</div>
      )}
    </div>
  );
}
