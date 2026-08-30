// Conversation-thread types split from the single-file src/types.ts (issue
// #197). Mirrors the Rust model types. Covers turn outcomes (ADR-0028), the
// provider's textual / viz payloads, and the unified timeline entries (turns +
// source lifecycle events, ADR-0040).

import type { OperationKind } from "./approval";
import type { DatasetDescriptor } from "./dataset";
import type { SourceLifecycleEvent } from "./lifecycle";
import type { SkillLifecycleEvent, SkillProvenance } from "./skills";

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
// longer crosses a free-text reason. Execute / Resource / InvalidConfig carry a
// technical `detail` for the collapsed fold (audited to carry no API key,
// ADR-0029); StaleReference carries the dead reference name for the locale
// template.
export type TurnFailure =
  | { kind: "Execute"; data: { detail: string } }
  | { kind: "Resource"; data: { detail: string } }
  | { kind: "NotWired" }
  | { kind: "InvalidConfig"; data: { detail: string } }
  | { kind: "StaleReference"; data: { reference_name: string } };

// One turn outcome (ADR-0028). Mirrors the Rust TurnOutcome (serde adjacently-
// tagged: kind + data). The four kinds are exhaustive: a turn always produces
// exactly one, regardless of whether it materialized a result. Only Materialized
// advances result_N; the others occupy a thread slot but consume no number.
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
      // The provider optional assumption note (ADR-0009), surfaced as a side
      // note the user can correct; null when the provider offered none.
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
  | { kind: "Cancelled" };

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
// it, ADR-0036) while a failed call carries its bounded error / denial
// message -- the cross-turn failure retrospection anchor.
export interface TraceEntry {
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
  // Bounded excerpt of a FAILED call's result; empty for a successful call.
  result_excerpt: string;
}

// The runtime that drove one turn (ADR-0101): the app's built-in loop, or an
// external CLI adapter named by its stable id. Mirrors the Rust TurnRuntime
// (adjacently-tagged kind + data, snake_case -- the same tagging scheme as
// SessionRuntimeChoice; the external payload differs: the adapter-id object
// with null for pre-id turns, vs the choice's bare adapter string). The
// thread renders it as a per-segment attribution badge; the LLM window
// never reads it (ADR-0101 Decision 3).
export type TurnRuntime =
  | { kind: "built_in" }
  | { kind: "external"; data: { adapter_id: string | null } };

// Per-turn provenance crossing IPC (issue #381, ADR-0101; issues
// #700/#702, ADR-0110): the skills whose bodies were actually injected into
// the turn's prompt -- the ACTIVATED set for every runtime (mounting injects
// metadata only; ADR-0110 Decision 5; both injection surfaces render
// disclosure). Each carries its
// content_hash so the TurnCard can drift-compare against the registry's
// current SkillEntry.content_hash and surface a "modified" drift badge when a
// skill changed after a recorded turn, plus the turn's executing runtime.
// Mirrors the Rust crate::model::TurnProvenance; `runtime` is omitted when
// absent (the optimistic append, or a pre-extension IPC peer) -- rendered
// without a badge, distinct from external-with-null-id ("recorded, adapter
// unknown").
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
  // registry (the activated set, either runtime -- see TurnProvenance
  // above). Empty `skills` for turns
  // that injected no skill body and for v3->v4 migrated turns (no baseline --
  // never trips the drift check).
  provenance: TurnProvenance;
  // When the user submitted the question, Unix epoch ms (ADR-0103). Absent
  // for turns recorded before v5 -- rendered without a timestamp, never a
  // synthetic one (honest degrade). The optimistic append stamps the client
  // clock; the backend's own reading lands when a reopened mount reads the
  // thread (no in-place refetch, ADR-0051).
  asked_at?: number;
  // When the turn settled, Unix epoch ms (ADR-0103). Same honest-degrade
  // rule as asked_at.
  settled_at?: number;
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
