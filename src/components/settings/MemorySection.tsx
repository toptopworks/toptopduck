// The user-memory settings pane (issue #1531, ADR-0147): the app-domain
// memory layer that rides EVERY workspace's conversations -- global
// semantics, so it lives in settings, not inside any one workspace's
// memory panel. Read-only by design (the layer is hand-written files only,
// #1531 D1/D4): the folder open is the hand-write entry point, reveal jumps
// to a single file, and the workspace layer keeps its own panel inside each
// workspace. The listing polls while the pane stands so a hand edit in the
// folder lands within one interval (the workspace panel's posture).

import { useState, type ReactNode } from "react";

import { FormattedMessage, useIntl } from "react-intl";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";

import {
  HeaderActionButton,
  PaneFilterBar,
  PaneHeader,
  SettingsCard,
} from "./settings-chrome";
import { matchesSearch, searchableText } from "./settings-filters";
import { MemoryRow } from "../common/MemoryRow";
import {
  LIST_MAX_HEIGHT_CLASS,
  USAGE_YELLOW_PERCENT,
  usageTone,
} from "../common/memory-list";
import { listUserMemory, openUserMemoryDir } from "../../api";
import { userMemoryKeys } from "../../session/queryKeys";
import { describeError } from "../../lib/error-presentation";

export function MemorySection() {
  const intl = useIntl();
  const [search, setSearch] = useState("");
  const listing = useQuery({
    queryKey: userMemoryKeys.listing(),
    queryFn: () => listUserMemory(),
    refetchInterval: 2000,
  });

  // The folder open: the backend mints the app-domain root on demand and
  // the front-end opener navigates to it. The folder is the layer's whole
  // hand-write entry (no create form), so a failure surfaces on the pane's
  // alert face -- the backend error carries the directory -- and a
  // successful retry clears it.
  const [openFailure, setOpenFailure] = useState<string | null>(null);
  const openFolder = () => {
    openUserMemoryDir()
      .then((dir) => openPath(dir))
      .then(() => setOpenFailure(null))
      .catch((e: unknown) => setOpenFailure(describeError(e, intl)));
  };

  const rows = listing.data?.rows ?? [];
  const unreadable = listing.data?.unreadable ?? [];
  const usagePercent = listing.data?.usage_percent ?? 0;

  // The searchable projection (the skills/agents pane posture): title +
  // hook joined by a newline so a title tail can't concatenate with a
  // hook head into a false match. An empty (or whitespace-only) query
  // matches everything (the shared matcher's contract), so no guard
  // wraps the filter.
  const filteredRows = rows.filter((m) =>
    matchesSearch(searchableText(m.title, m.hook), search),
  );

  return (
    <div>
      <PaneHeader
        title={<FormattedMessage id="settings.nav.memory" defaultMessage="Memory" />}
        description={(
          <FormattedMessage
            id="settings.memory.description"
            defaultMessage="Carried into every workspace's conversations. Hand-write files in the folder; each workspace's own memories live in its memory panel."
          />
        )}
        action={(
          <span className="flex items-center gap-1">
            {usagePercent >= USAGE_YELLOW_PERCENT && (
              <span className={`text-xs font-normal ${usageTone(usagePercent)}`}>
                <FormattedMessage
                  id="workspace.memory.usage"
                  defaultMessage="{percent}% used"
                  values={{ percent: usagePercent }}
                />
              </span>
            )}
            <HeaderActionButton
              label={intl.formatMessage({
                id: "common.openFolder",
                defaultMessage: "Open folder",
              })}
              icon={FolderOpen}
              onClick={openFolder}
            />
          </span>
        )}
      />
      {openFailure !== null && (
        <p className="settings-error mt-3 text-destructive text-sm" role="alert">
          {openFailure}
        </p>
      )}
      {/* A dataless error renders the error face alone: the empty guide
          and the search bar must not claim an unknown layer while the
          alert renders below (a failed poll with rows on screen keeps
          the card, the correct stale-while-error posture). */}
      {!listing.isPending && listing.data !== undefined && (
        <>
          <PaneFilterBar
            idPrefix="memory"
            placeholder={intl.formatMessage({
              id: "settings.memory.searchPlaceholder",
              defaultMessage: "Search memories…",
            })}
            search={search}
            onSearchChange={setSearch}
          />
          {rows.length > 0 && (
            // The MCP pane's count line: the total rides above the card,
            // not inside the pane title.
            <p className="mb-2 text-sm">
              <FormattedMessage
                id="settings.memory.configuredCount"
                defaultMessage="User memories <muted>{count}</muted>"
                values={{
                  count: rows.length,
                  muted: (chunks: ReactNode) => (
                    <span className="text-muted-foreground">{chunks}</span>
                  ),
                }}
              />
            </p>
          )}
          <SettingsCard>
            {rows.length === 0 && unreadable.length === 0 ? (
              // The empty face: the folder IS the entry point -- hand-write a
              // file there (no in-panel create, D4).
              <div className="text-muted-foreground px-4 py-8 text-center text-sm">
                <FormattedMessage
                  id="settings.memory.empty"
                  defaultMessage="No user memories yet. Hand-write a file in the folder — every workspace's conversations carry it."
                />
              </div>
            ) : search.trim() && filteredRows.length === 0 ? (
              <div className="text-muted-foreground px-4 py-8 text-center text-sm">
                <FormattedMessage
                  id="settings.memory.noResults"
                  defaultMessage="No memories match the current search."
                />
              </div>
            ) : (
              <ul className={`m-0 list-none overflow-y-auto p-0 ${LIST_MAX_HEIGHT_CLASS}`}>
                {filteredRows.map((memory) => (
                  <MemoryRow key={memory.file} memory={memory} />
                ))}
              </ul>
            )}
            {unreadable.length > 0 && (
              // The unreadable tail (#1538 posture): fence-less .md files
              // surface by name -- neutral copy, the fix for the silent skip.
              <p className="text-muted-foreground m-0 px-4 py-2.5 text-xs">
                <FormattedMessage
                  id="workspace.memory.unreadable"
                  defaultMessage="Unrecognized files: {files}"
                  values={{
                    files: intl.formatList(unreadable, {
                      style: "narrow",
                      type: "conjunction",
                    }),
                  }}
                />
              </p>
            )}
          </SettingsCard>
        </>
      )}
      {listing.isError && (
        <p className="settings-error mt-3 text-destructive text-sm" role="alert">
          {describeError(listing.error, intl)}
        </p>
      )}
    </div>
  );
}
