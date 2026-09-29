import { useMemo, useState } from "react";
import { useIntl } from "react-intl";

import { fmtError } from "../../lib/error-presentation";
import {
  matchesFilter,
  matchesSearch,
  type EnabledFilter,
} from "./settings-filters";

// The shared pane state machine behind the registry-backed settings panes
// (issue #1123): the list-filter face (search box + enabled-axis Select +
// the visible projection), the error face (#659's error half), the
// never-rejects write wrapper, and the two busy lanes (the row toggle and
// the confirm dialog). The domain is injected through exactly one point --
// `searchable` -- because the filter predicates are already structural
// (settings-filters.ts): the MCP pane passes its display names, the agents /
// skills panes pass searchableText(name, description); a pane without a
// search box passes a constant.
//
// Contract, held in one place so the panes cannot drift:
// - `runCommit` NEVER rejects. A resolve-to-error and a rejection both
//   surface through the error face (the rejection formatted once, here) and
//   resolve to the error string; success resolves to null without touching
//   an already-reported error.
// - `toggle` is the four-step dance: busy on for just that row, the error
//   face cleared BEFORE the write starts, the write through `runCommit`,
//   busy off -- the busy flag always clears because `runCommit` never
//   rejects.
// - `runConfirm` gates `confirmBusy` across the same contract and returns
//   the error string so a pane can gate its own post-write cleanup on
//   success (the MCP delete's keychain sweep) without the hook owning the
//   target state.
//
// ADR-0075 boundary: this hook deliberately does NOT introduce a
// section-level Save or a shared confirm-target -- per-control persistence
// stays with each pane (the form's save is explicit intent); the target
// payloads and close policies are domain shape and stay in the components.
export function useRegistryPane<T extends { enabled: boolean }>(
  items: T[],
  searchable: (item: T) => string,
) {
  const intl = useIntl();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<EnabledFilter>("all");
  const [error, setError] = useState<string | null>(null);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const visible = useMemo(
    () =>
      items.filter(
        (item) =>
          matchesSearch(searchable(item), search) && matchesFilter(item, filter),
      ),
    [items, search, filter, searchable],
  );

  function report(e: unknown) {
    setError(fmtError(e, intl));
  }

  function clearError() {
    setError(null);
  }

  /** The shared error half of every write here (#659): run one async write
   *  unit and surface a resolve-to-error or rejection through the error
   *  face. Never rejects -- the busy lanes rely on that. Returns the error
   *  string, or null on success. */
  async function runCommit(
    write: () => Promise<string | null>,
  ): Promise<string | null> {
    try {
      const err = await write();
      if (err) setError(err);
      return err;
    } catch (e) {
      const msg = fmtError(e, intl);
      setError(msg);
      return msg;
    }
  }

  /** The row-level enable toggle's four-step dance (ADR-0106): gate just
   *  that row's switch, clear a stale error so the write's own outcome is
   *  what the banner shows, run the write, release the row. */
  async function toggle(key: string, write: () => Promise<string | null>) {
    setTogglingKey(key);
    clearError();
    await runCommit(write);
    setTogglingKey(null);
  }

  /** The confirm-dialog lane: busy across the write (the dialog's buttons
   *  gate on it), clear-before-write like `toggle`, error string returned
   *  for the pane's own success-gated cleanup. */
  async function runConfirm(
    write: () => Promise<string | null>,
  ): Promise<string | null> {
    setConfirmBusy(true);
    clearError();
    const err = await runCommit(write);
    setConfirmBusy(false);
    return err;
  }

  return {
    search,
    setSearch,
    filter,
    setFilter,
    visible,
    error,
    report,
    clearError,
    runCommit,
    togglingKey,
    toggle,
    confirmBusy,
    runConfirm,
  };
}
