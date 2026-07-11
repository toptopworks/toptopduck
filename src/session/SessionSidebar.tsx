import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
  buildSidebarGroups,
  type OpenSession,
  type SidebarEntry,
  type SidebarGroupKind,
} from "./sidebarModel";
import { DisclosureBanner } from "../components/DisclosureBanner";
import type { SessionMetadata } from "../types";

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
  softCap: number;
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
  softCap,
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
  const atSoftCap = openSessions.length >= softCap;

  const displayName = (name: string): string =>
    name || intl.formatMessage({ id: "session.defaultName", defaultMessage: "New session" });

  return (
    <aside className="session-sidebar" aria-label={intl.formatMessage({ id: "sidebar.ariaLabel", defaultMessage: "Sessions" })}>
      <button
        type="button"
        className="sidebar-new-button"
        disabled={disabled}
        onClick={onNew}
      >
        <FormattedMessage id="sidebar.newSession" defaultMessage="New session" />
      </button>

      {atSoftCap && (
        <p className="sidebar-softcap" role="status">
          <FormattedMessage
            id="sidebar.softCap"
            defaultMessage="Many sessions open — close some to free memory."
          />
        </p>
      )}

      {loadError && (
        <p className="sidebar-error muted">
          <FormattedMessage
            id="sidebar.loadError"
            defaultMessage="Could not load saved sessions."
          />
        </p>
      )}

      <ul className="session-list">
        {groups.map((group) => (
          <li key={group.kind} className="session-group">
            <h3 className="session-group-title">
              <GroupTitle kind={group.kind} />
            </h3>
            <ul className="session-group-list">
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
          <li className="session-empty muted">
            <FormattedMessage
              id="sidebar.empty"
              defaultMessage="No saved sessions yet."
            />
          </li>
        )}
      </ul>

      <details className="sidebar-disclosure">
        <summary className="muted">
          <FormattedMessage id="sidebar.privacy" defaultMessage="Privacy disclosure" />
        </summary>
        <DisclosureBanner />
      </details>

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
  return (
    <li
      className={`session-entry${entry.active ? " active" : ""}${entry.sid ? " open" : ""}`}
    >
      <button
        type="button"
        className="session-entry-main"
        aria-current={entry.active ? "true" : undefined}
        disabled={disabled}
        onClick={onActivate}
        title={entry.path ?? undefined}
      >
        <span className="session-name">{displayName}</span>
        <span className="session-subline muted">
          {entry.firstSourceName ?? "—"}
          {" · "}
          <FormattedMessage
            id="sidebar.turns"
            defaultMessage="{count, plural, =0 {no turns} one {# turn} other {# turns}}"
            values={{ count: entry.turnCount }}
          />
        </span>
      </button>
      <button
        type="button"
        className="session-entry-menu"
        aria-label={intl.formatMessage({ id: "sidebar.menu.ariaLabel", defaultMessage: "Session actions" })}
        aria-expanded={menuOpen}
        disabled={disabled}
        onClick={onToggleMenu}
      >
        ⋯
      </button>
      {menuOpen && (
        <div className="session-menu" role="menu">
          <button type="button" role="menuitem" onClick={onRename}>
            <FormattedMessage id="sidebar.menu.rename" defaultMessage="Rename" />
          </button>
          {entry.sid && (
            <button type="button" role="menuitem" onClick={onClose}>
              <FormattedMessage id="sidebar.menu.close" defaultMessage="Close" />
            </button>
          )}
          {entry.path && (
            <button type="button" role="menuitem" className="danger" onClick={onDelete}>
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
// Cancel is the safe escape and takes focus (autoFocus).
function DeleteSessionDialog({
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
    <div className="dialog-overlay" role="dialog" aria-modal="true">
      <div className="dialog-card delete-session-dialog">
        <h3>
          <FormattedMessage id="session.delete.title" defaultMessage="Delete this session?" />
        </h3>
        <p>
          <FormattedMessage
            id="session.delete.body"
            defaultMessage="“{name}” will be permanently deleted. This cannot be undone."
            values={{ name }}
          />
        </p>
        {path && <p className="muted session-delete-path">{path}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel} autoFocus>
            <FormattedMessage id="session.delete.cancel" defaultMessage="Cancel" />
          </button>
          <button type="button" className="danger" onClick={onConfirm}>
            <FormattedMessage id="session.delete.confirm" defaultMessage="Delete permanently" />
          </button>
        </div>
      </div>
    </div>
  );
}

// Rename dialog (ADR-0060, single entry point). Pre-fills the current name (or
// empty for a never-saved session); blank submit is refused (button disabled).
function RenameSessionDialog({
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
    <div className="dialog-overlay" role="dialog" aria-modal="true">
      <form
        className="dialog-card rename-session-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value);
        }}
      >
        <label className="muted">
          <FormattedMessage id="session.rename.label" defaultMessage="Session name" />
        </label>
        <input
          type="text"
          className="rename-session-input"
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            <FormattedMessage id="session.rename.cancel" defaultMessage="Cancel" />
          </button>
          <button type="submit" disabled={!value.trim()}>
            <FormattedMessage id="session.rename.save" defaultMessage="Save" />
          </button>
        </div>
      </form>
    </div>
  );
}
