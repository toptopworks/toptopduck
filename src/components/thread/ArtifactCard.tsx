// The inline artifact manifest card (ADR-0124 Decision 3, issue #1088): the
// rail face of a turn's delivered-files list, riding the same position and
// rhythm as ResultPreviewCard (end of the assistant stream, one card per
// turn, never nested in the outcome body -- the manifest is turn-level, so
// it renders for every outcome kind that carried one).
//
// Dual-view seam (ADR-0083's shape): clicking a row selects that file (the
// caller opens the workspace + moves the view); `active` mirrors the viewed
// file back onto the row, so the rail and the panel agree on which file is
// on stage -- the file twin of the preview card's dataset linkage.
//
// Existence is a render-time fact (ADR-0124 Decision 2): each row asks
// artifact_exists whether its file still sits on disk; a miss renders the
// not-openable state (dimmed, no click) and NOTHING rewrites the manifest --
// a settled turn keeps its full list forever, deletions only degrade.

import { useQuery } from "@tanstack/react-query";
import { FormattedMessage, useIntl } from "react-intl";
import { FileText, FileX2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { artifactExists } from "../../api";
import { artifactKeys } from "../../session/queryKeys";
import type { TurnArtifact } from "../../types/thread";

export function ArtifactCard({
  artifacts,
  activePath,
  stale,
  onSelectFile,
}: {
  artifacts: TurnArtifact[];
  /** The viewed file's absolute path (workspace dual-view linkage): the row
   *  carrying it renders active. null while a dataset (or hero) is on stage. */
  activePath: string | null;
  /** The turn is a stale ghost: the card dims + dashes with it, still
   *  clickable -- a stale turn's files stay viewable (the ResultPreviewCard
   *  treatment; staleness is a dataset-fact, the files are untouched). */
  stale: boolean;
  /** Selects a file onto the workspace stage. Optional so unwired callers
   *  (tests) render the list read-only. */
  onSelectFile?: (path: string) => void;
}) {
  return (
    <div
      // The card hugs its content like ResultPreviewCard (the stream is
      // items-start); max-w-full caps the hug at the stream width.
      className={cn(
        "artifacts-card mt-4 block max-w-full rounded-md border bg-background text-left text-xs",
        stale && "stale border-dashed",
      )}
      data-stale={stale ? "true" : undefined}
    >
      <p className="artifacts-label m-0 px-1.5 py-1 text-muted-foreground">
        <FormattedMessage
          id="thread.artifacts.label"
          defaultMessage="Delivered files ({count})"
          values={{ count: artifacts.length }}
        />
      </p>
      {artifacts.map((artifact) => (
        <ArtifactRow
          key={artifact.path}
          artifact={artifact}
          active={artifact.path === activePath}
          onSelectFile={onSelectFile}
        />
      ))}
    </div>
  );
}

function ArtifactRow({
  artifact,
  active,
  onSelectFile,
}: {
  artifact: TurnArtifact;
  active: boolean;
  onSelectFile?: (path: string) => void;
}) {
  const intl = useIntl();
  // Undefined (in flight) reads as openable: existence is the common case,
  // and flipping a live row to "missing" mid-check would flash.
  const exists =
    useQuery({
      queryKey: artifactKeys.exists(artifact.path),
      queryFn: () => artifactExists(artifact.path),
      staleTime: 0,
      retry: false,
    }).data !== false;
  if (!exists) {
    return (
      // The not-openable degrade: a span, not a dead button -- nothing to
      // click, the state says so. The manifest keeps the entry (Decision 2).
      <p
        data-testid="artifact-row-missing"
        className="m-0 flex items-center gap-1.5 border-t px-1.5 py-1 text-muted-foreground opacity-70"
      >
        <FileX2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{artifact.file_name}</span>
        <FormattedMessage id="thread.artifacts.missing" defaultMessage="· missing" />
      </p>
    );
  }
  return (
    <button
      type="button"
      className={cn(
        // result-link's bareButtonReset posture: a real button with the
        // card's row chrome; full-width rows keep one hit target per file.
        "artifact-row flex w-full cursor-pointer items-center gap-1.5 border-t px-1.5 py-1 text-left transition-colors",
        "hover:bg-accent",
        active && "active font-semibold",
      )}
      aria-current={active ? "true" : undefined}
      aria-label={intl.formatMessage(
        { id: "thread.artifacts.open", defaultMessage: "Open {name} in the workspace" },
        { name: artifact.file_name },
      )}
      onClick={() => onSelectFile?.(artifact.path)}
    >
      <FileText aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      {/* Layer-4 content (the file's own name) passes through untranslated;
          truncate keeps a long name from stretching the card past the rail. */}
      <span className="truncate">{artifact.file_name}</span>
    </button>
  );
}
