// Conversation-thread types split from the single-file src/types.ts (issue
// #197). Mirrors the Rust model types. Covers turn outcomes (ADR-0028), the
// provider's textual / viz payloads, and the unified timeline entries (turns +
// source lifecycle events, ADR-0040).

import type { DatasetDescriptor } from "./dataset";
import type { SourceLifecycleEvent } from "./lifecycle";

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

// One conversation-thread entry (ADR-0028/0039): the verbatim user question
// paired with its outcome. Every turn appends exactly one -- always visible.
// Mirrors the Rust TurnRecord; nested under ThreadEntry.Turn.data (see below).
export interface TurnRecord {
  question: string;
  outcome: TurnOutcome;
}

// One entry of the unified conversation timeline (ADR-0040): a Turn (question +
// outcome) OR a source lifecycle event. Adjacently-tagged (`{entry, data}`) so
// the frontend narrows on `entry`. Mirrors the Rust ThreadEntry; the
// conversation() command returns ThreadEntry[]. Only the Turn variant enters the
// LLM window -- the backend filters source events out before assembly.
export type ThreadEntry =
  | { entry: "Turn"; data: TurnRecord }
  | { entry: "Source"; data: SourceLifecycleEvent };
