// Mirror of the Rust model types (serde externally-tagged enums cross IPC).

export interface ColumnSchema {
  name: string;
  canonical_type: string;
}

// One Excel sheet's user-chosen rectify decisions (ADR-0042): only the user's
// explicit choices enter the recipe; the auto-tidy algorithm never does.
export interface SheetRectify {
  // 1-based row whose cells become the column header; rows above are skipped.
  header_row: number;
  // 1-based absolute rows below the header to drop (separators/sub-headers).
  skip_rows: number[];
}

// Provenance of a dataset's rectify state (ADR-0042): mirrors the Rust enum
// (serde externally-tagged). The type makes "only user choices are recorded,
// never the auto algorithm" explicit.
// - "NotApplicable": CSV/Parquet/JSON (no rectify step).
// - "Auto": Excel auto-tidy chose confidently; no params ride the descriptor.
// - { User: SheetRectify }: the user supplied explicit header/skip choices.
export type RectifyProvenance =
  | "NotApplicable"
  | "Auto"
  | { User: SheetRectify };

export interface DatasetDescriptor {
  reference_name: string;
  display_name: string;
  source_path: string;
  columns: ColumnSchema[];
  row_count: number;
  sample: string[][];
  fingerprint: string;
  // Rectify provenance (ADR-0042): how the header/skip state was determined --
  // format N/A, Excel auto-tidy (not recorded), or the user's explicit choices.
  rectify: RectifyProvenance;
}

// Legacy `.xls` is rejected in v1 (ADR-0015); serde serializes the unit variant
// as the JSON string `"LegacyExcel"`, so it is a bare string in this union.
export type LoadError =
  | "LegacyExcel"
  | { UnsupportedFormat: { requested: string } }
  | { Parse: { detail: string } }
  | { Io: { detail: string } }
  | { Other: { detail: string } };

export interface GuidanceSheet {
  name: string;
  // Raw top-of-sheet rows (rendered strings) for the user to locate the header.
  preview: string[][];
}

export interface GuidanceRequest {
  source_path: string;
  workbook_name: string;
  sheets: GuidanceSheet[];
}

export interface SheetGuidance {
  name: string;
  rectify: SheetRectify;
}

export type LoadOutcome =
  | { Loaded: DatasetDescriptor }
  | { NeedsGuidance: GuidanceRequest }
  | { Error: LoadError };
