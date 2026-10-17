// The workspace's artifact stage (ADR-0124 Decision 4, issue #1088): the
// file branch of the single-stage workspace, two-part under a persistent
// file header (issue #1199) -- the header (name + external-open action) is
// the stage's chrome and survives every degrade; the body renders per the
// matrix. The matrix keys off the derived ArtifactRenderKind -- HTML rides
// the sandboxed asset-protocol iframe, pdf rides the same protocol
// UNSANDBOXED (the WebView's built-in viewer is a document renderer, not
// executable agent HTML), md rides the IPC text read + the shared prose
// renderer, everything else (and every degrade) is the centered face.
//
// Trust boundary (Decision 4): the HTML iframe runs with
// sandbox="allow-scripts" and NO allow-same-origin -- agent-generated HTML
// may execute (interactive reports stay usable) but only inside the opaque
// origin, never reading the app page or its credentials. The pdf frame pins
// the inverse posture: no sandbox attribute at all, because the viewer
// exposes no script surface to confine. The asset protocol's runtime scope
// covers the per-session artifacts directory only, so an out-of-scope path
// (a user-directory original, an unbound temp path) degrades to the face
// rather than pointing a frame at a denial.
//
// Existence is a render-time fact (Decision 2): artifact_exists answers
// whether the file still sits on disk; a miss degrades the body to the
// warning face, hides the open action, and NOTHING rewrites the manifest.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FormattedMessage, useIntl } from "react-intl";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  ExternalLink,
  FileDown,
  FileWarning,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Save,
} from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { copyArtifactFile, readArtifactText } from "../../api";
import { log } from "../../lib/log";
import { artifactKeys } from "../../session/queryKeys";
import { useArtifactExists } from "../../session/useArtifactExists";
import { isWithinArtifactsDir, type ArtifactRenderKind } from "../../session/workspace";
import { RoundProse } from "./RoundProse";

export function ArtifactView({
  artifact,
  render,
  duckPath,
}: {
  /** The manifest entry the view resolves (thread-derived, settle-frozen):
   *  the path (identity) + file_name (display) the derivation carries. */
  artifact: { path: string; file_name: string };
  /** The derived render matrix branch (deriveWorkspaceContent's output). */
  render: ArtifactRenderKind;
  /** The session's bound .duck path -- anchors the artifacts-dir scope check
   *  for the html/pdf iframe branches. */
  duckPath: string;
}) {
  // One existence read for the whole stage: the header's action gate and the
  // body's degrade share the entry (and the rail row's cache -- the same
  // artifactKeys key), so the check is paid once.
  const exists = useArtifactExists(artifact.path);
  // One failure slot for the whole header (issue #1317): at most one live
  // note at a time -- starting an action clears the previous note.
  const [failure, setFailure] = useState<"open" | "folder" | "save" | null>(null);
  // The stage body's remount counter: bumping it re-keys ArtifactStageBody,
  // re-running the iframe branches (a fresh iframe re-reads the file off
  // disk) and remounting the md text query.
  const [refreshKey, setRefreshKey] = useState(0);
  const queryClient = useQueryClient();
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
      log.warn("ArtifactView", "openPath failed", e);
      setFailure("open");
    });
  };
  const handleRefresh = async () => {
    setFailure(null);
    // md's text query is staleTime Infinity -- the remount alone never
    // re-reads, so the cache entry is invalidated first, and the await lets
    // the refetch land before the re-key (one deterministic read, no
    // stale-text flash). The iframe branches need nothing (no query; the
    // re-key remount re-reads from disk).
    await queryClient.invalidateQueries({ queryKey: artifactKeys.text(artifact.path) });
    setRefreshKey((k) => k + 1);
  };
  const handleOpenFolder = () => {
    setFailure(null);
    revealItemInDir(artifact.path).catch((e: unknown) => {
      log.warn("ArtifactView", "revealItemInDir failed", e);
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
      log.warn("ArtifactView", "save-as copy failed", e);
      setFailure("save");
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header
        data-testid="artifact-header"
        className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-1.5"
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ArtifactStageBody
          key={refreshKey}
          artifact={artifact}
          render={render}
          duckPath={duckPath}
          exists={exists}
        />
      </div>
    </div>
  );
}

/** The matrix body under the header. Every branch gate degrades to the
 * centered face -- the header above keeps the name (and the open entry
 * whenever the file still exists), so no failure state ever blanks the
 * stage chrome (issue #1199). */
function ArtifactStageBody({
  artifact,
  render,
  duckPath,
  exists,
}: {
  artifact: { path: string; file_name: string };
  render: ArtifactRenderKind;
  duckPath: string;
  exists: boolean;
}) {
  // The iframe branches share one degrade gate (Decision 2/4): the scope
  // check is a render fact (the duck path and the manifest paths are
  // settle/stable strings), and a missing in-scope file must render the
  // face, not point a frame at a denial the protocol would show as the
  // WebView's own error page.
  const inScope = isWithinArtifactsDir(artifact.path, duckPath);
  if (render === "html") {
    if (!inScope || !exists) {
      return <ArtifactFallbackFace exists={exists} />;
    }
    return <HtmlArtifactShell path={artifact.path} fileName={artifact.file_name} />;
  }
  if (render === "pdf") {
    if (!inScope || !exists) {
      return <ArtifactFallbackFace exists={exists} />;
    }
    return <PdfArtifactShell path={artifact.path} fileName={artifact.file_name} />;
  }
  if (render === "markdown") {
    return <MarkdownArtifact path={artifact.path} exists={exists} />;
  }
  return <ArtifactFallbackFace exists={exists} />;
}

/** The shared document frame (issue #1201): one relative box per iframe so
 *  the mounting window -- the frame is attached before the document's first
 *  paint, seconds for a slow fetch -- reads as "loading" rather than as a
 *  blank or broken file. The overlay is a passive status (aria-label only,
 *  no progress or timeout semantics): the escape hatch for a stuck load is
 *  the header's external-open action, never a spinner guess. */
function ArtifactFrame({
  path,
  fileName,
  sandbox,
}: {
  path: string;
  fileName: string;
  /** The branch's trust posture, pinned at the call site: "allow-scripts"
   *  for html; absent (undefined never renders the attribute) for pdf. */
  sandbox?: "allow-scripts";
}) {
  const [isLoaded, setIsLoaded] = useState(false);
  const intl = useIntl();
  return (
    <div className="relative h-full w-full">
      <iframe
        data-testid="artifact-frame"
        className="h-full w-full border-0 bg-background"
        src={convertFileSrc(path)}
        sandbox={sandbox}
        title={fileName}
        onLoad={() => setIsLoaded(true)}
      />
      {!isLoaded && (
        <div
          role="status"
          aria-label={intl.formatMessage({
            id: "workspace.artifact.loading",
            defaultMessage: "Loading document",
          })}
          className="absolute inset-0 flex items-center justify-center bg-background text-muted-foreground"
        >
          <Loader2 aria-hidden="true" className="h-6 w-6 animate-spin" />
        </div>
      )}
    </div>
  );
}

/** The isolated HTML shell (Decision 4's trust boundary): scripts execute
 *  inside the opaque origin, but it never reads the app page -- the frame
 *  is pinned to exactly "allow-scripts"; adding allow-same-origin would
 *  hand the origin back its documents, and the attribute's absence would
 *  kill interactive reports. */
function HtmlArtifactShell({ path, fileName }: { path: string; fileName: string }) {
  return <ArtifactFrame path={path} fileName={fileName} sandbox="allow-scripts" />;
}

/** The pdf viewer shell (issue #1199): the same frame deliberately WITHOUT
 *  the sandbox attribute -- the built-in viewer is a document renderer, not
 *  executable agent HTML, so there is no script surface to confine (an
 *  empty sandbox value would disable the frame entirely). */
function PdfArtifactShell({ path, fileName }: { path: string; fileName: string }) {
  return <ArtifactFrame path={path} fileName={fileName} />;
}

/** md rides the IPC text read (extension-pinned + size-capped server-side)
 *  into the shared prose renderer -- the same pipeline as an agent answer,
 *  settled mode (no live fences to placeholder). A refusal (over the cap)
 *  or any read failure degrades to the face, never a partial render. */
function MarkdownArtifact({ path, exists }: { path: string; exists: boolean }) {
  const text = useQuery({
    queryKey: artifactKeys.text(path),
    queryFn: () => readArtifactText(path),
    // One read per path (the manifest is settle-frozen): never stale and
    // focus refetch is off app-wide, so the text re-reads only when the
    // cache entry ages out (gcTime after the last observer unmounts) and a
    // later mount re-observes it.
    staleTime: Infinity,
    retry: false,
  });
  if (text.isPending) return null;
  if (text.isError) return <ArtifactFallbackFace exists={exists} />;
  return <RoundProse text={text.data} />;
}

/** The degrade face: one centered glyph for every body the matrix cannot
 *  render -- idle (FileDown) when the file is on disk but not embeddable
 *  (docx/xlsx/pptx, a refused md read), warning (FileWarning) when it is
 *  gone. Name and actions live in the header above, so the face carries no
 *  chrome of its own (issue #1199). */
function ArtifactFallbackFace({ exists }: { exists: boolean }) {
  return (
    <div
      data-testid="artifact-face"
      className="flex h-full items-center justify-center text-muted-foreground"
    >
      {exists ? (
        <FileDown aria-hidden="true" className="h-6 w-6" />
      ) : (
        <FileWarning aria-hidden="true" className="h-6 w-6" />
      )}
    </div>
  );
}
