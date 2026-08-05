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
