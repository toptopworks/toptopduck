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
import { FolderOpen, FolderSearch, Plus } from "lucide-react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

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
import { toast } from "../components/ui/use-toast";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import {
  HeaderActionButton,
  SETTINGS_TOOLTIP_CLASS,
} from "../components/settings/settings-chrome";
import { cn } from "../lib/utils";
import { log } from "../lib/log";
import { describeError } from "../lib/error-presentation";
import {
  getWorkspaceAutoExtraction,
  getWorkspaceExtractionStatus,
  getWorkspaceMemoryEnabled,
  listWorkspaceMemory,
  openWorkspaceMemoryDir,
  setWorkspaceAutoExtraction,
  setWorkspaceMemoryEnabled,
} from "../api";
import { workspaceMemoryKeys } from "./queryKeys";
import { MemoryCreateForm } from "./MemoryCreateForm";
import type { WorkspaceTarget } from "./useWorkspaceDatasets";
import type {
  ExtractionStatus,
  ListedMemory,
  MemoryType,
} from "../types/workspace-memory";

// The list card's chrome -- the datasets panel's PANEL_CARD_BASE form, so
// the two workspace management faces read as one family.
const PANEL_CARD_BASE = "panel bg-card border rounded-lg shadow-sm p-4";

// The list's visible ceiling (#1538 layout): ~5 rows (a full row is
// title 20px + hook 16px + py-2 16px + border 1px = 53px), then the list
// scrolls inside the card instead of stretching the dialog toward its
// 80vh cap. Fewer rows keep the panel at its natural height.
const LIST_MAX_HEIGHT_CLASS = "max-h-[265px]";

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
      <HeaderActionButton
        label={revealLabel}
        icon={FolderSearch}
        // The opener can refuse (a file deleted after the listing): log it
        // -- the ArtifactHeader posture (the action is simply retryable).
        onClick={() =>
          revealItemInDir(memory.file_path).catch((e: unknown) =>
            log.warn("WorkspaceMemoryDialog", "revealItemInDir failed", e),
          )}
      />
    </li>
  );
}

/** The extraction status line (issue #1530's three panel states): running /
 * skipped(+reason) / no-new-facts, with the extracted titles and the
 * failure detail spelled out. Rendered only when the status exists -- a
 * workspace that never extracted shows nothing. The settled states announce
 * (role=status on saved, role=alert on failure -- the toggle banner's
 * posture), and the failure carries the destructive tone: a failure must
 * never read as quiet "nothing happened" muted text. */
function ExtractionStatusLine({ status }: { status: ExtractionStatus }) {
  const intl = useIntl();
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
      // The title list joins per locale (zh-CN narrow conjunction renders
      // the enumeration comma; the hardcoded 、 never fit en-US).
      return (
        <p className="m-0 text-xs text-muted-foreground" role="status">
          <FormattedMessage
            id="workspace.memory.extraction.extracted"
            defaultMessage="Last turn saved: {titles}"
            values={{
              titles: intl.formatList(status.titles, {
                style: "narrow",
                type: "conjunction",
              }),
            }}
          />
        </p>
      );
    case "failed":
      return (
        <p className="text-destructive m-0 text-xs" role="alert">
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
  // The create form's mount is scoped to ONE panel open: it resets
  // whenever the prop leaves the retained panel (a close nulls it, a swap
  // replaces it), so a half-filled form never bleeds into the next open's
  // face -- the toggle failure's path-scoped posture.
  const [creating, setCreating] = useState(false);
  if (workspace !== panel && creating) {
    setCreating(false);
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
    // The listing polls the cheap local scan while the panel stands (#1538
    // follow-up): a hand edit in the memory folder (add/remove via any
    // editor) lands within one interval, and the query's enabled gate
    // stops the poll when the panel closes or the layer switches off.
    refetchInterval: 2000,
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
  const unreadable = listing.data?.unreadable ?? [];
  const usagePercent = listing.data?.usage_percent ?? 0;
  const isOn = enabled.data !== false; // undefined (pending) reads on-face.
  const extractionOn = autoExtraction.data === true;

  const openFolderLabel = intl.formatMessage({
    id: "common.openFolder",
    defaultMessage: "Open folder",
  });
  const createLabel = intl.formatMessage({
    id: "workspace.memory.create",
    defaultMessage: "New memory",
  });
  const memoryToggleLabel = intl.formatMessage({
    id: "workspace.memory.toggle",
    defaultMessage: "Memory enabled",
  });
  // The folder-open action (#1538): the backend mints the directory family
  // on demand (the zero-footprint fresh workspace included), then the
  // front-end opener navigates to it. A refusal is logged, not thrown --
  // the action is simply retryable (the reveal button's posture).
  const openFolder = () => {
    openWorkspaceMemoryDir(path)
      .then((dir) => openPath(dir))
      .catch((e: unknown) =>
        log.warn("WorkspaceMemoryDialog", "open memory folder failed", e),
      );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* No auto-focus on open (the datasets panel's posture): focus stays
          with the opener; Tab still enters the dialog. */}
      <DialogContent
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="flex max-h-[80vh] flex-col overflow-hidden sm:max-w-lg"
      >
        <DialogHeader>
          {/* The master switch rides the title row (#1538 layout): an
              unlabeled switch whose accessible name and tooltip share one
              source (the settings HeaderActionButton posture). It sits
              RIGHT AFTER the title text -- not flush right, where the
              dialog's absolute close button would cover it. The
              description keeps its own line below. */}
          <div className="flex items-center gap-2">
            <DialogTitle className="min-w-0 truncate">
              <FormattedMessage
                id="workspace.memory.title"
                defaultMessage="Memory — {workspace}"
                values={{ workspace: label }}
              />
            </DialogTitle>
            {/* Icon-only: the accessible name carries the meaning (no
                tooltip). */}
            <Switch
              aria-label={memoryToggleLabel}
              checked={isOn}
              disabled={enabled.isPending || toggle.isPending}
              onCheckedChange={(next) => toggle.mutate(next)}
              className="shrink-0"
            />
          </div>
          <DialogDescription>
            <FormattedMessage
              id="workspace.memory.description"
              defaultMessage="Your preferences and project context ride along every conversation automatically. Edit with any editor."
            />
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isOn && extractionStatus.data && (
            // The extraction's latest outcome rides ABOVE the list (#1538
            // layout: the switches live in the footer, the feedback lives
            // next to the content it describes).
            <div className="pb-2">
              <ExtractionStatusLine status={extractionStatus.data} />
            </div>
          )}
          {creating ? (
            // The create form replaces the list face while mounted (#1538):
            // the entry points are the empty state's primary action and the
            // list header's secondary one.
            <section className={PANEL_CARD_BASE}>
              <MemoryCreateForm
                workspace={path}
                onCreated={() => {
                  setCreating(false);
                  // The save confirmation is a toast (5s radix default),
                  // not an in-panel line: a persistent note never reads
                  // as done-and-gone. The formatMessage stays a LITERAL
                  // call site (the i18n catalog guard recovers ids from
                  // those, describeError's precedent).
                  toast({
                    description: intl.formatMessage({
                      id: "workspace.memory.created",
                      defaultMessage: "Saved.",
                    }),
                  });
                }}
                onCancel={() => setCreating(false)}
              />
            </section>
          ) : enabled.isError ? (
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
          ) : !listing.isPending && rows.length === 0 && unreadable.length === 0 ? (
            // The empty face (#1538 rewrite): the primary action creates
            // the first memory in-panel; the folder is the escape hatch.
            <section className={`${PANEL_CARD_BASE} flex min-h-64 flex-col items-center justify-center gap-3`}>
              <p className="text-muted-foreground m-0 text-center">
                <FormattedMessage
                  id="workspace.memory.empty"
                  defaultMessage="No memories yet. Create one and later conversations will remember it."
                />
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => setCreating(true)}
                >
                  <Plus className="size-4" aria-hidden />
                  {createLabel}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={openFolder}>
                  <FolderOpen className="size-4" aria-hidden />
                  {openFolderLabel}
                </Button>
              </div>
            </section>
          ) : listing.isPending ? null : (
            <section className={PANEL_CARD_BASE}>
              <h2 className="flex items-center justify-between gap-2 text-base font-semibold">
                <FormattedMessage
                  id="workspace.memory.listHeading"
                  defaultMessage="Memories · {count}"
                  values={{ count: rows.length }}
                />
                <span className="flex items-center gap-1">
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
                  {/* The header's secondary actions (#1538): open the
                      memory folder, then create. */}
                  <HeaderActionButton
                    label={openFolderLabel}
                    icon={FolderOpen}
                    onClick={openFolder}
                  />
                  <HeaderActionButton
                    label={createLabel}
                    icon={Plus}
                    onClick={() => setCreating(true)}
                  />
                </span>
              </h2>
              <ul className={`m-0 list-none overflow-y-auto p-0 ${LIST_MAX_HEIGHT_CLASS}`}>
                {rows.map((memory) => (
                  <MemoryRow key={memory.file} memory={memory} />
                ))}
              </ul>
              {unreadable.length > 0 && (
                // The unreadable face (#1538): fence-less .md files surface
                // by name -- neutral copy, the fix for the silent skip.
                <p className="text-muted-foreground m-0 pt-2 text-xs">
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
            </section>
          )}
        </div>

        {/* The extraction pair is the footer's only control, parked on the
            right (#1538 layout): the master switch is up in the header.
            The cost hint hangs straight off the label -- hover the text
            and the tooltip surfaces (the popover skin matches the settings
            FieldHint's, the same SETTINGS_TOOLTIP_CLASS source). Off hides
            the footer's control (a refused toggle write keeps the footer
            for its banner line), and so does the create face -- the form
            owns the bottom while mounted. */}
        {!creating && (isOn || toggleFailure?.path === path) && (
          <footer className="flex flex-col gap-2 border-t pt-3">
            {isOn && (
              <div className="flex items-center justify-end gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <label
                      htmlFor="workspace-extraction-toggle"
                      className="flex cursor-pointer items-center gap-2 text-sm"
                    >
                      <FormattedMessage
                        id="workspace.memory.extraction.toggle"
                        defaultMessage="Auto-extract"
                      />
                    </label>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    align="start"
                    sideOffset={3}
                    className={cn(SETTINGS_TOOLTIP_CLASS, "max-w-[15rem]")}
                  >
                    <div className="text-muted-foreground text-sm">
                      <FormattedMessage
                        id="workspace.memory.extraction.cost"
                        defaultMessage="One model request per reply."
                      />
                    </div>
                  </TooltipContent>
                </Tooltip>
                <Switch
                  id="workspace-extraction-toggle"
                  checked={extractionOn}
                  disabled={
                    autoExtraction.isPending || extractionToggle.isPending
                  }
                  onCheckedChange={(next) => extractionToggle.mutate(next)}
                />
              </div>
            )}
            {toggleFailure?.path === path && (
              // A refused toggle write (locked ledger, missing record)
              // surfaces right under the switch -- never a silently
              // unmoved control.
              <p className="text-destructive m-0 text-sm" role="alert">
                {toggleFailure.message}
              </p>
            )}
          </footer>
        )}
      </DialogContent>
    </Dialog>
  );
}
