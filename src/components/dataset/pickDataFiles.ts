import { open } from "@tauri-apps/plugin-dialog";
import type { IntlShape } from "react-intl";

// Every extension the ingest pipeline accepts: xlsx rides along because
// multi-sheet workbooks park on the guided-load dock inside handleIngestMany.
// (The per-row REPLACE picker in WorkingSetList keeps its own shorter list --
// that backend path is structured-only and deliberately excludes xlsx.)
export const DATA_FILE_EXTENSIONS = ["csv", "parquet", "json", "jsonl", "ndjson", "xlsx"];

// The add-data-file picker shared by the composer's + entry and the working
// set's empty-state card (issue #792): multiple selection over the one
// "Data files" filter, a cancelled picker resolves to an empty array so the
// caller no-ops.
export async function pickDataFiles(intl: IntlShape): Promise<string[]> {
  const selected = await open({
    multiple: true,
    filters: [
      {
        name: intl.formatMessage({ id: "workingSet.fileFilter", defaultMessage: "Data files" }),
        extensions: DATA_FILE_EXTENSIONS,
      },
    ],
  });
  return typeof selected === "string" ? [selected] : selected ?? [];
}
