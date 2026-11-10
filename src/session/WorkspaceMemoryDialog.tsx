// The workspace memory panel (issue #1529, P0 read path): a read-only modal
// off the sidebar's workspace-section menu. The list shows each memory's
// title, category badge, and hook (the same row content the built-in
// engine's injection block carries); reveal-in-folder opens the OS file
// manager on the memory file (`.toptopduck/memory/<type>-<slug>.md`).
// Editing lives outside the shell by design (any editor, via the reveal) --
// the in-shell editor is a P2 question. The header's switch is the
// workspace-level `memory_enabled` toggle: off stops the built-in engine's
// injection and deactivates the list (the off note replaces it), on
// restores both.
//
// Copy never promises automatic capture: the write path (extraction) is a
// later ticket -- the empty state explains where memories live and that
// they can be hand-written. Code and i18n keys keep the workspace.memory
// namespace.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormattedMessage, useIntl } from "react-intl";
import { FolderSearch } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Switch } from "../components/ui/switch";
import { log } from "../lib/log";
import { describeError } from "../lib/error-presentation";
import {
  getWorkspaceAutoExtraction,
  getWorkspaceExtractionStatus,
  getWorkspaceMemoryEnabled,
  listWorkspaceMemory,
  setWorkspaceAutoExtraction,
  setWorkspaceMemoryEnabled,
} from "../api";
import { workspaceMemoryKeys } from "./queryKeys";
import type { WorkspaceTarget } from "./useWorkspaceDatasets";
import type {
  ExtractionStatus,
  ListedMemory,
  MemoryType,
} from "../types/workspace-memory";

// The list card's chrome -- the datasets panel's PANEL_CARD_BASE form, so
// the two workspace management faces read as one family.
const PANEL_CARD_BASE = "panel bg-card border rounded-lg shadow-sm p-4";

/** The category badge: four STATIC branches (the i18n catalog guard reads
 * literal ids at call sites -- a dynamically built id would be invisible
 * to the check). */
function TypeBadge({ type }: { type: MemoryType }) {
  return (
    <Badge variant="secondary" className="shrink-0">
      {type === "user" ? (
        <FormattedMessage id="workspace.memory.type.user" defaultMessage="user" />
      ) : type === "feedback" ? (
        <FormattedMessage id="workspace.memory.type.feedback" defaultMessage="feedback" />
      ) : type === "project" ? (
        <FormattedMessage id="workspace.memory.type.project" defaultMessage="project" />
      ) : (
        <FormattedMessage id="workspace.memory.type.reference" defaultMessage="reference" />
      )}
    </Badge>
  );
}

/** One read-only memory row: title + category badge + hook + the reveal
 * button (the row's only action). */
function MemoryRow({ memory }: { memory: ListedMemory }) {
  const intl = useIntl();
  const revealLabel = intl.formatMessage({
    id: "workspace.memory.reveal",
    defaultMessage: "Reveal in folder",
  });
  return (
    <li className="flex items-start gap-2 border-b border-border py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{memory.title}</span>
          <TypeBadge type={memory.type} />
        </div>
        {memory.hook.length > 0 && (
          <p className="m-0 truncate text-xs text-muted-foreground" title={memory.hook}>
            {memory.hook}
          </p>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label={revealLabel}
        title={revealLabel}
        // The opener can refuse (a file deleted after the listing): log it
        // -- the ArtifactHeader posture (the action is simply retryable).
        onClick={() =>
          revealItemInDir(memory.file_path).catch((e: unknown) =>
            log.warn("WorkspaceMemoryDialog", "revealItemInDir failed", e),
          )}
      >
        <FolderSearch className="size-4" aria-hidden />
      </Button>
    </li>
  );
}

/** The extraction status line (issue #1530's three panel states): running /
 * skipped(+reason) / no-new-facts, with the extracted titles and the
 * failure detail spelled out. Rendered only when the status exists -- a
 * workspace that never extracted shows nothing. */
function ExtractionStatusLine({ status }: { status: ExtractionStatus }) {
  switch (status.state) {
    case "running":
      return (
        <p className="m-0 text-xs text-muted-foreground" role="status">
          <FormattedMessage
            id="workspace.memory.extraction.running"
            defaultMessage="Extracting memories from the last turn…"
          />
        </p>
      );
    case "skipped":
      // The skip reasons map to STATIC ids (the catalog guard's literal-id
      // rule, the TypeBadge posture).
      return (
        <p className="m-0 text-xs text-muted-foreground">
          {status.reason === "no_provider" ? (
            <FormattedMessage
              id="workspace.memory.extraction.skippedNoProvider"
              defaultMessage="No model configured — extraction waits."
            />
          ) : status.reason === "toggle_off" ? (
            <FormattedMessage
              id="workspace.memory.extraction.skippedToggleOff"
              defaultMessage="Extraction is off."
            />
          ) : (
            <FormattedMessage
              id="workspace.memory.extraction.skippedIndexCap"
              defaultMessage="Memories nearly full — clear a few to resume."
            />
          )}
        </p>
      );
    case "no_new_facts":
      return (
        <p className="m-0 text-xs text-muted-foreground">
          <FormattedMessage
            id="workspace.memory.extraction.noNewFacts"
            defaultMessage="Last turn: no new memories."
          />
        </p>
      );
    case "extracted":
      return (
        <p className="m-0 text-xs text-muted-foreground">
          <FormattedMessage
            id="workspace.memory.extraction.extracted"
            defaultMessage="Last turn saved: {titles}"
            values={{ titles: status.titles.join("、") }}
          />
        </p>
      );
    case "failed":
      return (
        <p className="m-0 text-xs text-muted-foreground">
          <FormattedMessage
            id="workspace.memory.extraction.failed"
            defaultMessage="Extraction failed: {detail}"
            values={{ detail: status.detail }}
          />
        </p>
      );
  }
}

// The color-scale thresholds (issue #1530): yellow from 80%, red from 95%.
// The red figure mirrors the backend's pause threshold; there is no shared
// cross-end constant channel, so the pair is named here instead.
const USAGE_YELLOW_PERCENT = 80;
const USAGE_RED_PERCENT = 95;

/** The index-usage color scale (issue #1530): the warning token for the
 * yellow band (DESIGN.md), destructive for the red. */
function usageTone(percent: number): string {
  if (percent >= USAGE_RED_PERCENT) {
    return "text-destructive";
  }
  if (percent >= USAGE_YELLOW_PERCENT) {
    return "text-warning";
  }
  return "text-muted-foreground";
}

export function WorkspaceMemoryDialog({
  workspace,
  onOpenChange,
}: {
  workspace: WorkspaceTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const open = workspace !== null;
  // The close-animation anchor (the datasets panel's panel/lastSeen posture,
  // minimal cut): `panel` holds the last non-null workspace, so the title,
  // the query keys, and the rows hold their rendered values while the exit
  // animation plays (the prop nulls the moment close is requested). A
  // reopen on another workspace swaps it in render-time.
  const [panel, setPanel] = useState(workspace);
  if (workspace !== null && workspace !== panel) {
    setPanel(workspace);
  }
  const path = panel?.path ?? "";
  const label = panel?.label ?? "";

  const enabled = useQuery({
    queryKey: workspaceMemoryKeys.enabled(path),
    queryFn: () => getWorkspaceMemoryEnabled(path),
    enabled: open,
  });
  const listing = useQuery({
    queryKey: workspaceMemoryKeys.listing(path),
    queryFn: () => listWorkspaceMemory(path),
    // Off = the panel's deactivated face: no refetch while disabled.
    enabled: open && enabled.data === true,
  });
  // The extraction toggle + latest status (issue #1530): only meaningful
  // while the memory layer itself is on. The status polls ONLY while the
  // backend reports running -- terminal states are settled facts.
  const autoExtraction = useQuery({
    queryKey: workspaceMemoryKeys.autoExtraction(path),
    queryFn: () => getWorkspaceAutoExtraction(path),
    enabled: open && enabled.data === true,
  });
  const extractionStatus = useQuery({
    queryKey: workspaceMemoryKeys.extractionStatus(path),
    queryFn: () => getWorkspaceExtractionStatus(path),
    enabled: open && enabled.data === true,
    refetchInterval: (query) =>
      query.state.data?.state === "running" ? 1500 : false,
  });

  // A refused toggle write, scoped to the workspace it failed on (the
  // dialog stays mounted across closes, so a stale banner must never
  // bleed into another workspace's panel). Cleared the moment a retry
  // starts.
  const [toggleFailure, setToggleFailure] = useState<{
    path: string;
    message: string;
  } | null>(null);

  const toggle = useMutation({
    mutationFn: (next: boolean) => setWorkspaceMemoryEnabled(path, next),
    onMutate: () => setToggleFailure(null),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workspaceMemoryKeys.enabled(path),
      });
    },
    // Logged AND surfaced: the backend is deliberately strict (a missing
    // record or refused write errors), so the failure renders as the
    // alert below -- never a silently unmoved switch.
    onError: (e) => {
      log.warn("WorkspaceMemoryDialog", "set memory toggle failed", e);
      setToggleFailure({ path, message: describeError(e, intl) });
    },
  });

  const extractionToggle = useMutation({
    mutationFn: (next: boolean) => setWorkspaceAutoExtraction(path, next),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workspaceMemoryKeys.autoExtraction(path),
      });
      void queryClient.invalidateQueries({
        queryKey: workspaceMemoryKeys.extractionStatus(path),
      });
    },
    // The same strict-write posture as the memory toggle: a refused write
    // surfaces through the shared banner, never a silently unmoved switch.
    onError: (e) => {
      log.warn("WorkspaceMemoryDialog", "set extraction toggle failed", e);
      setToggleFailure({ path, message: describeError(e, intl) });
    },
  });

  const rows = listing.data?.rows ?? [];
  const usagePercent = listing.data?.usage_percent ?? 0;
  const isOn = enabled.data !== false; // undefined (pending) reads on-face.
  const extractionOn = autoExtraction.data === true;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* No auto-focus on open (the datasets panel's posture): focus stays
          with the opener; Tab still enters the dialog. */}
      <DialogContent
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="flex max-h-[80vh] flex-col overflow-hidden sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>
            <FormattedMessage
              id="workspace.memory.title"
              defaultMessage="Memory — {workspace}"
              values={{ workspace: label }}
            />
          </DialogTitle>
          <DialogDescription>
            <FormattedMessage
              id="workspace.memory.description"
              defaultMessage="Your preferences and project context ride along every conversation automatically. Edit with any editor."
            />
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-3 pb-2">
          <label
            htmlFor="workspace-memory-toggle"
            className="flex cursor-pointer items-center gap-2 text-sm"
          >
            <FormattedMessage
              id="workspace.memory.toggle"
              defaultMessage="Memory enabled"
            />
          </label>
          <Switch
            id="workspace-memory-toggle"
            checked={isOn}
            disabled={enabled.isPending || toggle.isPending}
            onCheckedChange={(next) => toggle.mutate(next)}
          />
        </div>

        {isOn && (
          // The extraction block (issue #1530): its own OFF-by-default
          // toggle with the standing cost note (one model call per turn --
          // the ruling's "cost follows the switch"), plus the latest
          // status line.
          <section className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="workspace-extraction-toggle"
                className="flex cursor-pointer items-center gap-2 text-sm"
              >
                <FormattedMessage
                  id="workspace.memory.extraction.toggle"
                  defaultMessage="Auto-extract memories"
                />
              </label>
              <Switch
                id="workspace-extraction-toggle"
                checked={extractionOn}
                disabled={
                  autoExtraction.isPending || extractionToggle.isPending
                }
                onCheckedChange={(next) => extractionToggle.mutate(next)}
              />
            </div>
            <p className="text-muted-foreground m-0 pt-1 text-xs">
              <FormattedMessage
                id="workspace.memory.extraction.cost"
                defaultMessage="One model request per reply."
              />
            </p>
            {extractionStatus.data && (
              <div className="pt-1">
                <ExtractionStatusLine status={extractionStatus.data} />
              </div>
            )}
          </section>
        )}

        {toggleFailure?.path === path && (
          // A refused toggle write (locked ledger, missing record) surfaces
          // here -- the same alert face as the query failures above, so the
          // switch never just silently fails to move.
          <p className="text-destructive pb-2 text-sm" role="alert">
            {toggleFailure.message}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {enabled.isError ? (
            <p className="text-destructive text-sm" role="alert">
              {describeError(enabled.error, intl)}
            </p>
          ) : !isOn ? (
            // The deactivated face: off = no injection + no list; the note
            // says exactly that, and the switch above is the way back.
            <section className={`${PANEL_CARD_BASE} flex min-h-64 items-center justify-center`}>
              <p className="text-muted-foreground m-0 text-center">
                <FormattedMessage
                  id="workspace.memory.off"
                  defaultMessage="Memory is off — conversations no longer carry any memories."
                />
              </p>
            </section>
          ) : listing.isError ? (
            <p className="text-destructive text-sm" role="alert">
              {describeError(listing.error, intl)}
            </p>
          ) : !listing.isPending && rows.length === 0 ? (
            <section className={`${PANEL_CARD_BASE} flex min-h-64 items-center justify-center`}>
              <p className="text-muted-foreground m-0 text-center">
                <FormattedMessage
                  id="workspace.memory.empty"
                  defaultMessage="No memories yet. Each memory is a Markdown file — write one and later conversations remember it."
                />
              </p>
            </section>
          ) : listing.isPending ? null : (
            <section className={PANEL_CARD_BASE}>
              <h2 className="flex items-baseline justify-between gap-2 text-base font-semibold">
                <FormattedMessage
                  id="workspace.memory.listHeading"
                  defaultMessage="Memories · {count}"
                  values={{ count: rows.length }}
                />
                {/* The usage scale (issue #1530): yellow >=80, red >=95 --
                    the same thresholds the backend enforces. Shown only
                    when a non-trivial share is in use. */}
                {usagePercent >= USAGE_YELLOW_PERCENT && (
                  <span
                    className={`text-xs font-normal ${usageTone(usagePercent)}`}
                  >
                    <FormattedMessage
                      id="workspace.memory.usage"
                      defaultMessage="{percent}% used"
                      values={{ percent: usagePercent }}
                    />
                  </span>
                )}
              </h2>
              <ul className="m-0 list-none p-0">
                {rows.map((memory) => (
                  <MemoryRow key={memory.file} memory={memory} />
                ))}
              </ul>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
