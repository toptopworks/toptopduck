// Skill registry types (issue #362, ADR-0086). Mirrors the Rust
// crate::skills::model wire shapes. A skill is an Agent Skills spec directory
// `<root>/<name>/SKILL.md`; identity IS the spec `name` (kebab-case, <= 64,
// equals the directory name). `acquired` is loader-derived (linked = symlink /
// junction onto an external source, local = real directory); the file carries
// the prompt fragment (the body after the frontmatter). The settings page is
// row-level governance (list / enablement / delete); creation rides the
// model-face create_skill meta-tool and edits happen in the external editor
// the detail dialog's path bar opens (issue #1033).

// Loader-derived link/real-directory posture. Crosses IPC as the bare
// snake_case variant (mirrors the Rust `#[serde(rename_all = "snake_case")]`).
export type SkillAcquired = "linked" | "local" | "builtin";

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
  // The Markdown body after the frontmatter -- the prompt fragment.
  body: string;
  // The resolved link target for `linked` skills (the detail dialog's open
  // anchor); the reserved-subtree directory for `builtin` rows; null for
  // `local`.
  link_target: string | null;
  // The enablement axis read (issue #961, ADR-0118 Decision 2): enabled =
  // in the new-session seed's reach; disabled = dormant (grayed row, the
  // directory kept). Default-on polarity -- the backend overlays the
  // app-config disabled-name set before the rows cross IPC.
  enabled: boolean;
  // SHA-256 hex of the WHOLE SKILL.md bytes (frontmatter + body) at the
  // registry scan (ADR-0086, issue #381). The drift anchor the TurnCard
  // compares each turn's SkillProvenance.content_hash against to surface
  // a "modified" drift badge when a skill changed after a recorded turn.
  content_hash: string;
  // A local or linked row whose name sits in the builtin manifest
  // (ADR-0121 Decision 5): the row SHADOWS a builtin skill (when the
  // builtin is materialized, listing, invocation, and auto-include all
  // resolve to this row), and the settings row
  // renders the "covers built-in" badge -- the standing reminder that the
  // app-side curation is invisible to this fork until it is deleted.
  // Always false for builtin rows themselves.
  covers_builtin: boolean;
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
  | { kind: "ReservedSkillName"; data: string }
  | { kind: "BuiltinReadOnly"; data: string }
  | { kind: "BuiltinUndeletable"; data: string }
  | { kind: "ReadOnly"; data: string }
  | { kind: "FsFailure"; data: string };

// Which kind of skill lifecycle mutation produced an event (ADR-0086, issue
// #363; ADR-0110, issue #698). Straight-line machine of three transitions --
// Mount, Activate, Unmount -- with unmount as the sole exit: Mounted into the
// session's mounted (discoverable) set, optionally Activated from it into the
// persistent activated subset (activated set ⊆ mounted set), and Unmounted
// out of both in one cascade. A
// content change is NOT a lifecycle event -- it is captured per-turn by each
// SkillProvenance's content_hash. Mirrors the Rust SkillLifecycleKind as a
// bare variant string.
export type SkillLifecycleKind = "Mount" | "Unmount" | "Activate";

// Who initiated a skill action: pre-v7 lifecycle events (ADR-0110 Decision 4
// -- mount / unmount user-only, activation either actor) and v7 invocation
// records (the user actor is the submit-time picker materialization, the
// agent actor is the invoke_skill meta-tool) share the one union. Mirrors
// the Rust SkillLifecycleActor as a bare variant string.
export type SkillLifecycleActor = "User" | "Agent";

// A skill lifecycle event (ADR-0086, issue #363; ADR-0110, issue #698):
// first-class timeline slot, never a turn. Carries only the spec `name`
// (the stable identity) plus, for an Activate, the initiation actor -- the
// prompt fragment lives in the registry and is looked up at
// assembly time, never snapshotted into the timeline. Mirrors the Rust
// SkillLifecycleEvent. The mounted and activated sets are folded from the
// event sequence, never stored as snapshots.
export interface SkillLifecycleEvent {
  kind: SkillLifecycleKind;
  // The skill's spec name (kebab-case identity, equal to the directory name).
  name: string;
  // The initiation actor, present IFF kind is "Activate" (mount / unmount
  // are user-only by definition). `| null` per the project's no-skip
  // convention -- the backend serializes None as JSON null.
  actor: SkillLifecycleActor | null;
}

// One skill recorded on a turn's provenance (ADR-0086, issue #363). Mirrors
// the Rust SkillProvenance. `content_hash` is the SHA-256 of the skill's
// SKILL.md bytes at the name's LAST invocation of the turn, or "" when no
// baseline exists (a v3->v4 migration product, or the file unreadable at
// invocation -- never trips the stale-degrade check).
export interface SkillProvenance {
  // The skill's spec name (kebab-case identity).
  name: string;
  // SHA-256 at the name's last invocation of the turn, or "" for migrated
  // turns or an unreadable file.
  content_hash: string;
}

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
