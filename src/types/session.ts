// Session-domain types split from the single-file src/types.ts (issue #197).
// Mirrors the Rust model types (serde adjacently-/externally-tagged enums that
// cross IPC). Three cohesive concerns live here: typed command errors
// (SessionError tree + StoreCommandError), resume/turn progress side-channel
// events, and persisted session sidebar metadata.

import type { OperationKind } from "./approval";
import type { SkillMountError } from "./skills";
import type { TraceEntry } from "./thread";

// --- Session-scoped command errors ---------------------------------------

// Typed session-scoped command errors (issue #119). Mirrors the Rust
// `SessionError` -- serde adjacently-tagged (`#[serde(tag = "kind", content =
// "data")]`), the same shape the rest of the wire contract uses. Session-scoped
// commands reject with this structured value (NOT a bare string), so the
// frontend narrows on `kind` and renders a locale message instead of string-
// matching backend Chinese. `Resume` wraps the typed `ResumeError` (issue #120);
// `RemoveSource` / `RenameDataset` / `RenameSession` / `Turn` wrap their typed
// source-management sub-errors (issue #121), recursed by the frontend the same
// way; `SkillMount` wraps the typed `SkillMountError` (issue #363); `Engine`
// is the catch-all for internal failures and carries a free-text detail under
// `data` (technical, never an API key per ADR-0029).
export type SessionError =
  | { kind: "InvalidId" }
  | { kind: "NotFound" }
  | { kind: "Resuming" }
  | { kind: "InFlight" }
  | { kind: "Resume"; data: ResumeError }
  | { kind: "RemoveSource"; data: RemoveSourceError }
  | { kind: "RenameDataset"; data: RenameError }
  | { kind: "RenameSession"; data: RenameSessionError }
  | { kind: "Turn"; data: RowReadError }
  | { kind: "SkillMount"; data: SkillMountError }
  | { kind: "Engine"; data: string };

// Why a source removal was rejected (issues #38/#39/#40, ADR-0040). Mirrors the
// Rust `RemoveSourceError` (serde adjacently-tagged, issue #121). Rides
// SessionError::RemoveSource from `remove_source` / `remove_active_source`;
// NotFound / NotActive / InvalidContinueWith carry the reference name under
// data, IsActive carries both reference + display name.
export type RemoveSourceError =
  | { kind: "NotFound"; data: string }
  | { kind: "IsActive"; data: { reference_name: string; display_name: string } }
  | { kind: "NotActive"; data: string }
  | { kind: "InvalidContinueWith"; data: string };

// Why a dataset display-label rename was rejected (ADR-0037). Mirrors the Rust
// `RenameError` (serde adjacently-tagged, issue #121). Rides
// SessionError::RenameDataset from `rename_dataset`; NotFound / DisplayTaken
// carry the name/label under data, InvalidLabel is a unit variant.
export type RenameError =
  | { kind: "NotFound"; data: string }
  | { kind: "DisplayTaken"; data: string }
  | { kind: "InvalidLabel" };

// Why a session rename was rejected (ADR-0060, issue #81). Mirrors the Rust
// `RenameSessionError` (serde adjacently-tagged, issue #121). Rides
// SessionError::RenameSession from `rename_session`. The single refusal is a
// blank name; a persist write failure rides take_persist_error instead.
export type RenameSessionError = { kind: "EmptyName" };

// Why a row read failed (read_rows). Mirrors the Rust `RowReadError` (serde
// adjacently-tagged, issue #121). Rides SessionError::Turn; UnknownDataset
// carries the reference name, Execute carries the engine detail (technical,
// never an API key per ADR-0029). Turn failures are TurnOutcome::Failed
// (ADR-0028), NOT this type.
export type RowReadError =
  | { kind: "UnknownDataset"; data: string }
  | { kind: "Execute"; data: string };

// Why a forward migration step failed (issue #120). Rides DuckLoadError::
// Migration inside ResumeError::Load. Mirrors the Rust `MigrationError` (serde
// adjacently-tagged). `Field` carries the missing/ill-typed field detail;
// `NoTransform` names a gap in the migration chain (no registered step for the
// source version).
export type MigrationError =
  | { kind: "NoTransform"; data: { from: number; supported: number } }
  | { kind: "Field"; data: string };

// The .duck load error (persistence::io::LoadError, issue #120) -- DISTINCT
// from the ingest `LoadError` above. Nests MigrationError. Crosses IPC inside
// ResumeError::Load (the open_duck reject); the frontend recurses
// ResumeError::Load.data.kind to render the version-mismatch "please upgrade"
// hint or the io/parse/migration detail.
export type DuckLoadError =
  | { kind: "Io"; data: string }
  | { kind: "Parse"; data: string }
  | { kind: "VersionMismatch"; data: { found: number; supported: number } }
  | { kind: "Migration"; data: MigrationError };

// Why a resume failed (issue #120). The `open_duck` command wraps this in
// `SessionError::Resume`. Mirrors
// the Rust `ResumeError` (serde adjacently-tagged). `Load` recurses into
// DuckLoadError; `AlreadyOpen` carries the canonical .duck path (PathBuf ->
// string). Command-boundary internal failures (mutex poison / join panic) stay
// on `SessionError::Engine` -- they are not resume-domain, so they do not ride
// this enum.
export type ResumeError =
  | { kind: "Load"; data: DuckLoadError }
  | {
    kind: "SourceMissing";
    data: { reference_name: string; path: string; detail: string };
  }
  | { kind: "Replay"; data: { reference_name: string; detail: string } }
  | { kind: "ActiveMissing"; data: string }
  | { kind: "Cancelled" }
  | { kind: "Aborted" }
  | { kind: "AlreadyOpen"; data: string };

// Why a save failed (issue #120). Returned by `take_persist_error` as
// `SaveError | null` (a value, not a reject). Mirrors the Rust `SaveError`
// (serde adjacently-tagged). `AlreadyOpen` carries the canonical .duck path;
// the Serialize/Io/Rename data strings ride the technical-details fold.
export type SaveError =
  | { kind: "Serialize"; data: string }
  | { kind: "Io"; data: string }
  | { kind: "Rename"; data: string }
  | { kind: "AlreadyOpen"; data: string };

// Why a session-agnostic cold-store command failed (issue #130). Mirrors the
// Rust `StoreCommandError` (serde adjacently-tagged). Rejects from
// delete_session / rename_persisted_session (a cross-session .duck file),
// set_api_key / clear_api_key (the OS keychain), and set_provider_config /
// set_app_config (an app-config write). BlankName wraps RenameSessionError so
// the blank-name refusal matches rename_session's (one shape, one catalog id);
// the three failure variants carry the English technical detail under data for
// the fold. The top-level kind set is disjoint from SessionError / SaveError,
// so fmtError's kind dispatch is unambiguous.
export type StoreCommandError =
  | { kind: "OpenConflict" }
  | { kind: "BlankName"; data: RenameSessionError }
  | { kind: "DestinationExists"; data: string }
  | { kind: "IoFailure"; data: string }
  | { kind: "KeychainFailure"; data: string }
  | { kind: "ConfigWriteFailure"; data: string };

// --- Progress side-channel events ----------------------------------------

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

// A `resume-progress` side-channel event addressed by sessionId (ADR-0059,
// issue #76). Wraps a ResumeEvent with the addressing id so a multi-session
// frontend filters the global Tauri event broadcast to the one SessionPane that
// owns the resume. v1 emitted a bare ResumeEvent -- a single-session legacy.
// Mirrors the Rust `ResumeProgress`. `session_id` is the runtime id (UUID
// string) the open_duck command received.
export interface ResumeProgress {
  session_id: string;
  event: ResumeEvent;
}

// One discrete turn-progress event (ADR-0059, calibrated by ADR-0078,
// issue #297). The ask call is blocking with no intrinsic continuous progress,
// so the honest granularity is a discrete event at each boundary (no fabricated
// percentages, ADR-0017). The original Thinking / Querying phase pair evolved
// into the TOOL-CALL EVENT STREAM -- the trace is the stream's persisted form,
// so the rail renders the in-flight turn's trace from the very events that
// later land on TurnRecord.trace: Thinking brackets each provider round-trip
// (`attempt` is the 1-based STEP, rising across round-trips), and the
// ToolCallStarted / ToolCallCompleted pair wraps each dispatch (a gate-denied
// call fires only the completion, success: false). Mirrors the Rust
// `TurnPhase` (serde externally-tagged, like ResumeEvent); ToolCallCompleted
// wraps a TraceEntry verbatim (a newtype variant serializes to the same flat
// object), so the frontend appends the payload as its live trace entry.
export type TurnPhase =
  | { Thinking: { attempt: number } }
  | {
    ToolCallStarted: {
      name: string;
      operation_kind: OperationKind;
      summary: string;
    };
  }
  | { ToolCallCompleted: TraceEntry };

// A `turn-progress` side-channel event addressed by sessionId (ADR-0059,
// issue #76). Mirrors the Rust `TurnProgress`. The phase never enters the
// TurnOutcome contract; it is observer feedback only.
export interface TurnProgress {
  session_id: string;
  phase: TurnPhase;
}

// --- Persisted session metadata ------------------------------------------

// The working-set summary rendered as a sidebar entry's sub-line (ADR-0060:
// first source name + source count + turn count). Mirrors the Rust
// `SourceSummary`. All derived from the recipe -- no new persisted fields.
export interface SourceSummary {
  // The first source's display label, or null when the working set is empty.
  first_source_name: string | null;
  source_count: number;
  // Turn entries only -- source lifecycle events are not turns (ADR-0040).
  turn_count: number;
}

// One persisted session's sidebar metadata (ADR-0060/0061, issue #76). Mirrors
// the Rust `SessionMetadata`. `duck_path` is the `.duck` file path -- the
// stable identity of a persisted session (the runtime UUID is not persisted);
// pass it back to openDuck to resume. Every other field is derived from the
// recipe + the file mtime (zero new persistence). Renamed from `session_id` in
// issue #462 to disambiguate from the runtime UUID that addresses live IPC.
export interface SessionMetadata {
  duck_path: string;
  display_name: string;
  // File mtime, milliseconds since the Unix epoch.
  last_modified_at: number;
  source_summary: SourceSummary;
  format_version: number;
}
