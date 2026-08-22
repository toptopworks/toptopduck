import { useCallback, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { LiveTurnExchange } from "./LiveTurnExchange";
import { SourceMarker } from "./SourceMarker";
import { SkillMarker } from "./SkillMarker";
import { RuntimeAttributionMarker } from "./RuntimeAttributionMarker";
import { TurnCard } from "./TurnCard";
import {
  primaryReferenceName,
  findMentionedDataset,
  findStaleSourceIdx,
  runtimeSegmentBadges,
  type DatasetLabel,
} from "./turn-visual";
import type { LiveTurn } from "../../session/useTurnFlow";
import type { ApprovalResponse } from "../../types/approval";
import type { StaleAnchor } from "../../types/dataset";
import type { SkillEntry } from "../../types/skills";
import type { ThinkingTrace, ThreadEntry } from "../../types/thread";

export type { DatasetLabel } from "./turn-visual";

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
  /** The in-flight turn's live trace (ADR-0078/0103, issues #297/#610): when
   * non-null the thread renders the turn's chat exchange at its tail (the
   * user bubble + the streaming assistant side: round prose / thinking folds
   * / tool rows + approval cards). Client UI state only -- the settled turn
   * replaces it with its recorded TurnRecord in the same chat form. Optional
   * for call sites / tests that do not exercise live rendering; defaults to
   * null (no live exchange). */
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
// The empty fold-posture set, module-level for the same identity-stability
// reason (the live swap's collector starts and resets to it).
const NO_EXPANDED_FOLDS: ReadonlySet<ThinkingTrace> = new Set();

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
  // The live turn's open thinking folds (issue #620 settle continuity),
  // keyed by the round's thinking block REFERENCE: the settle projection
  // (liveRoundsToTrace) carries the same reference onto the optimistic
  // record's round, so the key survives the projection's round drop (an
  // entirely empty round vanishes from the trace, shifting array indices --
  // a reference key cannot shift) and the seed maps the same fold on both
  // sides. The exchange reports each toggle; the settle swap's mounting
  // frame (liveTurn nulls while the optimistic entry appends, in one
  // commit) seeds the appended entry's thinking folds with this set -- a
  // fold the user opened while the turn ran mounts already open on the
  // settled side, instead of snapping shut when the exchange's local fold
  // state dies with it.
  const [liveThinkingExpanded, setLiveThinkingExpanded] =
    useState<ReadonlySet<ThinkingTrace>>(NO_EXPANDED_FOLDS);
  const handleLiveThinkingExpanded = useCallback((thinking: ThinkingTrace, expanded: boolean) => {
    setLiveThinkingExpanded((prev) => {
      // Idempotent no-op: the fold reports on every posture/identity change
      // (mount included), so a report matching the current state must return
      // the SAME set (Object.is bailout) instead of churning a fresh one.
      if (prev.has(thinking) === expanded) return prev;
      const next = new Set(prev);
      if (expanded) next.add(thinking);
      else next.delete(thinking);
      return next;
    });
  }, []);
  // Reset the posture set when a FRESH turn starts (liveTurn transitions to
  // non-null), so a new turn never inherits the previous one's folds. The
  // edge is keyed by the submit stamp, NOT the liveTurn object identity:
  // the memoized liveTurn takes a new identity on EVERY progress event, so
  // an identity edge would wipe the collector mid-turn and the settle seed
  // below would arrive empty. askedAt is read once at submit and constant
  // within the turn, so it IS the turn identity (issue #620). Adjusted
  // during render -- the React-blessed "state on prop change" pattern, no
  // effect (an effect would land a frame too late for the seed below,
  // which must ride the swap's mounting frame).
  const [prevAskedAt, setPrevAskedAt] = useState<number | null>(null);
  const askedAt = liveTurn?.askedAt ?? null;
  if (prevAskedAt !== askedAt) {
    setPrevAskedAt(askedAt);
    if (askedAt !== null) setLiveThinkingExpanded(NO_EXPANDED_FOLDS);
  }
  // The index of the last recorded turn -- on the swap frame this is the
  // optimistic append the settle just landed (the timeline's tail turn).
  let lastTurnIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].entry === "Turn") {
      lastTurnIdx = i;
      break;
    }
  }
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

  // ADR-0101: the per-entry runtime segment badge (null where none opens).
  // Gated + quieted inside the helper -- a purely built-in thread renders
  // nothing; a mixed thread announces each attribution change once, at the
  // segment's first turn.
  const segmentBadges = useMemo(() => runtimeSegmentBadges(entries), [entries]);

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
            const segmentRuntime = segmentBadges[i];
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
                // benefit). ADR-0103 (issue #609) landed entry-local UI state
                // (each turn's fold + copy state lives INSIDE its components);
                // append-only keeps that state attached to the right entry. A
                // stable monotonic id becomes necessary only if entries can
                // ever be truncated or reordered.
                key={i}
                className="turn-entry"
                data-outcome={entry.data.outcome.kind.toLowerCase()}
              >
                {segmentRuntime != null && (
                  <RuntimeAttributionMarker runtime={segmentRuntime} />
                )}
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
                  // The settle seed rides only the appended entry's MOUNTING
                  // frame (the swap, one commit after the live turn's
                  // folds); the uncontrolled folds take the initial once, so
                  // re-passing the set on later frames is a no-op and no
                  // swap-frame detection is needed -- only the last turn
                  // entry is a fresh mount while no turn runs.
                  thinkingInitiallyExpanded={
                    liveTurn === null && i === lastTurnIdx && liveThinkingExpanded.size > 0
                      ? liveThinkingExpanded
                      : undefined
                  }
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
      {/* The in-flight turn's chat exchange (ADR-0103, issue #610): trails
          the recorded entries while a turn runs -- the user bubble mounts at
          submit, the assistant side streams (the dataset chip included, so
          the swap adds no element, issue #620) -- then folds away as the
          settled TurnRecord appends (the same chat form, so the swap does
          not move the bubble / chip / prose / thinking folds). A distinct
          block (not an <li>) -- the ol is the recorded timeline
          (append-only, ADR-0028/0040), the live exchange is transient
          client state that never enters it. */}
      {liveTurn !== null && (
        <LiveTurnExchange
          liveTurn={liveTurn}
          mentionedDataset={findMentionedDataset(liveTurn.question, datasetLabels)}
          onRespondApproval={onRespondApproval}
          onThinkingExpandedChange={handleLiveThinkingExpanded}
        />
      )}
    </section>
  );
}
