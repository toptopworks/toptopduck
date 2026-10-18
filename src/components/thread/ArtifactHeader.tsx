// The stage's persistent file header (issue #1199): the chrome that survives
// every degrade -- the file's own name, the external-open action, and the
// more menu (issue #1317) with refresh / show-in-folder / save-as. The stage
// above owns the single existence read (Decision 2); it arrives as a prop
// and the header only renders the gate -- an existing file gets the action
// cluster, a missing one gets the standing note. Refresh is a stage verb (it
// re-reads the exists/text caches and re-keys the body), so the header
// merely carries it as an onRefresh callback and this module stays free of
// the query client.
//
// The header's single failure slot (issue #1317): at most one live note at a
// time -- whichever action failed last; starting any action (refresh
// included) clears the previous note.

import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { ExternalLink, FolderOpen, MoreHorizontal, RefreshCw, Save } from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { copyArtifactFile } from "../../api";
import { log } from "../../lib/log";

type FailureKind = "open" | "folder" | "save";

export function ArtifactHeader({
  artifact,
  exists,
  onRefresh,
}: {
  /** The manifest entry the view resolves: the path (identity) the OS verbs
   *  act on + the file_name (display) the header shows. */
  artifact: { path: string; file_name: string };
  /** The stage's render-time existence fact (Decision 2): a miss swaps the
   *  action cluster for the standing note -- the header never re-reads. */
  exists: boolean;
  /** The stage's refresh verb (cache invalidation + body re-key); the menu's
   *  refresh item leads with the failure-slot clear, then delegates. */
  onRefresh: () => void;
}) {
  const [failure, setFailure] = useState<FailureKind | null>(null);
  const intl = useIntl();
  const openLabel = intl.formatMessage({
    id: "workspace.artifact.openExternal",
    defaultMessage: "Open externally",
  });
  const moreLabel = intl.formatMessage({
    id: "workspace.artifact.moreActions",
    defaultMessage: "More actions",
  });
  const handleOpen = () => {
    setFailure(null);
    // openPath hands the path to the OS opener; a failure is logged (the
    // RoundProse openUrl twin) and surfaces as a caption note in the
    // header, not a thrown promise.
    openPath(artifact.path).catch((e: unknown) => {
      log.warn("ArtifactHeader", "openPath failed", e);
      setFailure("open");
    });
  };
  const handleOpenFolder = () => {
    setFailure(null);
    revealItemInDir(artifact.path).catch((e: unknown) => {
      log.warn("ArtifactHeader", "revealItemInDir failed", e);
      setFailure("folder");
    });
  };
  // A cancelled dialog is a quiet no-op (the exportRowsCsv posture).
  const handleSaveAs = async () => {
    setFailure(null);
    try {
      const target = await saveDialog({ defaultPath: artifact.file_name });
      if (target === null) return;
      await copyArtifactFile(artifact.path, target);
    } catch (e) {
      log.warn("ArtifactHeader", "save-as copy failed", e);
      setFailure("save");
    }
  };
  // Refresh leads with the same slot-clearing as every other action, then
  // hands off to the stage's verb (cache invalidation + body re-key).
  const handleRefresh = () => {
    setFailure(null);
    onRefresh();
  };
  return (
    <header
      data-testid="artifact-header"
      // Asymmetric padding on purpose: the name aligns with the body's 16px
      // text edge (pl-4), while the actions pull 4px closer to the pane
      // corner (pr-3) -- chrome hugs the corner, content keeps the margin.
      className="flex shrink-0 items-center justify-between gap-2 border-b py-1.5 pl-4 pr-3"
    >
      {/* Layer-4 content (the file's own name) passes through untranslated;
          truncate keeps a long name from pushing the action out. */}
      <p className="m-0 min-w-0 truncate text-sm font-medium">{artifact.file_name}</p>
      <div className="flex shrink-0 items-center gap-2">
        {exists ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-testid="artifact-open-external"
              title={openLabel}
              aria-label={openLabel}
              className="h-7 w-7 text-muted-foreground"
              onClick={handleOpen}
            >
              <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  data-testid="artifact-more-menu"
                  title={moreLabel}
                  aria-label={moreLabel}
                  className="h-7 w-7 text-muted-foreground"
                >
                  {/* The SessionHeaderMenu trigger shape (ADR-0067 #171). */}
                  <MoreHorizontal aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2.5} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" aria-label={moreLabel}>
                <DropdownMenuItem onSelect={handleRefresh}>
                  <RefreshCw aria-hidden />
                  <FormattedMessage
                    id="workspace.artifact.refresh"
                    defaultMessage="Refresh"
                  />
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handleOpenFolder}>
                  <FolderOpen aria-hidden />
                  <FormattedMessage
                    id="workspace.artifact.openFolder"
                    defaultMessage="Show in folder"
                  />
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handleSaveAs}>
                  <Save aria-hidden />
                  <FormattedMessage
                    id="workspace.artifact.saveAs"
                    defaultMessage="Save as…"
                  />
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : (
          <p className="m-0 text-xs text-muted-foreground">
            <FormattedMessage
              id="workspace.artifact.missing"
              defaultMessage="This file is no longer on disk"
            />
          </p>
        )}
        {failure === "open" && (
          <p className="m-0 text-xs text-muted-foreground" role="status">
            <FormattedMessage
              id="workspace.artifact.openFailed"
              defaultMessage="Could not open the file externally"
            />
          </p>
        )}
        {failure === "folder" && (
          <p className="m-0 text-xs text-muted-foreground" role="status">
            <FormattedMessage
              id="workspace.artifact.folderFailed"
              defaultMessage="Could not locate the file in the folder"
            />
          </p>
        )}
        {failure === "save" && (
          <p className="m-0 text-xs text-muted-foreground" role="status">
            <FormattedMessage
              id="workspace.artifact.saveFailed"
              defaultMessage="Could not save a copy of the file"
            />
          </p>
        )}
      </div>
    </header>
  );
}
