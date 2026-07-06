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
  // Stale-state anchor (issue #40, ADR-0013): absent on an active dataset;
  // present when this result_N was invalidated by a source removal (stale-
  // cascade). A stale result stays visible (history / read_rows) but is excluded
  // from the LLM working set and refused as a new SQL reference. Mirrors the
  // Rust `Option<StaleAnchor>` -- `skip_serializing_if` omits it on the wire
  // when active, so it is optional and never `null`.
  stale?: StaleAnchor;
}

// Which kind of source event invalidated a result_N (issue #40/#41, mirrors the
// Rust StaleReason). The UI renders each variant distinctly in the stale badge
// (issue #41 AC4): "Deleted" -> "已删除"; "Replaced" -> "已更新". Bare variant
// string across IPC (like SourceLifecycleKind).
export type StaleReason = "Deleted" | "Replaced";

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

// Which kind of non-SQL textual response the provider returned (ADR-0009
// textual branch): a disambiguation question (ADR-0018) or an out-of-scope
// refusal (ADR-0017). Mirrors the Rust TextKind (a bare variant string).
export type TextKind = "Clarify" | "Refuse";

// v1 chart whitelist (ADR-0016). Mirrors the Rust ChartKind (serde
// rename_all="lowercase" -> a bare lowercase variant string). The closed set a
// provider viz may target; anything outside is not a ChartKind -- the Rust enum
// rejects it at the contract boundary, and a spec that draws a non-whitelisted
// chart degrades to a table in the frontend (ADR-0033).
export type ChartKind = "table" | "bar" | "line" | "scatter" | "area" | "pie";

// A provider-emitted viz spec (ADR-0016/0033, issue #26): chart kind from the
// v1 whitelist plus the Vega-Lite JSON that renders it. Mirrors the Rust
// VizSpec. The frontend renders `spec` via Vega-Embed, or degrades to the
// table with a disclosure when the spec is malformed or fails to render.
export interface VizSpec {
  kind: ChartKind;
  // Vega-Lite JSON spec string (carried verbatim across IPC; parsed + rendered
  // in the frontend).
  spec: string;
}

// One turn outcome (ADR-0028). Mirrors the Rust TurnOutcome (serde adjacently-
// tagged: kind + data). The four kinds are exhaustive: a turn always produces
// exactly one, regardless of whether it materialized a result. Only Materialized
// advances result_N; the others occupy a thread slot but consume no number.
export type TurnOutcome =
  | {
    kind: "Materialized";
    data: {
      dataset: DatasetDescriptor;
      // The verbatim SQL the provider returned (ADR-0009/0023): the recent-turn
      // window ships it so the provider sees its own prior SQL. Optional to
      // mirror the Rust serde default (absent on older data); a fresh result
      // turn always carries one. The frontend does not yet surface it.
      sql?: string | null;
      // The provider's optional viz spec (ADR-0016/0033, issue #26): null when
      // the provider offered no chart (the default table turn). The frontend
      // renders it via Vega-Embed or degrades to the table with a disclosure
      // when the spec is malformed or fails to render.
      viz: VizSpec | null;
      // The provider optional assumption note (ADR-0009), surfaced as a side
      // note the user can correct; null when the provider offered none.
      assumption: string | null;
    };
  }
  | {
    kind: "Textual";
    data: {
      text_kind: TextKind;
      body: string;
      assumption: string | null;
    };
  }
  | { kind: "Failed"; data: { reason: string } }
  | { kind: "Cancelled" };

// One conversation-thread entry (ADR-0028/0039): the verbatim user question
// paired with its outcome. Every turn appends exactly one -- always visible.
// Mirrors the Rust TurnRecord; nested under ThreadEntry.Turn.data (see below).
export interface TurnRecord {
  question: string;
  outcome: TurnOutcome;
}

// Which kind of source lifecycle mutation produced an event (ADR-0040/0025).
// Mirrors the Rust SourceLifecycleKind as a bare variant string (like TextKind).
// Added = every ingest; Deleted = remove (issue #38); Replaced = re-upload
// under an existing reference name (issue #41, ADR-0025).
export type SourceLifecycleKind = "Added" | "Deleted" | "Replaced";

// A source lifecycle event (ADR-0040): a user-driven mutation of the working
// set's source membership. First-class in the thread (always visible, occupies a
// timeline slot) but NOT a turn -- never enters the LLM window or advances
// result_N. Mirrors the Rust SourceLifecycleEvent.
export interface SourceLifecycleEvent {
  kind: SourceLifecycleKind;
  // Stable reference name (the identity SQL / recipe / active pointer use).
  reference_name: string;
  // Readable label captured at event time, so the thread still names a dataset
  // after it's removed (a Deleted event shows what was deleted).
  display_name: string;
}

// One entry of the unified conversation timeline (ADR-0040): a Turn (question +
// outcome) OR a source lifecycle event. Adjacently-tagged (`{entry, data}`) so
// the frontend narrows on `entry`. Mirrors the Rust ThreadEntry; the
// conversation() command returns ThreadEntry[]. Only the Turn variant enters the
// LLM window -- the backend filters source events out before assembly.
export type ThreadEntry =
  | { entry: "Turn"; data: TurnRecord }
  | { entry: "Source"; data: SourceLifecycleEvent };

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

// Non-secret LLM provider config (issue #29, ADR-0007/0019/0029): the
// Anthropic-protocol endpoint base URL + model id. Mirrors the Rust
// ProviderConfig. The API key is NOT here -- it lives in the OS keychain and
// never crosses to the frontend; this is the set_provider_config input shape.
export interface ProviderConfig {
  // Anthropic Messages API base URL (ADR-0019: configurable baseURL; default
  // Anthropic direct, overridable to a user's own Anthropic-compatible gateway).
  base_url: string;
  // Model id to request (ADR-0007: default Sonnet-class, pinned; the user may
  // switch to a stronger or cheaper model).
  model: string;
}

// The get_provider_config view (ADR-0029): effective base URL + model plus
// has_key -- a boolean, never the key itself. Mirrors the Rust
// ProviderConfigView. The frontend learns whether to prompt for a key without
// ever receiving it.
export interface ProviderConfigView {
  base_url: string;
  model: string;
  // Whether an API key is stored in the OS keychain. A boolean only (ADR-0029
  // invariant 3: the decrypted key lives only in the Rust core).
  has_key: boolean;
}

// One resume-progress event (issue #48, ADR-0034 visible progress). Mirrors
// the Rust `ResumeEvent` (serde externally-tagged: `"Source"` / `"Replay"` as
// the variant key). Emitted by the backend `open_duck` command via a Tauri
// event per source verification and per replayed productive turn.
export type ResumeEvent =
  | {
    Source: {
      index: number;
      total: number;
      reference_name: string;
    };
  }
  | {
    Replay: {
      index: number;
      total: number;
      reference_name: string;
    };
  };

// --- App-level config (issue #53, ADR-0038) --------------------------------
//
// The second at-rest artifact (alongside .duck): preferences, defaults, window
// geometry, recent files, and the no-key endpoint config. Mirrors the Rust
// `app_config::model` types verbatim. The API key NEVER appears here -- it
// lives in the OS keychain; app-config has no key field at all (enforced
// structurally + a read-time secret scan). Crosses IPC via get/set_app_config.

// UI theme preference (ADR-0050). Crosses IPC as the bare lowercase variant.
export type Theme = "system" | "light" | "dark";

// Persisted window geometry, restored on launch so the app reopens where the
// user left it. x/y are null until the first move is persisted.
export interface WindowGeometry {
  width: number;
  height: number;
  x: number | null;
  y: number | null;
  maximized: boolean;
}

// Engine default parameters (ADR-0005 L3). Stored + round-tripped here;
// applying them to the live DuckDB is a follow-up slice.
export interface EngineDefaults {
  // DuckDB memory limit string (e.g. "512MB").
  memory_limit: string;
  threads: number;
  // Ceiling on a materialized result's row count.
  row_cap: number;
  // Per-statement timeout in milliseconds.
  statement_timeout_ms: number;
}

// Default-for-new-datasets privacy knob (ADR-0011). Per-dataset overrides still
// ride each descriptor; this is only the starting switch.
export interface PrivacyDefaults {
  send_samples: boolean;
}

// Export starting directory + default format (ADR-0004/0015). last_dir is a path
// POINTER (not user-data content).
export interface ExportDefaults {
  last_dir: string | null;
  default_format: string;
}

// Tunable defaults (ADR-0013/0023/0028). Stored + round-tripped here; applying
// them to the live orchestrator is a follow-up slice.
export interface Tunables {
  retry_budget: number;
  window_turns: number;
  far_window: number;
}

// The full app-config document. Lives in the OS app-data directory; all
// non-secret, so it crosses IPC verbatim (no separate "view" type).
export interface AppConfig {
  format_version: number;
  theme: Theme;
  window: WindowGeometry;
  engine: EngineDefaults;
  privacy: PrivacyDefaults;
  provider: ProviderConfig;
  export: ExportDefaults;
  tunables: Tunables;
  // Recently-opened .duck paths, most-recent first. Capped server-side.
  recent_files: string[];
}
