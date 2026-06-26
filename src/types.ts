// Mirror of the Rust model types (serde externally-tagged enums cross IPC).

export interface ColumnSchema {
  name: string;
  canonical_type: string;
}

export interface DatasetDescriptor {
  reference_name: string;
  display_name: string;
  source_path: string;
  columns: ColumnSchema[];
  row_count: number;
  sample: string[][];
  fingerprint: string;
}

export type LoadError =
  | { UnsupportedFormat: { requested: string } }
  | { Parse: { detail: string } }
  | { Io: { detail: string } }
  | { Other: { detail: string } };

export type LoadOutcome =
  | { Loaded: DatasetDescriptor }
  | { Error: LoadError };
