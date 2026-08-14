import { useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Check, FolderOpen, Pencil, Search, Settings } from "lucide-react";
import {
  buildSidebarGroups,
  type OpenSession,
  type SidebarEntry,
  type SidebarGroupKind,
} from "./sidebarModel";
import { formatRelativeTime } from "./lastModifiedText";
import { resolveDisplayName } from "./displayName";
import type { SessionMetadata } from "../types/session";
import type { SidebarGrouping } from "../types/app-config";
import type { ProviderConfig } from "../types/provider";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button-variants";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { bareButtonReset } from "@/lib/buttonReset";
import { cn } from "@/lib/utils";

// Group heading (ADR-0060 Chat-style Today/Yesterday/Previous-7-days/Older, or
// `recent` for ADR-0072's flat mode). Each branch is a STATIC-literal
// <FormattedMessage> call site so @formatjs/cli extract resolves the id (a
// template-literal id would break the i18n:check CI gate).
function GroupTitle({ kind }: { kind: SidebarGroupKind }) {
  switch (kind) {
    case "recent":
      return <FormattedMessage id="sidebar.group.recent" defaultMessage="Recent" />;
    case "today":
      return <FormattedMessage id="sidebar.group.today" defaultMessage="Today" />;
    case "yesterday":
      return <FormattedMessage id="sidebar.group.yesterday" defaultMessage="Yesterday" />;
    case "last7":
      return <FormattedMessage id="sidebar.group.last7" defaultMessage="Previous 7 days" />;
    case "older":
      return <FormattedMessage id="sidebar.group.older" defaultMessage="Older" />;
  }
}

// The Chat-style session sidebar (ADR-0060, issue #81). Col 1 of the shell:
// lists every persisted .duck (ADR-0061 cold start) merged with the open
// keep-alive sessions, Chat-style time-grouped and last-modified descending.
// ADR-0093 (issue #511): each row is pure navigation (title + conditional
// status dot). Management actions (rename / export / close / delete) moved to
// .session-header (slice 2, #512).

// A frozen empty set so the optional prop's default keeps a stable identity
// (no every-render fresh Set -> SidebarRow prop churn).
const NO_PENDING_APPROVALS: ReadonlySet<string> = new Set();

interface SessionSidebarProps {
  // Collapse state (ADR-0054 level 1, issue #287): when true the whole
  // subtree goes inert so keyboard / screen-reader focus cannot land on the
  // opacity-0 controls (ghost-focus fix). Drives the inert prop on the
  // <aside> shell; the opacity fade + grid-column animation stay in CSS.
  collapsed: boolean;
  sessions: SessionMetadata[];
  openSessions: OpenSession[];
  activeSessionId: string | null;
  disabled: boolean;
  loadError: string | null;
  grouping: SidebarGrouping;
  /** Runtime sids with one or more UNANSWERED approvals (ADR-0083, issue
   *  #297): the matching entry rows carry the attention tint + dot so a
   *  suspended turn is visible from anywhere in the shell (the "unanswered
   *  badge coloring carries forced visibility" consequence). Keyed by runtime
   *  sid (the approval events' addressing), so only OPEN entries match -- a
   *  persisted-but-closed session can never hold a pending gate. */
  pendingApprovalSids?: ReadonlySet<string>;
  onNew: () => void;
  onOpenDuck: () => void;
  onActivate: (sid: string) => void;
  onOpenPersisted: (path: string, name: string) => void;
  onSwitchGrouping: (mode: SidebarGrouping) => void;
  // Open the Ctrl/⌘+K search modal (ADR-0072, issue #252). The
  // shell owns the open state so the global keydown + this button share one
  // entry point; the button is the always-visible affordance for the same
  // shortcut.
  onOpenSearch: () => void;
  // Footer settings gear (issue #282): `provider` is null until app-config
  // resolves -- the footer stays ABSENT until then, which keeps the
  // white-screen state unreachable (opening settings on a null config hides
  // the shell but mounts no SettingsView, leaving no ESC exit; the absence
  // replaces the retired topbar gear's settingsDisabled gate).
  provider: ProviderConfig | null;
  // The gear opens the settings overlay (General pane).
  onOpenSettings: () => void;
}

export function SessionSidebar({
  sessions,
  openSessions,
  activeSessionId,
  disabled,
  loadError,
  grouping,
  pendingApprovalSids = NO_PENDING_APPROVALS,
  onNew,
  onOpenDuck,
  onActivate,
  onOpenPersisted,
  onSwitchGrouping,
  onOpenSearch,
  provider,
  onOpenSettings,
  collapsed,
}: SessionSidebarProps) {
  const intl = useIntl();
  // Capture "now" and refresh every 60 s so the sidebar row relative-time
  // display (issue #513) stays current without calling Date.now in render
  // (react-hooks/purity). The calendar-day buckets are also stable enough at
  // this granularity; a cross-midnight drift refreshes on the next tick.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const groups = buildSidebarGroups(
    sessions,
    openSessions,
    activeSessionId,
    now,
    grouping,
  );

  return (
    // ADR-0067 (issue #171): the shell-skeleton visual rules ride inline
    // utilities over the ADR-0050 token (see styles.css for the retirement
    // list). The .session-sidebar / .session-list LAYOUT shells (grid-column
    // /row + flex column + flex:1 scroll container) stay as layout-only CSS;
    // the semantic class hooks are kept on every element for selector / test
    // stability.
    <aside
      className="session-sidebar bg-muted border-r border-border p-2"
      aria-label={intl.formatMessage({ id: "sidebar.ariaLabel", defaultMessage: "Sessions" })}
      inert={collapsed}
    >
      {/* ADR-0072 (issue #250): brand title row (product name left + circular
          search magnifier right) replaces the ADR-0060 full-width solid teal
          New button; the New button trades the solid primary fill for a fused
          bg-secondary. ADR-0072 (issue #252) wires the magnifier to
          the Ctrl/⌘+K search modal -- this click + the global keydown route to
          the same shell-owned open state. */}
      <header className="sidebar-brand-row mb-2 flex items-center justify-between">
        <span className="sidebar-brand text-sm font-semibold text-foreground">
          <FormattedMessage id="sidebar.brand" defaultMessage="TOPTOPDuck" />
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={onOpenSearch}
          className="sidebar-search-button inline-flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-progress disabled:opacity-50"
          aria-label={intl.formatMessage({
            id: "sidebar.search.ariaLabel",
            defaultMessage: "Search sessions",
          })}
        >
          <Search className="size-4" aria-hidden />
        </button>
      </header>
      <button
        type="button"
        className="sidebar-new-button mb-2 flex w-full cursor-pointer items-center gap-1.5 rounded-md bg-secondary p-2 text-sm text-secondary-foreground hover:bg-accent disabled:opacity-60 disabled:cursor-progress"
        disabled={disabled}
        onClick={onNew}
      >
        <Pencil className="size-4 shrink-0" aria-hidden />
        <FormattedMessage id="sidebar.newSession" defaultMessage="New session" />
      </button>
      <button
        type="button"
        className="sidebar-open-button mb-2 flex w-full cursor-pointer items-center gap-1.5 rounded-md border border-border bg-transparent p-2 text-sm text-foreground hover:bg-accent disabled:opacity-60 disabled:cursor-progress"
        disabled={disabled}
        onClick={onOpenDuck}
        title={intl.formatMessage({
          id: "sidebar.importSession.title",
          defaultMessage: "Import a .duck to resume a prior session",
        })}
      >
        <FolderOpen className="size-4 shrink-0" aria-hidden />
        <FormattedMessage id="sidebar.importSession" defaultMessage="Import session" />
      </button>

      {loadError && (
        <p className="sidebar-error text-muted-foreground mb-1.5 text-xs">
          <FormattedMessage
            id="sidebar.loadError"
            defaultMessage="Could not load saved sessions."
          />
        </p>
      )}

      <ul className="session-list">
        {groups.map((group, groupIndex) => (
          <li key={group.kind} className="session-group mt-1.5 mb-0.5">
            {/* ADR-0072 (#251): the grouping toggle rides the FIRST group's
                title row -- one entry point regardless of mode, and naturally
                hidden on an empty sidebar (no groups render). The trigger is
                hover-revealed (group-hover) but stays focus-visible for AT
                users; the open popover also pins it visible via
                data-[state=open]. */}
            <div className="session-group-title-row group relative mb-0.5 flex items-center justify-between px-1">
              <h3 className="session-group-title text-xs uppercase tracking-wider text-muted-foreground">
                <GroupTitle kind={group.kind} />
              </h3>
              {groupIndex === 0 && (
                <GroupingToggle
                  grouping={grouping}
                  disabled={disabled}
                  onSwitch={onSwitchGrouping}
                />
              )}
            </div>
            <ul className="session-group-list list-none m-0 p-0">
              {group.entries.map((entry) => (
                <SidebarRow
                  key={entry.key}
                  entry={entry}
                  displayName={resolveDisplayName(entry.name, intl)}
                  now={now}
                  hasPendingApproval={
                    entry.sid !== null && pendingApprovalSids.has(entry.sid)
                  }
                  disabled={disabled}
                  onActivate={() => {
                    if (entry.sid) onActivate(entry.sid);
                    else onOpenPersisted(entry.path, entry.name);
                  }}
                />
              ))}
            </ul>
          </li>
        ))}
        {groups.length === 0 && !loadError && (
          <li className="session-empty text-muted-foreground text-sm p-2">
            <FormattedMessage
              id="sidebar.empty"
              defaultMessage="No saved sessions yet."
            />
          </li>
        )}
      </ul>

      {/* Footer: the settings gear (issue #282). The .session-list flex:1
          scroll region above keeps this pinned to the column's bottom. Absent
          until app-config resolves (see the provider prop note) to keep the
          white-screen state unreachable. */}
      {provider && (
        <div className="sidebar-footer border-border border-t p-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={intl.formatMessage({
                  id: "header.settings",
                  defaultMessage: "Settings",
                })}
                onClick={onOpenSettings}
              >
                <Settings className="size-4" aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <FormattedMessage id="header.settings" defaultMessage="Settings" />
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </aside>
  );
}

// The flat/time grouping toggle (ADR-0072, issue #251). Triggered by a weakly-
// visible `⋯` on the first group-title row (one entry point regardless of
// mode, hidden on an empty sidebar). The Popover offers the two modes as a
// radio group (mutually exclusive -> radio semantics, not menu); the selected
// mode carries a trailing Check. A pick commits immediately via onSwitch (the
// hook routes through commitShellPrefs, same immediate-persist contract as the
// collapse toggles).
//
// a11y (issue #251 review):
// - The trigger rides opacity-60 by default (not opacity-0 + hover-only) so
//   keyboard, touch, and AT users can discover it without hovering; it
//   brightens on hover/focus/open.
// - bareButtonReset on the trigger/options strips native chrome including the
//   focus ring, so focus-visible:outline-ring re-adds one (the --ring token
//   is the project focus-indicator standard).
// - `disabled` propagates to both radio options, not just the trigger: a busy
//   shell must block a pick mid-popover (New button / context-menu parity).
function GroupingToggle({
  grouping,
  disabled,
  onSwitch,
}: {
  grouping: SidebarGrouping;
  disabled: boolean;
  onSwitch: (mode: SidebarGrouping) => void;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);

  const pick = (mode: SidebarGrouping) => {
    setOpen(false);
    onSwitch(mode);
  };

  // Shared option styling. bareButtonReset strips native button chrome; the
  // focus-visible outline is re-added explicitly (the reset would otherwise
  // leave keyboard users without a focus indicator on the radio options).
  const optionClass = cn(
    `${bareButtonReset} cursor-pointer flex w-full items-center justify-between gap-2 rounded-md py-1 pl-2 pr-1.5 text-sm text-foreground`,
    "hover:bg-accent",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    "disabled:cursor-progress disabled:opacity-50",
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={intl.formatMessage({
            id: "sidebar.grouping.toggle.ariaLabel",
            defaultMessage: "Change session grouping",
          })}
          className={cn(
            `sidebar-grouping-toggle ${bareButtonReset} cursor-pointer rounded-md px-1.5 text-base leading-none text-muted-foreground`,
            // Weakly visible by default (opacity-60) so keyboard / touch / AT
            // users can discover the entry point without hovering; brightens on
            // hover, focus, or while the popover is open.
            "opacity-60 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
            "hover:bg-accent hover:text-foreground",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            "disabled:cursor-progress disabled:opacity-50",
          )}
        >
          ⋯
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={4}
        className="sidebar-grouping-menu w-44 p-1"
      >
        <div className="px-2 py-1 text-xs text-muted-foreground">
          <FormattedMessage id="sidebar.grouping.label" defaultMessage="Group by" />
        </div>
        {/* Mutually-exclusive modes -> radio semantics. Tab cycles between the
            two options (a legal radiogroup keyboard model); arrow-key roving
            is not required. aria-checked carries the selected state; a trailing
            Check mirrors the selection visually. */}
        <div
          role="radiogroup"
          aria-label={intl.formatMessage({
            id: "sidebar.grouping.label",
            defaultMessage: "Group by",
          })}
        >
          <button
            type="button"
            role="radio"
            aria-checked={grouping === "flat"}
            disabled={disabled}
            onClick={() => pick("flat")}
            className={optionClass}
          >
            <FormattedMessage id="sidebar.grouping.flat" defaultMessage="In a list" />
            {grouping === "flat" && <Check className="size-4 shrink-0" aria-hidden />}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={grouping === "time"}
            disabled={disabled}
            onClick={() => pick("time")}
            className={optionClass}
          >
            <FormattedMessage id="sidebar.grouping.time" defaultMessage="By time" />
            {grouping === "time" && <Check className="size-4 shrink-0" aria-hidden />}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// One sidebar row: navigation + inline metadata (ADR-0093, issue #511/#513).
// The row carries the session title, a conditional status dot, and a compact
// relative-time span. Management actions (rename / export / close / delete)
// moved to .session-header (slice 2); the persistent sub-line (first source +
// turn count) is retired in favor of a HoverCard (slice 3, this change).
function SidebarRow({
  entry,
  displayName,
  now,
  hasPendingApproval,
  disabled,
  onActivate,
}: {
  entry: SidebarEntry;
  displayName: string;
  /** Refreshed every 60 s by SessionSidebar for the relative-time display. */
  now: number;
  /** The session holds an unanswered approval (ADR-0083, issue #297): the
   *  status dot flips to warning color + an sr-only label so a suspended turn
   *  stays visible while the user works in another session. */
  hasPendingApproval: boolean;
  disabled: boolean;
  onActivate: () => void;
}) {
  const intl = useIntl();
  // ADR-0093 (issue #511): the MessageSquare leading icon + the inset shadow
  // left bar are retired. Active = accent background only; open = status dot
  // (primary green / warning when pending approval); not-open = equal-width
  // placeholder so titles stay left-aligned across all rows. The active/open
  // booleans also stay as classes on the parent .session-entry hook for
  // selector / test stability.
  //
  // ADR-0093 slice 3 (issue #513): the row is wrapped in a HoverCard so hover
  // or keyboard focus surfaces the full metadata (title + source summary +
  // turn count) in a fixed-width card positioned to the right. The
  // openDelay prevents flicker when the pointer sweeps across the list.
  return (
    <li
      className={cn(
        "session-entry relative my-0.5 flex items-stretch",
        entry.active && "active",
        entry.sid && "open",
        hasPendingApproval && "pending-approval",
      )}
      data-pending-approval={hasPendingApproval ? "true" : undefined}
    >
      <HoverCard openDelay={300} closeDelay={200}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            className={cn(
              `session-entry-main ${bareButtonReset} cursor-pointer flex-1 flex flex-row items-center gap-1.5 min-w-0 py-1.5 px-2 rounded-md text-foreground`,
              "hover:bg-accent disabled:opacity-50 disabled:cursor-progress",
              entry.active && "bg-accent text-accent-foreground",
            )}
            aria-current={entry.active ? "true" : undefined}
            disabled={disabled}
            onClick={(e) => {
              e.currentTarget.blur();
              onActivate();
            }}
          >
            <span className="session-name flex-1 min-w-0 text-left text-sm truncate">
              {displayName}
              {hasPendingApproval && (
                <span className="sr-only">
                  <FormattedMessage
                    id="sidebar.pendingApproval"
                    defaultMessage="(awaiting approval)"
                  />
                </span>
              )}
            </span>
            {/* Status dot on the right edge (ADR-0093): open = primary dot,
                pending approval = warning dot (overrides open), not-open = no
                dot. shrink-0 prevents truncation from consuming the dot. */}
            {entry.sid && (
              <span
                className={cn(
                  "sidebar-status-dot inline-block h-2 w-2 shrink-0 rounded-full",
                  hasPendingApproval ? "bg-warning" : "bg-primary",
                )}
                aria-hidden="true"
              />
            )}
            <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
              {formatRelativeTime(entry.lastModifiedAt, now, intl.locale)}
            </span>
          </button>
        </HoverCardTrigger>
        <HoverCardContent side="right" align="start">
          <SidebarRowHoverContent
            entry={entry}
            displayName={displayName}
          />
        </HoverCardContent>
      </HoverCard>
    </li>
  );
}

// Hover-card metadata body (ADR-0093, issue #513). Key-value pairs: full title
// (wrapping, no truncation) + source summary + turn count. Last-modified is
// shown inline on the row (formatRelativeTime), not in the card.
// Rendered inside a Radix Portal, but the React context tree (IntlProvider) is
// preserved across portals, so useIntl works here.
function SidebarRowHoverContent({
  entry,
  displayName,
}: {
  entry: SidebarEntry;
  displayName: string;
}) {
  const intl = useIntl();

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium text-foreground break-words">
        {displayName}
      </p>
      <dl className="m-0 flex flex-col gap-1.5 text-xs">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">
            <FormattedMessage
              id="sidebar.hover.dataSource"
              defaultMessage="Data source"
            />
          </dt>
          <dd className="text-foreground text-right">
            {entry.sourceCount > 0
              ? intl.formatMessage(
                  {
                    id: "sidebar.hover.sourceSummary",
                    defaultMessage:
                      "{first} · {count, plural, one {# source} other {# sources}}",
                  },
                  { first: entry.firstSourceName ?? "—", count: entry.sourceCount },
                )
              : "—"}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">
            <FormattedMessage id="sidebar.hover.turns" defaultMessage="Turns" />
          </dt>
          <dd className="text-foreground">
            <FormattedMessage
              id="sidebar.turns"
              defaultMessage="{count, plural, =0 {no turns} one {# turn} other {# turns}}"
              values={{ count: entry.turnCount }}
            />
          </dd>
        </div>
      </dl>
    </div>
  );
}

// Strong-confirm delete dialog (ADR-0060, issue #81): deletion is irreversible,
// so the dialog names the .duck explicitly and requires an explicit confirm.
// The shell is a Radix AlertDialog (issue #105): role="alertdialog" + focus-trap
// + scroll-lock come from the primitive. AlertDialog blocks overlay-click
// dismiss by default (destructive guard -- a stray pointer-down cannot drop the
// session). ESC routes to onCancel via onEscapeKeyDown, NOT onOpenChange:
// AlertDialogAction's built-in auto-close fires onOpenChange(false) after a
// confirm click, so an onOpenChange-to-onCancel bridge would invoke cancel on
// every Delete; onEscapeKeyDown isolates the keyboard-cancel path, leaving the
// Cancel/Action button routing (and their Radix auto-close) untouched. Cancel
// renders before Action so Radix auto-focuses it (the safe escape). The
// destructive Action passes buttonVariants({ variant: "destructive" }); twMerge
// (in cn) lets it override AlertDialogAction's built-in default variant, reusing
// the destructive look without forking the copy-in component.
// Exported for component-level testing (issue #111); the dialog is rendered only
// by SessionHeaderMenu in production, but the destructive-semantics + ESC routing
// contract is verified in isolation.
export function DeleteSessionDialog({
  name,
  onCancel,
  onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog defaultOpen>
      <AlertDialogContent onEscapeKeyDown={() => onCancel()}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <FormattedMessage id="session.delete.title" defaultMessage="Delete this session?" />
          </AlertDialogTitle>
          <AlertDialogDescription>
            <FormattedMessage
              id="session.delete.body"
              defaultMessage="“{name}” will be permanently deleted. This cannot be undone."
              values={{ name }}
            />
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>
            <FormattedMessage id="session.delete.cancel" defaultMessage="Cancel" />
          </AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            onClick={onConfirm}
          >
            <FormattedMessage id="session.delete.confirm" defaultMessage="Delete permanently" />
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Rename dialog (ADR-0060, single entry point). Pre-fills the current name (or
// empty for a never-saved session); blank submit is refused (Save disabled).
// The shell is now a Radix Dialog (issue #105): portal + focus-trap +
// scroll-lock + ESC + overlay-click dismiss come from the primitive, replacing
// the hand-written overlay div. showCloseButton={false} lets Radix auto-focus
// the Input (preserving the prior input autoFocus); ESC / overlay-click route
// to onCancel via onOpenChange. The Input + Label are copy-in primitives
// (ADR-0050: standard surface uses shadcn primitives). aria-describedby={undefined}
// opts out of a Description (the visible Label already names the field), which
// also silences Radix's missing-description warning.
// Exported for component-level testing (issue #111); rendered only by
// SessionHeaderMenu in production, but the onOpenChange-to-onCancel bridge + blank
// guard are verified in isolation.
export function RenameSessionDialog({
  initialName,
  onCancel,
  onSubmit,
}: {
  initialName: string;
  onCancel: () => void;
  onSubmit: (newName: string) => void;
}) {
  const [value, setValue] = useState(initialName);
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent showCloseButton={false} aria-describedby={undefined}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) onSubmit(value);
          }}
          className="grid gap-4"
        >
          <DialogTitle>
            <FormattedMessage id="session.rename.title" defaultMessage="Rename session" />
          </DialogTitle>
          <div className="grid gap-2">
            <Label htmlFor="rename-session-input">
              <FormattedMessage id="session.rename.label" defaultMessage="Session name" />
            </Label>
            <Input
              id="rename-session-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={onCancel}>
              <FormattedMessage id="session.rename.cancel" defaultMessage="Cancel" />
            </Button>
            <Button type="submit" disabled={!value.trim()}>
              <FormattedMessage id="common.save" defaultMessage="Save" />
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
