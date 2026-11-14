// One workspace-dataset refusal's agent-free rendering (ADR-0141): the
// catalog owns the wording, the technical detail rides the same string.
// Moved verbatim from WorkspaceDatasetsDialog (#1519) -- the dialog and its
// seam are its only consumers today, but the catalog is presentation
// knowledge, not component state, so it lives with the other error
// presenters.

import type { IntlShape } from "react-intl";

import { isWorkspaceDatasetError } from "../../types/workspace-datasets";

export function describeError(e: unknown, intl: IntlShape): string {
  if (isWorkspaceDatasetError(e)) {
    switch (e.kind) {
      case "XlsxRejected":
        return intl.formatMessage({
          id: "workspace.datasets.error.xlsx",
          defaultMessage:
            "xlsx workbooks import through the guided confirm dialog; replacing a dataset with a workbook is not supported — remove the dataset and import the workbook again",
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
