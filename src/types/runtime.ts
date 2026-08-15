// Runtime selection wire types (issue #353, ADR-0076/0081/0083). Mirror the
// Rust `commands::{SessionRuntimeChoice, AdapterEntry}` serde shapes, pinned
// in `src-tauri/tests/ipc_contract.rs`. The composer runtime picker reads the
// adapter table + the per-session choice through these and feeds a switch back
// via `set_session_runtime`; the next turn dispatches on the selection
// (built-in BYOK loop vs external ACP engine) at the turn boundary.

// The session's runtime choice for the next turn. Adjacently-tagged
// (`tag="kind", content="data"`, `rename_all="snake_case"`): a unit
// `built_in` (no content key) or an `external` carrying the adapter id under
// `data` (the repo's generic content key). Mirrors
// `commands::SessionRuntimeChoice`.
export type SessionRuntimeChoice =
  | { kind: "built_in" }
  | { kind: "external"; data: string };

// One v1 adapter projected for the composer picker + the settings adapter
// panel (issue #489). The stable id is the `set_session_runtime` key; the
// display name is the row label; `detected` drives the selectable / disabled
// + "not installed" rendering; `binary_path` is the resolved binary location
// shown in the settings panel when detected. The picker renders this table
// verbatim -- adding a CLI upstream grows the list with zero frontend change.
// Mirrors `commands::AdapterEntry`.
export interface AdapterEntry {
  id: string;
  display_name: string;
  detected: boolean;
  /** Absolute path of the resolved binary (null when not detected). */
  binary_path: string | null;
  /** The adapter's stream format (ADR-0095). "acp" renders the model /
   * thought-level dropdowns fed by handshake discovery; "json_event_stream"
   * renders read-only CLI-default labels (no dynamic discovery). Mirrors the
   * Rust StreamFormat (snake_case serde). */
  stream_format: "acp" | "json_event_stream";
}

// The honest default while the read settles (and after a resume, before the
// fresh pane's read lands): the built-in BYOK loop (ADR-0081). A single TS
// expression of the backend's `None` / `BuiltIn` default, mirroring how the
// auth-mode chip renders `AUTH_MODE_DEFAULT` before its read resolves.
export const RUNTIME_CHOICE_DEFAULT = {
  kind: "built_in",
} as const satisfies SessionRuntimeChoice;

// The discovered model + thought-level catalog an ACP handshake reported
// (ADR-0095). Mirrors the Rust `DiscoveredRuntime` (snake_case serde), pinned
// in tests/ipc_contract.rs; also the persisted recipe-header shape, so the
// resume path returns the same object.
export interface DiscoveredRuntime {
  models: string[];
  current_model: string | null;
  thought_levels: string[];
  current_thought_level: string | null;
  // The catalog entry's agent-chosen config id (ADR-0095 D4), absent when the
  // entry carried no usable id (the engine then falls back to the standard
  // category id). Not user-facing; consumed by the injection path.
  model_config_id?: string;
  thought_level_config_id?: string;
  // The adapter that produced this catalog (issue #529): stamped by the
  // engine after the handshake extract. The picker compares it against the
  // active runtime to detect a catalog cached under a different adapter
  // (stale across a runtime switch). Absent on recipes persisted before the
  // field existed (old-recipe compatibility) -- treated as no provenance.
  adapter_id?: string;
}

// The session's external-runtime model config (ADR-0095, issue #527): the two
// selections plus the cached discovery catalog. `model` / `thought_level` are
// `null` until the user picks (the CLI defaults then rule); the cache is
// `null` until the first ACP turn (restored from the recipe on resume).
// Mirrors `commands::SessionModelConfig`, pinned in tests/ipc_contract.rs.
export interface SessionModelConfig {
  model: string | null;
  thought_level: string | null;
  cached_discovered: DiscoveredRuntime | null;
}

// The adapter diagnostic probe's success shape (ADR-0096, issues #534/#535).
// Per-format tagged (`kind`), mirroring the Rust `ProbeOk` adjacently-tagged
// enum: `acp` carries the flat handshake catalog, `codex` carries the
// app-server per-model catalog (or the degraded "unavailable" state). The
// codex catalog is NOT flattened into `DiscoveredRuntime` -- a union of
// per-model efforts would let the user select an effort the current model
// does not support (ADR-0096 D3).
export type ProbeOk =
  | { kind: "acp"; data: { discovered: DiscoveredRuntime } }
  | { kind: "codex"; data: { outcome: CodexCatalogOutcome } };

// The codex app-server `model/list` outcome (ADR-0096 D2/D3). `available`
// carries the ordered per-model catalog; `unavailable` is the degraded
// "started but catalog unavailable" state (the process is alive, so this is a
// success, not a ProbeError). Mirrors the Rust `CodexCatalogOutcome`
// (status-tagged, snake_case serde).
export type CodexCatalogOutcome =
  | { status: "available"; models: CodexModel[] }
  | { status: "unavailable"; detail: string };

// One codex model from the `model/list` catalog (ADR-0096 D3). The reasoning
// efforts are the per-model `supportedReasoningEfforts` in the CLI's declared
// order (never a union across models). Mirrors the Rust `CodexModel`
// (snake_case serde).
export interface CodexModel {
  id: string;
  display_name: string;
  is_default: boolean;
  default_reasoning_effort: string;
  supported_reasoning_efforts: string[];
}

// The probe's structured refusal/failure (ADR-0096, issue #534). Mirrors the
// Rust `ProbeError` (serde adjacently-tagged like SessionError), with a
// top-level `kind` set disjoint from every other typed IPC error. The three
// failure variants carry the English technical detail under `data` for the
// fold; user-facing wording lives in the locale catalog. `ProbeUnreachable`
// is frontend-only: the fallback kind for a non-shaped IPC reject (harness /
// transport fault) that never reached the CLI.
export type ProbeError =
  | { kind: "NotDetected"; data: string }
  | { kind: "SpawnFailure"; data: string }
  | { kind: "HandshakeFailure"; data: string }
  | { kind: "ProbeUnreachable"; data: string }
  | { kind: "Timeout" };
