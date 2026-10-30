import { useEffect, useRef, useState, type ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  SquarePen,
  Search,
  Settings,
} from "lucide-react";
import {
  buildArchivedEntries,
  buildSidebarModel,
  buildWorkspaceGroups,
  SIDEBAR_PREVIEW_CAP,
  type OpenSession,
  type SidebarEntry,
} from "./sidebarModel";
import { formatRelativeTime } from "./lastModifiedText";
import { resolveDisplayName } from "./displayName";
import { listWorkspaces } from "../api";
import { readSidebarExpansion, saveSidebarExpansion } from "./sidebarExpansion";
import { workspaceKeys } from "./queryKeys";
import { RowActionsMenu } from "./RowActionsMenu";
import {
  PILL_CLASS,
  ROW_SHELL_CLASS,
  SHOW_MORE_CLASS,
  WorkspaceSidebarSection,
} from "./WorkspaceSidebarSection";
import {
  useSidebarHoverCard,
  useSidebarHoverCardBridge,
  type SidebarHoverCardMachine,
} from "./sidebarHoverCard";
import type { SessionMetadata } from "../types/session";
import type { ProviderConfig } from "../types/provider";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { bareButtonReset } from "@/lib/buttonReset";
import { cn } from "@/lib/utils";

// The Chat-style session sidebar (ADR-0060, issue #81). Col 1 of the shell:
// lists every persisted recipe.json (ADR-0061 cold start) merged with the open
// keep-alive sessions, last-modified descending (#1401 retired the ADR-0060
// Chat-style time buckets -- the body is the single "Recent" section).
// ADR-0093 (issue #511): each row is pure navigation (title + conditional
// status dot), management actions moved to .session-header (slice 2, #512);
// ADR-0133 (issue #1319) returns the row-level actions to the row-end actions
// menu, the header menu keeping the active-session anchor.

// A frozen empty set so the optional prop's default keeps a stable identity
// (no every-render fresh Set -> SidebarRow prop churn).
const NO_PENDING_APPROVALS: ReadonlySet<string> = new Set();
// Same frozen-empty posture for the turn-failure set (issue #1005).
const NO_TURN_FAILURES: ReadonlySet<string> = new Set();

interface SessionSidebarProps {
  // Collapse state (ADR-0054 level 1, issue #287): when true the whole
  // subtree goes inert so keyboard / screen-reader focus cannot land on the
  // opacity-0 controls (ghost-focus fix). Drives the inert prop on the
  // <aside> shell; the opacity fade + grid-column animation stay in CSS.
  collapsed: boolean;
  sessions: SessionMetadata[];
  /** True once the first listSessions scan resolved (the hook's signal):
   *  rides down to the workspace section, whose landing diff must not read
   *  the scan's own arrival as new content. */
  sessionsLoaded: boolean;
  openSessions: OpenSession[];
  activeSessionId: string | null;
  disabled: boolean;
  loadError: string | null;
  /** Runtime sids with one or more UNANSWERED approvals (ADR-0083, issue
   *  #297): the matching entry rows carry the attention tint + dot so a
   *  suspended turn is visible from anywhere in the shell (the "unanswered
   *  badge coloring carries forced visibility" consequence). Keyed by runtime
   *  sid (the approval events' addressing), so only OPEN entries match -- a
   *  persisted-but-closed session can never hold a pending gate. */
  pendingApprovalSids?: ReadonlySet<string>;
  /** Runtime sids whose latest settled turn is Failed (issue #1005): the
   *  matching entry rows carry the error state -- a destructive status dot +
   *  sr-only label -- so a failed turn stays visible from anywhere in the
   *  shell. State-style, like the approval tint (ADR-0083): never cleared on
   *  activation; it extinguishes with the underlying state -- a newer turn
   *  landing non-Failed, a close, or a pane-level cache reset. Keyed by
   *  runtime sid, so only OPEN entries match. */
  turnFailedSids?: ReadonlySet<string>;
  /** The archived rows (ADR-0127 Decision 7, issue #1175): the caller's
   *  usePersistedSessions partitions the includeArchived scan into this
   *  while the view is visible; the hidden scan carries no archived rows,
   *  so this is [] whenever the view is hidden. The component additionally
   *  gates rendering on `showArchived` -- the props contract does not
   *  depend on the caller keeping the two in sync. */
  archivedSessions: SessionMetadata[];
  /** The archived view's visibility. NOT persisted (Decision 7: the peek
   *  semantics reset it to hidden on every startup). */
  showArchived: boolean;
  onNew: () => void;
  /** The workspace section's ⊕ shortcut (issue #1392): the shell stages
   *  the workspace binding (pendingWorkspace) and returns to the cold-start
   *  bar -- the next minted session binds it (the one-shot contract). */
  onNewInWorkspace: (path: string, label: string) => void;
  onActivate: (sid: string) => void;
  onOpenPersisted: (path: string, name: string) => void;
  /** Toggle the archived view's visibility (ADR-0127, issue #1175). */
  onToggleArchived: () => void;
  /** Pin/unpin (ADR-0127, issue #1175): mutation contract in
   *  useSessionFileOps (reject -> shell error surface, success -> refetch). */
  onSetPinned: (path: string, pinned: boolean) => void;
  /** Archive/restore (ADR-0127, issue #1175). `sid` is the row's runtime
   *  binding when archiving a MAIN-list row; restoring passes null (the
   *  archived row is never open -- open-is-unarchive, Decision 4). */
  onArchive: (path: string, archived: boolean, sid: string | null) => void;
  /** Row-menu delete (ADR-0133, issue #1319): the same deletePersisted
   *  contract as the header-menu delete, generalized to every row -- `sid`
   *  is the open binding when the row is open (the ADR-0063 wait-release
   *  close runs first), null for a cold persisted / archived row. The
   *  strong-confirm dialog lives in the row menu, the mutation in the
   *  caller. */
  onDelete: (path: string, sid: string | null) => void;
  /** Row-menu rename (ADR-0133, issue #1319): the renameEntry contract --
   *  an open row renames via its sid, a cold persisted row rewrites the
   *  recipe.json header in place by path. */
  onRename: (path: string, sid: string | null, newName: string) => void;
  /** Row-menu close (ADR-0133, issue #1319): open rows only. The shell
   *  callback (cancel + approval cleanup + draft drop) is the same one the
   *  header menu fires. */
  onClose: (sid: string) => void;
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
  sessionsLoaded,
  openSessions,
  activeSessionId,
  disabled,
  loadError,
  pendingApprovalSids = NO_PENDING_APPROVALS,
  turnFailedSids = NO_TURN_FAILURES,
  archivedSessions,
  showArchived,
  onNew,
  onNewInWorkspace,
  onActivate,
  onOpenPersisted,
  onToggleArchived,
  onSetPinned,
  onArchive,
  onDelete,
  onRename,
  onClose,
  onOpenSearch,
  provider,
  onOpenSettings,
  collapsed,
}: SessionSidebarProps) {
  const intl = useIntl();
  // Capture "now" and refresh every 60 s so the sidebar row relative-time
  // display (issue #513) stays current without calling Date.now in render
  // (react-hooks/purity); a cross-midnight drift refreshes on the next tick.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Single-flight hover-card machine (issue #1175, collected into
  // sidebarHoverCard.ts by issue #1325): one metadata card max, keyed by
  // row -- the full transition contract lives in the module's header.
  const hover = useSidebarHoverCard();

  // The workspace listing (issue #1392): the section's data face. The
  // query opts out of the app's staleTime: Infinity (ADR-0051) the same
  // way the selector does: this section's mutations and the App's mint
  // path invalidate this key explicitly (rename / remove / create / the
  // post-mint refresh), and staleTime 0 keeps every mount fresh besides.
  // The picker rides the same cache, so a rename / remove in either face
  // lands in both.
  const { data: workspaceList } = useQuery({
    queryKey: workspaceKeys.all(),
    queryFn: listWorkspaces,
    staleTime: 0,
  });
  const workspaceGroups = buildWorkspaceGroups(
    workspaceList ?? [],
    sessions,
    openSessions,
    activeSessionId,
  );
  // A bound session shows in ITS workspace subtree only (issue #1392): the
  // recent body holds the unbound remainder -- "remove from list" drops the
  // record and the group's sessions fall back to this body.
  const explicitPaths = new Set(workspaceGroups.map((g) => g.path));
  const isWorkspaceBound = (m: SessionMetadata) =>
    m.workspace !== null && explicitPaths.has(m.workspace);
  const recentSessions = sessions.filter((m) => !isWorkspaceBound(m));
  // The open side of the same partition: an open session whose persisted row
  // is bound already renders in its workspace group -- passing the full open
  // list would let the model's not-yet-persisted loop resurrect it in the
  // recent body for as long as the session stays open. Open rows whose
  // persisted scan hasn't landed yet stay here (no persisted row exists yet,
  // so the bound-path filter cannot exclude them), so a just-minted session
  // is visible during the refetch window.
  const workspaceBoundPaths = new Set(
    sessions.filter(isWorkspaceBound).map((m) => m.recipe_path),
  );
  const recentOpenSessions = openSessions.filter(
    (o) => !workspaceBoundPaths.has(o.path),
  );

  const model = buildSidebarModel(recentSessions, recentOpenSessions, activeSessionId, now);
  const archivedEntries = showArchived ? buildArchivedEntries(archivedSessions) : [];

  // Section-level folds + preview expansion (issue #1392): the folds persist
  // across restarts (issue #1404 -- the #1392 "session-only" ruling flips
  // here); the preview expansion stays per-expansion and is never written.
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(
    () => readSidebarExpansion().collapsedSections,
  );
  const [showAllSections, setShowAllSections] = useState<ReadonlySet<string>>(new Set());
  // Collapsing a section resets its preview, same rule as the workspace
  // groups: "Show more" is a per-expansion choice, not a sticky one.
  const toggleSection = (key: string) => {
    const next = new Set(collapsedSections);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsedSections(next);
    saveSidebarExpansion({ collapsedSections: next });
    if (!collapsedSections.has(key)) {
      const rest = new Set(showAllSections);
      rest.delete(key);
      setShowAllSections(rest);
    }
  };

  // The section render plan (ADR-0127, issue #1175; the three-section
  // navigation rides issue #1392): pinned → workspaces (always present) →
  // the recent body → archived, the rest only when they have content. The
  // chrome (the archived-visibility toggle; #1401 retired the grouping
  // toggle with the time buckets) rides the RECENT section's title row --
  // the first section keeps it reachable whenever recent is absent
  // (workspace-bound-only, pinned-only, or the empty sidebar).
  type SidebarSection =
    | { key: string; title: ReactNode; entries: SidebarEntry[]; variant: "main" | "archived"; capped: boolean }
    | { key: "workspaces"; variant: "workspaces" };
  const sections: SidebarSection[] = [];
  if (model.pinned.length > 0) {
    sections.push({
      key: "pinned",
      title: <FormattedMessage id="sidebar.group.pinned" defaultMessage="Pinned" />,
      entries: model.pinned,
      variant: "main",
      capped: false,
    });
  }
  // The workspaces section is PERMANENT: zero groups still renders the head
  // (with the count) + the empty hint, so the three-section order and the
  // chrome anchor stay stable on an otherwise-empty sidebar.
  sections.push({ key: "workspaces", variant: "workspaces" });
  if (model.recent.length > 0) {
    sections.push({
      key: "recent",
      title: <FormattedMessage id="sidebar.group.recent" defaultMessage="Recent" />,
      entries: model.recent,
      variant: "main",
      capped: true,
    });
  }
  if (archivedEntries.length > 0) {
    sections.push({
      key: "archived",
      title: <FormattedMessage id="sidebar.group.archived" defaultMessage="Archived" />,
      entries: archivedEntries,
      variant: "archived",
      capped: false,
    });
  }

  // One chrome element, one anchor (issue #1175, re-anchored): the
  // archived-visibility toggle rides the RECENT section's title row -- the
  // visibility it controls is the recent body's, so the control lives
  // there; the first section takes it only when recent is absent
  // (workspace-bound-only, pinned-only, or the empty sidebar), keeping the
  // single instance alive in every state.
  const sectionChrome = (
    <ArchivedToggle
      visible={showArchived}
      disabled={disabled}
      onToggle={onToggleArchived}
    />
  );
  const chromeIndex = sections.findIndex((s) => s.key === "recent");
  const chromeAnchorIndex = chromeIndex === -1 ? 0 : chromeIndex;

  // One row-render channel for every section body (issue #1392: the
  // workspace subtrees render the EXACT same rows as the recent body --
  // same SidebarRow, same actions menu, same hover-card machine).
  const renderRows = (entries: SidebarEntry[], archived: boolean) =>
    entries.map((entry) => (
      <SidebarRow
        key={entry.key}
        entry={entry}
        displayName={resolveDisplayName(entry.name, intl)}
        now={now}
        hasPendingApproval={
          entry.sid !== null && pendingApprovalSids.has(entry.sid)
        }
        hasTurnFailed={
          entry.sid !== null && turnFailedSids.has(entry.sid)
        }
        disabled={disabled}
        archived={archived}
        hover={hover}
        onActivate={() => {
          if (entry.sid) onActivate(entry.sid);
          else onOpenPersisted(entry.path, entry.name);
        }}
        menu={(
          <RowActionsMenu
            entry={entry}
            displayName={resolveDisplayName(entry.name, intl)}
            disabled={disabled}
            archived={archived}
            onSetPinned={onSetPinned}
            onArchive={onArchive}
            onRename={onRename}
            onClose={onClose}
            onDelete={onDelete}
            onMenuOpenChange={(open) => hover.menuOpenChange(entry.key, open)}
          />
        )}
      />
    ));

  const renderSection = (
    section: (typeof sections)[number],
    showChrome: boolean,
  ) => {
    if (section.variant === "workspaces") {
      return (
        <WorkspaceSidebarSection
          key={section.key}
          groups={workspaceGroups}
          sessions={sessions}
          sessionsLoaded={sessionsLoaded}
          disabled={disabled}
          collapsed={collapsedSections.has(section.key)}
          onToggleCollapsed={() => toggleSection(section.key)}
          renderRows={(entries) => renderRows(entries, false)}
          onNewInWorkspace={onNewInWorkspace}
          chrome={showChrome ? sectionChrome : undefined}
        />
      );
    }
    // The section preview cap (issue #1392): the recent body shows its
    // freshest 5 rows, a "Show more (N)" tail expands the rest. The
    // pinned / archived sections are uncapped.
    const collapsed = collapsedSections.has(section.key);
    const capped =
      section.capped &&
      !showAllSections.has(section.key) &&
      section.entries.length > SIDEBAR_PREVIEW_CAP;
    const shown = capped
      ? section.entries.slice(0, SIDEBAR_PREVIEW_CAP)
      : section.entries;
    return (
      <li key={section.key} className="session-group mt-3 mb-1" data-section={section.key}>
        {/* The chrome (the archived-visibility toggle, ADR-0127) rides the
            RECENT section's title row (the first section's when recent is
            absent) -- one entry point for every sidebar state. The trigger
            is hover-revealed (group-hover) but
            stays focus-visible for AT users; the pressed state also pins it
            visible via aria-pressed. */}
        <div className="session-group-title-row group relative mb-0.5 flex items-center justify-between px-1">
          {/* The title row itself is the fold toggle (the whole row clicks):
              the button sits inside the h3 (legal phrasing nesting) and
              stretches full-width; the chevron rides the label's tail,
              hover/focus-revealed -- at rest the row is just the label. */}
          <h3 className="session-group-title min-w-0 flex-1 text-xs uppercase tracking-wider text-muted-foreground">
            <button
              type="button"
              aria-expanded={!collapsed}
              onClick={() => toggleSection(section.key)}
              className="flex w-full items-center gap-0.5 rounded text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span className="truncate">{section.title}</span>
              <span className="shrink-0 tabular-nums">({section.entries.length})</span>
              <span
                aria-hidden
                className="shrink-0 opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100"
              >
                {collapsed ? (
                  <ChevronRight className="size-3.5" />
                ) : (
                  <ChevronDown className="size-3.5" />
                )}
              </span>
            </button>
          </h3>
          {showChrome && sectionChrome}
        </div>
        {!collapsed && (
          <ul className="session-group-list list-none m-0 pb-2 pt-1">
            {renderRows(shown, section.variant === "archived")}
            {capped && (
              <li className="my-0.5">
                <button
                  type="button"
                  className={SHOW_MORE_CLASS}
                  onClick={() =>
                    setShowAllSections((prev) => new Set(prev).add(section.key))}
                >
                  <FormattedMessage
                    id="sidebar.showMore"
                    defaultMessage="Show more ({count})"
                    values={{ count: section.entries.length - SIDEBAR_PREVIEW_CAP }}
                  />
                </button>
              </li>
            )}
          </ul>
        )}
      </li>
    );
  };

  // One read feeds both the gear's aria-label and its tooltip -- the last
  // remaining aria-and-tooltip descriptor double-write in the tree collapses
  // to a single variable (issue #960).
  const settingsLabel = intl.formatMessage({
    id: "header.settings",
    defaultMessage: "Settings",
  });

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
          className="sidebar-search-button inline-flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-progress disabled:opacity-50"
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
        className="sidebar-new-button mb-2 flex w-full items-center gap-1.5 rounded-md bg-secondary px-2 py-1 text-sm text-secondary-foreground hover:bg-accent disabled:opacity-60 disabled:cursor-progress"
        disabled={disabled}
        onClick={onNew}
      >
        <SquarePen className="size-3.5 shrink-0" aria-hidden />
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

      <ul className="session-list" onPointerLeave={hover.listLeave}>
        {sections.map((section, i) => renderSection(section, i === chromeAnchorIndex))}
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
                aria-label={settingsLabel}
                onClick={onOpenSettings}
              >
                <Settings className="size-4" aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{settingsLabel}</TooltipContent>
          </Tooltip>
        </div>
      )}
    </aside>
  );
}

// The archived-view visibility toggle (ADR-0127 Decision 7, issue #1175): an
// icon-only aria-pressed button. Hover-revealed posture (opacity-0; visible
// on hover / focus / pressed, the pressed state keeping the active view's
// entry point findable). The state is NEVER persisted -- every startup resets
// the archived view to hidden.
function ArchivedToggle({
  visible,
  disabled,
  onToggle,
}: {
  visible: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const intl = useIntl();
  const label = intl.formatMessage({
    id: "sidebar.archived.toggle.ariaLabel",
    defaultMessage: "Show archived sessions",
  });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            `sidebar-archived-toggle ${bareButtonReset} rounded-md p-1 text-muted-foreground`,
            "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
            "aria-pressed:opacity-100 aria-pressed:text-foreground",
            "hover:bg-accent hover:text-foreground",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            "disabled:cursor-progress disabled:opacity-50",
          )}
          aria-pressed={visible}
          aria-label={label}
          disabled={disabled}
          onClick={onToggle}
        >
          <Archive className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

// One sidebar row: navigation + inline metadata (ADR-0093, issue #511/#513).
// The row carries the session title, a conditional status dot, and a compact
// relative-time span. Management actions lived in .session-header from
// ADR-0093 (slice 2) until ADR-0133 returned them to the row-end actions
// menu; the persistent sub-line (first source + turn count) is retired in
// favor of a HoverCard (slice 3, this change).
// ADR-0127 (issue #1175): the row is a main activate BUTTON plus a trailing
// SIBLING slot -- buttons cannot nest, so the whole-row button split. ADR-0133
// (issue #1319) retired the inline action buttons for a single row-end `⋯`
// menu in that slot (RowActionsMenu): still the ROW_ACTIONS_OVERLAY posture
// -- an absolute accent pill floating over the row tail with ZERO flex
// footprint (a flow-laid group would squeeze the truncating session name),
// revealed on row hover or focus-visible; opacity-0 + pointer-events-none
// keeps the trigger in the tab order (unlike visibility:hidden), so keyboard
// focus reveals the pill and the row stays keyboard reachable.
function SidebarRow({
  entry,
  displayName,
  now,
  hasPendingApproval,
  hasTurnFailed,
  disabled,
  archived = false,
  onActivate,
  menu,
  hover,
}: {
  entry: SidebarEntry;
  displayName: string;
  /** Refreshed every 60 s by SessionSidebar for the relative-time display. */
  now: number;
  /** The session holds an unanswered approval (ADR-0083, issue #297): the
   *  status dot flips to warning color + an sr-only label so a suspended turn
   *  stays visible while the user works in another session. */
  hasPendingApproval: boolean;
  /** The session's latest settled turn is Failed (issue #1005): the status
   *  dot flips to destructive + an sr-only label, same visibility contract
   *  as the approval tint. Lower priority than the approval tint: when both
   *  hold, the approval dot + label win (the classes coexist on the row). */
  hasTurnFailed: boolean;
  disabled: boolean;
  /** Archived-view variant (ADR-0127 Decision 7): the main button is
   *  non-activatable (aria-disabled + an activation guard) + muted --
   *  archived means gone from the browsing surface -- while the HoverCard
   *  metadata stays (read-only viewing is not activation). NOT the
   *  `disabled` attribute: a disabled control stops dispatching pointer
   *  events in real browsers, which would silently kill the HoverCard
   *  (jsdom cannot catch that); aria-disabled keeps the hover alive and
   *  tells AT the row is inert. */
  archived?: boolean;
  onActivate: () => void;
  /** The row-end actions menu (ADR-0133, issue #1319), built by the section
   *  renderer: one RowActionsMenu per row in every row state. */
  menu: ReactNode;
  /** The row's view of the list-level single-flight hover machine
   *  (sidebarHoverCard.ts, issue #1325): the bridge hook derives this row's
   *  handlers + controlled card open from it -- the full intent-classifying
   *  contract lives in the module's header. */
  hover: SidebarHoverCardMachine;
}) {
  const intl = useIntl();
  // The li ref stays with the row (it renders the element); the bridge uses
  // it for the native pointerleave backstop (see sidebarHoverCard.ts).
  const liRef = useRef<HTMLLIElement | null>(null);
  const bridge = useSidebarHoverCardBridge(hover, entry.key, liRef);

  // ADR-0093 (issue #511): the MessageSquare leading icon + the inset shadow
  // left bar are retired. Active = accent background only; open = status dot
  // (primary green / warning when pending approval); not-open = equal-width
  // placeholder so titles stay left-aligned across all rows. The active/open
  // booleans also stay as classes on the parent .session-entry hook for
  // selector / test stability.
  //
  // ADR-0093 slice 3 (issue #513): the row is wrapped in a HoverCard so hover
  // or keyboard focus surfaces the full metadata (title + source summary +
  // turn count) in a fixed-width card positioned to the right. Sweep flicker
  // is prevented by the machine's 300 ms open dwell, not by Radix's
  // openDelay, which is pinned to 0 under the controlled open.
  return (
    <HoverCard
      open={bridge.cardOpen}
      openDelay={0}
      closeDelay={0}
      onOpenChange={bridge.hoverOpenChange}
    >
      <HoverCardTrigger asChild>
        <li
          ref={liRef}
          {...bridge.liProps}
          className={cn(
            ROW_SHELL_CLASS,
            entry.active && "active bg-accent",
            entry.sid && "open",
            hasPendingApproval && "pending-approval",
            hasTurnFailed && "turn-failed",
            archived && "archived",
          )}
          data-pending-approval={hasPendingApproval ? "true" : undefined}
          data-turn-failed={hasTurnFailed ? "true" : undefined}
        >
          <button
            type="button"
            className={cn(
              `session-entry-main ${bareButtonReset} flex-1 flex flex-row items-center gap-1.5 min-w-0 py-1.5 px-2 text-foreground`,
              "disabled:opacity-50",
              // No background / radius here: the row li owns them. The
              // absolute action pill intercepts the pointer over the row
              // tail, so a button-level :hover would drop the background the
              // moment the cursor reaches the pill (same posture as
              // WorkingSetList's row-level hover:bg-accent).
              !archived && "disabled:cursor-progress",
              archived && "cursor-default text-muted-foreground",
              entry.active && "text-accent-foreground",
            )}
            aria-current={entry.active ? "true" : undefined}
            aria-disabled={archived || undefined}
            disabled={disabled}
            onClick={(e) => {
              if (archived) return;
              e.currentTarget.blur();
              onActivate();
            }}
          >
            <span className="session-name flex-1 min-w-0 text-left text-sm truncate">
              {displayName}
              {/* Highest priority wins (issue #1005): the approval label
                    outranks the failure label when both states hold. Static
                    literal ids only -- a ternary id would break the
                    i18n:check CI gate. */}
              {hasPendingApproval ? (
                <span className="sr-only">
                  <FormattedMessage
                    id="sidebar.pendingApproval"
                    defaultMessage="(awaiting approval)"
                  />
                </span>
              ) : hasTurnFailed ? (
                <span className="sr-only">
                  <FormattedMessage
                    id="sidebar.turnFailed"
                    defaultMessage="(last turn failed)"
                  />
                </span>
              ) : null}
            </span>
            {/* Status dot on the right edge (ADR-0093): open = primary dot,
                  pending approval = warning dot, turn failed = destructive
                  dot, not-open = no dot. Priority approval > failure > plain
                  open; the row classes coexist, the dot + label take the
                  highest (issue #1005). shrink-0 prevents truncation from
                  consuming the dot. */}
            {entry.sid && (
              <span
                className={cn(
                  "sidebar-status-dot inline-block h-2 w-2 shrink-0 rounded-full",
                  hasPendingApproval
                    ? "bg-warning"
                    : hasTurnFailed
                      ? "bg-destructive"
                      : "bg-primary",
                )}
                aria-hidden="true"
              />
            )}
            {/* The pill's opaque 28px ground is narrower than this label
                (e.g. "11个月"), so once the pill shows the label's tail would
                peek out beside the trigger -- hide the label under the SAME
                two reveal conditions (row hover / focus inside the pill). */}
            <span className="text-xs text-muted-foreground shrink-0 tabular-nums group-hover/row:opacity-0 group-has-[.session-entry-actions_:focus-visible]/row:opacity-0">
              {formatRelativeTime(entry.lastModifiedAt, now, intl.locale)}
            </span>
          </button>
          <div className={PILL_CLASS}>
            {menu}
          </div>
        </li>
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        className="data-[state=open]:animate-none! data-[state=closed]:animate-none!"
        {...bridge.cardProps}
      >
        <SidebarRowHoverContent
          entry={entry}
          displayName={displayName}
        />
      </HoverCardContent>
    </HoverCard>
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
