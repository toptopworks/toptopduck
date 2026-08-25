// Skill registry types (issue #362, ADR-0086). Mirrors the Rust
// crate::skills::model wire shapes. A skill is an Agent Skills spec directory
// `<root>/<name>/SKILL.md`; identity IS the spec `name` (kebab-case, <= 64,
// equals the directory name). `acquired` is loader-derived (linked = symlink /
// junction onto an external source, local = real directory); the frontmatter
// carries the prompt fragment (the body) + optional MCP server references
// (the `metadata.toptopduck_mcp_servers` extension key). The settings page
// edits local skills in full and shows linked skills read-only + "open source
// location".

// Loader-derived link/real-directory posture. Crosses IPC as the bare
// snake_case variant (mirrors the Rust `#[serde(rename_all = "snake_case")]`).
export type SkillAcquired = "linked" | "local";

// One registry skill as it crosses IPC (list_skills + the mutating commands'
// return). Mirrors the Rust SkillEntry. Option fields are `| null` (the
// project's no-skip_serializing_if convention -- None serializes as JSON null,
// same shape as AppConfig.last_dir), NOT optional; Vec fields are `string[]`.
export interface SkillEntry {
  // The spec name -- identity, kebab-case, equals the directory name.
  name: string;
  // The spec description (required, <= 1024 chars).
  description: string;
  // Loader-derived link/real-directory posture.
  acquired: SkillAcquired;
  // The spec license field, when present.
  license: string | null;
  // The spec compatibility field, when present.
  compatibility: string | null;
  // The ids under metadata.toptopduck_mcp_servers (empty when absent).
  mcp_servers: string[];
  // The names under metadata.toptopduck_cli_tools (issue #674, ADR-0108
  // Decision 7; empty when absent). Declarative only -- a reference never
  // configures or enables the tool.
  cli_tools: string[];
  // The Markdown body after the frontmatter -- the prompt fragment.
  body: string;
  // The resolved link target for `linked` skills (the "open source location"
  // anchor); null for `local`.
  link_target: string | null;
  // SHA-256 hex of the WHOLE SKILL.md bytes (frontmatter + body) at the
  // registry scan (ADR-0086, issue #381). The drift anchor the TurnCard
  // compares each turn's SkillProvenance.content_hash against to surface
  // a "modified" drift badge when a skill changed after a recorded turn.
  content_hash: string;
}

// One spec-invalid skill directory the registry scan skipped (issue #373).
// Mirrors the Rust SkippedSkill. `dir` is the directory name (parallel to
// SkillEntry.name); `reason` is the English technical detail rendered verbatim
// -- the locale catalog owns the section title / intro wording, NOT this
// string (ADR-0052 layer 4).
export interface SkippedSkill {
  // The directory name under the skills root (its file_name, not the full
  // OS path).
  dir: string;
  // The English technical reason the directory failed spec validation,
  // rendered verbatim. This is the SkillError Display string, so the value
  // carries the variant prefix (e.g. "invalid skill: frontmatter name `X`
  // does not match its directory name `Y`"; a read failure carries the full
  // OS path, parallel to SkillEntry.link_target).
  reason: string;
}

// The result of a registry scan (issue #373 / #375): the spec-valid skills
// plus the directories the scan skipped, plus a root-level error when the
// skills root itself could not be read. Mirrors the Rust SkillListing.
// `skills` keeps the sorted / deduplicated semantics; `ignored` is sorted by
// directory name for a stable listing. The frontend renders the ignored
// section ONLY when `ignored` is non-empty (a clean registry never shows the
// section). `root_error` is null for the common case (root readable or never
// created); when non-null the settings UI renders it so the user can
// distinguish a locked-out root from a clean registry.
export interface SkillListing {
  // Spec-valid skills, sorted by name.
  skills: SkillEntry[];
  // Directories the scan skipped, each with the English technical reason.
  // Sorted by directory name. Empty for a clean registry.
  ignored: SkippedSkill[];
  // The English technical reason the skills root itself could not be read
  // (issue #375): a permission denial, lock contention, or other IO failure
  // distinct from a never-created registry (null). When non-null, `skills`
  // and `ignored` are both empty.
  root_error: string | null;
}

// The editable payload of update_skill. Addressed by the command's separate
// `name` parameter (the CURRENT directory name); `name` here is the identity to
// WRITE -- equal to the current one for a plain edit, different for a rename.
export interface SkillUpdate {
  name: string;
  description: string;
  // Blank / null removes the key from frontmatter.
  license: string | null;
  compatibility: string | null;
  // Empty removes the metadata.toptopduck_mcp_servers extension key.
  mcp_servers: string[];
  // Empty removes the metadata.toptopduck_cli_tools extension key (issue
  // #674) -- the exact mcp_servers semantics.
  cli_tools: string[];
  // Required non-blank (a skill without a prompt fragment has nothing to
  // inject on mount).
  body: string;
}

// Typed reject for the skills commands (issue #362). Adjacently tagged
// `{ kind, data }` like every other typed IPC error; the kind set is DISJOINT
// from SessionError / SaveError / StoreCommandError so fmtError's dispatch
// stays unambiguous (ADR-0069 invariant). The data string carries the English
// technical detail for the fold; user-facing wording lives in the locale
// catalog (ADR-0052).
export type SkillError =
  | { kind: "InvalidName"; data: string }
  | { kind: "InvalidSkill"; data: string }
  | { kind: "NoSuchSkill"; data: string }
  | { kind: "NameTaken"; data: string }
  | { kind: "ReadOnly"; data: string }
  | { kind: "FsFailure"; data: string };

// Which kind of skill lifecycle mutation produced an event (ADR-0086, issue
// #363). Two-state only: a skill is either Mounted into the session's active
// set or Unmounted from it. A content change is NOT a lifecycle event -- it is
// captured per-turn by each SkillProvenance's content_hash. Mirrors the Rust
// SkillLifecycleKind as a bare variant string.
export type SkillLifecycleKind = "Mount" | "Unmount";

// A skill lifecycle event (ADR-0086, issue #363): first-class timeline slot,
// never a turn. Carries only the spec `name` (the stable identity) -- the
// prompt fragment / MCP references live in the registry and are looked up at
// assembly time, never snapshotted into the timeline. Mirrors the Rust
// SkillLifecycleEvent. The active skill set is folded from the Mount/Unmount
// sequence, never stored as a snapshot.
export interface SkillLifecycleEvent {
  kind: SkillLifecycleKind;
  // The skill's spec name (kebab-case identity, equal to the directory name).
  name: string;
}

// One skill recorded on a turn's provenance (ADR-0086, issue #363). Mirrors
// the Rust SkillProvenance. `content_hash` is the SHA-256 of the skill's
// SKILL.md bytes at the turn's assembly time, or "" when no baseline exists
// (a v3->v4 migration product -- never trips the stale-degrade check).
export interface SkillProvenance {
  // The skill's spec name (kebab-case identity).
  name: string;
  // SHA-256 of the SKILL.md bytes at assembly time, or "" for migrated turns.
  content_hash: string;
}

// Typed reject for skill mount / unmount (issue #363, ADR-0086). Wraps under
// SessionError.SkillMount (adjacently tagged) so the frontend narrows on
// `data.kind`. Mirrors the Rust SkillMountError.
export type SkillMountError =
  | { kind: "AlreadyMounted"; data: { name: string } }
  | { kind: "NotMounted"; data: { name: string } };

// --- Skill import (issue #367, ADR-0086) -----------------------------------
//
// The import dialog discovers Agent Skills spec directories under external
// agent libraries (Claude Code ~/.claude/skills, Codex CLI ~/.codex/skills,
// + user-added custom paths) and imports each selected skill into the registry
// either as a link (acquired: linked, read-only) or a copy (acquired: local,
// editable). Mirrors the Rust crate::skills::model import wire shapes.

// Import readiness for one discovered skill directory (issue #367). Mirrors
// the Rust DiscoveredSkillStatus as a bare snake_case variant string.
// - importable: spec-valid + the name is free in the registry.
// - already_exists: a skill with this name is in the registry (excluded from
//   import; the registry is never overwritten).
// - invalid: the directory failed spec validation (checkbox disabled + a
//   tooltip carrying the English reason).
export type DiscoveredSkillStatus = "importable" | "already_exists" | "invalid";

// One skill directory found under a discovered source, with its import
// readiness (issue #367). Mirrors the Rust DiscoveredSkill. `source_dir` is
// the ONLY anchor that survives a source change between discovery and commit
// -- the backend re-validates + re-checks the registry at import time, so no
// name / status is cached on the wire beyond the preview classification.
export interface DiscoveredSkill {
  // The spec name (= the directory's file_name); kebab-case identity.
  name: string;
  // The spec description, when the frontmatter parsed far enough. Present for
  // importable / already_exists; null for a partial invalid parse.
  description: string | null;
  // Absolute OS path of the skill's source directory (the link / copy source).
  source_dir: string;
  // Import readiness classification.
  status: DiscoveredSkillStatus;
  // English technical reason for `invalid`; null otherwise. Rendered verbatim
  // as the disabled row's tooltip (ADR-0052 layer 4 -- the locale catalog owns
  // the section / hint wording, NOT the per-row reason).
  reason: string | null;
}

// One discovered skill source (issue #367) -- a directory that exists on disk
// and might hold Agent Skills spec directories. The dialog renders the list of
// these (collapsed) and drills into the skills of an expanded one. Mirrors the
// Rust SkillSource.
export interface SkillSource {
  // Stable id (standard sources carry fixed ids "claude-code" / "codex-cli" /
  // "codex-cli-system"; a custom source's id is its path string). The dialog
  // keys expand/collapse state off it.
  id: string;
  // Display label (source name).
  label: string;
  // Absolute OS path of the source directory.
  path: string;
  // Skill directories found under this source, sorted by name. May be empty.
  skills: DiscoveredSkill[];
}

// Import mode for a batch (issue #367). Mirrors the Rust ImportMode as a bare
// snake_case variant string. The dialog's bottom dropdown selects one mode for
// every selected skill.
export type ImportMode = "link" | "copy";

// One item in an import batch (issue #367). Mirrors the Rust ImportItem. The
// absolute source directory alone -- the backend re-validates + re-checks the
// registry at commit time.
export interface ImportItem {
  source_dir: string;
}

// The per-item outcome of an import batch (issue #367). Mirrors the Rust
// ImportOutcome as an adjacently-tagged union. `failed` nests the typed
// SkillError (already adjacently tagged) as its `data`, so the frontend
// reaches the reject detail through `data.kind` + `data.data`.
export type ImportOutcome =
  | { kind: "imported"; data: SkillEntry }
  | { kind: "failed"; data: SkillError };
