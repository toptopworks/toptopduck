// Dataset / source / row types split from the single-file src/types.ts (issue
// #197). Mirrors the Rust model types (serde adjacently-tagged enums that cross
// IPC). Covers column schemas, ingest guidance + outcomes, dataset descriptors
// with privacy controls and stale anchors, and windowed row pages.

import type { SourceLifecycleKind } from "./lifecycle";

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
  // Stale-state anchor (issue #40, ADR-0013): absent on an active dataset;
  // present when this result_N was invalidated by a source removal (stale-
  // cascade). A stale result stays visible (history / read_rows) but is excluded
  // from the LLM working set and refused as a new SQL reference. Mirrors the
  // Rust `Option<StaleAnchor>` -- `skip_serializing_if` omits it on the wire
  // when active, so it is optional and never `null`.
  stale?: StaleAnchor;
}

// Which kind of source event invalidated a result_N (issue #40/#41, mirrors the
// Rust StaleReason). This is the invalidating subset of SourceLifecycleKind --
// every lifecycle kind except Added (adding a source never invalidates a result,
// ADR-0040) -- so the type is derived rather than re-listed: a future lifecycle
// kind that can invalidate joins automatically, and only one that never
// invalidates needs a fresh Exclude term. The UI renders each variant distinctly
// in the stale badge (issue #41 AC4): "Deleted" -> "已删除"; "Replaced" -> "已更新".
export type StaleReason = Exclude<SourceLifecycleKind, "Added">;

// Why a result_N is stale and which source lifecycle event invalidated it
// (issue #40/#41): a snapshot of the invalidating source event's identity -- the
// ADR-0040 traceability anchor (the soft-invalidate mechanism itself is
// ADR-0013), captured when the cascade marked this result stale. Mirrors the
// Rust StaleAnchor. `reason` says which kind of event (Deleted vs Replaced); the
// display label lets the UI render "因「Orders」已删除/已更新而失效" after the
// source itself is gone or swapped.
export interface StaleAnchor {
  // Reference name of the source whose removal/replacement invalidated this
  // result.
  reference_name: string;
  // Display label of that source at event time (rendered in the stale badge).
  display_name: string;
  // Which kind of source event invalidated this result (issue #41). Mirrors the
  // Rust #[serde(default)] -> Deleted, but the field is required on the wire:
  // the backend always serializes it, and older payloads predate #40 entirely
  // (stale was absent), so there is no "missing reason" shape to deserialize.
  reason: StaleReason;
}

// Discriminated union (serde adjacently-tagged: `#[serde(tag="kind", content="data")]`).
// Every variant carries `kind`; only the struct/newtype variants carry `data`.
export type LoadError =
  | { kind: "LegacyExcel" }
  | { kind: "UnsupportedFormat"; data: { requested: string } }
  | { kind: "Parse"; data: { detail: string } }
  | { kind: "Io"; data: { detail: string } }
  | { kind: "UnknownDataset"; data: { reference_name: string } }
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

// One page of a dataset rows (ADR-0024 windowed display). Cells are CAST to
// VARCHAR (NULL renders as "") server-side. `total` is the full row count so a
// truncated page never masquerades as complete (ADR-0030).
export interface RowPage {
  columns: ColumnSchema[];
  rows: string[][];
  total: number;
  offset: number;
  limit: number;
}
