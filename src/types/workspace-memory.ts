// Workspace memory contracts (issue #1529), mirroring the Rust
// `workspace::memory` shapes: one row per memory file (the files are the
// source of truth; MEMORY.md is a derived projection).

// The four memory categories (the storage protocol's classification).
export type MemoryType = "user" | "feedback" | "project" | "reference";

// The panel's list face: the index row (flattened on the wire), the typed
// category, and the memory file's absolute path (the reveal target).
export interface ListedMemory {
  title: string;
  // The memory file's name inside `.toptopduck/memory/`.
  file: string;
  // The one-line hook (what the injection block carries per row).
  hook: string;
  type: MemoryType;
  file_path: string;
}
