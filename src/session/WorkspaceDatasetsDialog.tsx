// The workspace shared-dataset management panel (ADR-0141 D4): a modal off
// the sidebar's workspace-section menu -- list, browse-to-add, replace,
// delete, privacy. Visibility follows the workspace, not any session: the
// panel owns the manifest; bound sessions read it live on their next turn.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open as openPicker } from "@tauri-apps/plugin-dialog";
import { FolderOpen, RefreshCw, Trash2, Upload } from "lucide-react";
import { useCallback, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import {
  addWorkspaceDataset,
  listWorkspaceDatasets,
  removeWorkspaceDataset,
  replaceWorkspaceDataset,
  setWorkspaceDatasetPrivacy,
} from "../api";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Switch } from "../components/ui/switch";
import type { DatasetPrivacy } from "../types/dataset";
import { isWorkspaceDatasetError } from "../types/workspace-datasets";

// The panel's target workspace: the listing projection's canonical path +
// label (the dialog is mounted per open, never re-targeted while open).
interface WorkspaceDatasetsDialogProps {
  workspace: { path: string; label: string } | null;
  onOpenChange: (open: boolean) => void;
}

// The extensions the shared face accepts (ADR-0141 D11: xlsx is refused --
// the picker never offers it; the store-side refusal stays as the honest
// boundary for any channel that slips one through).
const SHARED_EXTENSIONS = ["csv", "parquet", "json", "jsonl", "ndjson"];

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
            "xlsx is not supported on the shared face; convert to CSV/Parquet or use a session-private source",
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
          defaultMessage: "No shared dataset with that name",
        });
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

export function WorkspaceDatasetsDialog({ workspace, onOpenChange }: WorkspaceDatasetsDialogProps) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const open = workspace !== null;
  const path = workspace?.path ?? "";
  const [error, setError] = useState<string | null>(null);
  // The delete confirm staging (the strong-confirm posture: the row's button
  // arms, a second click fires; arming another row, a successful remove, or
  // closing the dialog disarms).
  const [armedDelete, setArmedDelete] = useState<string | null>(null);

  // Closing resets the panel's transient state: the error banner and the
  // delete staging must not survive into the next open (possibly another
  // workspace's panel -- the component stays mounted in the sidebar).
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setError(null);
        setArmedDelete(null);
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

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
    onSuccess: invalidate,
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
    onSuccess: () => {
      setArmedDelete(null);
      invalidate();
    },
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
        defaultMessage: "Shared data files",
      }),
      extensions: SHARED_EXTENSIONS,
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
    for (const file of files) add.mutate(file);
  };

  // Replace swaps one freshly picked file under the row's name.
  const pickAndReplace = async (name: string) => {
    const selected = await openPicker({
      multiple: false,
      filters: pickerFilters,
    }).catch((e: unknown) => {
      setError(describeError(e, intl));
      return null;
    });
    if (typeof selected === "string") replace.mutate({ name, file: selected });
  };

  const rows = listing.data ?? [];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            <FormattedMessage
              id="workspace.datasets.title"
              defaultMessage="Shared datasets — {workspace}"
              values={{ workspace: workspace?.label ?? "" }}
            />
          </DialogTitle>
          <DialogDescription>
            <FormattedMessage
              id="workspace.datasets.description"
              defaultMessage="Datasets shared by every session bound to this workspace; the first SQL mention attaches them automatically."
            />
          </DialogDescription>
        </DialogHeader>

        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => void pickAndAdd()}>
            <Upload className="h-4 w-4" aria-hidden />
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

        <ul className="flex flex-col gap-2">
          {rows.map((d) => (
            <li
              key={d.reference_name}
              className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {d.reference_name}
                  {d.file_missing && (
                    <span className="text-destructive ml-2 text-xs">
                      <FormattedMessage
                        id="workspace.datasets.missingFile"
                        defaultMessage="(store file missing — re-add or replace)"
                      />
                    </span>
                  )}
                </p>
                <p className="text-muted-foreground truncate text-xs">
                  <FormattedMessage
                    id="workspace.datasets.rowMeta"
                    defaultMessage="{rows} rows · {cols} columns · {source}"
                    values={{
                      rows: d.row_count,
                      cols: d.columns.length,
                      source: d.source_path,
                    }}
                  />
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <label className="text-muted-foreground flex cursor-pointer items-center gap-1.5 text-xs">
                  <Switch
                    checked={d.privacy.send_samples}
                    onCheckedChange={(checked) =>
                      privacy.mutate({
                        name: d.reference_name,
                        next: { ...d.privacy, send_samples: checked },
                      })}
                  />
                  <FormattedMessage
                    id="workspace.datasets.sendSamples"
                    defaultMessage="send samples"
                  />
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setError(null);
                    void pickAndReplace(d.reference_name);
                  }}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  <FormattedMessage id="workspace.datasets.replace" defaultMessage="Replace" />
                </Button>
                {armedDelete === d.reference_name ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => remove.mutate(d.reference_name)}
                  >
                    <FormattedMessage
                      id="workspace.datasets.confirmDelete"
                      defaultMessage="Confirm delete"
                    />
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setArmedDelete(d.reference_name);
                      setError(null);
                    }}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                    <FormattedMessage id="workspace.datasets.delete" defaultMessage="Delete" />
                  </Button>
                )}
              </div>
            </li>
          ))}
          {rows.length === 0 && !listing.isPending && (
            <li className="text-muted-foreground flex items-center gap-2 p-3 text-sm">
              <FolderOpen className="h-4 w-4" aria-hidden />
              <FormattedMessage
                id="workspace.datasets.empty"
                defaultMessage="No shared datasets yet."
              />
            </li>
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
