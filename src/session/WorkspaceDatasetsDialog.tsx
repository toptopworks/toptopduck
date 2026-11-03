// The workspace shared-dataset management panel (ADR-0141 D4): a modal off
// the sidebar's workspace-section menu -- list, drop-to-add, replace, delete,
// privacy. Visibility follows the workspace, not any session: the panel owns
// the manifest; bound sessions read it live on their next turn.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, RefreshCw, Trash2, Upload } from "lucide-react";
import { useCallback, useRef, useState } from "react";
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
// the picker never offers it, so the refusal path stays a drop-zone-only
// honest error).
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
          id: "workspaceDatasets.error.xlsx",
          defaultMessage:
            "xlsx is not supported on the shared face; convert to CSV/Parquet or use a session-private source",
        });
      case "LegacyExcel":
        return intl.formatMessage({
          id: "workspaceDatasets.error.legacyExcel",
          defaultMessage: "Legacy .xls is not supported; save as .xlsx or CSV",
        });
      case "UnsupportedFormat":
        return intl.formatMessage(
          {
            id: "workspaceDatasets.error.unsupported",
            defaultMessage: "Unsupported format: {format}",
          },
          { format: e.data },
        );
      case "ManifestCorrupt":
        return intl.formatMessage(
          {
            id: "workspaceDatasets.error.corrupt",
            defaultMessage:
              "The workspace dataset manifest is corrupt (a copy was preserved); fix or remove datasets.json before editing",
          },
        );
      case "NotFound":
        return intl.formatMessage({
          id: "workspaceDatasets.error.notFound",
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
  const [dropping, setDropping] = useState(false);
  // The delete confirm staging (the strong-confirm posture: the row's button
  // arms, a second click fires; any other action disarms).
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const replaceInput = useRef<HTMLInputElement | null>(null);
  const [replacing, setReplacing] = useState<string | null>(null);

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
    onSuccess: () => {
      setReplacing(null);
      invalidate();
    },
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

  // The picker: the canonical multi-select entry (the same plugin-dialog face
  // the working set uses), restricted to the shared face's formats.
  const pickAndAdd = useCallback(async () => {
    const { open: openPicker } = await import("@tauri-apps/plugin-dialog");
    const selected = await openPicker({
      multiple: true,
      filters: [
        {
          name: intl.formatMessage({
            id: "workspaceDatasets.fileFilter",
            defaultMessage: "Shared data files",
          }),
          extensions: SHARED_EXTENSIONS,
        },
      ],
    });
    const files = typeof selected === "string" ? [selected] : (selected ?? []);
    for (const file of files) add.mutate(file);
  }, [intl, add]);

  // The drop zone: the webview hands OS drops as File objects; Tauri exposes
  // the absolute path as the non-standard `path` property. A drop without it
  // (a browser-grade file) falls through to the hint -- the picker remains
  // the always-works channel.
  const droppedFile = useCallback(
    (file: File) => {
      const dropped = (file as File & { path?: string }).path;
      if (dropped) add.mutate(dropped);
    },
    [add],
  );

  const rows = listing.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            <FormattedMessage
              id="workspaceDatasets.title"
              defaultMessage="Shared datasets — {workspace}"
              values={{ workspace: workspace?.label ?? "" }}
            />
          </DialogTitle>
          <DialogDescription>
            <FormattedMessage
              id="workspaceDatasets.description"
              defaultMessage="Datasets shared by every session bound to this workspace; the first SQL mention attaches them automatically."
            />
          </DialogDescription>
        </DialogHeader>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDropping(true);
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDropping(false);
            const file = e.dataTransfer.files[0];
            if (file) droppedFile(file);
          }}
          className={
            dropping
              ? "flex flex-col items-center gap-1 rounded-lg border border-dashed border-primary bg-primary/5 p-4 text-sm"
              : "flex flex-col items-center gap-1 rounded-lg border border-dashed p-4 text-sm text-muted-foreground"
          }
        >
          <Upload className="h-4 w-4" aria-hidden />
          <span>
            <FormattedMessage
              id="workspaceDatasets.dropHint"
              defaultMessage="Drop a CSV / Parquet / JSON file here, or"
            />{" "}
            <Button variant="link" className="h-auto p-0" onClick={() => void pickAndAdd()}>
              <FormattedMessage id="workspaceDatasets.pick" defaultMessage="browse files" />
            </Button>
          </span>
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
                        id="workspaceDatasets.missingFile"
                        defaultMessage="(store file missing — re-add or replace)"
                      />
                    </span>
                  )}
                </p>
                <p className="text-muted-foreground truncate text-xs">
                  <FormattedMessage
                    id="workspaceDatasets.rowMeta"
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
                <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <Switch
                    checked={d.privacy.send_samples}
                    onCheckedChange={(checked) =>
                      privacy.mutate({
                        name: d.reference_name,
                        next: { ...d.privacy, send_samples: checked },
                      })}
                  />
                  <FormattedMessage
                    id="workspaceDatasets.sendSamples"
                    defaultMessage="send samples"
                  />
                </label>
                <input
                  ref={replacing === d.reference_name ? replaceInput : undefined}
                  type="file"
                  accept={SHARED_EXTENSIONS.map((e) => `.${e}`).join(",")}
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file && replacing === d.reference_name) {
                      const dropped = (file as File & { path?: string }).path;
                      if (dropped) replace.mutate({ name: d.reference_name, file: dropped });
                    }
                  }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setReplacing(d.reference_name);
                    setError(null);
                    requestAnimationFrame(() => replaceInput.current?.click());
                  }}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  <FormattedMessage id="workspaceDatasets.replace" defaultMessage="Replace" />
                </Button>
                {armedDelete === d.reference_name ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => remove.mutate(d.reference_name)}
                  >
                    <FormattedMessage
                      id="workspaceDatasets.confirmDelete"
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
                    <FormattedMessage id="workspaceDatasets.delete" defaultMessage="Delete" />
                  </Button>
                )}
              </div>
            </li>
          ))}
          {rows.length === 0 && !listing.isPending && (
            <li className="text-muted-foreground flex items-center gap-2 p-3 text-sm">
              <FolderOpen className="h-4 w-4" aria-hidden />
              <FormattedMessage
                id="workspaceDatasets.empty"
                defaultMessage="No shared datasets yet."
              />
            </li>
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
