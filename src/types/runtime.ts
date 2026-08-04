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

// One v1 adapter projected for the composer picker. The stable id is the
// `set_session_runtime` key; the display name is the row label; `detected`
// drives the selectable / disabled + "not installed" rendering. The picker
// renders this table verbatim -- adding a CLI upstream grows the list with
// zero frontend change. Mirrors `commands::AdapterEntry`.
export interface AdapterEntry {
  id: string;
  display_name: string;
  detected: boolean;
}

// The honest default while the read settles (and after a resume, before the
// fresh pane's read lands): the built-in BYOK loop (ADR-0081). A single TS
// expression of the backend's `None` / `BuiltIn` default, mirroring how the
// auth-mode chip renders `AUTH_MODE_DEFAULT` before its read resolves.
export const RUNTIME_CHOICE_DEFAULT: SessionRuntimeChoice = { kind: "built_in" };
