import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useQuery } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { Plus } from "lucide-react";
import { listMountedSkills, listMcpServerStatus, listSkills } from "../../api";
import { sessionKeys, skillKeys } from "../../session/queryKeys";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ComposerSkillsSection } from "./ComposerSkillsSection";

// The composer "+" session-context panel (ADR-0083, issue #351). One entry for
// the three per-turn context additions -- files / skills / MCP tools -- at the
// turn-launch point. This slice delivers the shell + the live FILE section
// (multi-select into the existing ingest pipeline) + the live SKILLS section
// (issue #365: per-session mount/unmount checkbox list); the MCP (#301) section
// renders as a disabled placeholder until that ticket lights it up. With
// nothing to assemble (registry empty AND no configured MCP server) the "+"
// DEGRADES to a pure add-files button: the dialog opens directly, no panel.
// The trigger's badge carries attached context (mounted skills + session-
// enabled MCP servers, hidden at zero / degraded).
//
// The retired standalone source entry (the workspace-hero FileDropzone button)
// moved here; window-level drag-and-drop stays untouched (App's single
// listener, ADR-0061), and the ingest pipeline + source lifecycle events
// (ADR-0040) are unchanged -- onIngestFiles routes through useIngestFlow's
// handleIngestMany.

// The data-file extensions the picker offers -- the same surface the retired
// FileDropzone button + the window drag-and-drop accept (ADR-0040 ingest).
const DATA_FILE_EXTENSIONS = ["csv", "parquet", "json", "jsonl", "ndjson", "xlsx"];

// Shared icon-button chrome for both modes (panel trigger + degraded button),
// sized to the composer control row like the provider/model picker trigger.
const TRIGGER_CLASS =
  "composer-context-trigger relative inline-flex size-9 items-center justify-center rounded-md border border-border bg-card text-foreground transition-colors hover:bg-muted cursor-pointer disabled:pointer-events-none disabled:opacity-50";

export type ComposerContextPanelProps = {
  /** The session this panel assembles context for (MCP enablement is
   *  per-session, ADR-0083). */
  sessionId: string;
  /** Hand the picked paths to the ingest pipeline (useIngestFlow's
   *  handleIngestMany: sequential, halts on guidance / error). */
  onIngestFiles: (paths: string[]) => void;
  /** The session is mid-turn or mid-mutation: file additions are gated off
   *  (same gate the retired FileDropzone honored). */
  loading: boolean;
  /** The app-config registry has at least one configured MCP server. Drives
   *  the degraded decision together with the skill-registry read; undefined
   *  app-config reads as "not configured" until it resolves. */
  mcpConfigured: boolean;
  /** Hop to the settings SkillsSection. The shell owns the navigation; App
   *  threads openSettings({ section: "skills" }) through SessionPane. The
   *  skill section's "Manage skills" footer fires this (issue #365 AC #4). */
  onOpenSettingsSkills: () => void;
};

export function ComposerContextPanel({
  sessionId,
  onIngestFiles,
  loading,
  mcpConfigured,
  onOpenSettingsSkills,
}: ComposerContextPanelProps) {
  const intl = useIntl();
  const [panelOpen, setPanelOpen] = useState(false);

  // Per-session MCP status (issue #301 slice D): the badge counts the servers
  // THIS session enabled. The query is lock-light server-side, so one read per
  // mounted pane is cheap; a reject (session closed mid-flight) degrades to
  // data-undefined -> count 0, never a user-facing error.
  // TODO(#301 follow-up): invalidate mcpStatus after the MCP section's toggle
  // flips a server, so the badge re-reads without a remount.
  const { data: mcpStatus } = useQuery({
    queryKey: sessionKeys.mcpStatus(sessionId),
    queryFn: () => listMcpServerStatus(sessionId),
  });
  const enabledMcpCount = (mcpStatus ?? []).filter((s) => s.enabled).length;

  // Per-session mounted skills (issue #365). The badge count + the section's
  // checkbox state share this query's cache (ComposerSkillsSection reads the
  // same key). Lock-light server-side; a reject (session closed mid-flight)
  // degrades to data-undefined -> count 0, never a user-facing error. Mount /
  // unmount invalidate the key so the badge re-reads without a remount.
  const { data: mounted } = useQuery({
    queryKey: sessionKeys.mountedSkills(sessionId),
    queryFn: () => listMountedSkills(sessionId),
  });
  const mountedSkillCount = (mounted ?? []).length;

  // Process-global skill registry (issue #362). Drives the degraded decision:
  // the panel serves no purpose when there is nothing to assemble (registry
  // empty AND no MCP configured). The ComposerSkillsSection inside the popover
  // reads the same key -- the first consumer pays the IPC, the second rides
  // the cache.
  const { data: listing } = useQuery({
    queryKey: skillKeys.all(),
    queryFn: listSkills,
  });
  const hasSkills = (listing?.skills ?? []).length > 0;

  const badgeCount = mountedSkillCount + enabledMcpCount;

  // ADR-0083 degraded mode: nothing to assemble -> "+" is a pure add-files
  // button (dialog directly, no panel shell, no badge). Before the registry
  // resolves the read is undefined -> hasSkills false -> degrade, matching the
  // pre-slice behavior; once it resolves the panel opens if there is anything
  // to attach.
  const degraded = !mcpConfigured && !hasSkills;

  async function pickFiles() {
    const selected = await open({
      multiple: true,
      filters: [
        {
          // Shared filter label with the working-set replace picker so every
          // data-file dialog reads identically.
          name: intl.formatMessage({
            id: "workingSet.fileFilter",
            defaultMessage: "Data files",
          }),
          extensions: DATA_FILE_EXTENSIONS,
        },
      ],
    });
    // The plugin's union return narrows on `multiple`, but the type stays
    // string | string[] | null -- normalize defensively.
    const paths = typeof selected === "string" ? [selected] : selected ?? [];
    if (paths.length === 0) return; // dialog cancelled -> keep the panel open
    setPanelOpen(false);
    onIngestFiles(paths);
  }

  const filesOnlyLabel = intl.formatMessage({
    id: "composer.contextPanel.triggerAriaFilesOnly",
    defaultMessage: "Add files",
  });

  if (degraded) {
    return (
      <button
        type="button"
        className={TRIGGER_CLASS}
        disabled={loading}
        aria-label={filesOnlyLabel}
        onClick={() => void pickFiles()}
      >
        <Plus className="size-4" aria-hidden />
      </button>
    );
  }

  const triggerLabel =
    badgeCount > 0
      ? intl.formatMessage(
          {
            id: "composer.contextPanel.triggerAriaWithCount",
            defaultMessage: "Add session context ({count} attached)",
          },
          { count: badgeCount },
        )
      : intl.formatMessage({
          id: "composer.contextPanel.triggerAria",
          defaultMessage: "Add session context",
        });

  return (
    <Popover open={panelOpen} onOpenChange={setPanelOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={TRIGGER_CLASS} aria-label={triggerLabel}>
          <Plus className="size-4" aria-hidden />
          {badgeCount > 0 && (
            // The count also rides the trigger's accessible name, so the
            // visual chip stays aria-hidden (one announcement, not two).
            <span
              className="composer-context-badge absolute -right-1.5 -top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground"
              aria-hidden="true"
            >
              {badgeCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      {/* The composer row sits at the pane's bottom edge -> open upward. */}
      <PopoverContent side="top" align="start" className="w-64 p-3">
        <div className="grid gap-3">
          {/* Section 1: files -- live. Multi-select into the ingest pipeline. */}
          <section className="grid gap-1.5">
            <span className="text-sm font-medium">
              <FormattedMessage
                id="composer.contextPanel.filesTitle"
                defaultMessage="Add files"
              />
            </span>
            <button
              type="button"
              disabled={loading}
              onClick={() => void pickFiles()}
              className="inline-flex h-8 w-full items-center rounded-md border border-border bg-background px-3 text-sm transition-colors hover:bg-muted cursor-pointer disabled:pointer-events-none disabled:opacity-50"
            >
              <FormattedMessage
                id="composer.contextPanel.pickFiles"
                defaultMessage="Select data files…"
              />
            </button>
          </section>
          {/* Section 2: skills -- live (issue #365). Compact checkbox list of
              every registry skill; each toggle mounts / unmounts into THIS
              session's active set, appending a SkillLifecycleEvent + driving
              the trigger badge via the shared mounted-skills query. */}
          <ComposerSkillsSection
            sessionId={sessionId}
            loading={loading}
            onOpenSettingsSkills={onOpenSettingsSkills}
          />
          {/* Section 3: MCP tools -- disabled placeholder until #301 lights it
              up (server-granularity per-session enablement multi-select). */}
          <section className="grid gap-1.5 opacity-60" aria-disabled="true">
            <span className="text-sm font-medium text-muted-foreground">
              <FormattedMessage
                id="composer.contextPanel.mcpTitle"
                defaultMessage="MCP tools"
              />
            </span>
            <span className="text-xs text-muted-foreground">
              <FormattedMessage
                id="composer.contextPanel.placeholderHint"
                defaultMessage="Not available yet"
              />
            </span>
          </section>
        </div>
      </PopoverContent>
    </Popover>
  );
}
