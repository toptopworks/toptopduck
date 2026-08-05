import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import {
  Ban,
  ChevronRight,
  CircleOff,
  MessageCircleQuestion,
  PencilLine,
  Plug,
  Plus,
  RefreshCw,
  Table2,
  Trash2,
  TriangleAlert,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { LiveTurnCard, TraceRowList } from "./TraceView";
import { ResultPreviewCard } from "./ResultPreviewCard";
import type { LiveTurn } from "../../session/useTurnFlow";
import type { ApprovalResponse } from "../../types/approval";
import type { DatasetDescriptor, StaleAnchor, StaleReason } from "../../types/dataset";
import type { SourceLifecycleEvent, SourceLifecycleKind } from "../../types/lifecycle";
import type {
  SkillEntry,
  SkillLifecycleEvent,
  SkillLifecycleKind,
} from "../../types/skills";
import type { ThreadEntry, TurnOutcome, TurnRecord } from "../../types/thread";
import { formatTurnFailure, turnFailureDetail } from "../../lib/error-presentation";
import { TechnicalDetailsFold } from "../common/TechnicalDetailsFold";

// A compact label slice for the active-chip match (ADR-0047): the thread only
// needs the names to detect when a question explicitly points at a dataset, so
// the descriptor is narrowed at the call site. Pick keeps the structural tie to
// the single source of truth (DatasetDescriptor) rather than hand-mirroring
// field names that would silently drift on a rename.
export type DatasetLabel = Pick<DatasetDescriptor, "reference_name" | "display_name">;

// The reference name of a Materialized turn's primary result (ADR-0084): the
// promotion chain's tail -- the result the turn's answer references. The stale
// ghost and the result link both key on the primary; antecedent promotions
// (earlier in the chain) are intermediate results. undefined for a
// non-Materialized outcome (or an illegal empty chain).
function primaryReferenceName(outcome: TurnOutcome): string | undefined {
  if (outcome.kind !== "Materialized") return undefined;
  const { promotions } = outcome.data;
  return promotions[promotions.length - 1]?.dataset.reference_name;
}

interface ThreadProps {
  /** The unified timeline (ADR-0040): turns interleaved with source lifecycle
   * events, in order. Source events render as non-interactive markers distinct
   * from turns. */
  entries: ThreadEntry[];
  /** The result reference currently shown in the result pane, so its thread
   * entry can be marked active. */
  selectedResult: string | null;
  /** Click a result turn to show its rows in the result pane. Carries only the
   * reference name -- assumption/viz are derived from the thread by the caller
   * (single source of truth, ADR-0051), not carried as a fat snapshot. */
  onSelectResult: (referenceName: string) => void;
  /** Stale result_N anchors keyed by reference name (issue #40/#41,
   * ADR-0013): a Materialized turn whose result is now stale renders as a ghost
   * (CircleOff + reduced opacity) plus a clickable causal chip that jumps to
   * the invalidating source event. The stale flag lives on the live working-set
   * descriptor (a TurnRecord's dataset snapshot is the at-materialization
   * state, always fresh), so the caller derives this map from the current
   * working set and passes it down -- the thread itself holds no state.
   * Optional so call sites that don't exercise stale rendering (tests) can omit
   * it; defaults to an empty map (no ghosts rendered). */
  staleByReference?: ReadonlyMap<string, StaleAnchor>;
  /** Non-stale dataset labels used to detect when a turn's question explicitly
   * names a working-set dataset (ADR-0047 conditional active chip). Most turns
   * act implicitly on the prior step, so the chip is absent by default; it
   * lights up only when the user typed a dataset name. Optional for tests that
   * do not exercise the chip; defaults to empty (no chips rendered). */
  datasetLabels?: ReadonlyArray<DatasetLabel>;
  /** The process-global skill registry keyed by spec name (ADR-0086, issue
   *  #366): a Skill lifecycle marker looks up its name here to surface the
   *  declared MCP server ids in its tooltip AND to detect a name the registry
   *  no longer carries (resume honest-degrade -- a skill deleted / renamed /
   *  uninstalled external library since the event was recorded). undefined
   *  when the caller does not wire the registry: the marker then renders the
   *  verb + name from the event alone (no MCP tooltip, no missing-skill
   *  warning). The timeline stays readable; the registry only enriches it. */
  skillIndex?: ReadonlyMap<string, SkillEntry>;
  /** The in-flight turn's live trace (ADR-0078, issue #297): when non-null the
   * thread renders a progressive turn card at its tail (question + tool-call
   * rows + approval cards). Client UI state only -- the settled turn replaces
   * it with its recorded TurnRecord. Optional for call sites / tests that do
   * not exercise live rendering; defaults to null (no live card). */
  liveTurn?: LiveTurn | null;
  /** Answers a pending approval request (the live card's three buttons,
   * ADR-0083). Wired to the app-level approval hook; defaults to a no-op so
   * tests that render a pending card without the hook do not crash. */
  onRespondApproval?: (requestId: string, response: ApprovalResponse) => void;
}

// The always-visible conversation thread (ADR-0028/0039/0040/0047). The rail
// hosts two visually distinct species: turn cards (single-line verbatim
// question + outcome glyph/color) and source lifecycle markers (thin, full-
// width, non-interactive). A Materialized result that has since gone stale
// renders as a ghost (CircleOff + reduced opacity) whose causal chip jumps to
// the invalidating source event (ADR-0041/0047). Source events are first-class
// in the thread (always visible, occupy a slot) but are NOT turns -- they never
// show a question/outcome and never enter the LLM window.
//
// i18n (ADR-0052): every layer-1 chrome string (headings, outcome/source
// labels, stale chips, active-chip tooltip) routes through react-intl with a
// STATIC literal id + defaultMessage so @formatjs/cli extract can resolve the
// source id set for the CI alignment guard. Layer-4 content (the verbatim
// question, reference names, display names, LLM failure reasons) passes through
// untranslated via ICU placeholders; the assumption note's text is layer-3 LLM
// content and is likewise passed through.
// A frozen no-op so the optional approval handler's default keeps a stable
// reference across renders (the module-level-constant convention the sidebar
// / pane use for their empty defaults).
const NOOP_RESPOND: (requestId: string, response: ApprovalResponse) => void = () => {};

export function Thread({
  entries,
  selectedResult,
  onSelectResult,
  staleByReference = new Map(),
  datasetLabels = [],
  skillIndex,
  liveTurn = null,
  onRespondApproval = NOOP_RESPOND,
}: ThreadProps) {
  const intl = useIntl();
  // The source-event index currently highlighted by a stale-chip jump-select
  // (ADR-0047 chip-trace). Persistent so the user sees which event a stale chip
  // pointed at; a subsequent jump moves it. null when no chip has been clicked.
  const [highlightedSourceIdx, setHighlightedSourceIdx] = useState<number | null>(null);
  // One ref per source-event <li> so a chip jump can scrollIntoView the match.
  // The thread is append-only (ADR-0028/0040) so indices are stable positions.
  // The cleanup nulls the slot so a future break of the append-only invariant
  // (e.g. truncation/reorder) cannot leave a stale ref pointing at the wrong
  // element -- the lookup would hit null instead of the wrong <li>.
  const sourceRefs = useRef<(HTMLLIElement | null)[]>([]);

  // Stale-derivative count per (reference_name, reason), so a Replaced/Deleted
  // source marker can show "失效 N" naming how many results that event killed.
  // No event_id is added (ADR-0047 YAGNI); the count is attributed by matching
  // reference_name + kind, exact for the common single-event case.
  const staleCountsByKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const anchor of staleByReference.values()) {
      const key = `${anchor.reference_name}:${anchor.reason}`;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }, [staleByReference]);

  // Apply a chip jump (ADR-0047): highlight the matched source event and scroll
  // it into view. Only ever called when findStaleSourceIdx already located a
  // target (the chip is disabled otherwise), so targetIdx is a valid index.
  const jumpToSource = useCallback((targetIdx: number) => {
    setHighlightedSourceIdx(targetIdx);
    // Optional-call: jsdom does not implement scrollIntoView, so guard the
    // method itself (a real browser scrolls; tests assert the data-highlighted
    // attribute set on the line above instead).
    sourceRefs.current[targetIdx]?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, []);

  // A session asking its FIRST question has no entries yet but a live turn --
  // the live card must still render, so the empty bail-out needs both empty.
  if (entries.length === 0 && liveTurn === null) return null;
  // ADR-0067 (issue #184): the Thread rail section does not carry a `.panel`
  // hook -- the rail itself (.session-rail in styles.css) supplies bg-card +
  // 0.5rem padding, so a panel chrome here would be redundant. The .thread
  // hook stays as the rail section's anchor (#169).
  return (
    <section
      className="thread"
      aria-label={intl.formatMessage({
        id: "thread.ariaLabel",
        defaultMessage: "Conversation history",
      })}
    >
      <h2 className="m-0 mb-1.5 text-xs text-muted-foreground uppercase tracking-wider">
        <FormattedMessage id="thread.title" defaultMessage="Conversation" />
      </h2>
      <ol className="list-none m-0 p-0">
        {entries.map((entry, i) => {
          if (entry.entry === "Turn") {
            const primaryRef = primaryReferenceName(entry.data.outcome);
            const staleAnchor =
              primaryRef === undefined ? undefined : staleByReference.get(primaryRef);
            // Resolve the chip's jump target up front (ADR-0047): the nearest
            // matching SourceLifecycleEvent after this turn. null when no event
            // follows (resume / stale-map inconsistency) -- the chip then
            // renders disabled rather than promising a jump it cannot perform.
            const jumpTargetIdx =
              staleAnchor === undefined ? null : findStaleSourceIdx(entries, i, staleAnchor);
            return (
              <li
                // The thread is append-only and never reordered (ADR-0028/0039/
                // 0040), so the array index is a stable, unique key for each
                // entry -- no separate id is needed (YAGNI: an id would ripple
                // through the Rust/TS model + wire contract for no present
                // benefit). Switch to a stable monotonic id if entry-local UI
                // state (fold/copy) ever lands.
                key={i}
                className="turn-entry"
                data-outcome={entry.data.outcome.kind.toLowerCase()}
              >
                <TurnCard
                  record={entry.data}
                  selectedResult={selectedResult}
                  onSelectResult={onSelectResult}
                  staleAnchor={staleAnchor}
                  hasJumpTarget={jumpTargetIdx !== null}
                  onStaleChipJump={
                    jumpTargetIdx === null ? undefined : () => jumpToSource(jumpTargetIdx)
                  }
                  mentionedDataset={findMentionedDataset(entry.data.question, datasetLabels)}
                  skillIndex={skillIndex}
                />
              </li>
            );
          }
          // Skill lifecycle events (ADR-0086, issue #366): thin markers
          // isomorphic to source events, a distinct species from a turn (no
          // question, no outcome glyph). Mount = active tone + Plug glyph;
          // Unmount = weakened tone + Unplug glyph; a name the registry no
          // longer carries (resume drift) flips the marker to a destructive
          // warning. The registry lookup is optional -- without skillIndex
          // the marker renders the verb + name from the event alone.
          if (entry.entry === "Skill") {
            return (
              <li
                key={i}
                className="skill-entry"
                data-skill-kind={entry.data.kind.toLowerCase()}
              >
                <SkillMarker event={entry.data} skillIndex={skillIndex} />
              </li>
            );
          }
          const staleCount =
            entry.data.kind === "Added"
              ? 0
              : staleCountsByKey.get(`${entry.data.reference_name}:${entry.data.kind}`) ?? 0;
          return (
            <li
              key={i}
              ref={(el) => {
                sourceRefs.current[i] = el;
                return () => {
                  sourceRefs.current[i] = null;
                };
              }}
              className="source-entry"
              data-source-kind={entry.data.kind.toLowerCase()}
              data-highlighted={highlightedSourceIdx === i ? "true" : undefined}
            >
              <SourceMarker
                event={entry.data}
                staleCount={staleCount}
                highlighted={highlightedSourceIdx === i}
              />
            </li>
          );
        })}
      </ol>
      {/* The in-flight turn's progressive card (ADR-0078, issue #297): trails
          the recorded entries while a turn runs, then folds away as the
          settled TurnRecord appends. A distinct block (not an <li>) -- the
          ol is the recorded timeline (append-only, ADR-0028/0040), the live
          card is transient client state that never enters it. */}
      {liveTurn !== null && (
        <LiveTurnCard liveTurn={liveTurn} onRespondApproval={onRespondApproval} />
      )}
    </section>
  );
}

// Tail-ellipsis truncation (ADR-0054) hover-recovery layer (ADR-0050 maps
// Tooltip to card-truncation full-text recovery, issue #106). The truncated span
// is the Tooltip trigger; the full text rides TooltipContent so a hover recovers
// what the fixed rail width clipped. asChild keeps the trigger span a direct
// flex child (no wrapper node) so the `truncate` utility on the same span owns
// the ellipsis end-to-end. Replaces the v0 native title attribute (which carried
// the same full text but only as the browser's slow, unstyled tooltip). max-w-xs
// caps the popover so a long question wraps instead of stretching the rail-wide
// tooltip.
// `text` is ReactNode so a source marker can append its i18n'd stale suffix
// alongside the verbatim name. Keyboard recovery is a non-goal: the trigger span
// carries no tabIndex, matching the v0 native title (which keyboard users could
// not surface either); the verbatim text also lives in the persisted session for
// non-pointer access.
function TruncatingTooltip({
  text,
  className,
  children,
}: {
  text: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={className}>{children}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{text}</TooltipContent>
    </Tooltip>
  );
}

// A source lifecycle event rendered as a non-interactive timeline marker
// (ADR-0040/0047): distinct species from a turn (no question, no outcome icon).
// Added = Plus (a source entered the working set); Deleted = Trash2 (a source
// left it); Replaced = RefreshCw (a source's backing snapshot was swapped under
// the same reference name, ADR-0025). A Replaced/Deleted marker names how many
// derivatives it invalidated ("失效 N") when that count is non-zero. The marker
// is thin and full-width so the two species read as visually distinct at a
// glance. The display name is layer-4 canonical (ADR-0037) and passes through
// the {name} ICU placeholder untranslated.
//
// ADR-0067 (issue #169): the marker's visual details (bg-muted tint, three-way
// border-left color encoding, jump-select highlight ring) migrated here from
// styles.css's `.thread .source-lifecycle*` rules. The three lifecycle kinds
// each carry a tailwind border-l-* utility over the ADR-0050 token so the kind
// is readable at a glance (Added=primary / Replaced=accent-foreground /
// Deleted=destructive, ADR-0047 source-marker species). The jump-select
// highlight (ADR-0047 chip-trace) lifts bg-accent + ring-2 ring-primary on the
// marker a stale chip points at; the `highlighted` flag is derived by the
// caller from data-highlighted on the wrapping <li>, but the visual lands on
// the marker itself so the highlight owns the whole bar.
function SourceMarker({
  event,
  staleCount,
  highlighted,
}: {
  event: SourceLifecycleEvent;
  staleCount: number;
  highlighted: boolean;
}) {
  const intl = useIntl();
  const { Icon, text } = sourceMarkerText(intl, event.kind, event.display_name);
  // The three-way border-left hue is the kind's identity cue (ADR-0047). Each
  // branch is a literal utility so the Tailwind scanner keeps the class; a
  // computed `border-l-${kind}` string would be tree-shaken away.
  const borderTone =
    event.kind === "Added"
      ? "border-l-primary"
      : event.kind === "Replaced"
        ? "border-l-accent-foreground"
        : "border-l-destructive"; // Deleted (exhaustive over SourceLifecycleKind).
  // The stale suffix (ADR-0047 invalidation disclosure) is i18n'd (ADR-0052)
  // and rides both the visible marker and the hover Tooltip, so a marker
  // truncated by the fixed source-row width still discloses the count on hover.
  // Declared once so the visible copy and the tooltip copy cannot drift apart.
  const staleSuffix =
    staleCount > 0 ? (
      <FormattedMessage
        id="thread.source.staleSuffix"
        defaultMessage=" · invalidated {count}"
        values={{ count: staleCount }}
      />
    ) : null;
  return (
    <p
      className={cn(
        "source-lifecycle flex items-center gap-1 m-0 py-1 px-1.5",
        "text-xs text-muted-foreground border-l-2 rounded-r-md bg-muted",
        // Hook class kept for kind-targeted selectors/tests (.source-lifecycle.added etc.).
        event.kind.toLowerCase(),
        borderTone,
        highlighted && "bg-accent ring-2 ring-primary",
      )}
    >
      <Icon className="source-icon w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <TruncatingTooltip
        text={staleSuffix ? <>{text}{staleSuffix}</> : text}
        className="source-text min-w-0 truncate"
      >
        {text}
        {staleSuffix && <span className="source-stale-count text-destructive">{staleSuffix}</span>}
      </TruncatingTooltip>
    </p>
  );
}

// Lucide glyph + i18n'd text per source lifecycle kind (ADR-0050 glyph mapping,
// ADR-0052 i18n). The verb + display name ride one ICU message so the quoting
// convention (zh 「」 vs en ") follows the locale. Exhaustiveness guard
// mirroring Rust's compile-time match on `SourceLifecycleKind`: a future variant
// must add a branch here. `types/lifecycle.ts` is the hand-maintained mirror of the Rust
// enum, so the TS compiler won't catch a missing branch without this `never`
// check.
function sourceMarkerText(
  intl: IntlShape,
  kind: SourceLifecycleKind,
  name: string,
): { Icon: LucideIcon; text: string } {
  switch (kind) {
    case "Added":
      return {
        Icon: Plus,
        text: intl.formatMessage(
          { id: "thread.source.added", defaultMessage: "Loaded \"{name}\"" },
          { name },
        ),
      };
    case "Deleted":
      return {
        Icon: Trash2,
        text: intl.formatMessage(
          { id: "thread.source.deleted", defaultMessage: "Deleted \"{name}\"" },
          { name },
        ),
      };
    case "Replaced":
      // "Replaced" carries the PRD term (CONTEXT.md / ADR-0025), distinct from
      // Added (a new name) and Deleted (a name gone).
      return {
        Icon: RefreshCw,
        text: intl.formatMessage(
          { id: "thread.source.replaced", defaultMessage: "Replaced \"{name}\"" },
          { name },
        ),
      };
    default: {
      const unhandled: never = kind;
      throw new Error(`unhandled source lifecycle kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

// A skill lifecycle event rendered as a non-interactive timeline marker
// (ADR-0086, issue #366): a sibling species to SourceMarker -- thin, full-
// width, no question / outcome glyph. Mount = active (Plug + border-l-
// primary); Unmount = weakened (Unplug + border-l-muted-foreground). A name
// the registry no longer carries (resume drift: deleted / renamed / external
// library uninstalled since the event was recorded) overrides the kind tone
// to a destructive warning + TriangleAlert glyph + " · no longer exists"
// suffix, so the event stays in the timeline (it happened) but the reader
// sees the skill is gone. When the registry index is not wired by the
// caller, the marker renders the verb + name from the event alone -- no MCP
// tooltip, no missing-skill warning (honest degrade: the timeline is always
// readable, the registry only enriches it).
function SkillMarker({
  event,
  skillIndex,
}: {
  event: SkillLifecycleEvent;
  skillIndex: ReadonlyMap<string, SkillEntry> | undefined;
}) {
  const intl = useIntl();
  // The verb + name come from the event alone -- always present, even when
  // the registry has no entry (the timeline's record is the source of truth,
  // not the current registry state).
  const { Icon, text } = skillMarkerText(intl, event.kind, event.name);
  const skill = skillIndex?.get(event.name);
  // Three-way lookup distinguishes "registry not wired" (honest degrade, no
  // drift signal) from "registry wired but name absent" (drift warning). The
  // missing branch fires only when the caller passed an index AND the name
  // is not in it -- a caller that skips the index opts out of drift detection.
  const missing = skillIndex !== undefined && skill === undefined;
  // Each branch is a literal utility so the Tailwind scanner keeps the class;
  // a computed `border-l-${x}` string would be tree-shaken away. Missing
  // overrides the kind tone (destructive > kind) so drift is unmistakable.
  const borderTone = missing
    ? "border-l-destructive"
    : event.kind === "Mount"
      ? "border-l-primary"
      : "border-l-muted-foreground"; // Unmount (exhaustive over SkillLifecycleKind).
  // The MCP declaration is registry state, not carried by the event.
  // Disclosed only on a Mount whose skill is still carried -- the declaration
  // is operative only while the skill is active; an Unmount's declaration is
  // no longer in force, and a missing skill has no declaration to read.
  // (The `skill` truthiness check covers both "not wired" and "wired but
  // missing" -- either way `skill` is undefined and the guard short-circuits.)
  const mcpServers = event.kind === "Mount" && skill ? skill.mcp_servers : [];
  const missingSuffix = missing ? (
    <FormattedMessage
      id="thread.skill.missingSuffix"
      defaultMessage=" · no longer exists"
    />
  ) : null;
  const mcpDetail = mcpServers.length > 0 ? (
    <FormattedMessage
      id="thread.skill.declaresMcp"
      defaultMessage="Declares MCP: {servers}"
      values={{ servers: mcpServers.join(", ") }}
    />
  ) : null;
  // TriangleAlert overrides the kind glyph on drift; the kind glyph stays
  // when the skill is still in the registry.
  const MarkerIcon = missing ? TriangleAlert : Icon;
  // The tooltip carries the verbatim name + drift suffix (so a marker
  // truncated by the fixed skill-row width still discloses the state on
  // hover) plus the MCP declaration when operative. Declared once so the
  // visible copy and the tooltip copy cannot drift apart.
  const tooltipText = (
    <>
      {text}
      {missingSuffix}
      {mcpDetail !== null && (
        <>
          <br />
          {mcpDetail}
        </>
      )}
    </>
  );
  return (
    <p
      className={cn(
        "skill-lifecycle flex items-center gap-1 m-0 py-1 px-1.5",
        "text-xs border-l-2 rounded-r-md bg-muted",
        // Kind tone rides text-muted-foreground by default; missing flips to
        // text-destructive so the warning reads at a glance.
        missing ? "text-destructive" : "text-muted-foreground",
        // Hook class kept for kind-targeted selectors/tests
        // (.skill-lifecycle.mount/unmount etc.), matching SourceMarker.
        event.kind.toLowerCase(),
        borderTone,
      )}
    >
      <MarkerIcon className="skill-icon w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <TruncatingTooltip text={tooltipText} className="skill-text min-w-0 truncate">
        {text}
        {missingSuffix && <span className="skill-missing">{missingSuffix}</span>}
      </TruncatingTooltip>
    </p>
  );
}

// Lucide glyph + i18n'd text per skill lifecycle kind (ADR-0086, issue #366).
// The verb + spec name ride one ICU message so the quoting / spacing stays
// locale-correct (ADR-0052), mirroring sourceMarkerText. When a new kind is
// added to SkillLifecycleKind, this switch's `never` check fails compilation
// -- the only way to keep the thread rail's kind set in lockstep with the
// wire enum. `types/skills.ts` is the hand-maintained mirror of the Rust
// enum, so the TS compiler won't catch a missing branch without this `never`
// check.
function skillMarkerText(
  intl: IntlShape,
  kind: SkillLifecycleKind,
  name: string,
): { Icon: LucideIcon; text: string } {
  switch (kind) {
    case "Mount":
      return {
        Icon: Plug,
        text: intl.formatMessage(
          { id: "thread.skill.mount", defaultMessage: "Mounted skill \"{name}\"" },
          { name },
        ),
      };
    case "Unmount":
      return {
        Icon: Unplug,
        text: intl.formatMessage(
          { id: "thread.skill.unmount", defaultMessage: "Unmounted skill \"{name}\"" },
          { name },
        ),
      };
    default: {
      const unhandled: never = kind;
      throw new Error(`unhandled skill lifecycle kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

// A turn's outcome mapped to its Lucide glyph + accessible label + color tone
// (ADR-0047/0050 four-outcome visual language, ADR-0052 i18n). A stale
// Materialized turn swaps Table2 for CircleOff (ghost). The label rides the
// icon's aria-label so the outcome kind is conveyed to assistive tech and is
// queryable in tests without relying on color alone. The tone rides the
// outcome-icon span as a Tailwind text-* utility over the ADR-0050 token, so
// the four-way color encoding (A=primary / B=muted / C=destructive / D=muted,
// per ADR-0047) is owned by the component and flips with .dark alongside the
// token -- no [data-outcome] hue hook in styles.css (retired by ADR-0067).
//
// OutcomeTone is the closed union of the three text-* utilities this function
// emits. Typing the return field as OutcomeTone (not string) lets the compiler
// enforce the ADR-0047 hue mapping: a typo like "text-primay", or a stray warm
// class on the Textual/Cancelled branch (which ADR-0017 forbids), is a type
// error rather than a silent broken render.
type OutcomeTone = "text-primary" | "text-muted-foreground" | "text-destructive";
function outcomeVisual(
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
// a dataset name ("在订单表上"), making the chip a signal rather than noise.
// Matches on the display label (what the user sees/types) first, then the
// reference name (for users who know the technical id); the first hit wins.
function findMentionedDataset(
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
function findStaleSourceIdx(
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
function staleChipVerb(intl: IntlShape, reason: StaleReason): string {
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

// The clickable stale causal chip (ADR-0041/0047): a compact label that jumps
// to the invalidating source event. Disabled (not hidden) when no matching event
// follows the turn, so the chip never promises a jump it cannot perform -- the
// title then explains why. Extracted so the verb is computed once and the
// Materialized body reads cleanly. The wording splits honestly by reason:
// Replaced = re-askable, Deleted = gone.
function StaleChip({
  reason,
  hasJumpTarget,
  onJump,
}: {
  reason: StaleReason;
  hasJumpTarget: boolean;
  onJump: (() => void) | undefined;
}) {
  const intl = useIntl();
  const verb = staleChipVerb(intl, reason);
  // Badge secondary = muted-neutral (ADR-0050 stale semantic); asChild merges
  // the variant onto the <button> so the chip stays a real focusable / clickable
  // control with a disabled state. ADR-0067 (issue #169): the stale-chip class
  // now carries layout + the disabled dim only; the variant owns the color so
  // the chip rides the --secondary token and flips with .dark. The hover tint
  // (ADR-0050 stale = muted) is gated on enabled: the inert chip never promises
  // a hover it cannot perform. The disabled dim is opacity-[0.55] -- a value
  // between Tailwind v4's 0.4/0.5/0.6 opacity steps (hence the arbitrary
  // bracket), tuned so the inert chip still reads as present without inviting a
  // click.
  return (
    <Badge
      variant="secondary"
      asChild
      className={cn(
        "stale-chip ml-1 cursor-pointer",
        "enabled:hover:bg-muted disabled:cursor-not-allowed disabled:opacity-[0.55]",
      )}
    >
      <button
        type="button"
        disabled={!hasJumpTarget}
        aria-label={intl.formatMessage(
          {
            id: "thread.staleChip.aria",
            defaultMessage: "Stale because {reason}, jump to the source event",
          },
          { reason: verb },
        )}
        title={
          hasJumpTarget
            ? undefined
            : intl.formatMessage({
                id: "thread.staleChip.noTarget",
                defaultMessage: "Source event no longer in the timeline",
              })
        }
        onClick={onJump}
      >
        {verb}
      </button>
    </Badge>
  );
}

// Issue #381: the turn's mounted skills whose content changed after this turn
// was recorded. Each provenance skill carries its SKILL.md SHA-256 at assembly
// time; the registry's current SkillEntry.content_hash is the same hash
// recomputed at load. A mismatch means the skill was edited after this answer
// -- the TurnCard surfaces "已修改" so a reader can tell the answer may be
// stale. An empty content_hash (v3->v4 migration, no baseline) never trips the
// check; a name the registry no longer carries is the SkillMarker's "no longer
// exists" case (issue #366), not a content drift -- omitted here.
function selectDriftedSkills(
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

interface TurnCardProps {
  record: TurnRecord;
  selectedResult: string | null;
  onSelectResult: (referenceName: string) => void;
  staleAnchor: StaleAnchor | undefined;
  /** Whether a matching source event follows this turn, i.e. the stale chip can
   * actually perform its jump (ADR-0047). False on the resume / stale-map
   * inconsistency edge case, which disables the chip instead of a silent no-op. */
  hasJumpTarget: boolean;
  /** Jump-to-source handler, bound to the pre-resolved target index. undefined
   * when hasJumpTarget is false (the chip is disabled, so no handler is wired). */
  onStaleChipJump: (() => void) | undefined;
  mentionedDataset: DatasetLabel | null;
  /** The registry index for skill drift detection (issue #381). undefined when
   *  the caller does not wire the registry: drift detection is skipped (honest
   *  degrade -- the timeline stays readable, mirroring SkillMarker's #366
   *  no-index posture). */
  skillIndex: ReadonlyMap<string, SkillEntry> | undefined;
}

// One turn rendered as a single-row head (ADR-0047): outcome glyph + verbatim
// question (tail-truncated, head kept per ADR-0054) + a conditional active chip
// when the question named a dataset. The outcome body (result link / textual
// body / failure reason / cancelled marker) renders beneath so the four kinds
// stay distinguishable by text as well as by glyph/color (ADR-0028). A stale
// Materialized turn becomes a ghost (CircleOff + reduced opacity) and gains a
// clickable causal chip; Failed/Cancelled are weakened (opacity) but kept
// visible -- never collapsed away (ADR-0028 Why 2). The verbatim question and
// the chip's dataset display name are layer-4 content (ADR-0039/0037) and pass
// through untranslated.
function TurnCard({
  record,
  selectedResult,
  onSelectResult,
  staleAnchor,
  hasJumpTarget,
  onStaleChipJump,
  mentionedDataset,
  skillIndex,
}: TurnCardProps) {
  const intl = useIntl();
  const isStale = !!staleAnchor;
  const drifted = selectDriftedSkills(record, skillIndex);
  const { Icon, label, tone } = outcomeVisual(intl, record.outcome, isStale);
  // ADR-0028 Why 2: Failed/Cancelled are weakened but not collapsed (opacity-
  // 60); a stale Materialized turn ghosts further (opacity-50, ADR-0041/0047).
  // Stale only lands on Materialized turns, so the two dims never stack.
  const weakened =
    record.outcome.kind === "Failed" || record.outcome.kind === "Cancelled";
  // ADR-0078 (issue #297): the execution trace is collapsible -- the card
  // shows the question + answer + outcome always and expands the tool-call
  // chain on demand. Default COLLAPSED so a forty-turn rail stays readable;
  // the expand state is session-ephemeral UI state (the trace DATA persists
  // on the TurnRecord / recipe, the toggle does not). Zero-call turns (a
  // plain textual answer) carry no trace, hence no toggle.
  const [traceExpanded, setTraceExpanded] = useState(false);
  const hasTrace = record.trace.length > 0;
  return (
    <div
      className={cn(
        "turn-card rounded-md py-1.5",
        isStale && "stale-ghost opacity-50",
        weakened && "opacity-60",
      )}
      data-stale={isStale ? "true" : undefined}
    >
      <div className="turn-head flex items-center gap-1.5 min-w-0">
        <span
          className={cn(
            "outcome-icon inline-flex items-center justify-center w-4 h-4 shrink-0",
            tone,
          )}
          role="img"
          aria-label={label}
        >
          <Icon aria-hidden="true" className="w-4 h-4" />
        </span>
        {/* The verbatim question is the identity handle (ADR-0039): single-line,
            tail-ellipsis truncation keeps the head (where identity concentrates)
            visible at a fixed rail width (ADR-0054). The full text rides the
            Tooltip (ADR-0050, issue #106). A stale ghost also strikes the
            question through dotted (ADR-0041/0047) -- the strike is question-
            local so the truncation + tooltip still recover the full text. */}
        <TruncatingTooltip
          text={record.question}
          className={cn(
            "turn-question flex-1 min-w-0 truncate text-sm text-foreground",
            isStale && "line-through decoration-dotted",
          )}
        >
          {record.question}
        </TruncatingTooltip>
        {/* The active chip (ADR-0047) flags a turn that explicitly named a
            dataset. Unlike the question/source tooltips (truncation recovery),
            its hover carries a localized explanatory label -- the v0 native
            title's "Question names {name}" -- so the chip's meaning survives
            both truncation (max-width 8rem) and non-English locales (ADR-0052).
            The full name rides the {name} placeholder, so the hover also
            recovers a truncated chip verbatim. */}
        {mentionedDataset && (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Badge default = teal --primary (ADR-0050 active semantic); the
                  turn-active-chip class carries layout only (flex-shrink,
                  8rem tail-ellipsis + the test selector), the variant owns the
                  color so the chip recolors with .dark alongside the token. */}
              <Badge
                variant="default"
                className="turn-active-chip shrink-0 max-w-32 truncate"
              >
                →{mentionedDataset.display_name}
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <FormattedMessage
                id="thread.activeChip.title"
                defaultMessage={`Question names "{name}"`}
                values={{ name: mentionedDataset.display_name }}
              />
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {drifted.length > 0 && (
        <p className="skill-drift m-0 mt-0.5 ml-6 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {drifted.map((name) => (
            <span
              key={name}
              className="skill-drift-name inline-flex items-center gap-0.5 rounded-sm bg-muted px-1 py-0.5"
            >
              <PencilLine aria-hidden="true" className="w-3 h-3 shrink-0" />
              <span className="truncate">{name}</span>
              <FormattedMessage
                id="thread.skill.modifiedSuffix"
                defaultMessage=" · modified since this answer"
              />
            </span>
          ))}
        </p>
      )}
      {hasTrace && (
        // The trace toggle: a compact chevron + call count between the head
        // and the answer. aria-expanded conveys the fold state; the chevron
        // rotates on expand. The count reads "Trace · N calls" so a rail
        // scan shows which turns made multiple calls without expanding.
        <button
          type="button"
          className="trace-toggle mt-0.5 ml-6 flex items-center gap-1 cursor-pointer text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={traceExpanded}
          onClick={() => setTraceExpanded((v) => !v)}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn("w-3.5 h-3.5 transition-transform", traceExpanded && "rotate-90")}
          />
          <FormattedMessage
            id="thread.trace.toggle"
            defaultMessage="Trace · {count} {count, plural, one {call} other {calls}}"
            values={{ count: record.trace.length }}
          />
        </button>
      )}
      {hasTrace && traceExpanded && <TraceRowList entries={record.trace} />}
      <TurnBody
        record={record}
        selectedResult={selectedResult}
        onSelectResult={onSelectResult}
        staleAnchor={staleAnchor}
        hasJumpTarget={hasJumpTarget}
        onStaleChipJump={onStaleChipJump}
      />
    </div>
  );
}

// The provider's optional assumption note (ADR-0009/0018), rendered as a
// correctable side note on both Materialized and Textual turns. The assumption
// text is layer-3 LLM content (ADR-0052) and passes through the {text}
// placeholder untranslated; only the "Assumption:" prefix is chrome. Extracted
// so the rendering isn't duplicated across the two outcomes that carry it.
function AssumptionNote({ assumption }: { assumption: string | null }) {
  const intl = useIntl();
  if (!assumption) return null;
  return (
    <span className="assumption block text-xs italic text-muted-foreground">
      {intl.formatMessage(
        { id: "thread.assumption", defaultMessage: "Assumption: {text}" },
        { text: assumption },
      )}
    </span>
  );
}

interface TurnBodyProps {
  record: TurnRecord;
  selectedResult: string | null;
  onSelectResult: (referenceName: string) => void;
  staleAnchor: StaleAnchor | undefined;
  hasJumpTarget: boolean;
  onStaleChipJump: (() => void) | undefined;
}

function TurnBody({
  record,
  selectedResult,
  onSelectResult,
  staleAnchor,
  hasJumpTarget,
  onStaleChipJump,
}: TurnBodyProps) {
  const intl = useIntl();
  switch (record.outcome.kind) {
    case "Materialized": {
      const { promotions, assumption } = record.outcome.data;
      // ADR-0084: the chain tail is the primary result (the answer the question
      // produced); earlier promotions are intermediate results, rendered as a
      // muted "derived from" line so the lineage stays visible without
      // competing with the primary link.
      const primary = promotions[promotions.length - 1];
      const antecedents = promotions.slice(0, -1);
      if (!primary) return null;
      const active = primary.dataset.reference_name === selectedResult;
      return (
        <>
          <p className="turn-outcome mt-1 ml-6 text-xs leading-snug">
            {antecedents.length > 0 && (
              <span className="antecedents block mb-0.5 text-muted-foreground">
                <FormattedMessage
                  id="thread.antecedents"
                  defaultMessage="Derived from {names}"
                  values={{
                    names: intl.formatList(
                      antecedents.map((p) => p.dataset.reference_name),
                      { type: "conjunction" },
                    ),
                  }}
                />
              </span>
            )}
            {/* result-link is a real <button> (clickable, focusable) but stripped
              of native button chrome via [all:unset] so it reads as an inline
              link; subsequent utilities rebuild the box model + token color.
              `active`/`stale` are kept as hook classes (semantic + test
              selectors) -- their visual lands on the same element via the
              conditional utilities below. */}
            <button
              type="button"
              className={cn(
                "result-link [all:unset] cursor-pointer inline-block text-primary",
                "px-1.5 py-0.5 rounded-md border border-transparent",
                "hover:bg-accent",
                active && "active font-semibold border-primary",
                staleAnchor && "stale text-muted-foreground border-dashed",
              )}
              aria-current={active ? "true" : undefined}
              onClick={() => onSelectResult(primary.dataset.reference_name)}
            >
              <FormattedMessage
                id="thread.resultLink"
                defaultMessage="Result: {name}"
                values={{ name: primary.dataset.reference_name }}
              />
            </button>
            {staleAnchor && (
              <StaleChip
                reason={staleAnchor.reason}
                hasJumpTarget={hasJumpTarget}
                onJump={onStaleChipJump}
              />
            )}
            <AssumptionNote assumption={assumption} />
          </p>
          {/* ADR-0083 (issue #298): the primary result's inline preview card --
            the windowed sample (first rows, ADR-0026) for a rail-scan glance
            at the answer. Clicking it selects the result (the caller opens
            the workspace); the active state mirrors the viewed selection
            back (dual-view linkage). Antecedent promotions carry no card --
            the chain tail is the answer. */}
          <ResultPreviewCard
            dataset={primary.dataset}
            active={active}
            stale={!!staleAnchor}
            onSelect={() => onSelectResult(primary.dataset.reference_name)}
          />
        </>
      );
    }
    case "Textual": {
      const { text_kind, body, assumption } = record.outcome.data;
      // The Agent kind (the tool-calling contract's terminal text, ADR-0077)
      // renders as a plain answer -- the body IS the reply, so no kind badge.
      // The legacy Clarify / Refuse kinds keep their action-signaling badge.
      const badge =
        text_kind === "Clarify" ? (
          <FormattedMessage id="thread.outcome.clarify" defaultMessage="Needs clarification" />
        ) : text_kind === "Refuse" ? (
          <FormattedMessage id="thread.outcome.refused" defaultMessage="Cannot fulfill" />
        ) : null;
      return (
        <p
          className={cn(
            "turn-outcome textual mt-1 ml-6 text-xs leading-snug",
            text_kind.toLowerCase(),
          )}
        >
          {badge && (
            <span className="textual-kind inline-block mr-1 text-muted-foreground">{badge}</span>
          )}
          <span className="textual-body text-foreground">{body}</span>
          <AssumptionNote assumption={assumption} />
        </p>
      );
    }
    case "Failed": {
      // Outcome C (issue #125): render by TurnFailure kind via the locale
      // catalog (no backend Display string crosses IPC). Execute / Resource
      // carry a technical detail under the collapsed fold.
      const failure = record.outcome.data;
      const detail = turnFailureDetail(failure);
      return (
        <div className="turn-outcome failed mt-1 ml-6 text-xs leading-snug">
          {/* <div>, not <p>: a <p> cannot legally contain the <details> fold. */}
          <span className="failed-reason text-destructive">{formatTurnFailure(failure, intl)}</span>
          <TechnicalDetailsFold detail={detail} />
        </div>
      );
    }
    case "Cancelled":
      return (
        <p className="turn-outcome cancelled mt-1 ml-6 text-xs leading-snug text-muted-foreground">
          <FormattedMessage id="thread.outcome.cancelled" defaultMessage="Cancelled" />
        </p>
      );
    default: {
      // Exhaustiveness guard: a future TurnOutcome variant must add a case here,
      // mirroring Rust's compile-time match exhaustiveness. `types/thread.ts` is the
      // hand-maintained mirror, so the TS compiler won't catch a missing branch
      // without this `never` check.
      const unhandled: never = record.outcome;
      throw new Error(`unhandled turn outcome: ${JSON.stringify(unhandled)}`);
    }
  }
}
