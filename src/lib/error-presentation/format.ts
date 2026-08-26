// The locale-catalog formatting core (ADR-0069). fmtError renders an unknown
// IPC reject to a readable string; errorDetail extracts the technical-detail
// fold. The 7 sub-formatters + 4 detail extractors are private to this file;
// only fmtError + errorDetail are re-exported via index.ts. Moved verbatim from
// api.ts (issue #225 slice 1) -- each formatMessage call site carries a literal
// id + defaultMessage so @formatjs/cli extract recovers it for the catalog
// guard (ADR-0052). ADR-0029 holds: the primary message never embeds the raw
// detail, and the Rust side is audited to keep secrets out of these payloads.

import type { IntlShape } from "react-intl";
import type {
  DuckLoadError,
  MigrationError,
  RemoveSourceError,
  RenameError,
  ResumeError,
  SaveError,
  StoreCommandError,
  RowReadError,
} from "../../types/session";
import type { SkillError, SkillMountError } from "../../types/skills";
import { isSaveError, isSessionError, isSkillError, isStoreCommandError } from "./guards";

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
// and rename_persisted_session. NoActiveProfile is a self-contained refusal
// like OpenConflict (a config-state rejection -- the OS keychain was never
// touched, so it is NOT keychainFailure). The three failure variants render a
// generic message; their English data rides the technical-details fold
// (ADR-0029: no key leaks).
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
    case "DestinationExists":
      return intl.formatMessage({
        id: "error.store.destinationExists",
        defaultMessage: "A folder with this name already exists; choose a different name",
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
    case "NoActiveProfile":
      return intl.formatMessage({
        id: "error.store.noActiveProfile",
        defaultMessage: "No provider profile is active; create or activate one first",
      });
    case "UnknownAdapter":
      return intl.formatMessage({
        id: "error.store.unknownAdapter",
        defaultMessage: "Unknown CLI adapter",
      });
    case "InvalidCliTool":
      return intl.formatMessage({
        id: "error.store.invalidCliTool",
        defaultMessage: "Invalid CLI tool registration",
      });
    default: {
      const unhandled: never = e;
      throw new Error(`unhandled StoreCommandError kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Format a SkillError through the locale catalog (issue #362). NoSuchSkill
// interpolates the skill name; the other variants render a generic message and
// their English data rides the technical-details fold (the reason detail / the
// offending name -- ADR-0029: no secrets cross this path).
function formatSkillError(e: SkillError, intl: IntlShape): string {
  switch (e.kind) {
    case "InvalidName":
      return intl.formatMessage({
        id: "error.skill.invalidName",
        defaultMessage: "Skill name must be kebab-case (lowercase a-z / 0-9 + hyphens) and at most 64 chars",
      });
    case "InvalidSkill":
      return intl.formatMessage({
        id: "error.skill.invalidSkill",
        defaultMessage: "The skill file is missing required fields or a body",
      });
    case "NoSuchSkill":
      return intl.formatMessage(
        {
          id: "error.skill.notFound",
          defaultMessage: "No skill named \"{name}\"",
        },
        { name: e.data },
      );
    case "NameTaken":
      return intl.formatMessage(
        {
          id: "error.skill.nameTaken",
          defaultMessage: "A skill named \"{name}\" already exists",
        },
        { name: e.data },
      );
    case "ReadOnly":
      return intl.formatMessage({
        id: "error.skill.readOnly",
        defaultMessage: "Linked skills are read-only; edit the source instead",
      });
    case "FsFailure":
      return intl.formatMessage({
        id: "error.skill.fsFailure",
        defaultMessage: "A skill file operation failed",
      });
    default: {
      const unhandled: never = e;
      throw new Error(`unhandled SkillError kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Format a RemoveSourceError through the locale catalog (issue #121). NotFound
// shares the merged `error.dataset.notFound` id with RenameError::NotFound and
// RowReadError::UnknownDataset (DRY -- one "dataset not found" message, not three
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

// Format a RowReadError (read_rows failure) through the locale catalog (issue
// #121). UnknownDataset shares the merged `error.dataset.notFound` id; Execute
// renders a generic message and the engine detail rides the technical-details
// fold (the detail is a DuckDB read error, never an API key per ADR-0029).
// Format a SkillMountError (issue #363, ADR-0086), reached via SessionError::
// SkillMount. AlreadyMounted / NotMounted name the offending skill in the
// primary message; both are self-contained (no fold detail).
function formatSkillMountError(e: SkillMountError, intl: IntlShape): string {
  switch (e.kind) {
    case "AlreadyMounted":
      return intl.formatMessage(
        {
          id: "error.skillMount.alreadyMounted",
          defaultMessage: "Skill \"{name}\" is already mounted",
        },
        { name: e.data.name },
      );
    case "NotMounted":
      return intl.formatMessage(
        {
          id: "error.skillMount.notMounted",
          defaultMessage: "Skill \"{name}\" is not mounted",
        },
        { name: e.data.name },
      );
    default: {
      const unhandled: never = e;
      throw new Error(`unhandled SkillMountError kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

function formatRowReadError(e: RowReadError, intl: IntlShape): string {
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
      throw new Error(`unhandled RowReadError kind: ${JSON.stringify(unhandled)}`);
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
        return formatRowReadError(e.data, intl);
      case "SkillMount":
        return formatSkillMountError(e.data, intl);
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
  if (isSkillError(e)) {
    return formatSkillError(e, intl);
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
// io/keychain/config-write/invalid-cli-tool detail -- and null for every
// variant whose message is already self-contained (so the fold is omitted).
// fmtError keeps this detail OUT of the primary message; ADR-0029 holds -- the
// Rust side is audited to keep secrets out of these payloads (the resume /
// save paths are keychain-free) -- so the raw detail is safe to surface.
export function errorDetail(e: unknown): string | null {
  if (isSessionError(e)) {
    if (e.kind === "Engine") return e.data;
    if (e.kind === "Resume") return resumeErrorDetail(e.data);
    if (e.kind === "Turn") return rowReadErrorDetail(e.data);
    return null;
  }
  if (isSaveError(e)) {
    // Every SaveError variant carries a string under data (the detail or the
    // AlreadyOpen path) -- all useful in the fold.
    return e.data;
  }
  if (isStoreCommandError(e)) {
    // The failure variants carry the English technical detail for the fold;
    // OpenConflict / BlankName / NoActiveProfile are self-contained (the
    // message already names the refusal). DestinationExists carries the path,
    // UnknownAdapter the offending adapter id, and InvalidCliTool the backend
    // refusal detail -- the tool name and its remedy ("disable it instead of
    // deleting"), which the generic message cannot carry.
    if (
      e.kind === "DestinationExists" ||
      e.kind === "IoFailure" ||
      e.kind === "KeychainFailure" ||
      e.kind === "ConfigWriteFailure" ||
      e.kind === "UnknownAdapter" ||
      e.kind === "InvalidCliTool"
    ) {
      return e.data;
    }
    return null;
  }
  if (isSkillError(e)) {
    // Every SkillError variant carries a string under data (the reason detail
    // or the offending name) -- all useful in the fold except NoSuchSkill /
    // NameTaken, whose name already rides the message.
    if (e.kind === "NoSuchSkill" || e.kind === "NameTaken") {
      return null;
    }
    return e.data;
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

// Detail for a nested RowReadError (issue #121), reached via SessionError::Turn.
// Execute carries the engine detail for the fold; UnknownDataset's name is
// already in the message, so it carries no fold detail.
function rowReadErrorDetail(e: RowReadError): string | null {
  switch (e.kind) {
    case "Execute":
      return e.data;
    case "UnknownDataset":
      return null;
    default: {
      const unhandled: never = e;
      throw new Error(`unhandled RowReadError kind: ${JSON.stringify(unhandled)}`);
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
