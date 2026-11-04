// The workspace dataset management panel (ADR-0141 D4): a modal off the
// sidebar's workspace-section menu -- list, browse-to-add, replace, rename,
// delete, privacy. Visibility follows the workspace, not any session: the
// panel owns the manifest; bound sessions read it live on their next turn.
// The form mirrors the working-set tab's master/detail shell (issue #1475):
// the list reuses WorkingSetList (no active pointer), the detail reuses the
// pure DatasetDetail renderer, and the preview is the manifest's frozen
// sample -- zero new read IPC.
//
// Copy never says "shared": the panel is this workspace's datasets (the
// dual-name label is user-renamable, the reference name stays the SQL and
// injection anchor). Code and i18n keys keep the workspace.datasets
// namespace.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open as openPicker } from "@tauri-apps/plugin-dialog";
import { Loader2, Upload } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import {
  addWorkspaceDataset,
  listWorkspaceDatasets,
  removeWorkspaceDataset,
  renameWorkspaceDataset,
  replaceWorkspaceDataset,
  setWorkspaceDatasetPrivacy,
} from "../api";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { DatasetDetail, type DatasetSamplePage } from "../components/dataset/DatasetDetail";
import { fileBasename } from "../lib/basename";
import { WorkingSetList } from "../components/dataset/WorkingSetList";
import type { DatasetDescriptor, DatasetPrivacy } from "../types/dataset";
import {
  isWorkspaceDatasetError,
  type ListedWorkspaceDataset,
} from "../types/workspace-datasets";

// The panel's target workspace: the listing projection's canonical path +
// label (the dialog is mounted per open, never re-targeted while open).
interface WorkspaceDatasetsDialogProps {
  workspace: { path: string; label: string } | null;
  onOpenChange: (open: boolean) => void;
}

// The extensions the shared face accepts (ADR-0141 D11: xlsx is refused --
// the picker never offers it; the store-side refusal stays as the honest
// boundary for any channel that slips one through).
const PICKER_EXTENSIONS = ["csv", "parquet", "json", "jsonl", "ndjson"];

// The in-flight upload's status line (issue #1485): what the picker's batch
// is doing right now -- the file's basename plus, for the add batch, its
// 1-based position and the batch size (a replace is a single-file wait and
// carries no position). Cleared when the batch settles.
type UploadStatus =
  | { mode: "add"; name: string; index: number; total: number }
  | { mode: "replace"; name: string };

// The master/detail sections' card chrome -- the working-set tab's
// PANEL_CARD_BASE form (bg-card + border + rounded + shadow + padding), so
// the two management faces read as one family.
const PANEL_CARD_BASE = "panel bg-card border rounded-lg shadow-sm p-4";

function datasetKey(path: string): readonly unknown[] {
  return ["workspace-datasets", path];
}

// One refusal's agent-free rendering: the catalog owns the wording, the
// technical detail rides the same string (the panel's only consumer).
function describeError(e: unknown, intl: ReturnType<typeof useIntl>): string {
  if (isWorkspaceDatasetError(e)) {
    switch (e.kind) {
      case "XlsxRejected":
        return intl.formatMessage({
          id: "workspace.datasets.error.xlsx",
          defaultMessage:
            "xlsx is not supported in this panel; convert to CSV/Parquet or use a session-private source",
        });
      case "LegacyExcel":
        return intl.formatMessage({
          id: "workspace.datasets.error.legacyExcel",
          defaultMessage: "Legacy .xls is not supported; save as .xlsx or CSV",
        });
      case "UnsupportedFormat":
        return intl.formatMessage(
          {
            id: "workspace.datasets.error.unsupported",
            defaultMessage: "Unsupported format: {format}",
          },
          { format: e.data },
        );
      case "ManifestCorrupt":
        return intl.formatMessage(
          {
            id: "workspace.datasets.error.corrupt",
            defaultMessage:
              "The workspace dataset manifest is corrupt (a copy was preserved); fix or remove datasets.json before editing",
          },
        );
      case "NotFound":
        return intl.formatMessage({
          id: "workspace.datasets.error.notFound",
          defaultMessage: "No dataset with that name",
        });
      case "InvalidLabel":
        return intl.formatMessage({
          id: "workspace.datasets.error.invalidLabel",
          defaultMessage: "A display name may not be blank",
        });
      case "DisplayTaken":
        return intl.formatMessage(
          {
            id: "workspace.datasets.error.displayTaken",
            defaultMessage: "Display name {name} is already taken",
          },
          { name: e.data },
        );
      case "DataUnreadable":
        // The catalog sentence leads; the engine string rides after it for
        // triage (issue #1483) -- never as the whole banner.
        return intl.formatMessage(
          {
            id: "workspace.datasets.error.dataUnreadable",
            defaultMessage:
              "The data file could not be parsed (the encoding may not be UTF-8, or the format is unrecognized); engine detail: {detail}",
          },
          { detail: e.data },
        );
      case "Io":
        return e.data;
      default: {
        const unhandled: never = e;
        throw new Error(`unhandled WorkspaceDatasetError: ${JSON.stringify(unhandled)}`);
      }
    }
  }
  return e instanceof Error ? e.message : String(e);
}

// A manifest entry onto the detail renderer's descriptor: the label comes
// from the manifest, the shared format has no rectify step, and a shared
// attach is never stale (staleness is a session-side result concept). The
// fingerprint is the store key (the source bytes' SHA256).
function toDescriptor(d: ListedWorkspaceDataset): DatasetDescriptor {
  return {
    reference_name: d.reference_name,
    display_name: d.display_name,
    source_path: d.source_path,
    columns: d.columns,
    row_count: d.row_count,
    sample: d.sample,
    fingerprint: d.fingerprint,
    size_bytes: d.size_bytes,
    rectify: { kind: "NotApplicable" },
    privacy: d.privacy,
  };
}

export function WorkspaceDatasetsDialog({ workspace, onOpenChange }: WorkspaceDatasetsDialogProps) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const open = workspace !== null;
  const [error, setError] = useState<string | null>(null);
  // The in-flight upload's status line (issue #1485): non-null while the
  // picker's add batch or a row's replace round-trips; cleared on settle.
  const [uploadStatus, setUploadStatus] = useState<UploadStatus | null>(null);
  // The detail pick (which row's detail the right pane shows), resolved to
  // the first entry when unset or deleted -- the band rides the resolved
  // pick so it never names a row that is no longer in the list.
  const [selectedName, setSelectedName] = useState<string | null>(null);
  // The close-animation anchor: clearing the workspace prop unmounts the
  // listing's query key mid-animation, and the panel would flash its empty
  // face while it plays. `panel` keeps the last non-null workspace, so the
  // key, the title and the listing all hold their rendered values until the
  // exit animation is done (the prop is nulled by the sidebar the moment
  // close is requested). React's render-time state adjustment pattern: the
  // branch fires only when the prop moved, and converges on the next render.
  const [panel, setPanel] = useState(workspace);
  const [lastSeen, setLastSeen] = useState(workspace);
  if (workspace !== lastSeen) {
    setLastSeen(workspace);
    setPanel(workspace ?? panel);
    if (workspace !== null) {
      // The open edge clears the transient state (the error banner and the
      // detail pick never survive into a fresh panel); the close edge
      // deliberately keeps everything, so the animation plays over the
      // exact face the user is leaving.
      setError(null);
      setSelectedName(null);
    }
  }
  const path = panel?.path ?? "";

  const listing = useQuery({
    queryKey: datasetKey(path),
    queryFn: () => listWorkspaceDatasets(path),
    enabled: open,
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: datasetKey(path) });
  }, [path, queryClient]);

  const add = useMutation({
    mutationFn: (file: string) => addWorkspaceDataset(path, file),
    onSuccess: (entry) => {
      // The freshly added dataset becomes the detail pick: the user's last
      // upload is what they want to look at (a multi-file pick lands on the
      // last one). The IPC returns the landed entry with its de-conflicted
      // reference name.
      setSelectedName(entry.reference_name);
      invalidate();
    },
    onError: (e: unknown) => setError(describeError(e, intl)),
  });
  const replace = useMutation({
    mutationFn: (v: { name: string; file: string }) =>
      replaceWorkspaceDataset(path, v.name, v.file),
    onSuccess: invalidate,
    onError: (e: unknown) => setError(describeError(e, intl)),
  });
  const remove = useMutation({
    mutationFn: (name: string) => removeWorkspaceDataset(path, name),
    onSuccess: invalidate,
    onError: (e: unknown) => setError(describeError(e, intl)),
  });
  const rename = useMutation({
    mutationFn: (v: { name: string; newDisplay: string }) =>
      renameWorkspaceDataset(path, v.name, v.newDisplay),
    onSuccess: invalidate,
    onError: (e: unknown) => setError(describeError(e, intl)),
  });
  const privacy = useMutation({
    mutationFn: (v: { name: string; next: DatasetPrivacy }) =>
      setWorkspaceDatasetPrivacy(path, v.name, v.next),
    onSuccess: invalidate,
    onError: (e: unknown) => setError(describeError(e, intl)),
  });

  // The picker: the panel's only add / replace channel (the same
  // plugin-dialog face the working set uses). xlsx never appears -- the
  // filter below is the first refusal edge (ADR-0141 D11).
  const pickerFilters = [
    {
      name: intl.formatMessage({
        id: "workspace.datasets.fileFilter",
        defaultMessage: "Data files",
      }),
      extensions: PICKER_EXTENSIONS,
    },
  ];

  const pickAndAdd = async () => {
    const selected = await openPicker({
      multiple: true,
      filters: pickerFilters,
    }).catch((e: unknown) => {
      setError(describeError(e, intl));
      return null;
    });
    const files = typeof selected === "string" ? [selected] : (selected ?? []);
    // Sequential awaits (issue #1485): the backend's manifest lock serializes
    // anyway, so the total time is unchanged -- but each file's onSuccess
    // (invalidate + the detail pick) lands per file, so rows appear one by
    // one instead of all at once at the end. A rejected mutate is already
    // surfaced via onError; swallow the throw so the batch continues.
    for (const [i, file] of files.entries()) {
      setUploadStatus({ mode: "add", name: fileBasename(file), index: i + 1, total: files.length });
      await add.mutateAsync(file).catch(() => {});
    }
    setUploadStatus(null);
  };

  const rows = listing.data ?? [];
  // The missing-store-file set flags rows in the list and arms the detail's
  // warning line (the honesty posture, ADR-0141 D8: flagged, not hidden).
  const missingNames = new Set(rows.filter((d) => d.file_missing).map((d) => d.reference_name));
  // The detail pick resolves with the sibling face's deleted-pick fallback
  // (pick ?? first): a pick naming a row that is no longer listed
  // re-resolves to the first entry, so band and pane never go blank.
  const resolvedName =
    selectedName !== null && rows.some((d) => d.reference_name === selectedName)
      ? selectedName
      : (rows[0]?.reference_name ?? null);
  const shown = rows.find((d) => d.reference_name === resolvedName) ?? null;
  // The list's action buttons lock while any row-level mutation round-trips.
  const busy =
    rename.isPending || replace.isPending || remove.isPending || privacy.isPending;

  // The list row's extra marker: a missing store file badges the row
  // (destructive -- the honest flag), the detail carries the long sentence.
  const badgeFor = (d: DatasetDescriptor): ReactNode =>
    missingNames.has(d.reference_name) ? (
      <Badge variant="destructive" className="ml-2">
        <FormattedMessage id="workspace.datasets.missingBadge" defaultMessage="Missing" />
      </Badge>
    ) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The header, the add row and the error banners stay fixed; only the
          dataset management area scrolls (the working-set tab's posture:
          chrome pinned, content scrolls). min-h-0 is what lets the flex-1
          scroll region actually shrink inside the max-h dialog. */}
      {/* No auto-focus on open: Radix would land it on the first focusable
          (the add button), lighting it up before any interaction. Focus
          stays with the opener; Tab still enters the dialog. Same posture
          as ComposerWorkspacePicker. */}
      <DialogContent
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="flex max-h-[80vh] flex-col overflow-hidden sm:max-w-4xl"
      >
        <DialogHeader>
          <DialogTitle>
            <FormattedMessage
              id="workspace.datasets.title"
              defaultMessage="Datasets — {workspace}"
              values={{ workspace: panel?.label ?? "" }}
            />
          </DialogTitle>
          <DialogDescription>
            <FormattedMessage
              id="workspace.datasets.description"
              defaultMessage="Datasets in this workspace are available to every session bound to it — a session picks them up automatically the first time a query mentions them."
            />
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3">
          {uploadStatus !== null && (
            // The status line (issue #1485): the picker's per-file progress,
            // the same content model the rail's ingest block carries.
            <p className="m-0 min-w-0 flex-1 truncate text-xs text-muted-foreground" role="status">
              {uploadStatus.mode === "add" ? (
                <FormattedMessage
                  id="workspace.datasets.adding"
                  defaultMessage="Adding {name} (file {index} of {total})…"
                  values={{ name: uploadStatus.name, index: uploadStatus.index, total: uploadStatus.total }}
                />
              ) : (
                <FormattedMessage
                  id="workspace.datasets.replacing"
                  defaultMessage="Replacing {name}…"
                  values={{ name: uploadStatus.name }}
                />
              )}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            disabled={add.isPending}
            onClick={() => void pickAndAdd()}
          >
            {add.isPending ? (
              // The in-flight spinner (the settings-panel posture, issue #1485).
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Upload className="h-4 w-4" aria-hidden />
            )}
            <FormattedMessage id="workspace.datasets.add" defaultMessage="Add dataset…" />
          </Button>
        </div>

        {error !== null && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
        {listing.isError && (
          <p className="text-destructive text-sm" role="alert">
            {describeError(listing.error, intl)}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* A failed listing renders neither face (the banner above is the
              face): the empty card would assert an empty workspace the
              listing never established, and invite an Add it would refuse. */}
          {listing.isError ? null : rows.length === 0 && !listing.isPending ? (
          // The empty set renders ONE card (the working-set tab's empty
          // form, issue #792): the two-column shell never mounts empty. The
          // header's add button is the only entry (a second button in the
          // card would duplicate it); the centered copy rides a floor
          // height so the card reads as an intentional resting face.
            <section className={`${PANEL_CARD_BASE} flex min-h-64 items-center justify-center`}>
              <p className="text-muted-foreground m-0 text-center">
                <FormattedMessage
                  id="workspace.datasets.empty"
                  defaultMessage="No datasets yet — click Add dataset to import a data file."
                />
              </p>
            </section>
          ) : !listing.isPending ? (
            <div className="layout working-set-layout">
              <section className={PANEL_CARD_BASE}>
                <h2 className="text-base font-semibold">
                  <FormattedMessage
                    id="workspace.datasets.listHeading"
                    defaultMessage="Datasets · {count}"
                    values={{ count: rows.length }}
                  />
                </h2>
                <WorkingSetList
                  datasets={rows.map(toDescriptor)}
                  activeName={null}
                  selectedName={resolvedName}
                  onSelect={setSelectedName}
                  onRename={(name, newDisplay) => {
                    // Clear-on-fire (the private face's runSimpleMutation
                    // posture): a stale banner must not contradict a retry's
                    // visible success.
                    setError(null);
                    rename.mutate({ name, newDisplay });
                  }}
                  onReplace={(name, file) => {
                    setError(null);
                    // The same status line as the add batch (issue #1485): a
                    // replace is one long IPC, the line names the row until
                    // it settles. A reject is already surfaced via onError.
                    setUploadStatus({ mode: "replace", name });
                    void replace
                      .mutateAsync({ name, file })
                      .catch(() => {})
                      .finally(() => setUploadStatus(null));
                  }}
                  onDelete={(name) => {
                    setError(null);
                    remove.mutate(name);
                  }}
                  onPickError={(e: unknown) => setError(describeError(e, intl))}
                  badgeFor={badgeFor}
                  deleteTitleFor={(name) => (
                    <FormattedMessage
                      id="workspace.datasets.delete.confirm"
                      defaultMessage="Remove {name} from this workspace?"
                      values={{ name }}
                    />
                  )}
                  loading={busy}
                />
              </section>
              <section className={PANEL_CARD_BASE}>
                {shown !== null && (
                  <>
                    {shown.file_missing && (
                    // The detail's honest warning (the list row carries the
                    // short badge): the entry renders in full -- meta, schema,
                    // frozen sample, privacy -- and the failure is named.
                      <p
                        className="text-destructive mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
                        role="alert"
                      >
                        <FormattedMessage
                          id="workspace.datasets.detailMissing"
                          defaultMessage="The dataset's underlying file is missing — SQL referencing it will fail until it is re-added or replaced."
                        />
                      </p>
                    )}
                    <DatasetDetail
                      dataset={toDescriptor(shown)}
                      sample={
                      {
                        columns: shown.columns,
                        rows: shown.sample,
                      } satisfies DatasetSamplePage
                      }
                      sampleLoading={false}
                      sampleError={null}
                      loading={privacy.isPending}
                      onPrivacyChange={(name, next) => {
                        setError(null);
                        privacy.mutate({ name, next });
                      }}
                    />
                  </>
                )}
              </section>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
