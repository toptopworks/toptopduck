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
import { fmtError, listSessions } from "../api";
import { log } from "../lib/log";
import type { SessionMetadata } from "../types/session";

export interface UsePersistedSessionsDeps {
  /** Shell-level IntlShape (App sits above <IntlProvider>, built via createIntl)
   *  so fmtError can localize a list_sessions reject at the shell layer. */
  intl: IntlShape;
}

/** The persisted-session sidebar list state. sessionsEpoch stays INTERNAL -- it
 *  is the manual invalidate counter (ADR-0068), bumped by refreshSessions; the
 *  list + its error are the public surface. Composed into App as the sidebar's
 *  `sessions` / `loadError` source (ADR-0061 cold start). */
export function usePersistedSessions({ intl }: UsePersistedSessionsDeps): {
  sessions: SessionMetadata[];
  sessionsError: string | null;
  refreshSessions: () => void;
} {
  // Bumped to re-fetch list_sessions after a save/delete/rename (the persisted
  // sidebar list is advisory state held in React, not TanStack Query, mirroring
  // how app-config is fetched).
  const [sessionsEpoch, setSessionsEpoch] = useState(0);
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  // ADR-0061 cold start: load list_sessions on mount (and after a save/delete/
  // rename bumps sessionsEpoch). NOT createSession -- zero instances until the
  // user acts.
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
    return () => {
      cancelled = true;
    };
  }, [intl, sessionsEpoch]);

  const refreshSessions = useCallback(() => setSessionsEpoch((e) => e + 1), []);

  return { sessions, sessionsError, refreshSessions };
}
