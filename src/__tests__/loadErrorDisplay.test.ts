import { createIntl } from "react-intl";
import { describe, expect, it } from "vitest";

import { loadErrorDisplay } from "../loadErrorDisplay";
import type { LoadError } from "../types";

// An IntlShape carrying the ingest LoadError message ids (mirroring the locale
// files) so loadErrorDisplay resolves kind -> catalog wording.
const intl = createIntl({
  locale: "en",
  messages: {
    "error.dataset.notFound": "No dataset found with reference name \"{name}\"",
    "error.load.legacyExcel":
      ".xls is not supported (only .xlsx); re-save as .xlsx in Excel and retry",
    "error.load.unsupportedFormat":
      "Unsupported format: {requested} (supported: .csv / .parquet / .json / .xlsx)",
    "error.load.unrecognizedFormat": "Unrecognized format",
    "error.load.parse": "Failed to parse the file",
    "error.load.io": "Failed to read the file",
    "error.load.other": "Failed to load",
  },
});

// Covers every LoadError kind the switch narrows. Issue #131 split the primary
// message from the backend detail: the message is a fixed catalog string (no
// {detail} interpolation), and Parse/Io/Other carry the backend technical
// detail in the fold. UnknownDataset reuses error.dataset.notFound (issue #131
// Task 1) so the replace unknown-reference refusal no longer crosses a backend
// free-text string. ADR-0029 holds: the detail fields never carry an API key.
describe("loadErrorDisplay", () => {
  it("returns the .xls rejection hint with no detail for LegacyExcel", () => {
    const err: LoadError = { kind: "LegacyExcel" };
    expect(loadErrorDisplay(err, intl)).toEqual({
      message: ".xls is not supported (only .xlsx); re-save as .xlsx in Excel and retry",
      detail: null,
    });
  });

  it("names the requested format with no detail when UnsupportedFormat carries one", () => {
    const err: LoadError = { kind: "UnsupportedFormat", data: { requested: "pdf" } };
    expect(loadErrorDisplay(err, intl)).toEqual({
      message: "Unsupported format: pdf (supported: .csv / .parquet / .json / .xlsx)",
      detail: null,
    });
  });

  it("falls back to the generic hint with no detail when the requested format is empty", () => {
    const err: LoadError = { kind: "UnsupportedFormat", data: { requested: "" } };
    expect(loadErrorDisplay(err, intl)).toEqual({
      message: "Unrecognized format",
      detail: null,
    });
  });

  it("renders the shared not-found catalog id for UnknownDataset (issue #131)", () => {
    const err: LoadError = { kind: "UnknownDataset", data: { reference_name: "people" } };
    expect(loadErrorDisplay(err, intl)).toEqual({
      message: "No dataset found with reference name \"people\"",
      detail: null,
    });
  });

  it("keeps the backend detail OUT of the Parse primary message, in the fold", () => {
    const err: LoadError = { kind: "Parse", data: { detail: "bad cell" } };
    expect(loadErrorDisplay(err, intl)).toEqual({
      message: "Failed to parse the file",
      detail: "bad cell",
    });
  });

  it("keeps the backend detail OUT of the Io primary message, in the fold", () => {
    const err: LoadError = { kind: "Io", data: { detail: "io-fail" } };
    expect(loadErrorDisplay(err, intl)).toEqual({
      message: "Failed to read the file",
      detail: "io-fail",
    });
  });

  it("keeps the backend detail OUT of the Other primary message, in the fold", () => {
    const err: LoadError = { kind: "Other", data: { detail: "boom" } };
    expect(loadErrorDisplay(err, intl)).toEqual({
      message: "Failed to load",
      detail: "boom",
    });
  });
});
