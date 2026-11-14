// Memory contracts (issue #1529; user layer since #1531), mirroring the
// Rust `persistence::memory` shapes: one row per memory file (the files
// are the source of truth; MEMORY.md is a derived projection). Both layers
// share these shapes -- only the directory differs (the workspace's
// `.toptopduck/memory/` vs the app-domain user `memory/`).

// The four memory categories (the storage protocol's classification).
export type MemoryType = "user" | "feedback" | "project" | "reference";

// The panel's list face: the index row (flattened on the wire), the typed
// category, and the memory file's absolute path (the reveal target).
export interface ListedMemory {
  title: string;
  // The memory file's name inside its layer's directory.
  file: string;
  // The one-line hook (what the injection block carries per row).
  hook: string;
  type: MemoryType;
  file_path: string;
}

// The panel's one-shot read (issue #1530): the rows plus the index usage
// percentage the color scale renders (the same ratio the write caps
// enforce). `unreadable` (issue #1538) names the .md files that carry no
// frontmatter fence or fail to read -- a hand-written file must never
// vanish silently.
export interface ListedMemorySection {
  rows: ListedMemory[];
  usage_percent: number;
  unreadable: string[];
}

// Why an extraction was skipped (the panel's "skipped" faces).
export type ExtractionSkipReason = "no_provider" | "toggle_off" | "index_cap";

// The extraction status the panel renders (issue #1530's three states:
// running / skipped / no-new-facts, with failure spelled out). Mirrors the
// Rust `ExtractionStatus` (serde snake_case tag).
export type ExtractionStatus =
  | { state: "running" }
  | { state: "skipped"; reason: ExtractionSkipReason }
  | { state: "no_new_facts" }
  | { state: "extracted"; titles: string[] }
  | { state: "failed"; detail: string };
