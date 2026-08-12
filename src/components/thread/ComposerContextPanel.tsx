import { useIntl } from "react-intl";
import { open } from "@tauri-apps/plugin-dialog";
import { Plus } from "lucide-react";

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

const DATA_FILE_EXTENSIONS = ["csv", "parquet", "json", "jsonl", "ndjson", "xlsx"];

const TRIGGER_CLASS =
  "composer-context-trigger relative inline-flex size-9 items-center justify-center rounded-md border border-border bg-card text-foreground transition-colors hover:bg-muted cursor-pointer disabled:pointer-events-none disabled:opacity-50";

export type ComposerContextPanelProps = {
  /** Hand the picked paths to the ingest pipeline (useIngestFlow's
   *  handleIngestMany: sequential, halts on guidance / error). */
  onIngestFiles: (paths: string[]) => void;
  /** The session is mid-turn or mid-mutation: file additions are gated off
   *  (same gate the retired FileDropzone honored). */
  loading: boolean;
};

export function ComposerContextPanel({
  onIngestFiles,
  loading,
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

  return (
    <button
      type="button"
      className={TRIGGER_CLASS}
      disabled={loading}
      aria-label={label}
      onClick={() => void pickFiles()}
    >
      <Plus className="size-4" aria-hidden />
    </button>
  );
}
