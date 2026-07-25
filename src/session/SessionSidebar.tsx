import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { MessageSquare, Pencil, Search } from "lucide-react";
import {
  buildSidebarGroups,
  type OpenSession,
  type SidebarEntry,
  type SidebarGroupKind,
} from "./sidebarModel";
import type { SessionMetadata } from "../types/session";
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
import { cn } from "@/lib/utils";

// Group heading (ADR-0060 Chat-style Today/Yesterday/Previous-7-days/Older). Each branch is a
// STATIC-literal <FormattedMessage> call site so @formatjs/cli extract resolves
// the id (a template-literal id would break the i18n:check CI gate).
function GroupTitle({ kind }: { kind: SidebarGroupKind }) {
  switch (kind) {
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

interface SessionSidebarProps {
  sessions: SessionMetadata[];
  openSessions: OpenSession[];
  activeSessionId: string | null;
  disabled: boolean;
  loadError: string | null;
  onNew: () => void;
  onActivate: (sid: string) => void;
  onOpenPersisted: (path: string, name: string) => void;
  onClose: (sid: string) => void;
  onDelete: (path: string, sid: string | null) => void;
  onRename: (sid: string | null, path: string | null, newName: string) => void;
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
  onNew,
  onActivate,
  onOpenPersisted,
  onClose,
  onDelete,
  onRename,
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
  );
  const displayName = (name: string): string =>
    name || intl.formatMessage({ id: "session.defaultName", defaultMessage: "New session" });

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
    >
      {/* ADR-0072 (issue #250): the top is rebuilt into a brand title row + a
          New icon button row, retiring the ADR-0060 full-width solid teal New
          button. Brand title row = product name left + circular search
          magnifier right (placeholder; the search modal arrives in a later
          slice). The New button drops the solid primary fill for a fused
          bg-secondary, matching the row tint visual language. */}
      <div className="sidebar-brand-row mb-2 flex items-center justify-between">
        <span className="sidebar-brand text-sm font-semibold text-foreground">
          <FormattedMessage id="sidebar.brand" defaultMessage="TOPTOPDuck" />
        </span>
        <button
          type="button"
          className="sidebar-search-button inline-flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={intl.formatMessage({
            id: "sidebar.search.ariaLabel",
            defaultMessage: "Search sessions",
          })}
        >
          <Search className="size-4" aria-hidden />
        </button>
      </div>
      <button
        type="button"
        className="sidebar-new-button mb-2 flex w-full cursor-pointer items-center gap-1.5 rounded-md bg-secondary p-2 text-sm text-secondary-foreground hover:bg-accent disabled:opacity-60 disabled:cursor-progress"
        disabled={disabled}
        onClick={onNew}
      >
        <Pencil className="size-4 shrink-0" aria-hidden />
        <FormattedMessage id="sidebar.newSession" defaultMessage="New session" />
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
        {groups.map((group) => (
          <li key={group.kind} className="session-group mt-1.5 mb-0.5">
            <h3 className="session-group-title mb-0.5 px-1 text-xs uppercase tracking-wider text-muted-foreground">
              <GroupTitle kind={group.kind} />
            </h3>
            <ul className="session-group-list list-none m-0 p-0">
              {group.entries.map((entry) => (
                <SidebarRow
                  key={entry.key}
                  entry={entry}
                  displayName={displayName(entry.name)}
                  menuOpen={openMenuKey === entry.key}
                  disabled={disabled}
                  onToggleMenu={() =>
                    setOpenMenuKey((cur) => (cur === entry.key ? null : entry.key))}
                  onActivate={() => {
                    setOpenMenuKey(null);
                    if (entry.sid) onActivate(entry.sid);
                    else if (entry.path) onOpenPersisted(entry.path, entry.name);
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
          name={displayName(pendingAction.entry.name)}
          path={pendingAction.entry.path}
          onCancel={() => setPendingAction(null)}
          onConfirm={() => {
            // Delete only enters this dialog from an entry with a path (the menu
            // renders Delete solely when entry.path is set); guard for the type.
            if (pendingAction.entry.path) {
              onDelete(pendingAction.entry.path, pendingAction.entry.sid);
            }
            setPendingAction(null);
          }}
        />
      )}
    </aside>
  );
}

// The session-menu item base (ADR-0067, issue #171): inline utilities
// replacing the retired .session-menu button CSS rule. Composed per item via
// cn() so the danger variant swaps text-foreground -> text-destructive
// without copy-paste drift across the three items.
const sessionMenuItemBase =
  "[all:unset] cursor-pointer block w-full py-1 px-2 rounded-md text-sm hover:bg-accent";

// One sidebar row: the session name (click to activate/open) + a sub-line
// (first source + turn count) + a context-menu toggle. The menu is the single
// entry point for rename / close / delete (ADR-0060 DRY).
function SidebarRow({
  entry,
  displayName,
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
  menuOpen: boolean;
  disabled: boolean;
  onToggleMenu: () => void;
  onActivate: () => void;
  onRename: () => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const intl = useIntl();
  // Entry states ride inline utilities over the ADR-0050 token (ADR-0060,
  // refined by ADR-0072 issue #249): active = accent tint + the 2px left bar;
  // open-but-not-active = the bar only; default = no signal. ADR-0072 retires
  // the ADR-0060 full-row teal fill. The active/open booleans also stay as
  // classes on the parent .session-entry hook for selector / test stability.
  return (
    <li
      className={cn(
        "session-entry relative my-0.5 flex items-stretch",
        entry.active && "active",
        entry.sid && "open",
      )}
    >
      <button
        type="button"
        className={cn(
          "session-entry-main [all:unset] cursor-pointer flex-1 flex flex-row items-center gap-1.5 min-w-0 py-1.5 px-2 rounded-md text-foreground",
          "hover:bg-accent disabled:opacity-50 disabled:cursor-progress",
          entry.sid && "shadow-[inset_2px_0_var(--primary)]",
          entry.active && "bg-accent text-accent-foreground",
        )}
        aria-current={entry.active ? "true" : undefined}
        disabled={disabled}
        onClick={onActivate}
        title={entry.path ?? undefined}
      >
        {/* ADR-0072 (issue #249): unified leading chat-bubble glyph on every
            row, replacing the persisted/not Database/CircleDot split. */}
        <MessageSquare className="size-4 shrink-0" aria-hidden />
        <span className="flex-1 min-w-0 flex flex-col">
          <span className="session-name text-sm truncate">{displayName}</span>
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
        className="session-entry-menu [all:unset] cursor-pointer px-1.5 text-base leading-none rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
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
              <FormattedMessage id="sidebar.menu.close" defaultMessage="Close" />
            </button>
          )}
          {entry.path && (
            <button
              type="button"
              role="menuitem"
              className={cn("danger", sessionMenuItemBase, "text-destructive")}
              onClick={onDelete}
            >
              <FormattedMessage id="sidebar.menu.delete" defaultMessage="Delete" />
            </button>
          )}
        </div>
      )}
    </li>
  );
}

// Strong-confirm delete dialog (ADR-0060, issue #81): deletion is irreversible,
// so the dialog names the .duck explicitly and requires an explicit confirm.
// The shell is now a Radix AlertDialog (issue #105): role="alertdialog" +
// focus-trap + scroll-lock come from the primitive. AlertDialog semantics
// intentionally do NOT dismiss on ESC or overlay click -- the user must take an
// explicit Cancel / Delete action, matching the prior hand-written overlay (no
// overlay-click close). Cancel renders before Action so Radix auto-focuses it
// (the safe escape), preserving the prior autoFocus behavior. The destructive
// Action passes buttonVariants({ variant: "destructive" }); twMerge (in cn) lets
// it override AlertDialogAction's built-in default variant, reusing the
// destructive look without forking the copy-in component.
// Exported for component-level testing (issue #111); the dialog is rendered only
// by SessionSidebar in production, but the destructive-semantics + routing
// contract is verified in isolation.
export function DeleteSessionDialog({
  name,
  path,
  onCancel,
  onConfirm,
}: {
  name: string;
  path: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog defaultOpen>
      <AlertDialogContent>
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
              <FormattedMessage id="session.rename.save" defaultMessage="Save" />
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
