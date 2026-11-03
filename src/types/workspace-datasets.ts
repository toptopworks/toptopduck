// Workspace shared dataset contracts (ADR-0141), mirroring the Rust
// `workspace::datasets` shapes.

import type { ColumnSchema, DatasetPrivacy } from "./dataset";

// One manifest entry: the workspace-level identity + shape facts the panel
// and the session faces read.
export interface WorkspaceDatasetEntry {
  reference_name: string;
  // The user-renamable display label (ADR-0037's dual-name scheme on the
  // shared face): defaults to the reference name; rename touches only this.
  display_name: string;
  // The SHA256 of the original source bytes -- the store key (NOT the
  // derived table fingerprint a working-set descriptor carries).
  fingerprint: string;
  columns: ColumnSchema[];
  row_count: number;
  sample: string[][];
  privacy: DatasetPrivacy;
  source_path: string;
}

// The list face: an entry plus its store-file presence (ADR-0141 D8 -- a
// missing store file keeps the entry visible, flagged).
export interface ListedWorkspaceDataset extends WorkspaceDatasetEntry {
  file_missing: boolean;
}

// Why a workspace-dataset command rejected. Mirrors the Rust
// WorkspaceDatasetError's adjacently-tagged `{kind, data}` shape.
export type WorkspaceDatasetError =
  | { kind: "XlsxRejected" }
  | { kind: "LegacyExcel" }
  | { kind: "UnsupportedFormat"; data: string }
  | { kind: "ManifestCorrupt"; data: string }
  | { kind: "NotFound" }
  | { kind: "InvalidLabel" }
  | { kind: "DisplayTaken"; data: string }
  | { kind: "Io"; data: string };

// L1 narrowing of an unknown IPC reject to a WorkspaceDatasetError (the
// error-presentation guards' defensive shape: a variant's data is verified
// before the guard promises it).
export function isWorkspaceDatasetError(e: unknown): e is WorkspaceDatasetError {
  if (typeof e !== "object" || e === null) return false;
  const kind = (e as { kind?: unknown }).kind;
  switch (kind) {
    case "XlsxRejected":
    case "LegacyExcel":
    case "NotFound":
    case "InvalidLabel":
      return true;
    case "UnsupportedFormat":
    case "ManifestCorrupt":
    case "DisplayTaken":
    case "Io":
      return typeof (e as { data?: unknown }).data === "string";
    default:
      return false;
  }
}
