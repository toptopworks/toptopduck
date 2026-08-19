// Runtime selection wire types (issue #353, ADR-0076/0081/0083). Mirror the
// Rust `commands::{SessionRuntimeChoice, AdapterEntry}` serde shapes, pinned
// in `src-tauri/tests/ipc_contract.rs`. The composer runtime picker reads the
// adapter table + the per-session choice through these and feeds a switch back
// via `set_session_runtime`; the next turn dispatches on the selection
// (built-in BYOK loop vs external ACP engine) at the turn boundary.

import type { DefaultRuntime } from "./app-config";

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
  /** The adapter's stream format (ADR-0095, ADR-0097). "acp" renders the
   * model / thought-level dropdowns fed by handshake discovery; the two
   * per-model catalog formats ("codex_event_stream", "claude_stream_json")
   * render probe-cache-fed per-model dropdowns once tested, read-only
   * CLI-default labels before. Mirrors the Rust StreamFormat (snake_case
   * serde); the "json_event_stream" tag was retired by the ADR-0097 rename. */
  stream_format: "acp" | "codex_event_stream" | "claude_stream_json";
}

// The honest default while the read settles (and after a resume, before the
// fresh pane's read lands): the built-in BYOK loop (ADR-0081). A single TS
// expression of the backend's `None` / `BuiltIn` default, mirroring how the
// auth-mode chip renders `AUTH_MODE_DEFAULT` before its read resolves.
export const RUNTIME_CHOICE_DEFAULT = {
  kind: "built_in",
} as const satisfies SessionRuntimeChoice;

// Resolve the runtime a cold start opens on, from the persisted default + the
// detected adapter table (ADR-0098 Decisions 2/3, issue #572) -- the frontend
// mirror of the Rust `commands::resolve_default_runtime`. Degrades to
// built-in when the default names an adapter that is undetected, outside the
// table, or when the table has not loaded yet (an unloaded table is
// deliberately indistinguishable from an empty one: the cold-start picker
// renders the degraded built-in form until it lands). The backend's own
// create_session resolution stays the startup truth -- this projection only
// drives the cold-start display + the submit-time gate.
export function resolveStartupRuntime(
  defaultRuntime: DefaultRuntime | undefined,
  adapters: AdapterEntry[] | undefined,
): SessionRuntimeChoice {
  if (defaultRuntime?.kind !== "external") return RUNTIME_CHOICE_DEFAULT;
  const named = adapters?.find((a) => a.id === defaultRuntime.data);
  return named?.detected
    ? { kind: "external", data: defaultRuntime.data }
    : RUNTIME_CHOICE_DEFAULT;
}

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

// The adapter diagnostic probe's success shape (ADR-0096, issues #534/#535;
// ADR-0097). Per-format tagged (`kind`), mirroring the Rust `ProbeOk`
// adjacently-tagged enum: `acp` carries the flat handshake catalog, the two
// per-model kinds carry the per-model catalog (or the degraded "unavailable"
// state). The per-model catalog is NOT flattened into `DiscoveredRuntime` --
// a union of per-model efforts would let the user select an effort the
// current model does not support (ADR-0096 D3).
export type ProbeOk =
  | { kind: "acp"; data: { discovered: DiscoveredRuntime } }
  | { kind: "codex_event_stream"; data: { outcome: ModelCatalogOutcome } }
  | { kind: "claude_stream_json"; data: { outcome: ModelCatalogOutcome } };

// The per-model catalog outcome of a non-ACP probe (ADR-0096 D2/D3: the
// codex app-server `model/list` query; ADR-0097 Decision 5: the claude-code
// control-plane `initialize` read). `available` carries the ordered
// per-model catalog; `unavailable` is the degraded "started but catalog
// unavailable" state (the process is alive, so this is a success, not a
// ProbeError). Mirrors the Rust `ModelCatalogOutcome` (status-tagged,
// snake_case serde).
export type ModelCatalogOutcome =
  | { status: "available"; models: CatalogModel[] }
  | { status: "unavailable"; detail: string };

// One model from a per-model catalog probe (ADR-0096 D3; ADR-0097 Decision
// 5 reuses the shape for claude-code). The reasoning efforts are the
// per-model supported list in the CLI's declared order (never a union across
// models). Mirrors the Rust `CatalogModel` (snake_case serde).
export interface CatalogModel {
  id: string;
  display_name: string;
  is_default: boolean;
  default_reasoning_effort: string;
  supported_reasoning_efforts: string[];
}

// --- Adapter catalog cache (ADR-0096 D5, issue #536) ------------------------
//
// The app-data sidecar `adapter-catalogs.json` read back over IPC: one
// entry per adapter id, each holding the last explicitly-tested probe
// catalog plus its wall-clock timestamp. The settings tab renders it as the
// "last tested" row state; the composer picker consumes it as the
// global-cache fallback (ADR-0096 D6 -- session catalog first, then this,
// then empty). Mirrors the Rust `catalog_store::{ProbeKind, CachedOutcome,
// AdapterCatalogEntry}` (snake_case serde).

// The channel that produced the catalog -- the per-format dispatch
// dimension (ADR-0096 D2, ADR-0097), selecting the consumer's rendering.
export type ProbeKind = "acp" | "codex_event_stream" | "claude_stream_json";

// The cached outcome, tagged by channel. The per-model degraded state is
// never cached (only a usable catalog is a cache point, ADR-0096 D5) -- the
// `models` variants are the only per-model shape that appears here.
export type CachedOutcome =
  | { acp: { discovered: DiscoveredRuntime } }
  | { codex_event_stream: { models: CatalogModel[] } }
  | { claude_stream_json: { models: CatalogModel[] } };

// One adapter's cache entry: the catalog + the probe timestamp
// (epoch millis, display-only -- it never feeds the picker's priority
// chain, ADR-0096 D6). A TAGGED UNION on `probe_kind` (issue #554): the
// probe kind and the outcome variant agree by construction -- the backend
// stamps both from the same probe and its loader drops any mismatched pair
// before the IPC boundary -- so the wire shape is unchanged and TS narrows
// `outcome` from `probe_kind` alone (no per-consumer variant checks).
export type AdapterCatalogEntry =
  | { probe_kind: "acp"; outcome: Extract<CachedOutcome, { acp: unknown }>; probed_at_millis: number }
  | {
    probe_kind: "codex_event_stream";
    outcome: Extract<CachedOutcome, { codex_event_stream: unknown }>;
    probed_at_millis: number;
  }
  | {
    probe_kind: "claude_stream_json";
    outcome: Extract<CachedOutcome, { claude_stream_json: unknown }>;
    probed_at_millis: number;
  };

// The whole cache document, keyed by adapter id.
export type AdapterCatalogs = Record<string, AdapterCatalogEntry>;

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
