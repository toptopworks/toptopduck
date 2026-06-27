import { invoke } from "@tauri-apps/api/core";
import type { DatasetDescriptor, LoadOutcome, SheetGuidance } from "./types";

export async function ingestFile(path: string): Promise<LoadOutcome> {
  return invoke<LoadOutcome>("ingest_file", { path });
}

// Re-ingest an Excel workbook with the user's guided rectify choices
// (ADR-0015/0042), after a `NeedsGuidance` outcome.
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
