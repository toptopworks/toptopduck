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
  // The Markdown body after the frontmatter -- the prompt fragment.
  body: string;
  // The resolved link target for `linked` skills (the "open source location"
  // anchor); null for `local`.
  link_target: string | null;
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

// The result of a registry scan (issue #373): the spec-valid skills plus the
// directories the scan skipped. Mirrors the Rust SkillListing. `skills` keeps
// the sorted / deduplicated semantics; `ignored` is sorted by directory name
// for a stable listing. The frontend renders the ignored section ONLY when
// `ignored` is non-empty (a clean registry never shows the section).
export interface SkillListing {
  // Spec-valid skills, sorted by name.
  skills: SkillEntry[];
  // Directories the scan skipped, each with the English technical reason.
  // Sorted by directory name. Empty for a clean registry.
  ignored: SkippedSkill[];
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
