import { useIntl } from "react-intl";
import { open } from "@tauri-apps/plugin-dialog";
import { Plus, X } from "lucide-react";

// The composer "+" files button (ADR-0083, issue #351). A single action button
// that opens the multi-select file dialog directly -- no popover shell. Skills
// and MCP moved to dedicated trigger chips above the QuestionBar
// (ComposerSkillsTrigger / ComposerMcpTrigger).
//
// The retired standalone source entry (the workspace-hero FileDropzone button)
// moved here; window-level drag-and-drop stays untouched (App's single
// listener, ADR-0061), and the ingest pipeline + source lifecycle events
// (ADR-0040) are unchanged -- onIngestFiles routes through useIngestFlow's
// handleIngestMany.
//
// Cold start (ADR-0092 Decision 6, #500): picks do NOT ingest immediately --
// the shell accumulates them in its pending file list and the first submit
// carries the list onto the minted session. pendingFiles renders that queue
// as a compact count chip beside the "+" button (file names in the tooltip,
// X clears the whole queue) so the queued state is visible instead of silent.
// Session-active bars omit the chip (pendingFiles is undefined).

const DATA_FILE_EXTENSIONS = ["csv", "parquet", "json", "jsonl", "ndjson", "xlsx"];

const TRIGGER_CLASS =
  "composer-context-trigger relative inline-flex size-9 items-center justify-center rounded-md border border-border bg-card text-foreground transition-colors hover:bg-muted cursor-pointer disabled:pointer-events-none disabled:opacity-50";

// The pending-queue chip chrome: the muted surface + small text match the
// composer's trigger chips; max-w keeps a long queue from stretching the
// toolbar row (the tooltip carries every name).
const PENDING_CHIP_CLASS =
  "composer-context-pending inline-flex max-w-40 items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground";

export type ComposerContextPanelProps = {
  /** Hand the picked paths to the ingest pipeline (useIngestFlow's
   *  handleIngestMany when a session is active) or to the shell-level pending
   *  file list on the cold-start bar (ADR-0092 / #500). */
  onIngestFiles: (paths: string[]) => void;
  /** The session is mid-turn or mid-mutation: file additions are gated off
   *  (same gate the retired FileDropzone honored). */
  loading: boolean;
  /** Cold-start draft mode (#500): the shell-held pending file list queued
   *  for the first submit. Undefined when a session is active (the chip never
   *  renders there). */
  pendingFiles?: string[];
  /** Clear the whole pending file list (the chip's X affordance). */
  onClearPendingFiles?: () => void;
};

export function ComposerContextPanel({
  onIngestFiles,
  loading,
  pendingFiles,
  onClearPendingFiles,
}: ComposerContextPanelProps) {
  const intl = useIntl();

  async function pickFiles() {
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: intl.formatMessage({
            id: "workingSet.fileFilter",
            defaultMessage: "Data files",
          }),
          extensions: DATA_FILE_EXTENSIONS,
        },
      ],
    });
    const paths = typeof selected === "string" ? [selected] : selected ?? [];
    if (paths.length === 0) return;
    onIngestFiles(paths);
  }

  const label = intl.formatMessage({
    id: "composer.contextPanel.filesTitle",
    defaultMessage: "Add files",
  });

  const pendingCount = pendingFiles?.length ?? 0;
  const pendingLabel =
    pendingCount > 0
      ? intl.formatMessage(
          {
            id: "composer.contextPanel.pendingFilesLabel",
            defaultMessage: "{count} files queued for the next session",
          },
          { count: pendingCount },
        )
      : null;

  return (
    <>
      <button
        type="button"
        className={TRIGGER_CLASS}
        disabled={loading}
        aria-label={label}
        onClick={() => void pickFiles()}
      >
        <Plus className="size-4" aria-hidden />
      </button>
      {pendingCount > 0 && pendingLabel !== null && (
        <span
          className={PENDING_CHIP_CLASS}
          aria-label={pendingLabel}
          title={(pendingFiles ?? []).map(baseName).join(", ")}
        >
          <span className="truncate">{pendingCount}</span>
          <button
            type="button"
            className="hover:text-foreground cursor-pointer rounded-sm p-0.5 transition-colors"
            aria-label={intl.formatMessage({
              id: "composer.contextPanel.clearPendingFiles",
              defaultMessage: "Clear queued files",
            })}
            onClick={() => onClearPendingFiles?.()}
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      )}
    </>
  );
}

// The file name portion of a picked path (both separator styles -- Windows
// picks carry backslashes, POSIX paths forward slashes). Falls back to the
// whole path when neither separator is present.
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
