import type { IntlShape } from "react-intl";
import type { LoadError } from "../types/dataset";

// Map an ingest LoadError to a user-facing display. The primary `message` is
// always a fixed catalog string -- the backend `detail` never interpolates into
// it (issue #131). The wording lives once in the locale files; the Rust
// `Display` is Rust-log-only and carries no user text. Parse / Io / Other carry
// an English technical detail (a file error, never an API key per ADR-0029)
// the caller surfaces in the collapsed technical-details fold; the self-
// contained kinds carry null so the fold is omitted. UnknownDataset reuses the
// shared `error.dataset.notFound` id (issue #131 Task 1) so a replace unknown-
// reference refusal no longer crosses a backend free-text string. Pure module
// (no React) so it is trivially unit-testable without Tauri mocks.
export function loadErrorDisplay(
  err: LoadError,
  intl: IntlShape,
): { message: string; detail: string | null } {
  switch (err.kind) {
    case "LegacyExcel":
      return {
        message: intl.formatMessage({
          id: "error.load.legacyExcel",
          defaultMessage: ".xls is not supported (only .xlsx); re-save as .xlsx in Excel and retry",
        }),
        detail: null,
      };
    case "UnsupportedFormat":
      return {
        message: err.data.requested
          ? intl.formatMessage(
              {
                id: "error.load.unsupportedFormat",
                defaultMessage:
                  "Unsupported format: {requested} (supported: .csv / .parquet / .json / .xlsx)",
              },
              { requested: err.data.requested },
            )
          : intl.formatMessage({
              id: "error.load.unrecognizedFormat",
              defaultMessage: "Unrecognized format",
            }),
        detail: null,
      };
    case "UnknownDataset":
      return {
        message: intl.formatMessage(
          {
            id: "error.dataset.notFound",
            defaultMessage: "No dataset found with reference name \"{name}\"",
          },
          { name: err.data.reference_name },
        ),
        detail: null,
      };
    case "Parse":
      return {
        message: intl.formatMessage({
          id: "error.load.parse",
          defaultMessage: "Failed to parse the file",
        }),
        detail: err.data.detail,
      };
    case "Io":
      return {
        message: intl.formatMessage({
          id: "error.load.io",
          defaultMessage: "Failed to read the file",
        }),
        detail: err.data.detail,
      };
    case "Other":
      return {
        message: intl.formatMessage({
          id: "error.load.other",
          defaultMessage: "Failed to load",
        }),
        detail: err.data.detail,
      };
    // Exhaustiveness guard (issue #131): LoadError crosses IPC with no runtime
    // validator (api.ts invoke<LoadOutcome> is unchecked), so a future backend
    // variant would silently fall through to `undefined` and render a blank
    // banner. Throw at the boundary instead -- mirrors every kind-dispatch
    // formatter in api.ts (formatDuckLoadError, formatSaveError, ...).
    default: {
      const unhandled: never = err;
      throw new Error(`unhandled LoadError kind: ${JSON.stringify(unhandled)}`);
    }
  }
}
