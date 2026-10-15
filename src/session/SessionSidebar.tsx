import { useEffect, useRef, useState, type ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
  Archive,
  ArchiveRestore,
  Check,
  Pencil,
  Pin,
  PinOff,
  Search,
  Settings,
  Trash2,
} from "lucide-react";
import {
  buildArchivedEntries,
  buildSidebarModel,
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
// status dot). Management actions (rename / close / delete) moved to
// .session-header (slice 2, #512).

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
  onActivate: (sid: string) => void;
  onOpenPersisted: (path: string, name: string) => void;
  onSwitchGrouping: (mode: SidebarGrouping) => void;
  /** Toggle the archived view's visibility (ADR-0127, issue #1175). */
  onToggleArchived: () => void;
  /** Pin/unpin (ADR-0127, issue #1175): mutation contract in
   *  useSessionFileOps (reject -> shell error surface, success -> refetch). */
  onSetPinned: (path: string, pinned: boolean) => void;
  /** Archive/restore (ADR-0127, issue #1175). `sid` is the row's runtime
   *  binding when archiving a MAIN-list row; restoring passes null (the
   *  archived row is never open -- open-is-unarchive, Decision 4). */
  onArchive: (path: string, archived: boolean, sid: string | null) => void;
  /** Delete an archived row (ADR-0127 Decision 6): routes through the same
   *  deletePersisted contract as the header-menu delete -- always the pure
   *  path variant here, since an archived row never carries a sid
   *  (open-is-unarchive); the confirm dialog lives in this component, the
   *  mutation in the caller. */
  onDeleteArchived: (path: string) => void;
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
  turnFailedSids = NO_TURN_FAILURES,
  archivedSessions,
  showArchived,
  onNew,
  onActivate,
  onOpenPersisted,
  onSwitchGrouping,
  onToggleArchived,
  onSetPinned,
  onArchive,
  onDeleteArchived,
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

  // The archived-row delete target (ADR-0127 Decision 6): the strong-confirm
  // dialog state lives here; the mutation rides onDeleteArchived on confirm.
  const [deleteTarget, setDeleteTarget] = useState<{
    path: string;
    name: string;
  } | null>(null);

  // Single-flight hover-card state (issue #1175): the OPEN key is owned HERE,
  // not per row, so at most one metadata card exists at any moment -- moving
  // to a new row swaps the card (unmounting the old portal) instead of
  // stacking fading ones behind the pointer. A per-row boolean cannot
  // guarantee that: a pointerleave lost to the pill's pointer-events toggling
  // strands that row's card open forever; here a lost leave self-heals the
  // moment any other row is entered, and the list-level leave is the final
  // backstop. Delays keep the old posture: 300 ms to open (sweep-proof),
  // 200 ms grace on leave (cancelled by entering the card itself -- read-only
  // per ADR-0127, but the pointer may still sweep onto it to read).
  //
  // hoverKey rides a ref, not state: render consumes only cardKey (the shown
  // card), while hoverKey feeds the stale-leave guard and the list backstop
  // -- handler-only reads. State here would re-render every row at
  // pointer-crossing frequency with no visible change.
  const hoverKeyRef = useRef<string | null>(null);
  const [cardKey, setCardKey] = useState<string | null>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const clearHoverTimers = () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  };
  const rowHoverEnter = (key: string) => {
    clearHoverTimers();
    hoverKeyRef.current = key;
    // Entering a DIFFERENT row retires the shown card immediately. The
    // 200 ms close grace belongs to the row->card read path only; clearing
    // the previous row's leave timer without this kept the OLD card on
    // screen the whole time the pointer traveled (each new row's enter
    // cancelled the pending close, and the new card only opens after a
    // 300 ms dwell) -- the card must vanish while moving and reappear
    // only once the pointer settles.
    if (cardKey !== null && cardKey !== key) setCardKey(null);
    openTimer.current = window.setTimeout(() => setCardKey(key), 300);
  };
  const rowHoverLeave = (key: string) => {
    // A stale leave from a row the pointer already left is ignored.
    if (hoverKeyRef.current !== key) return;
    clearHoverTimers();
    hoverKeyRef.current = null;
    closeTimer.current = window.setTimeout(() => setCardKey(null), 200);
  };
  const cardHoverEnter = () => window.clearTimeout(closeTimer.current);
  // Leaving the CARD schedules its own close -- it must NOT reuse
  // rowHoverLeave: by the time the pointer reached the card, the row's
  // leave already nulled hoverKey, so rowHoverLeave's stale-key guard would
  // swallow the close and strand the card open forever.
  const cardHoverLeave = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setCardKey(null), 200);
  };
  useEffect(() => clearHoverTimers, []);

  const model = buildSidebarModel(
    sessions,
    openSessions,
    activeSessionId,
    now,
    grouping,
  );
  const archivedEntries = showArchived ? buildArchivedEntries(archivedSessions) : [];

  // The section render plan (ADR-0127, issue #1175): the pinned section rides
  // above the grouped body in BOTH grouping modes (server order), then the
  // grouped body, then the archived section (only while the view is visible).
  // The chrome pair (GroupingToggle + the archived-visibility toggle) rides
  // the FIRST rendered section's title row; with zero sections (an empty
  // sidebar) it still renders on a bare title row so the archived view stays
  // reachable when every session is archived (the default list is empty then,
  // and without an entry point the archived rows would be unreachable).
  const sections: Array<{
    key: string;
    title: ReactNode;
    entries: SidebarEntry[];
    variant: "main" | "archived";
  }> = [];
  if (model.pinned.length > 0) {
    sections.push({
      key: "pinned",
      title: <FormattedMessage id="sidebar.group.pinned" defaultMessage="Pinned" />,
      entries: model.pinned,
      variant: "main",
    });
  }
  for (const g of model.groups) {
    sections.push({ key: g.kind, title: <GroupTitle kind={g.kind} />, entries: g.entries, variant: "main" });
  }
  if (archivedEntries.length > 0) {
    sections.push({
      key: "archived",
      title: <FormattedMessage id="sidebar.group.archived" defaultMessage="Archived" />,
      entries: archivedEntries,
      variant: "archived",
    });
  }

  // One chrome pair, two anchors (issue #1175): the grouping toggle rides
  // the FIRST rendered section's title row; on a zero-section sidebar it
  // renders on the bare fallback row instead. A single element instance is
  // safe to reuse -- the two anchors are mutually exclusive branches, so
  // only one GroupingToggle/ArchivedToggle instance ever mounts.
  const sectionChrome = (
    <div className="flex items-center gap-0.5">
      <GroupingToggle
        grouping={grouping}
        disabled={disabled}
        onSwitch={onSwitchGrouping}
      />
      <ArchivedToggle
        visible={showArchived}
        disabled={disabled}
        onToggle={onToggleArchived}
      />
    </div>
  );

  const renderSection = (
    section: (typeof sections)[number],
    showChrome: boolean,
  ) => (
    <li key={section.key} className="session-group mt-1.5 mb-0.5" data-section={section.key}>
      {/* ADR-0072 (#251): the grouping toggle rides the FIRST rendered
          section's title row -- one entry point regardless of mode. The
          archived-visibility toggle (ADR-0127) sits beside it. The triggers
          are hover-revealed (group-hover) but stay focus-visible for AT
          users; the open popover also pins it visible via data-[state=open]. */}
      <div className="session-group-title-row group relative mb-0.5 flex items-center justify-between px-1">
        <h3 className="session-group-title text-xs uppercase tracking-wider text-muted-foreground">
          {section.title}
        </h3>
        {showChrome && sectionChrome}
      </div>
      <ul className="session-group-list list-none m-0 p-0">
        {section.entries.map((entry) => (
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
            archived={section.variant === "archived"}
            cardOpen={cardKey === entry.key}
            onHoverEnter={() => rowHoverEnter(entry.key)}
            onHoverLeave={() => rowHoverLeave(entry.key)}
            onCardEnter={cardHoverEnter}
            onCardLeave={cardHoverLeave}
            onActivate={() => {
              if (entry.sid) onActivate(entry.sid);
              else onOpenPersisted(entry.path, entry.name);
            }}
            actions={
              section.variant === "archived" ? (
                <>
                  <RowActionButton
                    label={intl.formatMessage({
                      id: "sidebar.row.restore",
                      defaultMessage: "Restore",
                    })}
                    disabled={disabled}
                    onClick={() => onArchive(entry.path, false, null)}
                  >
                    <ArchiveRestore className="size-3.5" aria-hidden />
                  </RowActionButton>
                  <RowActionButton
                    label={intl.formatMessage({
                      id: "sidebar.row.delete",
                      defaultMessage: "Delete",
                    })}
                    disabled={disabled}
                    onClick={() => setDeleteTarget({ path: entry.path, name: entry.name })}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </RowActionButton>
                </>
              ) : (
                <>
                  <RowActionButton
                    label={
                      entry.pinned
                        ? intl.formatMessage({ id: "sidebar.row.unpin", defaultMessage: "Unpin" })
                        : intl.formatMessage({ id: "sidebar.row.pin", defaultMessage: "Pin" })
                    }
                    disabled={disabled}
                    onClick={() => onSetPinned(entry.path, !entry.pinned)}
                  >
                    {entry.pinned ? (
                      <PinOff className="size-3.5" aria-hidden />
                    ) : (
                      <Pin className="size-3.5" aria-hidden />
                    )}
                  </RowActionButton>
                  <RowActionButton
                    label={intl.formatMessage({
                      id: "sidebar.row.archive",
                      defaultMessage: "Archive",
                    })}
                    disabled={disabled}
                    onClick={() => onArchive(entry.path, true, entry.sid)}
                  >
                    <Archive className="size-3.5" aria-hidden />
                  </RowActionButton>
                </>
              )
            }
          />
        ))}
      </ul>
    </li>
  );

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

      {loadError && (
        <p className="sidebar-error text-muted-foreground mb-1.5 text-xs">
          <FormattedMessage
            id="sidebar.loadError"
            defaultMessage="Could not load saved sessions."
          />
        </p>
      )}

      <ul
        className="session-list"
        onPointerLeave={() => {
          if (hoverKeyRef.current !== null) rowHoverLeave(hoverKeyRef.current);
        }}
      >
        {sections.map((section, i) => renderSection(section, i === 0))}
        {sections.length === 0 && (
          <>
            {/* Zero sections still gets the chrome row (see the sections
                plan above): an all-archived sidebar must keep the archived
                toggle reachable, or the hidden rows would be stranded. */}
            <li className="session-group mt-1.5 mb-0.5">
              <div className="session-group-title-row group relative mb-0.5 flex items-center justify-end px-1">
                {sectionChrome}
              </div>
            </li>
            {!loadError && (
              <li className="session-empty text-muted-foreground text-sm p-2">
                <FormattedMessage
                  id="sidebar.empty"
                  defaultMessage="No saved sessions yet."
                />
              </li>
            )}
          </>
        )}
      </ul>

      {/* Archived-row delete (ADR-0127 Decision 6): the same strong-confirm
          dialog the header menu's delete uses, mounted here for the archived
          section's rows. An archived session is never open (open-is-unarchive),
          so the delete takes the pure path variant. */}
      {deleteTarget && (
        <DeleteSessionDialog
          name={deleteTarget.name}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            onDeleteArchived(deleteTarget.path);
            setDeleteTarget(null);
          }}
        />
      )}

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

  // One resolution, two slots: the popover heading and the radiogroup's
  // accessible name read the same label variable (issue #964).
  const groupingLabel = intl.formatMessage({
    id: "sidebar.grouping.label",
    defaultMessage: "Group by",
  });

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
          {groupingLabel}
        </div>
        {/* Mutually-exclusive modes -> radio semantics. Tab cycles between the
            two options (a legal radiogroup keyboard model); arrow-key roving
            is not required. aria-checked carries the selected state; a trailing
            Check mirrors the selection visually. */}
        <div role="radiogroup" aria-label={groupingLabel}>
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

// One trailing row action (ADR-0127, issue #1175): an icon-only button with a
// Tooltip + matching aria-label (the one-read-two-slots posture, issue #960).
// Pure-icon buttons have no text content, so aria-label IS the accessible
// name -- no sr-only span needed (contrast the status labels inside the main
// button, issue #1005).
function RowActionButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  /** Busy parity with every sibling control (the WorkingSetList posture):
   *  the actions are mutations too -- during a long archive-close wait a
   *  repeat click would double-fire the close on an already-closing sid. */
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip disableHoverableContent>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            // No cursor-pointer: the pill's icons keep the default arrow
            // (WorkingSetList's ICON_BUTTON_BASE posture -- on the accent
            // pill, color alone marks the hot icon).
            `session-row-action ${bareButtonReset} flex size-7 items-center justify-center rounded-md text-muted-foreground`,
            "transition-colors hover:text-foreground focus-visible:text-foreground",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            "disabled:cursor-progress disabled:opacity-50",
          )}
          aria-label={label}
          onClick={(e) => {
            // The action buttons are SIBLINGS of the main activate button,
            // so a click cannot reach it by bubbling; the stopPropagation is
            // defensive against a future row-level handler (issue #1175).
            e.stopPropagation();
            onClick();
          }}
        >
          {children}
        </button>
      </TooltipTrigger>
      {/* pointer-events-none: the tip must never intercept the pointer on
          its way up to the row above (the WorkingSetList hint posture). */}
      <TooltipContent className="pointer-events-none data-[state=closed]:animate-none!">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

// The archived-view visibility toggle (ADR-0127 Decision 7, issue #1175): an
// icon-only aria-pressed button beside the grouping toggle. Same weak-visible
// posture as GroupingToggle (opacity-60, brightens on hover/focus/pressed) so
// keyboard / touch / AT users can discover it without hovering. The state is
// NEVER persisted -- every startup resets the archived view to hidden.
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
            `sidebar-archived-toggle ${bareButtonReset} cursor-pointer rounded-md p-1 text-muted-foreground`,
            "opacity-60 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
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
// relative-time span. Management actions (rename / export / close / delete)
// moved to .session-header (slice 2); the persistent sub-line (first source +
// turn count) is retired in favor of a HoverCard (slice 3, this change).
// ADR-0127 (issue #1175): the row is now a main activate BUTTON plus a
// trailing action-group SIBLING (pin/unpin + archive, or restore + delete in
// the archived view) -- buttons cannot nest, so the whole-row button split.
// The action group is the WorkingSetList ROW_ACTIONS_OVERLAY posture: an
// absolute accent pill floating over the row tail with ZERO flex footprint
// (a flow-laid group would squeeze the truncating session name), revealed on
// row hover or focus-visible; opacity-0 + pointer-events-none keeps the
// buttons in the tab order (unlike visibility:hidden), so keyboard focus
// reveals the pill and the row stays keyboard reachable.
function SidebarRow({
  entry,
  displayName,
  now,
  hasPendingApproval,
  hasTurnFailed,
  disabled,
  archived = false,
  onActivate,
  actions,
  cardOpen,
  onHoverEnter,
  onHoverLeave,
  onCardEnter,
  onCardLeave,
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
  /** Trailing inline action group (ADR-0127, issue #1175), built by the
   *  section renderer: pin/unpin + archive on main rows, restore + delete
   *  on archived rows. */
  actions: ReactNode;
  /** Controlled metadata-card visibility (issue #1175): driven by the
   *  parent-owned single-flight machine -- see the state block in
   *  SessionSidebar for the transition contract. */
  cardOpen: boolean;
  onHoverEnter: () => void;
  onHoverLeave: () => void;
  /** Cancels the close grace while the pointer is ON the card itself. */
  onCardEnter: () => void;
  /** Schedules the card's own close (the row-leave guard cannot serve this
   *  path -- hoverKey is already null once the pointer is on the card). */
  onCardLeave: () => void;
}) {
  const intl = useIntl();
  // Controlled HoverCard open state (issue #1175): the parent owns the
  // boolean instead of Radix's uncontrolled trigger state machine. Sweeping
  // the pointer down the pills toggles a pill's pointer-events as each
  // row's :hover flips, which desyncs Radix's trigger/content bookkeeping
  // and strands stuck-open metadata cards; a controlled open cannot strand.
  // The delays (300 ms open dwell, 200 ms close grace, card-enter cancel)
  // live in the parent's single-flight machine -- see the state block there
  // for the full transition contract.

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
  // is prevented by the parent machine's 300 ms open dwell (below), not by
  // Radix's openDelay, which is pinned to 0 under the controlled open.
  return (
    <HoverCard
      open={cardOpen}
      openDelay={0}
      closeDelay={0}
      onOpenChange={(open) => {
        // Bridge Radix's own open/close intents into the parent machine:
        // Radix wires onFocus/onBlur on the trigger, and under a controlled
        // open with no change handler that intent is lost -- keyboard focus
        // is the only remaining path to the card for a non-pointer user.
        // Pointer-driven intents re-fire what the row-level handlers already
        // did; both paths are idempotent (timers re-armed, stale-leave
        // guarded).
        if (open) onHoverEnter();
        else onHoverLeave();
      }}
    >
      <HoverCardTrigger asChild>
        <li
          onPointerEnter={onHoverEnter}
          onPointerLeave={onHoverLeave}
          className={cn(
            "session-entry group/row relative my-0.5 flex items-stretch rounded-md hover:bg-accent",
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
              !archived && "cursor-pointer disabled:cursor-progress",
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
            <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
              {formatRelativeTime(entry.lastModifiedAt, now, intl.locale)}
            </span>
          </button>
          <div className="session-entry-actions absolute inset-y-0 right-1 z-10 flex items-center gap-0 rounded-md bg-accent opacity-0 pointer-events-none group-hover/row:opacity-100 group-hover/row:pointer-events-auto has-[:focus-visible]:opacity-100 has-[:focus-visible]:pointer-events-auto">
            {actions}
          </div>
        </li>
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        className="data-[state=open]:animate-none! data-[state=closed]:animate-none!"
        onPointerEnter={onCardEnter}
        onPointerLeave={onCardLeave}
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
// Exported for component-level testing (issue #111); the dialog is rendered
// by SessionHeaderMenu and by the sidebar's archived-section delete (ADR-0127
// Decision 6), but the destructive-semantics + ESC routing contract is
// verified in isolation.
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
            <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
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
              <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
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
