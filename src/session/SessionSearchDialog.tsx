import { useEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { MessageSquare, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  buildSearchEntries,
  formatLastModified,
  type OpenSession,
  type SearchEntry,
} from "./sidebarModel";
import { formatLastModifiedText } from "./lastModifiedText";
import { resolveDisplayName } from "./displayName";
import type { SessionMetadata } from "../types/session";

// The Ctrl/⌘+K session-search modal (ADR-0072, issue #252; archived
// partition issue #1403). The shell owns a single open state; both the global
// keydown (App.tsx) and the sidebar's search magnifier (ADR-0072, wired in
// this slice -- issue #252) route here. The body reuses `buildSearchEntries`
// (pure filter + sort + cap over `list_sessions`, two partitions) so the
// merge / filter / sort contract is unit-tested in sidebarModel.test.ts; this
// component stays a thin caller over input state + keyboard navigation.
//
// a11y model: a combobox input drives a listbox of options. Arrow keys move the
// selection (aria-activedescendant carries the highlighted id so screen readers
// announce it without moving DOM focus off the input); Enter activates the
// highlighted row; ESC closes (Radix Dialog). The title + description are
// sr-only -- the placeholder is the visible affordance, matching the Linear /
// Raycast ⌘K convention. The archived partition (#1403) renders in the SAME
// listbox as a bottom section: its header is a presentational li (non-option),
// its rows keep role="option", and the option ids are per-FLAT-index, so
// keyboard navigation stays one continuous index space across the partition
// boundary.
//
// Visual chrome (overlay + ESC + scroll-lock + the top-right X close) comes from
// the shared Dialog primitive (issue #105); p-0 on the content lets the input
// row sit flush at the top, and pr-12 reserves room for the X button.

interface SessionSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The unarchived rows (list_sessions minus the archived tail). */
  sessions: SessionMetadata[];
  /** The archived rows (#1403): matched with the same predicate, rendered as
   *  the bottom grayed section; activating a row rides the persisted-open
   *  path, whose open_duck contract unarchives on open (ADR-0127 Decision 4). */
  archivedSessions: SessionMetadata[];
  openSessions: OpenSession[];
  activeSessionId: string | null;
  onActivate: (sid: string) => void;
  onOpenPersisted: (path: string, name: string) => void;
}

export function SessionSearchDialog({
  open,
  onOpenChange,
  sessions,
  archivedSessions,
  openSessions,
  activeSessionId,
  onActivate,
  onOpenPersisted,
}: SessionSearchDialogProps) {
  const intl = useIntl();
  const [query, setQuery] = useState("");
  // The highlighted listbox index (always within entries range, or 0 when
  // empty). Arrow keys wrap; mouse-enter and click sync it to the hovered row.
  const [selected, setSelected] = useState(0);
  // Capture "now" once per mount (Date.now is impure in render). The time
  // label's relative-day classification is stable within a session for our
  // purposes.
  const [now] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);
  // One ref per option <li> so arrow-key navigation can scrollIntoView the
  // highlighted row when it leaves the viewport (jsdom skips the call; tests
  // assert aria-selected instead -- same pattern as Thread.tsx chip jumps).
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);

  const partition = useMemo(
    () =>
      buildSearchEntries(sessions, archivedSessions, openSessions, activeSessionId, query),
    [sessions, archivedSessions, openSessions, activeSessionId, query],
  );
  // One flat index space spanning both partitions (issue #1403): keyboard
  // navigation + aria-activedescendant index into this array; the render
  // below maps partition indices back onto it (the archived rows start at
  // main.length). The archived section header is NOT an entry -- it carries
  // no index and Enter never lands on it.
  const entries = useMemo(
    () => [...partition.main, ...partition.archived],
    [partition],
  );

  // Adjusting state during render (the React-recommended pattern, NOT effects --
  // setState-in-effect triggers cascading renders per react-hooks/
  // set-state-in-effect). Two adjustments:
  //  1. Reset the query + selection on every open so the dialog always starts
  //     fresh (a prior query from an earlier open must not leak in).
  //  2. Clamp selection when the entry list shrinks below it (the filter
  //     narrowed) so the highlight stays on a real row instead of stranding
  //     past the end where Enter would no-op.
  // React re-renders immediately without committing the stale frame, so the
  // user never sees the un-clamped index.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setQuery("");
      setSelected(0);
    }
  }
  if (entries.length > 0 && selected >= entries.length) {
    setSelected(entries.length - 1);
  } else if (entries.length === 0 && selected !== 0) {
    setSelected(0);
  }

  // Scroll the highlighted option into view whenever `selected` moves. Nearest-
  // edge blocking so a downward arrow stops at "first visible pixel of the next
  // row" rather than centering (centering would scroll the row above out of view
  // and feel jumpy). Pure DOM side effect -- no setState, so the effect is fine.
  useEffect(() => {
    optionRefs.current[selected]?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  const choose = (entry: SearchEntry) => {
    // Mirror the sidebar row contract: an open binding activates by sid; a
    // cold persisted row resumes by path. Either way the dialog closes.
    // SearchEntry guarantees a non-null path (buildSearchEntries sets it from
    // m.recipe_path), so no defensive else-throw is needed here.
    if (entry.sid) onActivate(entry.sid);
    else onOpenPersisted(entry.path, entry.name);
    onOpenChange(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (entries.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => (i + 1) % entries.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => (i - 1 + entries.length) % entries.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(entries[selected]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="session-search-dialog max-w-xl gap-0 p-0"
        onOpenAutoFocus={(e) => {
          // Redirect Radix's auto-focus (default: first focusable descendant,
          // which would be the sr-only title link) onto the search input so the
          // user can type immediately.
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">
          <FormattedMessage id="sidebar.search.ariaLabel" defaultMessage="Search sessions" />
        </DialogTitle>
        <DialogDescription className="sr-only">
          <FormattedMessage
            id="sidebar.search.description"
            defaultMessage="Filter sessions by name or source. Arrow keys move the selection; Enter opens the selected session."
          />
        </DialogDescription>
        <div className="session-search-input-row flex items-center gap-2 border-b border-border px-4 py-3 pr-12">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={entries.length > 0}
            aria-controls="session-search-listbox"
            aria-autocomplete="list"
            aria-activedescendant={
              entries.length > 0 ? `session-search-option-${selected}` : undefined
            }
            className="session-search-input flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            placeholder={intl.formatMessage({
              id: "sidebar.search.placeholder",
              defaultMessage: "Search sessions by name or source…",
            })}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <ul
          id="session-search-listbox"
          role="listbox"
          aria-label={intl.formatMessage({
            id: "sidebar.search.resultsLabel",
            defaultMessage: "Sessions",
          })}
          className="session-search-results max-h-80 overflow-y-auto p-1"
        >
          {partition.main.map((entry, i) => (
            <SearchRow
              key={entry.key}
              ref={(el: HTMLLIElement | null) => {
                optionRefs.current[i] = el;
              }}
              id={`session-search-option-${i}`}
              entry={entry}
              displayName={resolveDisplayName(entry.name, intl)}
              selected={i === selected}
              now={now}
              onClick={() => choose(entry)}
              onMouseEnter={() => setSelected(i)}
            />
          ))}
          {partition.archived.length > 0 && (
            // The bottom partition's header (issue #1403): presentational --
            // a listbox's options are the interactive surface, and the header
            // is chrome reusing the sidebar's archived heading (zero new i18n
            // keys). Enter never lands here: it carries no flat index.
            <li
              role="presentation"
              className="session-search-archived-header px-2 pb-1 pt-2 text-xs uppercase tracking-wider text-muted-foreground"
            >
              <FormattedMessage id="sidebar.group.archived" defaultMessage="Archived" />
            </li>
          )}
          {partition.archived.map((entry, j) => (
            <SearchRow
              key={entry.key}
              ref={(el: HTMLLIElement | null) => {
                optionRefs.current[partition.main.length + j] = el;
              }}
              id={`session-search-option-${partition.main.length + j}`}
              entry={entry}
              displayName={resolveDisplayName(entry.name, intl)}
              selected={partition.main.length + j === selected}
              now={now}
              archived
              onClick={() => choose(entry)}
              onMouseEnter={() => setSelected(partition.main.length + j)}
            />
          ))}
        </ul>
        {entries.length === 0 && (
          <p
            role="status"
            className="session-search-empty px-3 py-6 text-center text-sm text-muted-foreground"
          >
            <FormattedMessage
              id="sidebar.search.empty"
              defaultMessage="No matching sessions."
            />
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

// One result row: leading chat-bubble glyph + the session name with the
// dynamic last-modified label right-aligned on the same line. The dialog
// keeps the ADR-0072 result-row face (the MessageSquare glyph) collapsed to
// a single line -- a jump target is identified by name + recency alone;
// sidebar rows carry neither the glyph nor a sub-line since ADR-0093
// (conditional status dot, metadata in a HoverCard). React 19 ref-as-prop:
// the parent attaches a per-index callback ref so it can scrollIntoView the
// highlighted row. `archived` (#1403) dims the row face (the sidebar's
// archived gray) WITHOUT deactivating it -- activating an archived row
// resumes + unarchives it, so the row stays a first-class option.
function SearchRow({
  ref,
  id,
  entry,
  displayName,
  selected,
  now,
  archived = false,
  onClick,
  onMouseEnter,
}: {
  ref?: (el: HTMLLIElement | null) => void;
  id: string;
  entry: SearchEntry;
  displayName: string;
  selected: boolean;
  now: number;
  archived?: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
}) {
  const intl = useIntl();
  const label = formatLastModified(entry.lastModifiedAt, now);
  const lastModifiedText = formatLastModifiedText(label, now, intl);

  return (
    <li
      ref={ref}
      id={id}
      role="option"
      aria-selected={selected}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={cn(
        "session-search-option flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
        "hover:bg-transit",
        // The selected (keyboard-highlighted) row carries the accent tint, and
        // the committed face re-asserts on hover (`hover:bg-accent`) so the
        // teal never greys out under the pointer -- hover drives the transit
        // band on unselected rows only. Mouse-enter syncs `selected` so
        // keyboard and pointer share one face, matching native select behavior.
        selected && "bg-accent hover:bg-accent",
      )}
    >
      <MessageSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span
        className={cn(
          "session-search-option-name min-w-0 flex-1 truncate",
          archived ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {displayName}
      </span>
      <span className="session-search-option-time shrink-0 whitespace-nowrap text-xs text-muted-foreground">
        {lastModifiedText}
      </span>
    </li>
  );
}
