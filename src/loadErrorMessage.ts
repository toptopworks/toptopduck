import type { IntlShape } from "react-intl";
import type { LoadError } from "./types";

// Map an ingest LoadError to a user-facing message through the locale catalog
// (issue #121). The wording lives once in the locale files; the Rust `Display`
// is Rust-log-only and carries no user text. LegacyExcel / UnsupportedFormat
// carry fixed hints; Parse / Io / Other interpolate the backend detail (a file
// error, never an API key per ADR-0029). Pure module (no React) so it is
// trivially unit-testable without Tauri mocks.
export function loadErrorMessage(err: LoadError, intl: IntlShape): string {
  switch (err.kind) {
    case "LegacyExcel":
      return intl.formatMessage({
        id: "error.load.legacyExcel",
        defaultMessage: ".xls is not supported (only .xlsx); re-save as .xlsx in Excel and retry",
      });
    case "UnsupportedFormat":
      return err.data.requested
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
          });
    case "Parse":
      return intl.formatMessage(
        { id: "error.load.parse", defaultMessage: "Failed to parse the file: {detail}" },
        { detail: err.data.detail },
      );
    case "Io":
      return intl.formatMessage(
        { id: "error.load.io", defaultMessage: "Failed to read the file: {detail}" },
        { detail: err.data.detail },
      );
    case "Other":
      return intl.formatMessage(
        { id: "error.load.other", defaultMessage: "Failed to load: {detail}" },
        { detail: err.data.detail },
      );
  }
}
