import { useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Check, FolderOpen, MessageSquare, Pencil, Search } from "lucide-react";
import {
  buildSidebarGroups,
  type OpenSession,
  type SidebarEntry,
  type SidebarGroupKind,
} from "./sidebarModel";
import { resolveDisplayName } from "./displayName";
import type { SessionMetadata } from "../types/session";
import type { SidebarGrouping } from "../types/app-config";
import type { ProviderConfig, KeyStatus } from "../types/provider";
import { ConnectionStatus } from "../shell/ConnectionStatus";
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
// Each entry's context menu is the SINGLE entry point for rename / close /
// delete (ADR-0060 DRY); the top-bar name is read-only.

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
  onClose: (sid: string) => void;
  onDelete: (path: string, sid: string | null) => void;
  onRename: (sid: string | null, path: string, newName: string) => void;
  onSwitchGrouping: (mode: SidebarGrouping) => void;
  // Open the Ctrl/⌘+K search modal (ADR-0072, issue #252). The
  // shell owns the open state so the global keydown + this button share one
  // entry point; the button is the always-visible affordance for the same
  // shortcut.
  onOpenSearch: () => void;
  // Footer connection row + dual-state gear (issue #282): the non-secret
  // provider config (App-level app-config) + the active profile's key status,
  // rendered by the shared ConnectionStatus so the workspace footer is
  // isomorphic to the settings rail bottom. `provider` is null until app-config
  // resolves -- the footer stays ABSENT until then, which keeps the white-screen
  // state unreachable (opening settings on a null config hides the shell but
  // mounts no SettingsView, leaving no ESC exit; the absence replaces the
  // retired topbar gear's settingsDisabled gate).
  provider: ProviderConfig | null;
  keyStatus: KeyStatus;
  // The gear's workspace half: open the settings overlay (General pane).
  onOpenSettings: () => void;
  // The whole-row click: open the settings overlay landing on the Profiles
  // pane (the workspace analogue of the settings rail row's in-view jump).
  onOpenSettingsProfiles: () => void;
}

// The context-menu action the user picked, driving which dialog opens.
type MenuAction =
  | { kind: "rename"; entry: SidebarEntry }
  | { kind: "delete"; entry: SidebarEntry };

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
  onClose,
  onDelete,
  onRename,
  onSwitchGrouping,
  onOpenSearch,
  provider,
  keyStatus,
  onOpenSettings,
  onOpenSettingsProfiles,
  collapsed,
}: SessionSidebarProps) {
  const intl = useIntl();
  // Which entry's context menu is open (entry key); null = none. Only one menu
  // is open at a time.
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<MenuAction | null>(null);
  // Capture "now" once per mount via a lazy useState initializer (Date.now is
  // impure in render). The calendar-day buckets are stable within a session for
  // our purposes; a cross-midnight drift refreshes on the next mount.
  const [now] = useState(() => Date.now());

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
                  hasPendingApproval={
                    entry.sid !== null && pendingApprovalSids.has(entry.sid)
                  }
                  menuOpen={openMenuKey === entry.key}
                  disabled={disabled}
                  onToggleMenu={() =>
                    setOpenMenuKey((cur) => (cur === entry.key ? null : entry.key))}
                  onActivate={() => {
                    setOpenMenuKey(null);
                    if (entry.sid) onActivate(entry.sid);
                    else onOpenPersisted(entry.path, entry.name);
                  }}
                  onRename={() => {
                    setOpenMenuKey(null);
                    setPendingAction({ kind: "rename", entry });
                  }}
                  onClose={() => {
                    setOpenMenuKey(null);
                    if (entry.sid) onClose(entry.sid);
                  }}
                  onDelete={() => {
                    setOpenMenuKey(null);
                    setPendingAction({ kind: "delete", entry });
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

      {/* Footer: the shared connection status row + dual-state gear (issue
          #282), same place + structure as the settings rail bottom. The
          .session-list flex:1 scroll region above keeps this pinned to the
          column's bottom. Absent until app-config resolves (see the provider
          prop's C1 note). The gear carries the workspace half of the
          dual-state semantic (open settings); the settings rail's copy carries
          the "back to workspace" half. */}
      {provider && (
        <ConnectionStatus
          provider={provider}
          keyStatus={keyStatus}
          gearLabel={intl.formatMessage({
            id: "header.settings",
            defaultMessage: "Settings",
          })}
          onGearClick={onOpenSettings}
          onRowClick={onOpenSettingsProfiles}
        />
      )}

      {pendingAction?.kind === "rename" && (
        <RenameSessionDialog
          initialName={pendingAction.entry.name}
          onCancel={() => setPendingAction(null)}
          onSubmit={(newName) => {
            onRename(pendingAction.entry.sid, pendingAction.entry.path, newName);
            setPendingAction(null);
          }}
        />
      )}
      {pendingAction?.kind === "delete" && (
        <DeleteSessionDialog
          name={resolveDisplayName(pendingAction.entry.name, intl)}
          path={pendingAction.entry.path}
          onCancel={() => setPendingAction(null)}
          onConfirm={() => {
            // path is always non-null since ADR-0089 (sessions auto-persist).
            onDelete(pendingAction.entry.path, pendingAction.entry.sid);
            setPendingAction(null);
          }}
        />
      )}
    </aside>
  );
}

// The session-menu item base: composed per item via cn() so the danger variant
// swaps text-foreground -> text-destructive without copy-paste drift across
// the three items.
const sessionMenuItemBase =
  `${bareButtonReset} cursor-pointer block w-full py-1 px-2 rounded-md text-sm hover:bg-accent`;

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

// One sidebar row: the session name (click to activate/open) + a sub-line
// (first source + turn count) + a context-menu toggle. The menu is the single
// entry point for rename / close / delete (ADR-0060 DRY).
function SidebarRow({
  entry,
  displayName,
  hasPendingApproval,
  menuOpen,
  disabled,
  onToggleMenu,
  onActivate,
  onRename,
  onClose,
  onDelete,
}: {
  entry: SidebarEntry;
  displayName: string;
  /** The session holds an unanswered approval (ADR-0083, issue #297): the row
   *  carries the warning tint + dot so a suspended turn stays visible while
   *  the user works in another session. */
  hasPendingApproval: boolean;
  menuOpen: boolean;
  disabled: boolean;
  onToggleMenu: () => void;
  onActivate: () => void;
  onRename: () => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const intl = useIntl();
  // Click-away + ESC dismissal for the hand-positioned context menu (issue
  // #258): the menu is a plain div (not a Radix Popover), so without this a
  // pointer-down outside the row or an Escape keypress left it stuck open --
  // the user had to click a menu item or toggle the ⋯ button again. Runs only
  // while menuOpen; onToggleMenu is a toggle and menuOpen implies openMenuKey
  // === entry.key, so the call resolves to "close".
  const rowRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rowRef.current && !rowRef.current.contains(e.target as Node)) {
        onToggleMenu();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onToggleMenu();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen, onToggleMenu]);
  // Entry states ride inline utilities over the ADR-0050 token (ADR-0060,
  // refined by ADR-0072 issue #249): active = accent tint + the 2px left bar;
  // open-but-not-active = the bar only; default = no signal. ADR-0072 retires
  // the ADR-0060 full-row teal fill. The active/open booleans also stay as
  // classes on the parent .session-entry hook for selector / test stability.
  return (
    <li
      ref={rowRef}
      className={cn(
        "session-entry relative my-0.5 flex items-stretch",
        entry.active && "active",
        entry.sid && "open",
        hasPendingApproval && "pending-approval",
      )}
      data-pending-approval={hasPendingApproval ? "true" : undefined}
    >
      <button
        type="button"
        className={cn(
          `session-entry-main ${bareButtonReset} cursor-pointer flex-1 flex flex-row items-center gap-1.5 min-w-0 py-1.5 px-2 rounded-md text-foreground`,
          "hover:bg-accent disabled:opacity-50 disabled:cursor-progress",
          entry.sid && "shadow-[inset_2px_0_var(--primary)]",
          entry.active && "bg-accent text-accent-foreground",
          // ADR-0083 (issue #297) entry coloring: the warning-tinted left bar
          // overrides the open-session primary bar -- an unanswered approval
          // outranks "this session is open" as the row's signal.
          hasPendingApproval && "shadow-[inset_2px_0_var(--warning)]",
        )}
        aria-current={entry.active ? "true" : undefined}
        disabled={disabled}
        onClick={onActivate}
        title={entry.path}
      >
        {/* ADR-0072 (issue #249): unified leading chat-bubble glyph on every
            row, replacing the persisted/not Database/CircleDot split. */}
        <MessageSquare className="size-4 shrink-0" aria-hidden />
        <span className="flex-1 min-w-0 flex flex-col">
          <span className="session-name text-sm truncate">
            {displayName}
            {hasPendingApproval && (
              <>
                {/* The attention dot beside the name mirrors the rail toggle's
                    badge; the sr-only text names why for assistive tech (the
                    dot itself is decorative). */}
                <span
                  className="sidebar-pending-dot ml-1 inline-block h-1.5 w-1.5 rounded-full bg-warning align-middle"
                  aria-hidden="true"
                />
                <span className="sr-only">
                  <FormattedMessage
                    id="sidebar.pendingApproval"
                    defaultMessage="(awaiting approval)"
                  />
                </span>
              </>
            )}
          </span>
          <span className="session-subline text-muted-foreground text-xs font-normal opacity-85">
            {entry.firstSourceName ?? "—"}
            {" · "}
            <FormattedMessage
              id="sidebar.turns"
              defaultMessage="{count, plural, =0 {no turns} one {# turn} other {# turns}}"
              values={{ count: entry.turnCount }}
            />
          </span>
        </span>
      </button>
      <button
        type="button"
        className={`session-entry-menu ${bareButtonReset} cursor-pointer px-1.5 text-base leading-none rounded-md text-muted-foreground hover:bg-accent hover:text-foreground`}
        aria-label={intl.formatMessage({ id: "sidebar.menu.ariaLabel", defaultMessage: "Session actions" })}
        aria-expanded={menuOpen}
        disabled={disabled}
        onClick={onToggleMenu}
      >
        ⋯
      </button>
      {menuOpen && (
        <div
          className="session-menu absolute z-[5] right-1 top-full min-w-32 p-1 bg-card border border-border rounded-md shadow-md"
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            className={cn(sessionMenuItemBase, "text-foreground")}
            onClick={onRename}
          >
            <FormattedMessage id="sidebar.menu.rename" defaultMessage="Rename" />
          </button>
          {entry.sid && (
            <button
              type="button"
              role="menuitem"
              className={cn(sessionMenuItemBase, "text-foreground")}
              onClick={onClose}
            >
              <FormattedMessage id="common.close" defaultMessage="Close" />
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className={cn("danger", sessionMenuItemBase, "text-destructive")}
            onClick={onDelete}
          >
            <FormattedMessage id="common.delete" defaultMessage="Delete" />
          </button>
        </div>
      )}
    </li>
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
// by SessionSidebar in production, but the destructive-semantics + ESC routing
// contract is verified in isolation.
export function DeleteSessionDialog({
  name,
  path,
  onCancel,
  onConfirm,
}: {
  name: string;
  path: string;
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
        {path && <p className="text-muted-foreground text-xs break-all">{path}</p>}
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
// SessionSidebar in production, but the onOpenChange-to-onCancel bridge + blank
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
