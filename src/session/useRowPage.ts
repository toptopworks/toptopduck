import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { readRows } from "../api";
import { sessionKeys } from "./queryKeys";
import type { RowPage } from "../types/dataset";

// The row-page seam (issue #1079): the single owner of the thread-side
// result view's paged row reads -- one useQuery per (reference, offset)
// window through the sessionKeys.rows key (the ADR-0051 row-pages design;
// this seam is the key's first consumer). The offset stays a parameter
// (the paging window is the consuming view's UI state); the seam owns the
// query posture and nothing else.
//
// Snapshot contract (the authoritative narrative): a row page is a
// SNAPSHOT READ -- the reference name's rows are immutable for the
// table's lifetime. Derive-only materialization writes the table once
// (ADR-0004); a `result_N` name is never reused (ADR-0022); a source
// replace/delete cascade only marks results stale and never rewrites
// table contents (ADR-0025); a rename touches only the display label. A
// table removal surfaces as the read's own error (kind `read`, issue
// #194). Because the content never changes under a live key, this query
// NEVER joins an invalidation cascade: no workingSet prefix nesting, no
// refetch after mutations -- the cache lives until the session close
// drops the whole `session` prefix (ADR-0051/0055 removeQueries; gcTime
// Infinity keeps the paged history for the session's lifetime, so paging
// back is instant). A future same-reference mutation surface would have
// to invalidate explicitly against this key -- the snapshot contract
// above is what would need revisiting first.
//
// Errors pass through raw (the sampleError pass-through precedent): Tauri
// IPC rejects with the serialized error, not an Error -- toAppError and
// intl formatting belong to the consuming view.

/** The row page's read state. `page` is null only before the first fetch
 *  settles (a pending first window has no placeholder); an errored first
 *  load leaves it null with `error` set. `firstLoadPending` is the #773
 *  gate (true until the first fetch settles, success OR error); `inFlight`
 *  covers every fetch, so the paging buttons can disable while a turn
 *  keeps the last page on screen via keepPreviousData. */
export interface RowPageState {
  page: RowPage | null;
  firstLoadPending: boolean;
  inFlight: boolean;
  /** The reject as thrown -- raw, unformatted. */
  error: unknown;
}

export function useRowPage(
  sessionId: string,
  referenceName: string,
  offset: number,
  pageSize: number,
): RowPageState {
  const query = useQuery<RowPage, unknown>({
    queryKey: sessionKeys.rows(sessionId, referenceName, offset),
    queryFn: () => readRows(sessionId, referenceName, offset, pageSize),
    // The snapshot posture (see module header) -- pinned here, not in the
    // app-wide client defaults, so the contract travels with the seam.
    staleTime: Infinity,
    gcTime: Infinity,
    placeholderData: keepPreviousData,
    // A read reject is the read phase's own failure (issue #194): it
    // surfaces on the error surface immediately, never after a retry
    // delay.
    retry: false,
  });
  return {
    page: query.data ?? null,
    firstLoadPending: query.isLoading,
    inFlight: query.isFetching,
    error: query.error,
  };
}
