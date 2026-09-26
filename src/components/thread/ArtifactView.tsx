// The workspace's artifact stage (ADR-0124 Decision 3/4, issue #1088): the
// file branch of the single-stage workspace. The render matrix keys off the
// derived ArtifactRenderKind -- HTML rides the sandboxed asset-protocol
// iframe, md rides the IPC text read + the shared prose renderer, everything
// else (and every degrade) is the file card.
//
// Trust boundary (Decision 4): the iframe runs with sandbox="allow-scripts"
// and NO allow-same-origin -- agent-generated HTML may execute (interactive
// reports stay usable) but only inside the opaque origin, never reading the
// app page or its credentials. The asset protocol's runtime scope covers the
// per-session artifacts directory only, so an out-of-scope HTML path (a
// user-directory original, an unbound temp path) degrades to the card rather
// than pointing the iframe at a denial.
//
// Existence is a render-time fact (Decision 2): artifact_exists answers
// whether the file still sits on disk; a miss degrades the card to the
// not-openable state and NOTHING rewrites the manifest.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FormattedMessage } from "react-intl";
import { FileDown, FileWarning } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/utils";
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
   *  for the HTML branch. */
  duckPath: string;
}) {
  if (render === "html") {
    // The scope check is a render fact, not a query: the duck path and the
    // manifest paths are both settle/stable strings. A user-directory
    // original or an unbound temp path would be denied by the asset
    // protocol, so the card IS the render (Decision 4).
    if (!isWithinArtifactsDir(artifact.path, duckPath)) {
      return <ArtifactFallbackCard artifact={artifact} />;
    }
    return <HtmlArtifactGate path={artifact.path} fileName={artifact.file_name} />;
  }
  if (render === "markdown") {
    return <MarkdownArtifact path={artifact.path} fallback={artifact} />;
  }
  return <ArtifactFallbackCard artifact={artifact} />;
}

/** The existence gate before the iframe (Decision 2's honest degrade, the
 * one branch that used to skip it): a missing in-scope file must render
 * the not-openable card, not point the frame at a denial the opaque origin
 * would show as the WebView's own error page. Shares the rail row's exists
 * cache entry (same artifactKeys key), so the row's check pays for this. */
function HtmlArtifactGate({ path, fileName }: { path: string; fileName: string }) {
  const exists = useArtifactExists(path);
  if (!exists) {
    return <ArtifactFallbackCard artifact={{ path, file_name: fileName }} />;
  }
  return <HtmlArtifactShell path={path} fileName={fileName} />;
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

/** md rides the IPC text read (extension-pinned + size-capped server-side)
 *  into the shared prose renderer -- the same pipeline as an agent answer,
 *  settled mode (no live fences to placeholder). A refusal (over the cap)
 *  or any read failure degrades to the card, never a partial render. */
function MarkdownArtifact({
  path,
  fallback,
}: {
  path: string;
  fallback: { path: string; file_name: string };
}) {
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
  if (text.isError) return <ArtifactFallbackCard artifact={fallback} />;
  return <RoundProse text={text.data} />;
}

/** The card face: file name + the external-open action, or the not-openable
 *  state when the file no longer exists. Shared by every degrade (non-md/html
 *  formats, out-of-scope HTML, refused reads) so the honest fallback is one
 *  shape, not three. */
function ArtifactFallbackCard({
  artifact,
}: {
  artifact: { path: string; file_name: string };
}) {
  const [openFailed, setOpenFailed] = useState(false);
  const exists = useArtifactExists(artifact.path);
  const handleOpen = () => {
    setOpenFailed(false);
    // openPath hands the path to the OS opener; a failure surfaces as a
    // caption note (the RoundProse openUrl twin), not a thrown promise.
    openPath(artifact.path).catch(() => setOpenFailed(true));
  };
  return (
    <div
      data-testid="artifact-card"
      // DESIGN card token: bg-card + hairline border + rounded.lg, centered
      // in the panel as the quiet end-state of the render matrix.
      className="mx-auto mt-16 flex w-fit max-w-full flex-col items-center gap-2 rounded-lg border bg-card px-6 py-5 text-sm"
    >
      <span
        role="img"
        aria-label={artifact.file_name}
        className={cn("text-muted-foreground", !exists && "opacity-60")}
      >
        {exists ? (
          <FileDown aria-hidden="true" className="h-6 w-6" />
        ) : (
          <FileWarning aria-hidden="true" className="h-6 w-6" />
        )}
      </span>
      {/* Layer-4 content (the file's own name) passes through untranslated;
          break-words keeps a long name inside the capped card. */}
      <p className="m-0 max-w-full break-words font-medium">{artifact.file_name}</p>
      {exists ? (
        <button
          type="button"
          className="cursor-pointer rounded-md border px-3 py-1.5 text-xs hover:bg-accent"
          onClick={handleOpen}
        >
          <FormattedMessage
            id="workspace.artifact.openExternal"
            defaultMessage="Open externally"
          />
        </button>
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
  );
}
