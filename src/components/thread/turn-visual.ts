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
import type { SourceLifecycleEvent, SourceLifecycleKind } from "../../types/lifecycle";
import type { SkillEntry, SkillLifecycleKind } from "../../types/skills";
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

// The code-block copy affordance's reveal (issue #746): the same
// choreography as HOVER_REVEAL_CLASS, keyed on the block's own named group
// instead of the turn-card group so only the hovered/focused block's copy
// button reveals (a bare group-hover: would fire for the whole turn).
export const CODE_BLOCK_REVEAL_CLASS =
  "opacity-0 transition-opacity duration-150 group-hover/code-block:opacity-100 group-focus-within/code-block:opacity-100 [@media(hover:none)]:opacity-100";

// The summary row's fold-chevron reveal (issue #826): the same
// choreography as HOVER_REVEAL_CLASS, keyed on the row's own named group
// so only the hovered/focused row reveals its chevron (a bare
// group-hover: would fire for the whole turn). The expanded posture pins
// the chevron visible -- callers append opacity-100, which tailwind-merge
// resolves over the rest-state opacity-0.
export const SUMMARY_ROW_REVEAL_CLASS =
  "opacity-0 transition-opacity duration-150 group-hover/summary-row:opacity-100 group-focus-within/summary-row:opacity-100 [@media(hover:none)]:opacity-100";

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
    case "Textual": {
      // Exhaustiveness guard: a future TextKind member must add a branch
      // here -- the outer switch's never-check cannot see the nested union,
      // and a ternary fallthrough would mislabel the new kind as refused in
      // the glyph's aria-label.
      let label: string;
      switch (outcome.data.text_kind) {
        case "Agent":
          label = intl.formatMessage({ id: "thread.outcome.agent", defaultMessage: "Answered" });
          break;
        case "Clarify":
          label = intl.formatMessage({
            id: "thread.outcome.clarify",
            defaultMessage: "Needs clarification",
          });
          break;
        case "Refuse":
          label = intl.formatMessage({
            id: "thread.outcome.refused",
            defaultMessage: "Cannot fulfill",
          });
          break;
        default: {
          const unhandled: never = outcome.data.text_kind;
          throw new Error(`unhandled textual kind: ${JSON.stringify(unhandled)}`);
        }
      }
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
        label,
      };
    }
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
// the working-set list's stale row: its badge is the short "Stale" chip with
// the full causal sentence on the native tooltip (workingSet.staleRow /
// staleRow.title, issue #793) -- this chip is a compact, clickable label.
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

// Issue #737: the fold threshold -- a maximal same-(species × kind)
// subsegment of at least this many markers renders as ONE collapsed row;
// below it the markers stay scatter rows. Exported so the tests construct
// boundary fixtures from the number itself instead of restating a literal.
export const LIFECYCLE_FOLD_THRESHOLD = 3;

// Issue #737: one collapsed same-kind group, a discriminated union on the
// species so `kind` carries exactly its species' variants (a Source kind on
// a Skill fold is unrepresentable). anchorIdx is the FIRST member's entry
// index -- the thread is append-only (ADR-0028/0040), so the index is a
// stable key for the render-local expand state. memberIdxs carries every
// member for the jump contract (a stale-chip target inside a collapsed group
// expands it first, ADR-0047 exact-event semantics). The two counts are the
// group's aggregated disclosure: invalidatedCount sums the members'
// stale-derivative counts (an Added never invalidates -- its count is
// structurally 0 and it never contributes), and driftCount tallies the
// members whose skill name the registry no longer carries (the SkillMarker
// missing case, issue #366). The expanded combined member row keeps each
// member's individual warning; the fold row carries the aggregate. No name
// list rides the group: expanding renders it (ruled during implementation).
interface LifecycleFoldBase {
  readonly anchorIdx: number;
  readonly memberIdxs: readonly number[];
  readonly invalidatedCount: number;
  readonly driftCount: number;
}
export interface SkillFoldInfo extends LifecycleFoldBase {
  readonly species: "Skill";
  readonly kind: SkillLifecycleKind;
}
export interface SourceFoldInfo extends LifecycleFoldBase {
  readonly species: "Source";
  readonly kind: SourceLifecycleKind;
}
export type LifecycleFoldInfo = SkillFoldInfo | SourceFoldInfo;

// Issue #737: the render-facing visual row model. ONE projection derives
// both consumers -- the <li> sequence Thread renders and the run positions
// lifecycleRunMarks stamps -- so a collapsed row and its connector position
// can never disagree (per-entry marks plus a separate grouping would be two
// parallel segmentations of the same timeline). The four rows:
// - turn: a Turn entry (never enters the connector line).
// - absorbed: an agent activation its turn owns (renders inside the turn,
//   D5 / issue #722 -- the standalone slot renders nothing).
// - marker: a scatter lifecycle row (a subsegment below the fold threshold).
// - fold: a collapsed group rendering as ONE row (the disclosure button);
//   the caller renders the members underneath when expanded.
export type LifecycleVisualRow =
  | { readonly row: "turn"; readonly idx: number }
  | { readonly row: "absorbed"; readonly idx: number }
  | { readonly row: "marker"; readonly idx: number }
  | { readonly row: "fold"; readonly group: LifecycleFoldInfo };

// The aggregation inputs the fold rows disclose (issue #737). Both optional
// and independently omittable: tests pin the grouping algebra without
// registry/stale wiring, exactly as Thread's own props degrade.
export interface LifecycleFoldInputs {
  staleCountsByKey?: ReadonlyMap<string, number>;
  skillIndex?: ReadonlyMap<string, SkillEntry>;
}

// The stale-derivative count key (issues #40/#41, ADR-0047 no-event_id
// attribution): one template in one place so every producer and consumer
// (the stale map's fill in Thread, the fold aggregation in buildFoldGroup,
// the scatter suffix in Thread, the expanded member row in LifecycleFold)
// can never drift apart silently on a format change.
export function staleKey(
  referenceName: string,
  kind: SourceLifecycleKind,
): string {
  return `${referenceName}:${kind}`;
}

// The stale-derivative count of one source event (issues #40/#41): an Added
// never invalidates (structurally 0 -- a stray Added key in the map must not
// leak, pinned by tests); otherwise the (reference_name, kind) count from
// the aggregated stale map, 0 when the map holds no entry. Extracted next to
// staleKey so the three render surfaces (fold aggregation, scatter suffix,
// expanded member suffix) share ONE derivation.
export function staleDerivativeCount(
  event: Pick<SourceLifecycleEvent, "reference_name" | "kind">,
  staleCountsByKey: ReadonlyMap<string, number> | undefined,
): number {
  if (event.kind === "Added") return 0;
  return staleCountsByKey?.get(staleKey(event.reference_name, event.kind)) ?? 0;
}

// A standalone marker's identity for segmentation: the species tag and its
// precise kind variants. Discriminated so narrowing on species narrows
// kind. Turn entries never reach this (the projector handles them first).
type MarkerIdentity =
  | { species: "Skill"; kind: SkillLifecycleKind }
  | { species: "Source"; kind: SourceLifecycleKind };

function markerIdentity(
  entry: Extract<ThreadEntry, { entry: "Skill" | "Source" }>,
): MarkerIdentity {
  return entry.entry === "Skill"
    ? { species: "Skill", kind: entry.data.kind }
    : { species: "Source", kind: entry.data.kind };
}

// Aggregate a fold group's disclosure counts. Kept next to the projector so
// the "which member contributes what" rules live with the segmentation they
// summarize.
function buildFoldGroup(
  entries: readonly ThreadEntry[],
  seg: {
    species: "Skill" | "Source";
    kind: SkillLifecycleKind | SourceLifecycleKind;
    idxs: number[];
  },
  inputs: LifecycleFoldInputs,
): LifecycleFoldInfo {
  let invalidatedCount = 0;
  let driftCount = 0;
  for (const idx of seg.idxs) {
    const entry = entries[idx];
    if (entry.entry === "Source") {
      // An Added contributes 0 (never invalidates); Replaced/Deleted members
      // contribute their (reference_name, reason) counts, summed so the fold
      // row carries the group total.
      invalidatedCount += staleDerivativeCount(entry.data, inputs.staleCountsByKey);
    } else if (
      entry.entry === "Skill" &&
      // Three-way lookup mirroring SkillMarker: only a WIRED registry that
      // lacks the name counts as drift -- an unwired caller opted out.
      inputs.skillIndex !== undefined &&
      !inputs.skillIndex.has(entry.data.name)
    ) {
      driftCount += 1;
    }
  }
  const base = {
    anchorIdx: seg.idxs[0],
    memberIdxs: seg.idxs,
    invalidatedCount,
    driftCount,
  };
  // Re-derive the species-precise kind from the anchor entry (the segment
  // tracker keeps the loose union for the equality checks above); the guard
  // enforces the projector's own invariant -- a segment opens only at a
  // marker.
  const anchor = entries[base.anchorIdx];
  if (anchor.entry !== "Skill" && anchor.entry !== "Source") {
    throw new Error("fold segment must open at a marker entry");
  }
  const head = markerIdentity(anchor);
  if (head.species === "Skill") return { species: "Skill", kind: head.kind, ...base };
  return { species: "Source", kind: head.kind, ...base };
}

// Issue #737: project the timeline entries into the visual row model --
// maximal same-(species × kind) subsegments fold into one row at
// LIFECYCLE_FOLD_THRESHOLD or more, everything below stays scatter. The
// breakpoints are the ones lifecycleRunMarks has always flushed on (issues
// #721/#722): a Turn ALWAYS breaks, and so does an agent activation its turn
// absorbed (it renders inside the turn, not on the line). The thread is
// append-only (ADR-0028/0040), so the projection recomputes cheaply on each
// render from the entries alone -- no event carries fold state.
export function lifecycleVisualRows(
  entries: readonly ThreadEntry[],
  owned: readonly ActivationOwner[] = [],
  inputs: LifecycleFoldInputs = {},
): LifecycleVisualRow[] {
  const rows: LifecycleVisualRow[] = [];
  // The open same-(species × kind) subsegment; null between subsegments.
  let seg: {
    species: "Skill" | "Source";
    kind: SkillLifecycleKind | SourceLifecycleKind;
    idxs: number[];
  } | null = null;
  // Close the open subsegment: at threshold it folds into one row, below it
  // the members emit scatter marker rows.
  const flush = () => {
    if (seg === null) return;
    if (seg.idxs.length >= LIFECYCLE_FOLD_THRESHOLD) {
      rows.push({ row: "fold", group: buildFoldGroup(entries, seg, inputs) });
    } else {
      for (const idx of seg.idxs) rows.push({ row: "marker", idx });
    }
    seg = null;
  };
  entries.forEach((entry, i) => {
    if (entry.entry === "Turn" || owned[i] != null) {
      flush();
      rows.push(entry.entry === "Turn" ? { row: "turn", idx: i } : { row: "absorbed", idx: i });
      return;
    }
    // A standalone marker (a source event, or a skill event no turn owns):
    // extend the open subsegment when species AND kind match, else close it.
    const id = markerIdentity(entry);
    if (seg !== null && seg.species === id.species && seg.kind === id.kind) {
      seg.idxs.push(i);
    } else {
      flush();
      seg = { species: id.species, kind: id.kind, idxs: [i] };
    }
  });
  flush();
  return rows;
}

// The four positions a lifecycle event can occupy within its run (issue
// #721 run connector). Rendered as data-run on the marker <li>; styles.css
// keys the 1px node-connector segment off the attribute: first/mid connect
// DOWN to the next node, last/single draw nothing.
export type LifecycleRunMark = "first" | "mid" | "last" | "single";

// The maximal runs of consecutive visual rows (issue #721; single-sourced over
// the visual row model by issue #737): skill and source rows count as ONE
// contiguous species (a mixed stretch is one run); a turn ALWAYS breaks the
// run (turns never enter the line), and so does an agent activation absorbed
// into its turn (it renders inside the turn, D5 / issue #722). A collapsed
// fold row participates as its segment's SINGLE node -- the connector the
// group carries is the fold row's, and the expanded combined member row
// draws none (the fold row stays in place as the group's head either way,
// so the segment's line never moves on expand). Returns one mark per visual row, aligned by
// row index -- null for turns and absorbed activations. A run of length >=2
// connects its adjacent nodes; a lone row keeps its node bare. The thread is
// append-only (ADR-0028/0040), so the marks recompute cheaply on each render
// from the projection alone -- no event carries run state.
export function lifecycleRunMarks(
  rows: readonly LifecycleVisualRow[],
): Array<LifecycleRunMark | null> {
  const marks: Array<LifecycleRunMark | null> = rows.map(() => null);
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
  rows.forEach((row, i) => {
    if (row.row === "turn" || row.row === "absorbed") flush(i);
    else if (start === -1) start = i;
  });
  flush(rows.length);
  return marks;
}

// Issue #818: the per-turn runtime attribution gate. The marker opens every
// turn whose provenance names an external adapter; the built-in default and
// both unrecorded shapes -- no provenance at all (a failed ask-time read, an
// old IPC peer) and an external turn persisted before adapter ids existed --
// stay silent: an attribution is only worth rendering when it can name who
// ran the turn, and in a mixed thread an unmarked stretch reads as the
// default runtime. Returns the adapter id to display, null for no marker.
export function runtimeMarkerName(runtime: TurnRuntime | undefined): string | null {
  if (runtime?.kind !== "external") return null;
  return runtime.data.adapter_id;
}

// D5 / issue #722 placement: an actor=Agent skill event happened INSIDE the
// turn that settles after it (the backend inserts the event at occurrence and
// the Turn entry at settle, and the agent only acts within a turn), so the
// entry's next Turn is its owning turn. Returns one owning-turn index per
// entry (agent activations with a settled turn ahead), null everywhere else
// -- the thread renders those markers at the head of the owning turn's
// assistant side instead of as standalone timeline rows. An in-flight turn's
// activation has no Turn entry yet (the Turn lands at settle): while a turn
// runs it falls to the live exchange ("live"), which the settle swap then
// replaces with the appended Turn's index -- same head slot, same order.
// null is the honest degrade: no turn ahead and none running, the event
// stays a standalone top-level row (the resume inconsistency edge).
export type ActivationOwner = number | "live" | null;

export function agentActivationOwner(
  entries: readonly ThreadEntry[],
  hasLiveTurn = false,
): ActivationOwner[] {
  const owners: ActivationOwner[] = entries.map(() => null);
  let nextTurn = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.entry === "Turn") {
      nextTurn = i;
      continue;
    }
    // The kind guard mirrors SkillMarker's tooltip disclosure: the wire
    // contract says the actor is present IFF Activate, and a
    // contract-violating event (a hand-edited recipe stamping the agent
    // actor on a Mount) stays a standalone row instead of being absorbed
    // into a turn it did not happen inside.
    if (
      entry.entry === "Skill" &&
      entry.data.kind === "Activate" &&
      entry.data.actor === "Agent"
    ) {
      if (nextTurn !== -1) owners[i] = nextTurn;
      else if (hasLiveTurn) owners[i] = "live";
    }
  }
  return owners;
}
