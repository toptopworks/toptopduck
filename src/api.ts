import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { IntlShape } from "react-intl";
import type { AppConfig } from "./types/app-config";
import type { AppError, AppErrorKind } from "./types/error";
import type {
  DatasetDescriptor,
  DatasetPrivacy,
  LoadOutcome,
  RowPage,
  SheetGuidance,
} from "./types/dataset";
import type {
  DuckLoadError,
  MigrationError,
  RemoveSourceError,
  RenameError,
  ResumeError,
  ResumeProgress,
  SaveError,
  SessionError,
  SessionMetadata,
  StoreCommandError,
  TurnError,
  TurnProgress,
} from "./types/session";
import type { ProfileKeyStatus, ProviderConfig, ProviderConfigView } from "./types/provider";
import type { ThreadEntry, TurnFailure, TurnOutcome } from "./types/thread";

// Multi-session addressing (ADR-0056): every session-scoped function takes
// `sessionId` as its first parameter -- the backend looks up the target
// session by id. Session-AGNOSTIC functions (api key / provider config / app
// config / record_recent_file) take no sessionId. The frontend tracks the ids
// itself (createSession mints one); this single-session shell holds one until
// the multi-tab UI lands in a later PRD.

// Create a new session (ADR-0056): the backend builds an independent in-memory
// DuckDB instance + per-session cancel token, binds them to a backend-generated
// id (UUID), and returns it. This is the `+ tab` action.
export async function createSession(): Promise<string> {
  return invoke<string>("create_session");
}

// Close a session (ADR-0055): fire cancel + mark closing + remove from the
// store. Returns immediately; an in-flight ask's post-check discards its turn.
// After this, calls targeting the id reject as unknown session.
export async function closeSession(sessionId: string): Promise<void> {
  await invoke<void>("close_session", { sessionId });
}

// Close a session AND wait for the canonical single-writer key to be released
// (ADR-0063). The delete path's variant: blocks (<=120s, aligned to ADR-0021
// REQUEST_TIMEOUT) until the in-flight ask's Arc clone drops and Session::Drop
// runs, so delete_session's try_acquire gate sees the key free. Resolves at
// once when no ask is in flight. The plain closeSession (above) stays
// fire-and-forget -- this is the delete-only wait variant.
export async function closeSessionAndWaitRelease(
  sessionId: string,
): Promise<void> {
  await invoke<void>("close_session_and_wait_release", { sessionId });
}

export async function ingestFile(sessionId: string, path: string): Promise<LoadOutcome> {
  return invoke<LoadOutcome>("ingest_file", { sessionId, path });
}

// Re-ingest an Excel workbook with the user's guided rectify choices
// (ADR-0015/0042), after a NeedsGuidance outcome.
export async function ingestFileGuided(
  sessionId: string,
  path: string,
  guidance: SheetGuidance[],
): Promise<LoadOutcome> {
  return invoke<LoadOutcome>("ingest_file_guided", { sessionId, path, guidance });
}

export async function listWorkingSet(sessionId: string): Promise<DatasetDescriptor[]> {
  return invoke<DatasetDescriptor[]>("list_working_set", { sessionId });
}

export async function activeDataset(sessionId: string): Promise<DatasetDescriptor | null> {
  return invoke<DatasetDescriptor | null>("active_dataset", { sessionId });
}

// Rename a dataset's display label (ADR-0037, issue #8): display-only -- the
// reference name is untouched, so SQL / recipe / active references stay valid.
// Rejects an unknown reference or a label already shown by another dataset; the
// backend rejects with the typed `SessionError::RenameDataset` (issue #121).
export async function renameDataset(
  sessionId: string,
  referenceName: string,
  newDisplay: string,
): Promise<DatasetDescriptor> {
  return invoke<DatasetDescriptor>("rename_dataset", { sessionId, referenceName, newDisplay });
}

// Re-upload onto an existing dataset's reference name (ADR-0042, issue #11): a
// fresh snapshot takes over the name; the old one is discarded. Distinct from
// ingestFile (add) -- the reference name to take over is explicit.
export async function replaceSource(
  sessionId: string,
  referenceName: string,
  path: string,
): Promise<LoadOutcome> {
  return invoke<LoadOutcome>("replace_source", { sessionId, referenceName, path });
}

// Remove a source dataset from the working set (issue #38/#39, ADR-0040).
export async function removeSource(sessionId: string, referenceName: string): Promise<void> {
  await invoke<void>("remove_source", { sessionId, referenceName });
}

// Delete the ACTIVE source and repoint focus at an explicit continuation
// source (issue #39, ADR-0035 -- no silent focus jump).
export async function removeActiveSource(
  sessionId: string,
  referenceName: string,
  continueWith: string,
): Promise<void> {
  await invoke<void>("remove_active_source", { sessionId, referenceName, continueWith });
}

// Set a dataset's privacy controls (ADR-0011, issue #9 slice 5).
export async function setDatasetPrivacy(
  sessionId: string,
  referenceName: string,
  privacy: DatasetPrivacy,
): Promise<DatasetDescriptor> {
  return invoke<DatasetDescriptor>("set_dataset_privacy", { sessionId, referenceName, privacy });
}

// Ask one question (PRD #1) against the named session: run one turn and return
// its ADR-0028 outcome (result / textual / failed / cancelled).
export async function askQuestion(sessionId: string, question: string): Promise<TurnOutcome> {
  return invoke<TurnOutcome>("ask", { sessionId, question });
}

// Cancel the named session's in-flight turn (ADR-0021, issue #28). Fires THAT
// session's cancel token (per-session, ADR-0056).
export async function cancelQuery(sessionId: string): Promise<void> {
  await invoke<void>("cancel", { sessionId });
}

// Read the named session's conversation thread (ADR-0028/0039/0040).
export async function conversation(sessionId: string): Promise<ThreadEntry[]> {
  return invoke<ThreadEntry[]>("conversation", { sessionId });
}

// Read one page of a dataset's rows from the named session (ADR-0024).
export async function readRows(
  sessionId: string,
  referenceName: string,
  offset: number,
  limit: number,
): Promise<RowPage> {
  return invoke<RowPage>("read_rows", { sessionId, referenceName, offset, limit });
}

// Narrow an unknown IPC reject to a SessionError (issue #119). A session-
// scoped command rejects with the adjacently-tagged `{ kind, data? }` shape;
// anything else (a raw string, a JS Error, an opaque object) is left to
// fmtError's fallback path. The Engine variant additionally requires its
// `data` to be a string: a malformed `{ kind: "Engine" }` (missing/non-string
// data) is NOT treated as a SessionError, so the guard never narrows `e` to a
// shape whose `data` it has not actually verified (review L1).
function isSessionError(e: unknown): e is SessionError {
  if (typeof e !== "object" || e === null) return false;
  const kind = (e as { kind?: unknown }).kind;
  switch (kind) {
    case "InvalidId":
    case "NotFound":
    case "Resuming":
    case "InFlight":
      return true;
    case "Resume":
      return isResumeError((e as { data?: unknown }).data);
    case "RemoveSource":
      return isRemoveSourceError((e as { data?: unknown }).data);
    case "RenameDataset":
      return isRenameError((e as { data?: unknown }).data);
    case "RenameSession": {
      const d = (e as { data?: unknown }).data;
      return (
        typeof d === "object" &&
        d !== null &&
        (d as { kind?: unknown }).kind === "EmptyName"
      );
    }
    case "Turn":
      return isTurnError((e as { data?: unknown }).data);
    case "Engine":
      return typeof (e as { data?: unknown }).data === "string";
    default:
      return false;
  }
}

// Narrow an unknown value to a MigrationError (issue #120). Rides
// DuckLoadError::Migration inside ResumeError::Load. Same L1 defensive shape
// as isSessionError: a variant's `data` is verified before the guard promises
// it, so fmtError / errorDetail never read an unverified field.
function isMigrationError(e: unknown): e is MigrationError {
  if (typeof e !== "object" || e === null) return false;
  const kind = (e as { kind?: unknown }).kind;
  switch (kind) {
    case "NoTransform": {
      const d = (e as { data?: unknown }).data;
      return (
        typeof d === "object" &&
        d !== null &&
        typeof (d as { from?: unknown }).from === "number" &&
        typeof (d as { supported?: unknown }).supported === "number"
      );
    }
    case "Field":
      return typeof (e as { data?: unknown }).data === "string";
    default:
      return false;
  }
}

// Narrow an unknown value to a DuckLoadError -- the .duck load error
// (persistence::io::LoadError), distinct from the ingest model::LoadError
// (issue #120). Migration recurses into isMigrationError.
function isDuckLoadError(e: unknown): e is DuckLoadError {
  if (typeof e !== "object" || e === null) return false;
  const kind = (e as { kind?: unknown }).kind;
  switch (kind) {
    case "Io":
    case "Parse":
      return typeof (e as { data?: unknown }).data === "string";
    case "VersionMismatch": {
      const d = (e as { data?: unknown }).data;
      return (
        typeof d === "object" &&
        d !== null &&
        typeof (d as { found?: unknown }).found === "number" &&
        typeof (d as { supported?: unknown }).supported === "number"
      );
    }
    case "Migration":
      return isMigrationError((e as { data?: unknown }).data);
    default:
      return false;
  }
}

// Narrow an unknown IPC reject to a ResumeError (issue #120). The `open_duck`
// command wraps its ResumeError in SessionError::Resume, so this guard is
// reached via isSessionError's Resume branch. Load recurses into
// isDuckLoadError; SourceMissing / Replay verify their struct fields;
// AlreadyOpen / ActiveMissing carry a string under data; Cancelled / Aborted
// are unit.
function isResumeError(e: unknown): e is ResumeError {
  if (typeof e !== "object" || e === null) return false;
  const kind = (e as { kind?: unknown }).kind;
  switch (kind) {
    case "Load":
      return isDuckLoadError((e as { data?: unknown }).data);
    case "SourceMissing": {
      const d = (e as { data?: unknown }).data;
      return (
        typeof d === "object" &&
        d !== null &&
        typeof (d as { reference_name?: unknown }).reference_name === "string" &&
        typeof (d as { path?: unknown }).path === "string" &&
        typeof (d as { detail?: unknown }).detail === "string"
      );
    }
    case "Replay": {
      const d = (e as { data?: unknown }).data;
      return (
        typeof d === "object" &&
        d !== null &&
        typeof (d as { reference_name?: unknown }).reference_name === "string" &&
        typeof (d as { detail?: unknown }).detail === "string"
      );
    }
    case "ActiveMissing":
    case "AlreadyOpen":
      return typeof (e as { data?: unknown }).data === "string";
    case "Cancelled":
    case "Aborted":
      return true;
    default:
      return false;
  }
}

// Narrow an unknown value to a SaveError (issue #120). Returned by
// take_persist_error as `SaveError | null` (a value, not a reject). Every
// variant carries a string under data (the io/serde/rename detail, or the
// AlreadyOpen canonical path).
function isSaveError(e: unknown): e is SaveError {
  if (typeof e !== "object" || e === null) return false;
  const kind = (e as { kind?: unknown }).kind;
  switch (kind) {
    case "Serialize":
    case "Io":
    case "Rename":
    case "AlreadyOpen":
      return typeof (e as { data?: unknown }).data === "string";
    default:
      return false;
  }
}

// Narrow an unknown value to a StoreCommandError (issue #130). Rejects from the
// cold-store commands (delete / rename-persisted / keychain / provider + app
// config). Same L1 defensive shape as the other guards: a variant's data is
// verified before the guard promises it. BlankName recurses RenameSessionError.
function isStoreCommandError(e: unknown): e is StoreCommandError {
  if (typeof e !== "object" || e === null) return false;
  const kind = (e as { kind?: unknown }).kind;
  switch (kind) {
    case "OpenConflict":
      return true;
    case "BlankName": {
      const d = (e as { data?: unknown }).data;
      return (
        typeof d === "object" &&
        d !== null &&
        (d as { kind?: unknown }).kind === "EmptyName"
      );
    }
    case "IoFailure":
    case "KeychainFailure":
    case "ConfigWriteFailure":
      return typeof (e as { data?: unknown }).data === "string";
    default:
      return false;
  }
}

// Narrow an unknown value to a RemoveSourceError (issue #121). Reached via
// isSessionError's RemoveSource branch (remove_source / remove_active_source
// rejects). IsActive carries a struct; the newtype variants carry a string.
// Same L1 defensive shape as the other guards: a variant's data is verified
// before the guard promises it.
function isRemoveSourceError(e: unknown): e is RemoveSourceError {
  if (typeof e !== "object" || e === null) return false;
  const kind = (e as { kind?: unknown }).kind;
  switch (kind) {
    case "NotFound":
    case "NotActive":
    case "InvalidContinueWith":
      return typeof (e as { data?: unknown }).data === "string";
    case "IsActive": {
      const d = (e as { data?: unknown }).data;
      return (
        typeof d === "object" &&
        d !== null &&
        typeof (d as { reference_name?: unknown }).reference_name === "string" &&
        typeof (d as { display_name?: unknown }).display_name === "string"
      );
    }
    default:
      return false;
  }
}

// Narrow an unknown value to a RenameError (issue #121) -- the dataset display-
// label rename error. Reached via isSessionError's RenameDataset branch.
// NotFound / DisplayTaken carry a string; InvalidLabel is a unit variant.
function isRenameError(e: unknown): e is RenameError {
  if (typeof e !== "object" || e === null) return false;
  const kind = (e as { kind?: unknown }).kind;
  switch (kind) {
    case "NotFound":
    case "DisplayTaken":
      return typeof (e as { data?: unknown }).data === "string";
    case "InvalidLabel":
      return true;
    default:
      return false;
  }
}

// Narrow an unknown value to a TurnError (issue #121) -- the read_rows error.
// Reached via isSessionError's Turn branch. Both variants carry a string under
// data (the reference name / the engine detail).
function isTurnError(e: unknown): e is TurnError {
  if (typeof e !== "object" || e === null) return false;
  const kind = (e as { kind?: unknown }).kind;
  switch (kind) {
    case "UnknownDataset":
    case "Execute":
      return typeof (e as { data?: unknown }).data === "string";
    default:
      return false;
  }
}

// Format a DuckLoadError through the locale catalog (issue #120). The
// version-mismatch "please upgrade" hint interpolates the found / supported
// versions into the message; the io / parse / migration messages are generic
// and the underlying detail rides the technical-details fold via errorDetail.
function formatDuckLoadError(e: DuckLoadError, intl: IntlShape): string {
  switch (e.kind) {
    case "Io":
      return intl.formatMessage({
        id: "error.duck.loadIo",
        defaultMessage: "Failed to read the .duck file",
      });
    case "Parse":
      return intl.formatMessage({
        id: "error.duck.loadParse",
        defaultMessage: "Failed to parse the .duck file",
      });
    case "VersionMismatch":
      return intl.formatMessage(
        {
          id: "error.duck.versionMismatch",
          defaultMessage:
            "This .duck was made by a newer app (format_version={found}); the current app supports only {supported}. Please upgrade the app, then reopen it.",
        },
        { found: e.data.found, supported: e.data.supported },
      );
    case "Migration":
      return intl.formatMessage({
        id: "error.duck.migration",
        defaultMessage: "Failed to migrate the .duck file to the current format",
      });
    default: {
      const unhandled: never = e;
      throw new Error(`unhandled DuckLoadError kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Format a ResumeError through the locale catalog (issue #120). Load recurses
// into formatDuckLoadError; SourceMissing / Replay / ActiveMissing interpolate
// the reference name; AlreadyOpen shares the merged `error.duck.alreadyOpen`
// id with SaveError::AlreadyOpen (DRY -- the single-writer invariant is one
// message, not two).
function formatResumeError(e: ResumeError, intl: IntlShape): string {
  switch (e.kind) {
    case "Load":
      return formatDuckLoadError(e.data, intl);
    case "SourceMissing":
      return intl.formatMessage(
        { id: "error.resume.sourceMissing", defaultMessage: "Source \"{name}\" not found" },
        { name: e.data.reference_name },
      );
    case "Replay":
      return intl.formatMessage(
        { id: "error.resume.replay", defaultMessage: "Failed to replay \"{name}\"" },
        { name: e.data.reference_name },
      );
    case "ActiveMissing":
      return intl.formatMessage(
        {
          id: "error.resume.activeMissing",
          defaultMessage: "The session focus points to an unregistered source \"{name}\"",
        },
        { name: e.data },
      );
    case "Cancelled":
      return intl.formatMessage({
        id: "error.resume.cancelled",
        defaultMessage: "Resume cancelled",
      });
    case "Aborted":
      return intl.formatMessage({
        id: "error.resume.aborted",
        defaultMessage: "Resume aborted",
      });
    case "AlreadyOpen":
      return intl.formatMessage({
        id: "error.duck.alreadyOpen",
        defaultMessage: "This .duck is already open in this process",
      });
    default: {
      const unhandled: never = e;
      throw new Error(`unhandled ResumeError kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Format a SaveError through the locale catalog (issue #120). AlreadyOpen
// shares the merged `error.duck.alreadyOpen` id with ResumeError::AlreadyOpen.
function formatSaveError(e: SaveError, intl: IntlShape): string {
  switch (e.kind) {
    case "Serialize":
      return intl.formatMessage({
        id: "error.save.serialize",
        defaultMessage: "Failed to serialize the .duck file",
      });
    case "Io":
      return intl.formatMessage({
        id: "error.save.io",
        defaultMessage: "Failed to write the .duck temp file",
      });
    case "Rename":
      return intl.formatMessage({
        id: "error.save.rename",
        defaultMessage: "Failed to replace the .duck file",
      });
    case "AlreadyOpen":
      return intl.formatMessage({
        id: "error.duck.alreadyOpen",
        defaultMessage: "This .duck is already open in this process",
      });
    default: {
      const unhandled: never = e;
      throw new Error(`unhandled SaveError kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Format a StoreCommandError through the locale catalog (issue #130). BlankName
// reuses error.session.renameEmpty (the same id as SessionError::RenameSession)
// so the blank-name refusal has one user-facing shape across rename_session
// and rename_persisted_session. The three failure variants render a generic
// message; their English data rides the technical-details fold (ADR-0029: no
// key leaks).
function formatStoreCommandError(e: StoreCommandError, intl: IntlShape): string {
  switch (e.kind) {
    case "OpenConflict":
      return intl.formatMessage({
        id: "error.store.openConflict",
        defaultMessage: "This session is currently open; close it first",
      });
    case "BlankName":
      return intl.formatMessage({
        id: "error.session.renameEmpty",
        defaultMessage: "Session name must not be empty",
      });
    case "IoFailure":
      return intl.formatMessage({
        id: "error.store.ioFailure",
        defaultMessage: "A file operation failed",
      });
    case "KeychainFailure":
      return intl.formatMessage({
        id: "error.store.keychainFailure",
        defaultMessage: "Failed to access the OS keychain",
      });
    case "ConfigWriteFailure":
      return intl.formatMessage({
        id: "error.store.configWriteFailure",
        defaultMessage: "Failed to save settings",
      });
    default: {
      const unhandled: never = e;
      throw new Error(`unhandled StoreCommandError kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Format a RemoveSourceError through the locale catalog (issue #121). NotFound
// shares the merged `error.dataset.notFound` id with RenameError::NotFound and
// TurnError::UnknownDataset (DRY -- one "dataset not found" message, not three
// copies of the backend string). IsActive interpolates the display name; the
// other variants name the reference.
function formatRemoveSourceError(e: RemoveSourceError, intl: IntlShape): string {
  switch (e.kind) {
    case "NotFound":
      return intl.formatMessage(
        {
          id: "error.dataset.notFound",
          defaultMessage: "No dataset found with reference name \"{name}\"",
        },
        { name: e.data },
      );
    case "IsActive":
      return intl.formatMessage(
        {
          id: "error.dataset.removeActive",
          defaultMessage:
            "\"{name}\" is the current focus table; pick a continuation from the remaining sources first (or cancel)",
        },
        { name: e.data.display_name },
      );
    case "NotActive":
      return intl.formatMessage(
        {
          id: "error.dataset.notActive",
          defaultMessage:
            "\"{name}\" is not the current focus source; use plain delete or refresh the working set and retry",
        },
        { name: e.data },
      );
    case "InvalidContinueWith":
      return intl.formatMessage(
        {
          id: "error.dataset.invalidContinueWith",
          defaultMessage:
            "\"{name}\" is not among the remaining sources; cannot use it as the continuation (refresh the working set and re-pick)",
        },
        { name: e.data },
      );
    default: {
      const unhandled: never = e;
      throw new Error(`unhandled RemoveSourceError kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Format a RenameError (dataset display-label rename) through the locale
// catalog (issue #121). NotFound shares the merged `error.dataset.notFound` id.
function formatRenameDatasetError(e: RenameError, intl: IntlShape): string {
  switch (e.kind) {
    case "NotFound":
      return intl.formatMessage(
        {
          id: "error.dataset.notFound",
          defaultMessage: "No dataset found with reference name \"{name}\"",
        },
        { name: e.data },
      );
    case "DisplayTaken":
      return intl.formatMessage(
        {
          id: "error.dataset.displayTaken",
          defaultMessage: "Display label \"{label}\" is already used by another dataset; pick a different one",
        },
        { label: e.data },
      );
    case "InvalidLabel":
      return intl.formatMessage({
        id: "error.dataset.invalidLabel",
        defaultMessage: "Display label must not be empty or whitespace-only",
      });
    default: {
      const unhandled: never = e;
      throw new Error(`unhandled RenameError kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Format a TurnError (read_rows failure) through the locale catalog (issue
// #121). UnknownDataset shares the merged `error.dataset.notFound` id; Execute
// renders a generic message and the engine detail rides the technical-details
// fold (the detail is a DuckDB read error, never an API key per ADR-0029).
function formatTurnError(e: TurnError, intl: IntlShape): string {
  switch (e.kind) {
    case "UnknownDataset":
      return intl.formatMessage(
        {
          id: "error.dataset.notFound",
          defaultMessage: "No dataset found with reference name \"{name}\"",
        },
        { name: e.data },
      );
    case "Execute":
      return intl.formatMessage({
        id: "error.turn.execute",
        defaultMessage: "Failed to execute the query",
      });
    default: {
      const unhandled: never = e;
      throw new Error(`unhandled TurnError kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Format an unknown error (a Tauri IPC reject, a JS Error, or a structured
// object) into a readable string. A structured typed error -- SessionError
// (issue #119), ResumeError / SaveError (issue #120) -- is narrowed to its
// `kind` and rendered through the locale catalog, so the backend Chinese
// wording no longer crosses IPC. Each `formatMessage` call site carries a
// literal id + defaultMessage so @formatjs extract recovers it for the catalog
// guard (an id hidden behind a lookup map would be invisible to the extract).
// Anything else (a raw string reject, a JS Error, an opaque object) falls back
// to the prior best-effort stringification.
export function fmtError(e: unknown, intl: IntlShape): string {
  if (isSessionError(e)) {
    switch (e.kind) {
      case "InvalidId":
        return intl.formatMessage({
          id: "error.session.invalidId",
          defaultMessage: "Invalid session id",
        });
      case "NotFound":
        return intl.formatMessage({
          id: "error.session.notFound",
          defaultMessage: "Session not found or closed",
        });
      case "Resuming":
        return intl.formatMessage({
          id: "error.session.resuming",
          defaultMessage: "Session is resuming, please try again shortly",
        });
      case "InFlight":
        return intl.formatMessage({
          id: "error.session.inFlight",
          defaultMessage:
            "A query is already running on this session; cancel it or wait for it to finish",
        });
      case "Engine":
        return intl.formatMessage({
          id: "error.session.engine",
          defaultMessage: "Internal error",
        });
      case "Resume":
        return formatResumeError(e.data, intl);
      case "RemoveSource":
        return formatRemoveSourceError(e.data, intl);
      case "RenameDataset":
        return formatRenameDatasetError(e.data, intl);
      case "RenameSession":
        return intl.formatMessage({
          id: "error.session.renameEmpty",
          defaultMessage: "Session name must not be empty",
        });
      case "Turn":
        return formatTurnError(e.data, intl);
      default: {
        // Exhaustiveness guard (issue #121): a future SessionError variant must
        // trip the compiler here, not silently fall through to the opaque JSON
        // fallback below. Mirrors the `never` guards in the sub-formatters.
        const unhandled: never = e;
        throw new Error(`unhandled SessionError kind: ${JSON.stringify(unhandled)}`);
      }
    }
  }
  // Invariant: the top-level reject kind sets are disjoint (SessionError kinds
  // and SaveError kinds share none), so checking isSessionError before
  // isSaveError is unambiguous. If a future command rejects a bare DuckLoadError
  // (its `Io` collides with SaveError::Io), add an isDuckLoadError branch here
  // before isSaveError.
  if (isSaveError(e)) {
    return formatSaveError(e, intl);
  }
  if (isStoreCommandError(e)) {
    return formatStoreCommandError(e, intl);
  }
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  // Opaque object: stringify best-effort. A cyclic reject would throw, so fall
  // back to String() rather than crash the error renderer itself (review L2).
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

// Extract the technical detail for the collapsed "Technical details" fold
// (issue #119 / #120). Returns the underlying string from a typed error's
// `data` -- SessionError::Engine, ResumeError::Engine / SourceMissing / Replay
// / AlreadyOpen, the nested DuckLoadError io/parse/migration detail, or a
// SaveError's io/serde/rename detail / AlreadyOpen path, or a StoreCommandError's
// io/keychain/config-write detail -- and null for every variant whose message
// is already self-contained (so the fold is omitted).
// fmtError keeps this detail OUT of the primary message; ADR-0029 holds -- the
// Rust side is audited to keep secrets out of these payloads (the resume /
// save paths are keychain-free) -- so the raw detail is safe to surface.
export function errorDetail(e: unknown): string | null {
  if (isSessionError(e)) {
    if (e.kind === "Engine") return e.data;
    if (e.kind === "Resume") return resumeErrorDetail(e.data);
    if (e.kind === "Turn") return turnErrorDetail(e.data);
    return null;
  }
  if (isSaveError(e)) {
    // Every SaveError variant carries a string under data (the detail or the
    // AlreadyOpen path) -- all useful in the fold.
    return e.data;
  }
  if (isStoreCommandError(e)) {
    // The three failure variants carry the English technical detail for the
    // fold; OpenConflict / BlankName are self-contained (the message already
    // names the refusal).
    if (
      e.kind === "IoFailure" ||
      e.kind === "KeychainFailure" ||
      e.kind === "ConfigWriteFailure"
    ) {
      return e.data;
    }
    return null;
  }
  return null;
}

// Detail for a nested ResumeError (issue #120), reached via SessionError::
// Resume. SourceMissing / Replay carry their detail; AlreadyOpen carries the
// canonical path; the rest are self-contained (the message already names them).
function resumeErrorDetail(e: ResumeError): string | null {
  switch (e.kind) {
    case "Load":
      return duckLoadErrorDetail(e.data);
    case "SourceMissing":
    case "Replay":
      return e.data.detail;
    case "AlreadyOpen":
      return e.data;
    case "ActiveMissing":
    case "Cancelled":
    case "Aborted":
      return null;
    default: {
      const unhandled: never = e;
      throw new Error(`unhandled ResumeError kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Detail for a nested TurnError (issue #121), reached via SessionError::Turn.
// Execute carries the engine detail for the fold; UnknownDataset's name is
// already in the message, so it carries no fold detail.
function turnErrorDetail(e: TurnError): string | null {
  switch (e.kind) {
    case "Execute":
      return e.data;
    case "UnknownDataset":
      return null;
    default: {
      const unhandled: never = e;
      throw new Error(`unhandled TurnError kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Detail for a nested DuckLoadError (issue #120). VersionMismatch's versions
// are already in the message, so it carries no fold detail; the migration
// branch recurses into the MigrationError (Field detail or the NoTransform
// version gap).
function duckLoadErrorDetail(e: DuckLoadError): string | null {
  switch (e.kind) {
    case "Io":
    case "Parse":
      return e.data;
    case "VersionMismatch":
      return null;
    case "Migration":
      return migrationErrorDetail(e.data);
    default: {
      const unhandled: never = e;
      throw new Error(`unhandled DuckLoadError kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

function migrationErrorDetail(e: MigrationError): string | null {
  switch (e.kind) {
    case "NoTransform":
      return `format_version=${e.data.from} (supported: ${e.data.supported})`;
    case "Field":
      return e.data;
    default: {
      const unhandled: never = e;
      throw new Error(`unhandled MigrationError kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Describe an IPC reject for an error banner: the locale message via fmtError
// plus the technical detail (issues #119 / #120), tagged with the originating
// operation's kind (issue #194). Two callers: the shell (kind "shell", 9
// handler sites in App.tsx) and the result view (kind "read" -- a readRows
// reject). The session pane's persist-warning banner composes fmtError +
// errorDetail inline (SessionPane.tsx), so it is NOT a caller here; the
// close-wait / resume / save detail therefore surfaces consistently across
// every layer. If fmtError yields an empty string (a bare throw with no
// message, or a minified error), fall back to the Engine locale message so
// the banner is never blank.
export function describeReject(
  e: unknown,
  intl: IntlShape,
  kind: AppErrorKind,
): AppError {
  const message = fmtError(e, intl) ||
    intl.formatMessage({
      id: "error.session.engine",
      defaultMessage: "Internal error",
    });
  return { message, kind, detail: errorDetail(e) };
}

// Format a TurnFailure (TurnOutcome::Failed.data, issue #125) through the
// locale catalog. Execute shares the merged `error.turn.execute` id with
// SessionError::Turn::Execute (DRY -- one "query failed" message, not two);
// Resource / NotWired / StaleReference each have their own id, and
// StaleReference interpolates the dead reference name. Each formatMessage call
// carries a literal id + defaultMessage so @formatjs extract recovers it.
export function formatTurnFailure(failure: TurnFailure, intl: IntlShape): string {
  switch (failure.kind) {
    case "Execute":
      return intl.formatMessage({
        id: "error.turn.execute",
        defaultMessage: "Failed to execute the query",
      });
    case "Resource":
      return intl.formatMessage({
        id: "error.turn.resource",
        defaultMessage: "A resource limit was reached",
      });
    case "NotWired":
      return intl.formatMessage({
        id: "error.turn.notWired",
        defaultMessage: "No LLM provider is configured",
      });
    case "StaleReference":
      return intl.formatMessage(
        {
          id: "error.turn.stale",
          defaultMessage: "References a stale result \"{name}\"",
        },
        { name: failure.data.reference_name },
      );
    default: {
      // Exhaustiveness guard: a future TurnFailure kind trips the compiler
      // here, mirroring the Rust match and the `never` guards in fmtError.
      const unhandled: never = failure;
      throw new Error(`unhandled TurnFailure kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Extract the technical detail for the collapsed "Technical details" fold from
// a TurnFailure (issue #125). Execute / Resource carry the engine detail
// (audited to hold no API key, ADR-0029); NotWired / StaleReference are
// self-contained (the message already names them) -> no fold.
export function turnFailureDetail(failure: TurnFailure): string | null {
  switch (failure.kind) {
    case "Execute":
    case "Resource":
      return failure.data.detail;
    case "NotWired":
    case "StaleReference":
      return null;
    default: {
      const unhandled: never = failure;
      throw new Error(`unhandled TurnFailure kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

// --- LLM provider key + config (issue #29, ADR-0007/0019/0029) -------------
//
// Session-AGNOSTIC (ADR-0056): no sessionId. The API key crosses IPC exactly
// once (here, into Rust), is stored in the OS keychain, and thereafter the
// frontend learns only a boolean. The webview holds no key and makes no HTTP
// egress -- all LLM calls are placed by the Rust core (ADR-0029).

export async function hasApiKey(): Promise<boolean> {
  return invoke<boolean>("has_api_key");
}

export async function setApiKey(key: string): Promise<void> {
  await invoke<void>("set_api_key", { key });
}

export async function clearApiKey(): Promise<void> {
  await invoke<void>("clear_api_key");
}

export async function getProviderConfig(): Promise<ProviderConfigView> {
  return invoke<ProviderConfigView>("get_provider_config");
}

export async function setProviderConfig(config: ProviderConfig): Promise<ProviderConfigView> {
  return invoke<ProviderConfigView>("set_provider_config", { config });
}

// Per-profile key management (issue #153, ADR-0064/0029). The Profiles UI edits
// keys for ANY profile, not just the active one. Each profile's key lives in its
// own keychain slot `key-<profile_id>`; the frontend learns only booleans,
// never the key (ADR-0029 invariant 3). The active-profile commands above
// (hasApiKey/setApiKey/clearApiKey) stay for the header indicator's active view.

// One entry per profile currently in app-config: the profile id plus whether its
// keychain slot holds a key. Profile RECORDS stay single-sourced from
// app-config; this overlays only the key status. Read-only -- cannot refuse.
export async function listProviderProfiles(): Promise<ProfileKeyStatus[]> {
  return invoke<ProfileKeyStatus[]>("list_provider_profiles");
}

// Store the key for the named profile (ADR-0029 one-shot transfer; the key
// never returns across IPC). Returns the NEW has_key so the UI updates its
// overlay without a re-fetch. `profileId` is the opaque profile id; it need not
// match a saved profile yet (a freshly-minted id before Save is a valid target).
export async function setProfileKey(profileId: string, key: string): Promise<boolean> {
  return invoke<boolean>("set_profile_key", { profileId, key });
}

// Remove the key for the named profile (idempotent). Returns the NEW has_key
// (false on success). A keychain error rejects with StoreCommandError so the UI
// can tell the user the key did not come out (ADR-0029 trust root).
export async function clearProfileKey(profileId: string): Promise<boolean> {
  return invoke<boolean>("clear_profile_key", { profileId });
}

// --- Cross-session persistence (issue #48, ADR-0034/0036) -----------------

// Bind the named session to a .duck path and write one recipe immediately.
export async function saveAsDuck(
  sessionId: string,
  path: string,
  sessionName: string,
): Promise<void> {
  await invoke<void>("save_as_duck", { sessionId, path, sessionName });
}

// Open a .duck and resume the named session WITHIN THE SAME session_id
// (ADR-0056: open reuses the id; it does NOT create a new session). Runs off
// the UI thread; a `resume-progress` event fires per source / replayed turn.
export async function openDuck(sessionId: string, path: string): Promise<void> {
  await invoke<void>("open_duck", { sessionId, path });
}

// Subscribe to resume-progress events (ADR-0034/0059 visible progress, issue
// #76). Each event carries the addressing sessionId so a multi-session frontend
// filters the global broadcast; a single-session shell reads `.event` directly.
export async function onResumeProgress(
  cb: (ev: ResumeProgress) => void,
): Promise<UnlistenFn> {
  return listen<ResumeProgress>("resume-progress", (e) => cb(e.payload));
}

// Subscribe to turn-progress events (ADR-0059 discrete phase feedback, issue
// #76). Each event carries the addressing sessionId + a Thinking/Querying
// phase (with the 1-based attempt). The phase never enters the TurnOutcome
// contract; it is observer feedback only.
export async function onTurnProgress(
  cb: (ev: TurnProgress) => void,
): Promise<UnlistenFn> {
  return listen<TurnProgress>("turn-progress", (e) => cb(e.payload));
}

// List every persisted .duck session's metadata for the cold-start sidebar
// (ADR-0060/0061, issue #76). The backend reads recent_files and derives each
// entry from its recipe + mtime (zero new persistence); unreadable paths are
// skipped. session_id is the .duck path -- pass it back to openDuck to resume.
export async function listSessions(): Promise<SessionMetadata[]> {
  return invoke<SessionMetadata[]>("list_sessions");
}

// Delete a persisted .duck file (ADR-0060, issue #81). The frontend closes the
// session first when it is open, then calls this. The backend removes the file
// + drops the path from recent_files; a missing file is idempotent success.
// `path` is the .duck file path (the SessionMetadata.session_id from listSessions).
export async function deleteSession(path: string): Promise<void> {
  await invoke<void>("delete_session", { path });
}

// Rename the OPEN session bound to `sessionId` (ADR-0060, issue #81). Sets the
// recipe header name and rewrites the bound .duck; the bound path is untouched.
// For a never-saved session the name is held in memory until save-as.
export async function renameSession(
  sessionId: string,
  newName: string,
): Promise<string> {
  return invoke<string>("rename_session", { sessionId, newName });
}

// Rename a CLOSED .duck recipe's session_name in place (ADR-0060, issue #81).
// `path` is the .duck file path (SessionMetadata.session_id). The backend reads
// the recipe, rewrites the header, atomic-saves -- no DuckDB instance is built.
// Refuses a path currently held open (rename those via renameSession by id).
export async function renamePersistedSession(
  path: string,
  newName: string,
): Promise<void> {
  await invoke<void>("rename_persisted_session", { path, newName });
}

// Read + clear the named session's most recent per-turn persistence failure
// (ADR-0034/0035 honest signal). Returns the typed SaveError (issue #120) so
// the banner renders the failure kind via the locale catalog instead of
// matching a backend Display string; null after a clean save.
export async function takePersistError(sessionId: string): Promise<SaveError | null> {
  return invoke<SaveError | null>("take_persist_error", { sessionId });
}

// --- App-level config (issue #53, ADR-0038) --------------------------------
//
// Session-AGNOSTIC (ADR-0056): no sessionId.

export async function getAppConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("get_app_config");
}

export async function setAppConfig(config: AppConfig): Promise<AppConfig> {
  return invoke<AppConfig>("set_app_config", { config });
}

export async function recordRecentFile(path: string): Promise<void> {
  await invoke<void>("record_recent_file", { path });
}
