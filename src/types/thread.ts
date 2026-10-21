// Conversation-thread types split from the single-file src/types.ts (issue
// #197). Mirrors the Rust model types. Covers turn outcomes (ADR-0028), the
// provider's textual / viz payloads, and the unified timeline entries (turns +
// source lifecycle events, ADR-0040).

import type { OperationKind } from "./approval";
import type { DatasetDescriptor } from "./dataset";
import type { SourceLifecycleEvent } from "./lifecycle";
import type { SkillLifecycleEvent, SkillLifecycleActor, SkillProvenance } from "./skills";

// Which kind of textual response a turn produced (ADR-0009 textual branch,
// evolved by ADR-0077/0081): a plain agent answer (the tool-calling
// contract's terminal text -- an honest answer, a clarification, and a
// default-skillset boundary refusal (ADR-0079) all ride this kind), or -- on
// legacy single-SQL data only -- an explicit disambiguation question
// (ADR-0018) / out-of-scope refusal (ADR-0017). Mirrors the Rust TextKind (a
// bare variant string).
export type TextKind = "Agent" | "Clarify" | "Refuse";

// v1 chart whitelist (ADR-0016). Mirrors the Rust ChartKind (serde
// rename_all="lowercase" -> a bare lowercase variant string). The closed set a
// provider viz may target; anything outside is not a ChartKind -- the Rust enum
// rejects it at the contract boundary, and a spec that draws a non-whitelisted
// chart degrades to a table in the frontend (ADR-0033).
export type ChartKind = "table" | "bar" | "line" | "scatter" | "area" | "pie";

// A provider-emitted viz spec (ADR-0016/0033, issue #26): chart kind from the
// v1 whitelist plus the Vega-Lite JSON that renders it. Mirrors the Rust
// VizSpec. The frontend renders `spec` via Vega-Embed, or degrades to the
// table with a disclosure when the spec is malformed or fails to render.
export interface VizSpec {
  kind: ChartKind;
  // Vega-Lite JSON spec string (carried verbatim across IPC; parsed + rendered
  // in the frontend).
  spec: string;
}

// Why a turn failed (ADR-0028 outcome C, issue #125). Mirrors the Rust
// TurnFailure (serde adjacently-tagged, nested under TurnOutcome::Failed.data).
// The frontend narrows on `kind` to render a locale message -- the backend no
// longer crosses a free-text reason. Execute / Runtime / Resource /
// InvalidConfig carry a technical `detail` for the collapsed fold (audited to
// carry no API key, ADR-0029); StaleReference carries the dead reference name
// for the locale template. Runtime (issue #852) is the external-runtime
// wiring / transport failure split out of Execute.
export type TurnFailure =
  | { kind: "Execute"; data: { detail: string } }
  | { kind: "Runtime"; data: { detail: string } }
  | { kind: "Resource"; data: { detail: string } }
  | { kind: "NotWired" }
  | { kind: "InvalidConfig"; data: { detail: string } }
  | { kind: "StaleReference"; data: { reference_name: string } };

// One turn outcome (ADR-0028). Mirrors the Rust TurnOutcome (serde adjacently-
// tagged: kind + data). The four kinds are exhaustive: a turn always produces
// exactly one, regardless of whether it materialized a result. Only Materialized
// advances result_N; the others occupy a thread slot but consume no number.
// Why a turn landed cancelled (#883). "NoProgress" marks a no-progress
// watchdog kill (ADR-0115); null / absence is the manual stop. Mirrors the
// Rust CancelledReason (default serde naming: the variant ident).
export type CancelledReason = "NoProgress";

export type TurnOutcome =
  | {
    kind: "Materialized";
    data: {
      // ADR-0084: the turn's promotions in promotion order (one or more). The
      // chain tail is the primary result the answer references -- a derived
      // property, never a separate field. Each promotion carries the result
      // descriptor + the verbatim SQL that produced it. Mirrors the Rust
      // Promotion (nested under TurnOutcome::Materialized).
      promotions: Array<{
        dataset: DatasetDescriptor;
        sql: string;
      }>;
      // The provider's optional viz spec (ADR-0016/0033, issue #26): null when
      // the provider offered no chart (the default table turn). The frontend
      // renders it via Vega-Embed or degrades to the table with a disclosure
      // when the spec is malformed or fails to render.
      viz: VizSpec | null;
      // #847: the agent loop's terminal text -- the turn's prose answer,
      // rendered through the same markdown pipeline as a Textual body. null
      // when the turn converged without terminal text, and on turns persisted
      // before #847. Mirrors the Rust field (#[serde(default)]).
      body: string | null;
      // The provider optional assumption note (ADR-0009), surfaced as a side
      // note the user can correct; null when the provider offered none. No
      // live agent source emits one (#847); reserved for a future provider.
      assumption: string | null;
    };
  }
  | {
    kind: "Textual";
    data: {
      text_kind: TextKind;
      body: string;
      assumption: string | null;
    };
  }
  | { kind: "Failed"; data: TurnFailure }
  // Outcome D (#883): the optional cancel reason, named to mirror the Rust
  // CancelledReason (default serde naming: the variant ident). "NoProgress"
  // marks a watchdog kill (ADR-0115); null is a manual stop. Null, not
  // absent: the live wire always carries the data key; the Rust
  // newtype-over-Option additionally accepts the key-less pre-#883 recorded
  // shape as null.
  | { kind: "Cancelled"; data: CancelledReason | null };

// A round's persisted thinking block (ADR-0103): how long the model
// reasoned plus its raw reasoning text. Mirrors the Rust ThinkingTrace.
// Plain data shared verbatim by the display round and the persisted round
// (no lossy projection between them); the text carries no length cap --
// cost governance is the posture thought-level entry's concern
// (ADR-0095/0100), not the trace's.
export interface ThinkingTrace {
  duration_ms: number;
  text: string;
}

// One round of a turn's execution trace (ADR-0103, calibrating ADR-0078):
// the thinking + connective prose + tool-call batch of ONE provider
// round-trip. Mirrors the Rust TraceRound. Optional members are absent
// (never empty placeholders) when the runtime offered no source: no
// thinking block, or a reply with tool calls and no prose. A pre-v5 turn's
// migrated flat trace is a single round carrying only its calls.
export interface TraceRound {
  thinking?: ThinkingTrace;
  text?: string;
  calls: TraceEntry[];
}

// The display form of one execution-trace entry (ADR-0078, issue #297): a
// completed tool call as the rail's expanded trace + the in-flight
// turn-progress stream render it. Mirrors the Rust TraceEntryView (flat
// snake_case fields; operation_kind reuses the approval gateway's enum).
// Field-for-field the persisted recipe form, so a live turn, its recorded
// TurnRecord.trace, and its resumed reincarnation all render identically:
// a successful call's result payload is dropped (the .duck carries none of
// it, ADR-0036; the capped delegation report's truncation notice excepted,
// issue #1047) while a failed call carries its bounded error / denial
// message -- the cross-turn failure retrospection anchor.
export interface TraceEntry {
  // The call's id, present ONLY on a live delegation's completion
  // (ADR-0135 Decision 2): the routing fact that pairs the completion with
  // its started row. Never lands on the recorded trace or the recipe --
  // absent everywhere the persisted wire carries the entry.
  id?: string;
  // Tool name -- a built-in (explore / materialize / describe / sample) or an
  // external MCP server's tool name.
  name: string;
  // Operation badge (ADR-0083) -- presentation only.
  operation_kind: OperationKind;
  // Short argument summary (the SQL or reference_name), NOT the full args.
  summary: string;
  // Whether the call succeeded. An approval denial records success: false
  // with the denial message as the excerpt.
  success: boolean;
  // Bounded excerpt of a FAILED call's result; empty for a successful call
  // -- the capped delegation report's truncation notice excepted
  // (issue #1047).
  result_excerpt: string;
  // The delegation report's FULL text (ADR-0135 Decision 3), present only
  // on a live delegation's completion -- a display-face fact the slim
  // projection does not persist (after resume only the excerpt exists, so
  // the panel honestly degrades). Same absent-when-unset posture as id.
  report?: string;
  // The delegation entry's nested sub-trace (ADR-0117 Decision 6, issue
  // #934): the sub-agent's rounds under the same slim projection the main
  // trace takes. Optional: absent for every ordinary call (serde
  // skip_serializing_if none); the nesting is physically depth 1 (the
  // sub-face excludes every delegation tool), so a nested entry never itself
  // carries one. Rendered in the row's inline sub-trace panel, never as
  // flat rows.
  sub_rounds?: TraceRound[];
}

// The runtime that drove one turn (ADR-0101): the app's built-in loop, or an
// external CLI adapter named by its stable id. Mirrors the Rust TurnRuntime
// (adjacently-tagged kind + data, snake_case -- the same tagging scheme as
// SessionRuntimeChoice; the external payload differs: the adapter-id object
// with null for pre-id turns, vs the choice's bare adapter string). The
// thread renders it as a per-turn attribution marker (issue #818 -- only
// an external turn with a non-null adapter id renders); the LLM window
// never reads it (ADR-0101 Decision 3).
export type TurnRuntime =
  | { kind: "built_in" }
  | {
    kind: "external";
    data: {
      adapter_id: string | null;
      /** The adapter's display name snapshotted at stamp time (issue
         * #1351): the tombstone the attribution label falls back to when the
         * registry no longer resolves the id. Null, not absent -- the live
         * wire always carries the key, same contract as adapter_id. */
      display_name: string | null;
    };
  };

// Per-turn provenance crossing IPC (issue #381, ADR-0101; ADR-0119): the
// skills invoked on the turn -- the invocation records' name set, either
// runtime -- whose content changed after this turn was recorded. Each
// carries its
// content_hash so the TurnCard can drift-compare against the registry's
// current SkillEntry.content_hash and surface a "modified" drift badge when a
// skill changed after a recorded turn, plus the turn's executing runtime.
// Mirrors the Rust crate::model::TurnProvenance; `runtime` is omitted when
// absent (the optimistic append, or a pre-extension IPC peer) -- rendered
// with no marker, silent exactly like external-with-null-id (the two
// shapes differ in data only, issue #818).
export interface TurnProvenance {
  skills: SkillProvenance[];
  runtime?: TurnRuntime;
}

// One conversation-thread entry (ADR-0028/0039): the verbatim user question
// paired with its outcome. Every turn appends exactly one -- always visible.
// Mirrors the Rust TurnRecord; nested under ThreadEntry.Turn.data (see below).
// The trace is the turn's collapsible execution substructure (ADR-0078,
// issue #297; round-grouped per ADR-0103): the rail shows the question +
// outcome always and expands the tool-call chain on demand. Empty for v1-era
// turns and zero-call turns; a pre-v5 turn's migrated flat trace is one
// round of bare calls.
export interface TurnRecord {
  question: string;
  outcome: TurnOutcome;
  trace: TraceRound[];
  // Issue #381: the turn's skill provenance for drift comparison against the
  // registry (the turn's invocation name set since ADR-0119 -- see
  // TurnProvenance above). Empty `skills` for turns
  // that invoked no skill under v7 semantics; turns recorded before v7 keep
  // the legacy activated-subset provenance they were recorded with (hashes
  // included -- the drift check still applies to them).
  provenance: TurnProvenance;
  // The turn's skill invocation records (ADR-0119, #983): each skill invoked
  // this turn -- by the user (submit-time picker materialization) or the
  // agent (the invoke_skill meta-tool) -- with the body pinned at invocation
  // time. Turn input, isomorphic to the question. Absent for turns that
  // invoked no skill and for turns recorded before v7 (the backend skips
  // the field when empty). Consumption rides #984.
  invocations?: SkillInvocation[];
  // When the user submitted the question, Unix epoch ms (ADR-0103). Absent
  // for turns recorded before v5 -- rendered without a timestamp, never a
  // synthetic one (honest degrade). The optimistic append stamps the client
  // clock; the backend's own reading lands with the turn-end refresh, a
  // reopened mount, or another domain's invalidation -- all converge the
  // append onto the recorded row (ADR-0051 / #1088).
  asked_at?: number;
  // When the turn settled, Unix epoch ms (ADR-0103). Same honest-degrade
  // rule as asked_at.
  settled_at?: number;
  // The turn's delivered artifacts (ADR-0124, #1087): the settle-frozen
  // dual-channel manifest — present_files declarations + reply-text scan
  // hits, merged and deduped. Entries carry absolute paths (materialized
  // into the per-session artifacts/ dir when the source lived in the
  // session temp working dir); the first entry is the primary (declared
  // order for a present_files-shaped manifest, first-seen order for a
  // scan-only one). Absent for turns that delivered nothing and turns
  // recorded before the field. Rendering rides #1088; existence is
  // checked at render time, the manifest is never rewritten.
  artifacts?: TurnArtifact[];
  // The turn's token usage (ADR-0129, #1270): the five-field normalized
  // aggregate + the built-in sub-agent subtotals. Absent for fail-closed
  // turns (the channel reported no provider evidence) and turns recorded
  // before the field -- the footer renders nothing for either (honest
  // degrade). Display-only, never enters the LLM window (like trace).
  usage?: TurnUsage;
  // ADR-0130 (issue #1272): the turn's occupancy reading -- its own channel,
  // never folded into `usage`. The composer ring reads the LATEST one.
  occupancy?: OccupancySnapshot;
}

// Five-field normalized token usage (ADR-0129, #1270). Mirrors the Rust
// model::TokenUsage. input_tokens is the total-side input (ordinary +
// cache write + cache read); the two cache counters are breakdown SUBSETS
// of it (never re-added into any total -- the double-count guard the
// normalization contract pins). reasoning_tokens is a subset of
// output_tokens, absent when the upstream does not split it. The grand
// total is derived (input + output), never carried.
export interface TokenUsage {
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;
}

// The turn's context-occupancy reading (ADR-0130, issue #1272): the last
// round-trip's measured context size plus the window it filled -- a
// channel-reported one (ACP usage_update's used/size) or the backend's
// catalog stamp off the serving model (#1290). Occupancy channel,
// never billing evidence -- a reference figure for the composer ring.
// Mirrors the Rust model::OccupancySnapshot; absent for turns with no
// reading and turns recorded before the field (honest hollow).
export interface OccupancySnapshot {
  tokens: number;
  limit?: number | null;
}

// One turn's usage aggregate (ADR-0129, #1270): the turn total plus the
// built-in sub-agent subtotal table. External-runtime turns carry an empty
// table -- attribution falls to the host turn unannotated (Decision 6).
// Mirrors the Rust model::TurnUsage.
export interface TurnUsage {
  total: TokenUsage;
  subagents?: SubagentUsage[];
}

// One named built-in sub-agent's usage subtotal (ADR-0129, #1270). The
// name is the delegation spec's identity -- the one TurnCard's name+ordinal
// cursor pairs the subtotal to its row by.
export interface SubagentUsage {
  name: string;
  usage: TokenUsage;
}

// One delivered artifact on a turn's manifest (ADR-0124, #1087). Mirrors
// the Rust model::TurnArtifact. The primary is derived as the first entry
// of the manifest, never a stored flag.
export interface TurnArtifact {
  // Absolute filesystem path, post-materialization.
  path: string;
  // The entry's file name (display + external-open label).
  file_name: string;
  // Whether the path is durable (a materialized copy or a user-directory
  // original); false = a temp path openable until the session closes.
  durable: boolean;
}

// One skill invocation attached to a turn (ADR-0119, #983): the body expanded
// once at the call site, pinned at invocation-time bytes. Mirrors the Rust
// model::SkillInvocation. Consumption rides #984.
export interface SkillInvocation {
  name: string;
  body: string;
  // The one-enum-one-alias mirror (the Rust side reuses
  // model::SkillLifecycleActor for both roles): a future variant added to
  // the shared alias updates every consumer; an inline literal union here
  // would compile silently while the runtime filter in userInvocationNames
  // classed the new actor as non-user.
  actor: SkillLifecycleActor;
  content_hash: string;
}

// One entry of the unified conversation timeline (ADR-0040/0086): a Turn
// (question + outcome), a source lifecycle event, OR a skill lifecycle event.
// Adjacently-tagged (`{entry, data}`) so the frontend narrows on `entry`.
// Mirrors the Rust ThreadEntry; the conversation() command returns
// ThreadEntry[]. Only the Turn variant enters the LLM window -- the backend
// filters source + skill events out before assembly.
export type ThreadEntry =
  | { entry: "Turn"; data: TurnRecord }
  | { entry: "Source"; data: SourceLifecycleEvent }
  | { entry: "Skill"; data: SkillLifecycleEvent };
