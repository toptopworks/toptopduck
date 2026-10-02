// Persisted-session sidebar list (issue #195). Owns the list_sessions advisory
// state: the disk-derived sidebar list + its load error + the sessionsEpoch
// counter that drives a manual re-fetch after a save/delete/rename.
//
// ADR-0068: this is advisory state held in React (NOT TanStack Query) -- the
// list is derived metadata from recipe + mtime (ADR-0061), not a mirror of
// backend runtime truth (the runtime truth is the OPEN set held by
// useShellSessions). sessionsEpoch is the manual invalidate knob (the
// single-consumer shell has no shared-cache benefit from Query): bumping it
// re-runs the list_sessions effect, mirroring how app-config is fetched.
import { useCallback, useEffect, useState } from "react";
import type { IntlShape } from "react-intl";
import { listSessions } from "../api";
import { fmtError } from "../lib/error-presentation";
import { log } from "../lib/log";
import type { SessionMetadata } from "../types/session";

export interface UsePersistedSessionsDeps {
  /** Shell-level IntlShape (App sits above <IntlProvider>, built via createIntl)
   *  so fmtError can localize a list_sessions reject at the shell layer. */
  intl: IntlShape;
  /** The archived view's visibility (ADR-0127 Decision 7, issue #1175). While
   *  true the effect ALSO fetches listSessions({ includeArchived: true }) and
   *  filters to the archived rows for `archivedSessions`; false skips that
   *  fetch entirely. Never persisted -- the caller's state resets on startup. */
  includeArchived: boolean;
}

/** The persisted-session sidebar list state. sessionsEpoch stays INTERNAL -- it
 *  is the manual invalidate counter (ADR-0068), bumped by refreshSessions; the
 *  list + its error are the public surface. Composed into App as the sidebar's
 *  `sessions` / `loadError` source (ADR-0061 cold start). */
export function usePersistedSessions({
  intl,
  includeArchived,
}: UsePersistedSessionsDeps): {
  sessions: SessionMetadata[];
  /** The archived rows (ADR-0127): only fetched while the archived view is
   *  visible, empty otherwise. `sessions` NEVER contains archived rows -- the
   *  default response excludes them, so tray / search consumers stay blind to
   *  the organization state. */
  archivedSessions: SessionMetadata[];
  sessionsError: string | null;
  refreshSessions: () => void;
} {
  // Bumped to re-fetch list_sessions after a save/delete/rename (the persisted
  // sidebar list is advisory state held in React, not TanStack Query, mirroring
  // how app-config is fetched).
  const [sessionsEpoch, setSessionsEpoch] = useState(0);
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<SessionMetadata[]>([]);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  // ADR-0061 cold start: load list_sessions on mount (and after a save/delete/
  // rename bumps sessionsEpoch). NOT createSession -- zero instances until the
  // user acts. The archived fetch (ADR-0127) is a SECOND scan -- only while
  // the archived view is visible -- so the default list (tray / search source)
  // never sees archived rows.
  useEffect(() => {
    let cancelled = false;
    listSessions()
      .then((list) => {
        if (cancelled) return;
        setSessions(list);
        setSessionsError(null);
      })
      .catch((e) => {
        if (cancelled) {
          // Rejected AFTER unmount: setSessionsError would be a setState on a
          // gone component (fail-open), but a deterministic list_sessions
          // failure (DuckDB reader break, etc.) would otherwise stay invisible
          // until the next app open. Log it so the dropped reject is still
          // observable in devtools (issue #203).
          log.warn("listSessions", "reject dropped after unmount", fmtError(e, intl));
          return;
        }
        setSessionsError(fmtError(e, intl));
      });
    if (includeArchived) {
      listSessions({ includeArchived: true })
        .then((list) => {
          if (cancelled) return;
          setArchivedSessions(list.filter((m) => m.archived));
        })
        .catch((e) => {
          // Same surface as the main list reject: the archived section shares
          // the sidebar's loadError line, not a second error home.
          if (!cancelled) setSessionsError(fmtError(e, intl));
        });
    }
    // Hiding the view does NOT clear archivedSessions here: the render side
    // gates on the visibility flag already, and re-showing re-fetches (the
    // flag is an effect dep) -- a sync clear would just trip
    // react-hooks/set-state-in-effect for no observable gain.
    return () => {
      cancelled = true;
    };
  }, [intl, sessionsEpoch, includeArchived]);

  const refreshSessions = useCallback(() => setSessionsEpoch((e) => e + 1), []);

  return { sessions, archivedSessions, sessionsError, refreshSessions };
}
