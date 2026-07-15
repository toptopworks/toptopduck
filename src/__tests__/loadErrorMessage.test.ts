import { createIntl } from "react-intl";
import { describe, expect, it } from "vitest";

import { loadErrorMessage } from "../loadErrorMessage";
import type { LoadError } from "../types";

// An IntlShape carrying the ingest LoadError message ids (mirroring the locale
// files) so loadErrorMessage resolves kind -> catalog wording + interpolation.
const intl = createIntl({
  locale: "en",
  messages: {
    "error.load.legacyExcel":
      ".xls is not supported (only .xlsx); re-save as .xlsx in Excel and retry",
    "error.load.unsupportedFormat":
      "Unsupported format: {requested} (supported: .csv / .parquet / .json / .xlsx)",
    "error.load.unrecognizedFormat": "Unrecognized format",
    "error.load.parse": "Failed to parse the file: {detail}",
    "error.load.io": "Failed to read the file: {detail}",
    "error.load.other": "Failed to load: {detail}",
  },
});

// Covers every LoadError kind the switch narrows. Issue #121 moved the wording
// from hardcoded Chinese into the locale catalog; Parse/Io/Other now interpolate
// the backend detail (a file error, never an API key per ADR-0029).
describe("loadErrorMessage", () => {
  it("returns the .xls rejection hint for LegacyExcel", () => {
    const err: LoadError = { kind: "LegacyExcel" };
    expect(loadErrorMessage(err, intl)).toBe(
      ".xls is not supported (only .xlsx); re-save as .xlsx in Excel and retry",
    );
  });

  it("names the requested format when UnsupportedFormat carries one", () => {
    const err: LoadError = { kind: "UnsupportedFormat", data: { requested: "pdf" } };
    expect(loadErrorMessage(err, intl)).toBe(
      "Unsupported format: pdf (supported: .csv / .parquet / .json / .xlsx)",
    );
  });

  it("falls back to the generic hint when the requested format is empty", () => {
    const err: LoadError = { kind: "UnsupportedFormat", data: { requested: "" } };
    expect(loadErrorMessage(err, intl)).toBe("Unrecognized format");
  });

  it("interpolates the backend detail for Parse", () => {
    const err: LoadError = { kind: "Parse", data: { detail: "bad cell" } };
    expect(loadErrorMessage(err, intl)).toBe("Failed to parse the file: bad cell");
  });

  it("interpolates the backend detail for Io", () => {
    const err: LoadError = { kind: "Io", data: { detail: "io-fail" } };
    expect(loadErrorMessage(err, intl)).toBe("Failed to read the file: io-fail");
  });

  it("interpolates the backend detail for Other", () => {
    const err: LoadError = { kind: "Other", data: { detail: "boom" } };
    expect(loadErrorMessage(err, intl)).toBe("Failed to load: boom");
  });
});
