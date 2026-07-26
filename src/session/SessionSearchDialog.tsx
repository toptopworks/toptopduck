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
  type LastModifiedLabel,
  type OpenSession,
  type SearchEntry,
} from "./sidebarModel";
import { resolveDisplayName } from "./displayName";
import type { SessionMetadata } from "../types/session";

// The Ctrl/⌘+K session-search modal (ADR-0072, issue #252). The shell
// owns a single open state; both the global keydown (App.tsx) and the sidebar's
// search magnifier (ADR-0072, wired in this slice -- issue #252) route here. The body
// reuses `buildSearchEntries` (pure filter + sort over `list_sessions`) so the
// merge / filter / sort contract is unit-tested in sidebarModel.test.ts; this
// component stays a thin caller over input state + keyboard navigation.
//
// a11y model: a combobox input drives a listbox of options. Arrow keys move the
// selection (aria-activedescendant carries the highlighted id so screen readers
// announce it without moving DOM focus off the input); Enter activates the
// highlighted row; ESC closes (Radix Dialog). The title + description are
// sr-only -- the placeholder is the visible affordance, matching the Linear /
// Raycast ⌘K convention.
//
// Visual chrome (overlay + ESC + scroll-lock + the top-right X close) comes from
// the shared Dialog primitive (issue #105); p-0 on the content lets the input
// row sit flush at the top, and pr-12 reserves room for the X button.

interface SessionSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: SessionMetadata[];
  openSessions: OpenSession[];
  activeSessionId: string | null;
  onActivate: (sid: string) => void;
  onOpenPersisted: (path: string, name: string) => void;
}

export function SessionSearchDialog({
  open,
  onOpenChange,
  sessions,
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
  // Capture "now" once per mount (Date.now is impure in render). The sub-line
  // relative-day label is stable within a session for our purposes.
  const [now] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);
  // One ref per option <li> so arrow-key navigation can scrollIntoView the
  // highlighted row when it leaves the viewport (jsdom skips the call; tests
  // assert aria-selected instead -- same pattern as Thread.tsx chip jumps).
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);

  const entries = useMemo(
    () => buildSearchEntries(sessions, openSessions, activeSessionId, query),
    [sessions, openSessions, activeSessionId, query],
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
    // m.session_id), so no defensive else-throw is needed here.
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
          <FormattedMessage id="sidebar.search.title" defaultMessage="Search sessions" />
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
          {entries.map((entry, i) => (
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

// One result row: leading chat-bubble glyph + the session name + a sub-line
// (first source + turn count left, dynamic last-modified right). Mirrors the
// sidebar row contract (ADR-0060 row shape; ADR-0072 unified the leading glyph
// + subline) so the two surfaces agree
// on what a "session row" looks like. React 19 ref-as-prop: the parent attaches
// a per-index callback ref so it can scrollIntoView the highlighted row.
function SearchRow({
  ref,
  id,
  entry,
  displayName,
  selected,
  now,
  onClick,
  onMouseEnter,
}: {
  ref?: (el: HTMLLIElement | null) => void;
  id: string;
  entry: SearchEntry;
  displayName: string;
  selected: boolean;
  now: number;
  onClick: () => void;
  onMouseEnter: () => void;
}) {
  const intl = useIntl();
  const label = formatLastModified(entry.lastModifiedAt, now);
  const lastModifiedText = sublineDateText(label, now, intl);

  return (
    <li
      ref={ref}
      id={id}
      role="option"
      aria-selected={selected}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={cn(
        "session-search-option flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
        "hover:bg-accent",
        // The selected (keyboard-highlighted) row carries the accent tint; a
        // hovered row gets it via hover:bg-accent. Mouse-enter syncs `selected`
        // so the tint follows the pointer too, matching native select behavior.
        selected && "bg-accent",
      )}
    >
      <MessageSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex-1 min-w-0 flex flex-col">
        <span className="session-search-option-name truncate text-foreground">
          {displayName}
        </span>
        <span className="session-search-option-subline flex items-center gap-1 text-xs text-muted-foreground">
          <span className="truncate">
            {entry.firstSourceName ?? "—"}
            {" · "}
            <FormattedMessage
              id="sidebar.turns"
              defaultMessage="{count, plural, =0 {no turns} one {# turn} other {# turns}}"
              values={{ count: entry.turnCount }}
            />
          </span>
          <span className="ml-auto whitespace-nowrap pl-2">{lastModifiedText}</span>
        </span>
      </span>
    </li>
  );
}

// Resolve the sub-line last-modified text from a LastModifiedLabel. Today /
// Yesterday reuse the sidebar-group locale message ids (sidebar.group.today /
// yesterday) so the relative-day word agrees with the sidebar's group heading;
// older dates format via Intl.DateTimeFormat with the year omitted when it
// matches `now`'s year (a session from this year needs no year suffix; a
// prior-year one does).
//
// Lives here (not in sidebarModel.ts) because the today / yesterday arms need
// the localized heading text via `intl.formatMessage`, which is a React-layer
// concern; `formatLastModified` stays pure (returns the classification) so the
// label logic itself is unit-tested without intl.
function sublineDateText(
  label: LastModifiedLabel,
  now: number,
  intl: ReturnType<typeof useIntl>,
): string {
  switch (label.kind) {
    case "today":
      return intl.formatMessage({ id: "sidebar.group.today", defaultMessage: "Today" });
    case "yesterday":
      return intl.formatMessage({ id: "sidebar.group.yesterday", defaultMessage: "Yesterday" });
    case "date": {
      const sameYear = new Date(now).getFullYear() === label.date.getFullYear();
      return new Intl.DateTimeFormat(intl.locale, {
        ...(sameYear ? {} : { year: "numeric" }),
        month: "short",
        day: "numeric",
      }).format(label.date);
    }
    default: {
      // Exhaustive guard: a new LastModifiedLabel variant must add a case
      // above. tsconfig strict lacks noImplicitReturns, so without this the
      // implicit return undefined would slip (mirrors sidebarModel.ts
      // buildSidebarGroups + loadErrorDisplay/api.ts).
      const _exhaustive: never = label;
      return _exhaustive;
    }
  }
}
