import { describe, expect, it } from "vitest";

import { catalogFor } from "../../i18n";
import { catalogIntl } from "../../components/common/__tests__/helpers";
import { loadErrorDisplay } from "../loadErrorDisplay";
import type { LoadError } from "../../types/dataset";

// Real-catalog en-US intl from the shared i18n test seam (issue #1100):
// loadErrorDisplay resolves kind -> catalog wording through the actual
// catalog; assertions follow the catalog keys (compile-checked literals). The
// interpolated arms (UnsupportedFormat's {requested}, UnknownDataset's
// {name}) keep literal expected strings -- what they pin is the substitution.
const intl = catalogIntl("en-US");
const en = catalogFor("en-US");

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
      message: en["error.load.legacyExcel"],
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
      message: en["error.load.unrecognizedFormat"],
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
      message: en["error.load.parse"],
      detail: "bad cell",
    });
  });

  it("keeps the backend detail OUT of the Io primary message, in the fold", () => {
    const err: LoadError = { kind: "Io", data: { detail: "io-fail" } };
    expect(loadErrorDisplay(err, intl)).toEqual({
      message: en["error.load.io"],
      detail: "io-fail",
    });
  });

  it("keeps the backend detail OUT of the Other primary message, in the fold", () => {
    const err: LoadError = { kind: "Other", data: { detail: "boom" } };
    expect(loadErrorDisplay(err, intl)).toEqual({
      message: en["error.load.other"],
      detail: "boom",
    });
  });
});
