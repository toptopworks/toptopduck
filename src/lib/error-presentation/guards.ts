// Type guards that narrow an unknown IPC reject to its typed shape (ADR-0069).
// Pure narrowing -- no intl, no message rendering. Each guard is private to the
// error-presentation module; the public surface is the format / app-error
// functions in index.ts. Moved verbatim from api.ts (issue #225 slice 1); the
// defensive L1 shape (verify a variant's `data` before promising it) is
// preserved so fmtError / errorDetail never read an unverified field.

import type {
  DuckLoadError,
  MigrationError,
  RemoveSourceError,
  RenameError,
  ResumeError,
  SaveError,
  SessionError,
  StoreCommandError,
  RowReadError,
} from "../../types/session";
import type { SkillError, SkillMountError } from "../../types/skills";

// Narrow an unknown IPC reject to a SessionError (issue #119). A session-
// scoped command rejects with the adjacently-tagged `{ kind, data? }` shape;
// anything else (a raw string, a JS Error, an opaque object) is left to
// fmtError's fallback path. The Engine variant additionally requires its
// `data` to be a string: a malformed `{ kind: "Engine" }` (missing/non-string
// data) is NOT treated as a SessionError, so the guard never narrows `e` to a
// shape whose `data` it has not actually verified (review L1).
export function isSessionError(e: unknown): e is SessionError {
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
      return isRowReadError((e as { data?: unknown }).data);
    case "SkillMount":
      return isSkillMountError((e as { data?: unknown }).data);
    case "Engine":
      return typeof (e as { data?: unknown }).data === "string";
    default:
      return false;
  }
}

// Narrow an unknown IPC reject to a SkillMountError (issue #363). Rides
// SessionError.SkillMount -- the typed refuse for mount_skill / unmount_skill.
// Defensive L1 shape: verify data.kind + data.data.name before promising the
// shape, so fmtError / errorDetail never read an unverified field.
export function isSkillMountError(e: unknown): e is SkillMountError {
  if (typeof e !== "object" || e === null) return false;
  const kind = (e as { kind?: unknown }).kind;
  switch (kind) {
    case "AlreadyMounted":
    case "NotMounted": {
      const d = (e as { data?: unknown }).data;
      return (
        typeof d === "object" &&
        d !== null &&
        typeof (d as { name?: unknown }).name === "string"
      );
    }
    default:
      return false;
  }
}

// Narrow an unknown value to a MigrationError (issue #120). Rides
// DuckLoadError::Migration inside ResumeError::Load. Same L1 defensive shape
// as isSessionError: a variant's `data` is verified before the guard promises
// it, so fmtError / errorDetail never read an unverified field.
export function isMigrationError(e: unknown): e is MigrationError {
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
export function isDuckLoadError(e: unknown): e is DuckLoadError {
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
export function isResumeError(e: unknown): e is ResumeError {
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
export function isSaveError(e: unknown): e is SaveError {
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
export function isStoreCommandError(e: unknown): e is StoreCommandError {
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
    case "DestinationExists":
    case "IoFailure":
    case "KeychainFailure":
    case "ConfigWriteFailure":
    case "UnknownAdapter":
      return typeof (e as { data?: unknown }).data === "string";
    case "NoActiveProfile":
      return true;
    default:
      return false;
  }
}

// Narrow an unknown value to a RemoveSourceError (issue #121). Reached via
// isSessionError's RemoveSource branch (remove_source / remove_active_source
// rejects). IsActive carries a struct; the newtype variants carry a string.
// Same L1 defensive shape as the other guards: a variant's data is verified
// before the guard promises it.
export function isRemoveSourceError(e: unknown): e is RemoveSourceError {
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
export function isRenameError(e: unknown): e is RenameError {
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

// Narrow an unknown value to a RowReadError (issue #121) -- the read_rows error.
// Reached via isSessionError's Turn branch. Both variants carry a string under
// data (the reference name / the engine detail).
export function isRowReadError(e: unknown): e is RowReadError {
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

// Narrow an unknown IPC reject to a SkillError (issue #362). Rejects from the
// skills registry commands (list never refuses; create / update / delete do).
// Every variant carries a string under data (the English technical detail /
// the offending name). Same L1 defensive shape as the other guards: a
// variant's data is verified before the guard promises it. The kind set is
// disjoint from SessionError / SaveError / StoreCommandError, so checking it
// after those three in fmtError is unambiguous (ADR-0069 invariant).
export function isSkillError(e: unknown): e is SkillError {
  if (typeof e !== "object" || e === null) return false;
  const kind = (e as { kind?: unknown }).kind;
  switch (kind) {
    case "InvalidName":
    case "InvalidSkill":
    case "NoSuchSkill":
    case "NameTaken":
    case "ReadOnly":
    case "FsFailure":
      return typeof (e as { data?: unknown }).data === "string";
    default:
      return false;
  }
}
