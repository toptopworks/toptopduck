// Mirror of the Rust model types (serde externally-tagged enums cross IPC).

export interface ColumnSchema {
  name: string;
  canonical_type: string;
}

// Per-dataset privacy controls (ADR-0011, issue #9 slice 5): mirror of the Rust
// `DatasetPrivacy`. The config rides the descriptor (single source of truth),
// persists in the working set, and is readable by the (future, PRD #1) window
// assembler -- this slice only stores + reads the config; PRD #1 will apply the
// actual pruning based on these fields.
export interface DatasetPrivacy {
  // Whether any sample rows may be sent off-machine. Default true. When false,
  // PRD #1 will ensure no cell values enter the LLM payload.
  send_samples: boolean;
  // Column names marked "type only": stored by column name; treated as a set
  // at read time, so stale entries after a schema-changing replace are ignored.
  // PRD #1 will use this to send only the DuckDB type for these columns.
  type_only_columns: string[];
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
// (serde adjacently-tagged). The type makes "only user choices are recorded,
// never the auto algorithm" explicit.
// - "NotApplicable": CSV/Parquet/JSON (no rectify step).
// - "Auto": Excel auto-tidy chose confidently; no params ride the descriptor.
// - { User: SheetRectify }: the user supplied explicit header/skip choices.
export type RectifyProvenance =
  | { kind: "NotApplicable" }
  | { kind: "Auto" }
  | { kind: "User"; data: SheetRectify };

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
  // Privacy controls (ADR-0011, issue #9 slice 5): what of this dataset may
  // leave the local trust boundary. Defaults to samples on, no type-only cols.
  privacy: DatasetPrivacy;
}

// Discriminated union (serde adjacently-tagged: `#[serde(tag="kind", content="data")]`).
// Every variant carries `kind`; only the struct/newtype variants carry `data`.
export type LoadError =
  | { kind: "LegacyExcel" }
  | { kind: "UnsupportedFormat"; data: { requested: string } }
  | { kind: "Parse"; data: { detail: string } }
  | { kind: "Io"; data: { detail: string } }
  | { kind: "Other"; data: { detail: string } };

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
  | { kind: "Loaded"; data: DatasetDescriptor }
  | { kind: "NeedsGuidance"; data: GuidanceRequest }
  | { kind: "Error"; data: LoadError };
