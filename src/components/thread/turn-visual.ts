// Turn-domain pure functions extracted from Thread.tsx (issue #427).
// These are stateless transforms that do not depend on React — they map
// TurnRecord / TurnOutcome / stale anchors / skill provenance into the
// primitive values the rail components render.

import type { IntlShape } from "react-intl";
import {
  Ban,
  CircleOff,
  MessageCircleQuestion,
  Table2,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { DatasetDescriptor, StaleAnchor, StaleReason } from "../../types/dataset";
import type { SkillEntry } from "../../types/skills";
import type { ThreadEntry, TurnOutcome, TurnRecord, TurnRuntime } from "../../types/thread";

// A compact label slice for the active-chip match (ADR-0047): the thread only
// needs the names to detect when a question explicitly points at a dataset, so
// the descriptor is narrowed at the call site. Pick keeps the structural tie to
// the single source of truth (DatasetDescriptor) rather than hand-mirroring
// field names that would silently drift on a rename.
export type DatasetLabel = Pick<DatasetDescriptor, "reference_name" | "display_name">;

// The thread's conversation-fact chrome (the ask/settle stamps and the copy
// affordances flanking them) is hover-choreographed: hidden at rest so the
// exchange reads as pure conversation, revealed while its side is hovered or
// holds focus (keyboard parity), always revealed on devices without a hover
// pointer (touch). Opacity only -- layout and the a11y tree are unchanged and
// the reveal stays compositor-cheap. Carried by the `meta-reveal` elements.
export const HOVER_REVEAL_CLASS =
  "opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100";

// The reference name of a Materialized turn's primary result (ADR-0084): the
// promotion chain's tail -- the result the turn's answer references. The stale
// ghost and the result link both key on the primary; antecedent promotions
// (earlier in the chain) are intermediate results. undefined for a
// non-Materialized outcome (or an illegal empty chain).
export function primaryReferenceName(outcome: TurnOutcome): string | undefined {
  if (outcome.kind !== "Materialized") return undefined;
  const { promotions } = outcome.data;
  return promotions[promotions.length - 1]?.dataset.reference_name;
}

// OutcomeTone is the closed union of the three text-* utilities outcomeVisual
// emits. Typing the return field as OutcomeTone (not string) lets the compiler
// enforce the ADR-0047 hue mapping: a typo like "text-primay", or a stray warm
// class on the Textual/Cancelled branch (which ADR-0017 forbids), is a type
// error rather than a silent broken render.
export type OutcomeTone = "text-primary" | "text-muted-foreground" | "text-destructive";

// A turn's outcome mapped to its Lucide glyph + accessible label + color tone
// (ADR-0047/0050 four-outcome visual language, ADR-0052 i18n). A stale
// Materialized turn swaps Table2 for CircleOff (ghost). The label rides the
// icon's aria-label so the outcome kind is conveyed to assistive tech and is
// queryable in tests without relying on color alone. The tone rides the
// outcome-icon span as a Tailwind text-* utility over the ADR-0050 token, so
// the four-way color encoding (A=primary / B=muted / C=destructive / D=muted,
// per ADR-0047) is owned by the component and flips with .dark alongside the
// token -- no [data-outcome] hue hook in styles.css (retired by ADR-0067).
export function outcomeVisual(
  intl: IntlShape,
  outcome: TurnOutcome,
  stale: boolean,
): { Icon: LucideIcon; label: string; tone: OutcomeTone } {
  if (stale && outcome.kind === "Materialized") {
    return {
      Icon: CircleOff,
      label: intl.formatMessage({ id: "thread.outcome.stale", defaultMessage: "Result stale" }),
      // The ghost already dims the whole card via opacity-50 (TurnCard); the
      // CircleOff glyph reads as muted-foreground so the icon and the dimmed
      // card agree on "dead" -- distinct from a fresh Materialized's primary.
      tone: "text-muted-foreground",
    };
  }
  switch (outcome.kind) {
    case "Materialized":
      return {
        Icon: Table2,
        label: intl.formatMessage({
          id: "thread.outcome.materialized",
          defaultMessage: "Result ready",
        }),
        // A materialized round = teal --primary (ADR-0047 A hue).
        tone: "text-primary",
      };
    case "Textual":
      return {
        // ADR-0050 specifies `MessageSquareQuestion` for outcome B, but that
        // glyph is not exported by the currently pinned lucide-react; using
        // `MessageCircleQuestion` is a deliberate DEVIATION from ADR-0050
        // (question-mark semantics preserved). Follow-up: restore
        // MessageSquareQuestion once lucide ships it, OR amend ADR-0050 to make
        // MessageCircleQuestion the canonical glyph. The label still names
        // the sub-kind (Agent vs Clarify vs Refuse) so the split is legible
        // without it.
        Icon: MessageCircleQuestion,
        // B is intentionally neutral (ADR-0047 B!=C; an honest answer /
        // refuse / clarify must NOT read as failure, so no warm tint).
        tone: "text-muted-foreground",
        label:
          outcome.data.text_kind === "Agent"
            ? intl.formatMessage({
                id: "thread.outcome.agent",
                defaultMessage: "Answered",
              })
            : outcome.data.text_kind === "Clarify"
              ? intl.formatMessage({
                  id: "thread.outcome.clarify",
                  defaultMessage: "Needs clarification",
                })
              : intl.formatMessage({
                  id: "thread.outcome.refused",
                  defaultMessage: "Cannot fulfill",
                }),
      };
    case "Failed":
      return {
        Icon: TriangleAlert,
        // C failure round = --destructive (ADR-0047 C hue).
        tone: "text-destructive",
        label: intl.formatMessage({ id: "thread.outcome.failed", defaultMessage: "Failed" }),
      };
    case "Cancelled":
      return {
        Icon: Ban,
        // D cancelled round = weakened grey (ADR-0047 D hue); the card also
        // dims via opacity-60 (TurnCard) per ADR-0028 Why 2.
        tone: "text-muted-foreground",
        label: intl.formatMessage({
          id: "thread.outcome.cancelled",
          defaultMessage: "Cancelled",
        }),
      };
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled turn outcome: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Detect whether a turn's question explicitly names a working-set dataset
// (ADR-0047 conditional active chip). Most turns act implicitly on the prior
// step, so the chip is absent by default; it lights up only when the user typed
// a dataset name, making the chip a signal rather than noise.
// Matches on the display label (what the user sees/types) first, then the
// reference name (for users who know the technical id); the first hit wins.
export function findMentionedDataset(
  question: string,
  labels: ReadonlyArray<DatasetLabel>,
): DatasetLabel | null {
  for (const label of labels) {
    if (question.includes(label.display_name)) return label;
  }
  for (const label of labels) {
    if (question.includes(label.reference_name)) return label;
  }
  return null;
}

// Locate the nearest SourceLifecycleEvent after a turn whose reference_name +
// kind match a stale anchor (ADR-0047 chip-trace). Causality guarantees the
// invalidating event follows the turn; "nearest one" resolves same-source
// repeated lifecycles. No event_id is stored (ADR-0047 YAGNI) -- the match is
// derived from the existing thread. StaleReason is now the invalidating subset
// of SourceLifecycleKind (types/lifecycle.ts), so anchor.reason compares to entry.data.kind
// directly with no conversion function. Returns null when no event follows
// (resume / stale-map inconsistency); the caller renders the chip disabled then.
export function findStaleSourceIdx(
  entries: ThreadEntry[],
  turnIdx: number,
  anchor: StaleAnchor,
): number | null {
  for (let i = turnIdx + 1; i < entries.length; i++) {
    const e = entries[i];
    if (
      e.entry === "Source" &&
      e.data.reference_name === anchor.reference_name &&
      e.data.kind === anchor.reason
    ) {
      return i;
    }
  }
  return null;
}

// Concise verb for the stale causal chip (ADR-0041 honest split, ADR-0052 i18n):
// a Replaced source -> "Source updated" (the SQL still physically runs on the
// new backing; v1 just does not recompute); a Deleted source -> "Upstream
// deleted" (the reference name is gone, truly unavailable). The wording split
// signals whether the user could re-ask to recover the result. Distinct from
// the working-set list's workingSet.staleRow ICU message (a full sentence) --
// the chip is a compact, clickable label.
export function staleChipVerb(intl: IntlShape, reason: StaleReason): string {
  switch (reason) {
    case "Replaced":
      return intl.formatMessage({
        id: "thread.staleChip.replaced",
        defaultMessage: "Source updated",
      });
    case "Deleted":
      return intl.formatMessage({
        id: "thread.staleChip.deleted",
        defaultMessage: "Upstream deleted",
      });
    default: {
      const unhandled: never = reason;
      throw new Error(`unhandled stale reason: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Issue #381 (provenance semantics per issues #700/#702, ADR-0110): the
// skills whose bodies were injected into the turn's prompt -- the activated
// set, either runtime -- whose
// content changed after this turn was recorded. Each provenance skill carries
// its SKILL.md SHA-256 at assembly time; the registry's current
// SkillEntry.content_hash is the same hash recomputed at load. A mismatch
// means the skill was edited after this answer -- the TurnCard surfaces a
// drift badge so a reader can tell the answer may be stale. An empty
// content_hash (v3->v4 migration, no baseline) never trips the check; a name
// the registry no longer carries is the SkillMarker's "no longer exists" case
// (issue #366), not a content drift -- omitted here.
export function selectDriftedSkills(
  record: TurnRecord,
  skillIndex: ReadonlyMap<string, SkillEntry> | undefined,
): string[] {
  return record.provenance.skills
    .filter((s) => {
      if (s.content_hash === "") return false;
      const current = skillIndex?.get(s.name);
      if (!current) return false;
      return current.content_hash !== s.content_hash;
    })
    .map((s) => s.name);
}

// The four positions a lifecycle event can occupy within its run (issue
// #721 run connector). Rendered as data-run on the marker <li>; styles.css
// keys the 1px node-connector segment off the attribute: first/mid connect
// DOWN to the next node, last/single draw nothing.
export type LifecycleRunMark = "first" | "mid" | "last" | "single";

// The maximal runs of consecutive lifecycle events (issue #721): skill and
// source events count as ONE contiguous species (a mixed skill/source stretch
// is one run); a turn ALWAYS breaks the run (turns never enter the line).
// Returns one mark per entry, aligned by index -- null for turns. A run of
// length >=2 connects its adjacent nodes; a lone event keeps its node bare.
// The thread is append-only (ADR-0028/0040), so the marks recompute cheaply
// on each render from the entries alone -- no event carries run state.
export function lifecycleRunMarks(
  entries: readonly ThreadEntry[],
): Array<LifecycleRunMark | null> {
  const marks: Array<LifecycleRunMark | null> = entries.map(() => null);
  let start = -1;
  // Close the open run [start, endExclusive): stamp each member's position.
  const flush = (endExclusive: number) => {
    if (start === -1) return;
    const last = endExclusive - 1;
    for (let i = start; i <= last; i++) {
      marks[i] = start === last ? "single" : i === start ? "first" : i === last ? "last" : "mid";
    }
    start = -1;
  };
  entries.forEach((entry, i) => {
    if (entry.entry === "Turn") flush(i);
    else if (start === -1) start = i;
  });
  flush(entries.length);
  return marks;
}

// ADR-0101: the segment key of a runtime attribution. Adjacent turns
// sharing a key form one runtime segment; the thread renders the badge only
// at a segment's first turn (the "segment-start quieting" rule -- a mixed
// thread stays readable without repeating the marker on every row). Three
// key families: the built-in loop, one per named external adapter, and the
// unrecorded forms -- "external-unrecorded" (an external turn persisted before the
// adapter id existed, rendered as the honest "not recorded" note) and
// "unrecorded" (no attribution at all, the optimistic append / pre-extension
// recording -- never rendered, but it still breaks the segment so the next
// recorded runtime re-announces itself).
function runtimeAttributionKey(runtime: TurnRuntime | null): string {
  if (!runtime) return "unrecorded";
  if (runtime.kind === "built_in") return "built-in";
  return runtime.data.adapter_id == null
    ? "external-unrecorded"
    : `external:${runtime.data.adapter_id}`;
}

// ADR-0101: which thread entries open a runtime segment and carry its badge.
// The gate: badges appear only when the thread holds at least one external
// turn -- a purely built-in thread carries no information (the default
// runtime), and ADR-0101 Decision 4 keeps attribution a "useful when needed"
// affordance, not an always-on label. Behind the gate, every attribution
// CHANGE re-announces (built-in segments included -- in a mixed thread the
// reader must be able to tell who ran which stretch); an unrecorded stretch
// stays silent (no fabrication) but still breaks the segment.
export function runtimeSegmentBadges(
  entries: readonly ThreadEntry[],
): Array<TurnRuntime | null> {
  // One walk of the `provenance.runtime` chain per entry (issue #596): the
  // extracted value feeds the has-external gate, the key derivation, and
  // the badge push alike. `undefined` marks a non-Turn entry -- transparent
  // to segments, no key walk; null marks an unrecorded turn -- no badge,
  // but it still breaks the segment.
  const runtimes: Array<TurnRuntime | null | undefined> = entries.map((e) =>
    e.entry === "Turn" ? (e.data.provenance.runtime ?? null) : undefined,
  );
  if (!runtimes.some((r) => r?.kind === "external")) {
    return entries.map(() => null);
  }
  const out: Array<TurnRuntime | null> = [];
  let prevKey: string | null = null;
  for (const runtime of runtimes) {
    if (runtime === undefined) {
      out.push(null);
      continue;
    }
    const key = runtimeAttributionKey(runtime);
    // Value guard: `runtime != null` is the `key !== "unrecorded"` half it
    // replaces (that key derives from exactly the null case), so the old
    // `?? null` push fallback was unreachable.
    if (runtime != null && key !== prevKey) {
      out.push(runtime);
    } else {
      out.push(null);
    }
    prevKey = key;
  }
  return out;
}
