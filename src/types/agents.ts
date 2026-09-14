// Agent-definitions registry types (issue #932, ADR-0117). The wire mirrors
// of the Rust `agents::model` types -- one sub-agent assembly description
// per community-format markdown file under `<app_data_dir>/agents` (the
// directory scan is the registry, no sidecar). Crosses IPC via list_agents /
// create_agent / update_agent; delete_agent and set_agent_enabled return the
// updated full AppConfig (the ADR-0109 Decision 9 sync contract).

// Loader-derived source posture (mirrors the skills SkillAcquired triad).
// Crosses IPC as the bare snake_case variant.
export type AgentSource = "user" | "linked" | "builtin";

// One registry agent definition as it crosses IPC (list_agents + the
// mutating commands' return). Mirrors the Rust AgentEntry. Option fields are
// `| null` (the project's no-skip_serializing_if convention), NOT optional.
export interface AgentEntry {
  // The identity -- kebab-case, <= 64 chars, equals the file stem; also the
  // delegation tool name in the turn assembly (#933).
  name: string;
  // The routing description (required, <= 1024 chars) -- embedded in the
  // delegation tool's description for the main agent.
  description: string;
  // The Markdown body after the frontmatter -- the sub-agent's system prompt.
  preamble: string;
  // Loader-derived source posture.
  source: AgentSource;
  // The machine-level single axis: enabled = listed into the built-in
  // runtime's every-turn tool face; disabled = hidden. Lives in the
  // app-config name set, not the entity.
  enabled: boolean;
  // The resolved link target for `linked` definitions; null otherwise.
  link_target: string | null;
  // Backtick-marked skill names in the preamble that ARE registered (the
  // assembly-time binding set).
  skill_refs: string[];
  // Backtick-marked kebab-case words naming NO registered skill: a warning
  // row, not a save blocker.
  dangling_skill_refs: string[];
  // Community-format axes the app rejects and drops at parse time
  // (`tools` / `model`): parsed-then-discarded, surfaced as a warning row.
  dropped_axes: string[];
}

// The rewrite payload for update_agent: the full declaration face. `name` is
// the identity to write -- a different value renames the file.
export interface AgentUpdate {
  name: string;
  description: string;
  preamble: string;
}

// One non-spec definition file the registry scan skipped. Mirrors the Rust
// SkippedAgent. `reason` is the English technical detail rendered verbatim
// (the locale catalog owns the section wording, ADR-0052 layer 4).
export interface SkippedAgent {
  file: string;
  reason: string;
}

// The list_agents return: the spec-valid definitions + the skipped files +
// a root-level error when the registry root itself could not be read.
// Mirrors the Rust AgentListing.
export interface AgentListing {
  agents: AgentEntry[];
  ignored: SkippedAgent[];
  root_error: string | null;
}

// AgentError (already adjacently tagged `{kind, data}` on the wire). The
// `kind` set is disjoint from every other typed error enum so fmtError's
// dispatch stays unambiguous (the SkillError lane's contract): every shape
// SkillError also uses (invalid name / taken / name-locked / undeletable /
// read-only / fs) carries an Agent-prefixed wire name.
export type AgentError =
  | { kind: "InvalidAgentName"; data: string }
  | { kind: "InvalidAgent"; data: string }
  | { kind: "NoSuchAgent"; data: string }
  | { kind: "AgentNameTaken"; data: string }
  | { kind: "ReservedAgentName"; data: string }
  | { kind: "AgentBuiltinNameLocked"; data: string }
  | { kind: "AgentBuiltinUndeletable"; data: string }
  | { kind: "AgentReadOnly"; data: string }
  | { kind: "AgentFsFailure"; data: string };
