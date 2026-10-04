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
import { useQuery } from "@tanstack/react-query";
import { FormattedMessage, useIntl } from "react-intl";
import { Button } from "../ui/button";
import { ExternalLink, FileDown, FileWarning } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { readArtifactText } from "../../api";
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
  const [openFailed, setOpenFailed] = useState(false);
  const intl = useIntl();
  const openLabel = intl.formatMessage({
    id: "workspace.artifact.openExternal",
    defaultMessage: "Open externally",
  });
  const handleOpen = () => {
    setOpenFailed(false);
    // openPath hands the path to the OS opener; a failure surfaces as a
    // caption note in the header (the RoundProse openUrl twin), not a
    // thrown promise.
    openPath(artifact.path).catch(() => setOpenFailed(true));
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
          ) : (
            <p className="m-0 text-xs text-muted-foreground">
              <FormattedMessage
                id="workspace.artifact.missing"
                defaultMessage="This file is no longer on disk"
              />
            </p>
          )}
          {openFailed && (
            <p className="m-0 text-xs text-muted-foreground" role="status">
              <FormattedMessage
                id="workspace.artifact.openFailed"
                defaultMessage="Could not open the file externally"
              />
            </p>
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ArtifactStageBody
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
 * centered face -- the header above keeps the name and the open entry, so
 * no failure state ever blanks the stage chrome (issue #1199). */
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

/** The isolated HTML shell (Decision 4's trust boundary). sandbox is pinned
 *  to exactly "allow-scripts" -- adding allow-same-origin would hand the
 *  opaque origin back its documents; the attribute's absence would kill
 *  interactive reports. */
function HtmlArtifactShell({ path, fileName }: { path: string; fileName: string }) {
  return (
    <iframe
      data-testid="artifact-frame"
      className="h-full w-full border-0 bg-background"
      src={convertFileSrc(path)}
      sandbox="allow-scripts"
      title={fileName}
    />
  );
}

/** The pdf viewer shell (issue #1199): the same asset-protocol iframe as
 *  html, deliberately WITHOUT the sandbox attribute -- the WebView's
 *  built-in viewer is a document renderer, not executable agent HTML, so
 *  there is no script surface to confine to an opaque origin (and an empty
 *  sandbox value would disable the frame entirely). A platform without a
 *  built-in viewer (Linux WebKitGTK) leaves the frame blank -- the header's
 *  external-open action above is the escape hatch, which is exactly why the
 *  header never degrades away. */
function PdfArtifactShell({ path, fileName }: { path: string; fileName: string }) {
  return (
    <iframe
      data-testid="artifact-frame"
      className="h-full w-full border-0 bg-background"
      src={convertFileSrc(path)}
      title={fileName}
    />
  );
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
