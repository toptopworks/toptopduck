import type {
  DatasetDescriptor,
  DatasetPrivacy,
  GuidanceReason,
  GuidanceSheet,
} from "../../../types/dataset";

// Shared dataset-domain test fixtures (ADR-0011 defaults). The zh-CN
// IntlProvider wrapper used by the dataset component tests lives in the common
// test helpers (../../common/__tests__/helpers) and is imported per test file.

// Compact two-state constructors for readable guidance fixtures (#751): the
// NeedsGuidance / AutoTidied union literals inline verbosely, and a
// hand-written literal that drifts from the wire shape is exactly the
// mismatch the constructors rule out at compile time.
export function needsGuidance(reason: GuidanceReason): GuidanceSheet["state"] {
  return { kind: "NeedsGuidance", data: { reason } };
}

export function autoTidied(headerRow: number): GuidanceSheet["state"] {
  return { kind: "AutoTidied", data: { header_row: headerRow } };
}

export const mockDataset: DatasetDescriptor = {
  reference_name: "people",
  display_name: "people",
  source_path: "/x/people.csv",
  row_count: 5,
  fingerprint: "abc123def4560000000000000000000000000000000000000000000000000999",
  columns: [
    { name: "id", canonical_type: "BIGINT" },
    { name: "name", canonical_type: "VARCHAR" },
  ],
  sample: [
    ["1", "Alice"],
    ["2", "Bob"],
  ],
  rectify: { kind: "NotApplicable" },
  privacy: { send_samples: true, type_only_columns: [] },
};

// The ADR-0011 default: samples on, no type-only columns.
export const defaultPrivacy: DatasetPrivacy = { send_samples: true, type_only_columns: [] };
