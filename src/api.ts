import { invoke } from "@tauri-apps/api/core";
import type {
  DatasetDescriptor,
  DatasetPrivacy,
  LoadOutcome,
  RowPage,
  SheetGuidance,
  TurnOutcome,
  TurnRecord,
} from "./types";

export async function ingestFile(path: string): Promise<LoadOutcome> {
  return invoke<LoadOutcome>("ingest_file", { path });
}

// Re-ingest an Excel workbook with the user's guided rectify choices
// (ADR-0015/0042), after a NeedsGuidance outcome.
export async function ingestFileGuided(
  path: string,
  guidance: SheetGuidance[],
): Promise<LoadOutcome> {
  return invoke<LoadOutcome>("ingest_file_guided", { path, guidance });
}

export async function listWorkingSet(): Promise<DatasetDescriptor[]> {
  return invoke<DatasetDescriptor[]>("list_working_set");
}

export async function activeDataset(): Promise<DatasetDescriptor | null> {
  return invoke<DatasetDescriptor | null>("active_dataset");
}

// Rename a dataset's display label (ADR-0037, issue #8): display-only -- the
// reference name is untouched, so SQL / recipe / active references stay valid.
// Rejects an unknown reference or a label already shown by another dataset; the
// backend surfaces that as an error string (no typed RenameError crosses IPC).
export async function renameDataset(
  referenceName: string,
  newDisplay: string,
): Promise<DatasetDescriptor> {
  return invoke<DatasetDescriptor>("rename_dataset", { referenceName, newDisplay });
}

// Re-upload onto an existing dataset's reference name (ADR-0042, issue #11): a
// fresh snapshot takes over the name; the old one is discarded. Distinct from
// ingestFile (add) -- the reference name to take over is explicit. Structured
// files only (the backend rejects xlsx in this slice).
export async function replaceSource(
  referenceName: string,
  path: string,
): Promise<LoadOutcome> {
  return invoke<LoadOutcome>("replace_source", { referenceName, path });
}

// Set a dataset's privacy controls (ADR-0011, issue #9 slice 5): per-dataset
// sample switch + per-column type-only marking. In-memory config swap on the
// descriptor (no copy-in). Rejects an unknown reference name with an error
// string (no typed error crosses IPC).
export async function setDatasetPrivacy(
  referenceName: string,
  privacy: DatasetPrivacy,
): Promise<DatasetDescriptor> {
  return invoke<DatasetDescriptor>("set_dataset_privacy", { referenceName, privacy });
}

// Ask one question (PRD #1): run one turn and return its ADR-0028 outcome
// (result / textual / failed / cancelled). The single retry budget is consumed
// invisibly inside the turn. Runs off the UI thread (AC8). A turn always
// produces an outcome; the only rejection here is a session-lock failure.
export async function askQuestion(question: string): Promise<TurnOutcome> {
  return invoke<TurnOutcome>("ask", { question });
}

// Cancel the in-flight turn (ADR-0021, issue #28). Fires the shared cancel
// token, which interrupts the running DuckDB query; the in-flight ask lands as
// a Cancelled outcome. Best-effort and always resolves: cancel is a signal, not
// a transaction -- a cancel when nothing is in flight is a harmless no-op (the
// next ask resets the flag before it starts).
export async function cancelQuery(): Promise<void> {
  await invoke<void>("cancel");
}

// Read the conversation thread (ADR-0028/0039): every turn in order, each
// labeled by its verbatim question and its outcome. The always-visible history
// the UI renders; a snapshot read with no copy-in.
export async function conversation(): Promise<TurnRecord[]> {
  return invoke<TurnRecord[]>("conversation");
}

// Read one page of a dataset's rows (ADR-0024 windowed display). Bounded
// LIMIT/OFFSET, run off the UI thread like ask (AC8). Works for sources and
// materialized results alike. Rejects an unknown reference with an error string.
export async function readRows(
  referenceName: string,
  offset: number,
  limit: number,
): Promise<RowPage> {
  return invoke<RowPage>("read_rows", { referenceName, offset, limit });
}

// Format an unknown error (a Tauri IPC reject, a JS Error, or a structured
// object) into a readable string. The Rust side rejects with a plain string
// today; this also narrows a future structured error or a JS Error instead of
// rendering "[object Object]".
export function fmtError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return JSON.stringify(e);
}
