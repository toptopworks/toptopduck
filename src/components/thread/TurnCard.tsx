// TurnCard + TraceRoundBlock + TurnBody + AssumptionNote form the turn's chat
// projection (ADR-0103, issue #609): a right-aligned user bubble (UserBubble,
// question in full + asked_at + copy) over a left assistant stream -- header
// annotations (active chip, skill drift), the round-grouped trace as per-round
// thinking folds + always-expanded connective prose + per-round step folds,
// the outcome body, and a closing meta row (reply copy + settled_at + the
// outcome glyph for Materialized/Textual; Failed/Cancelled integrate their
// glyph into the outcome card head, issue #720). App annotations all live on
// the assistant side; the bubble carries only user output and conversation
// facts.

import { useState, type ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { PencilLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { TraceRowList } from "./TraceView";
import { ResultPreviewCard } from "./ResultPreviewCard";
import { CopyButton } from "./CopyButton";
import { FoldToggle } from "./FoldToggle";
import { RoundProse } from "./RoundProse";
import { StreamHeader } from "./StreamHeader";
import { ThinkingFold } from "./ThinkingFold";
import { TurnActiveChip } from "./TurnActiveChip";
import { UserBubble } from "./UserBubble";
import { StaleChip } from "./StaleChip";
import {
  HOVER_REVEAL_CLASS,
  outcomeVisual,
  selectDriftedSkills,
  type DatasetLabel,
} from "./turn-visual";
import type { StaleAnchor } from "../../types/dataset";
import type { SkillEntry } from "../../types/skills";
import type { ThinkingTrace, TraceRound, TurnRecord } from "../../types/thread";
import { formatTurnFailure, turnFailureDetail } from "../../lib/error-presentation";
import { TechnicalDetailsFold } from "../common/TechnicalDetailsFold";

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
  /** The thinking blocks whose fold mounts already expanded -- the live ->
   *  settled continuity (issue #620): the thread injects the live turn's
   *  open folds (keyed by the thinking block reference, which the settle
   *  projection carries onto the trace's own round) into the entry appended
   *  at the settle swap, so a fold the user opened while the turn ran stays
   *  open across the swap. Undefined (or an empty set) is the default
   *  collapsed posture. */
  thinkingInitiallyExpanded?: ReadonlySet<ThinkingTrace>;
  /** The registry index for skill drift detection (issue #381). undefined when
   *  the caller does not wire the registry: drift detection is skipped (honest
   *  degrade -- the timeline stays readable, mirroring SkillMarker's #366
   *  no-index posture). */
  skillIndex: ReadonlyMap<string, SkillEntry> | undefined;
  /** D5 / issue #722: the agent activations that happened inside this turn,
   *  rendered at the head of the assistant stream -- chronologically after the
   *  user bubble, before the execution they enabled. undefined when the turn
   *  owns none. */
  agentHead?: ReactNode;
  /** Issue #758: fires this turn's question again as a fresh turn -- the
   *  Failed/Cancelled continuation (ADR-0028 Why 2: these turns stay visible
   *  AND continuable). undefined when the caller does not wire a retry: the
   *  outcome cards keep their read-only shape (honest degrade). */
  onRetryTurn: ((question: string) => void) | undefined;
  /** Issue #758: the session busy gate (the composer's mirror) -- a turn or
   *  mutation in flight; the retry button renders disabled until it clears. */
  busy: boolean;
}

// One turn rendered as a chat exchange (ADR-0103): the user bubble (verbatim
// question, full text) over the assistant stream. The four outcome kinds stay
// distinguishable by text as well as by glyph/color (ADR-0028); the outcome
// glyph rides the stream's closing meta row on Materialized/Textual and the
// failure card head on Failed/Cancelled (issue #720). A stale Materialized turn ghosts
// the whole exchange (opacity-50) and gains a clickable causal chip
// (ADR-0041/0047). ADR-0103's attribution list names `stale`: the CHIP is
// that app annotation and renders on the assistant side (inside the body);
// the whole-exchange ghost + the question strike are the outcome-state
// marking ADR-0041/0047 established -- ADR-0103 retires neither, and the
// strike rides the question because the question's answer is what died.
// Failed/Cancelled weaken the ASSISTANT side only (opacity-60 -- the failure
// is the assistant's, the user's question never dims) but stay visible --
// never collapsed away (ADR-0028 Why 2). The verbatim question and the chip's
// dataset display name are layer-4 content (ADR-0039/0037) and pass through
// untranslated.
export function TurnCard({
  record,
  selectedResult,
  onSelectResult,
  staleAnchor,
  hasJumpTarget,
  onStaleChipJump,
  mentionedDataset,
  thinkingInitiallyExpanded,
  skillIndex,
  agentHead,
  onRetryTurn,
  busy,
}: TurnCardProps) {
  const intl = useIntl();
  const isStale = !!staleAnchor;
  const drifted = selectDriftedSkills(record, skillIndex);
  // ADR-0028 Why 2 + ADR-0103 attribution: Failed/Cancelled weaken the stream
  // only. Stale only lands on Materialized turns, so the two dims never stack.
  const weakened = record.outcome.kind === "Failed" || record.outcome.kind === "Cancelled";
  // Issue #720: Failed/Cancelled render their glyph at the outcome card head
  // (TurnBody), so the closing meta row carries no glyph for them; the row
  // renders only while it carries content (the glyph for the other outcomes,
  // or the settle stamp).
  const glyphInMeta = !weakened;
  const showsMetaRow = glyphInMeta || record.settled_at !== undefined;
  // The reply copy (ADR-0103 closing meta) exists only when the turn's answer
  // IS text: a Textual turn's body. Materialized answers with a result link,
  // Failed/Cancelled with markers -- nothing textual to copy.
  const replyText = record.outcome.kind === "Textual" ? record.outcome.data.body : null;
  return (
    <div
      className={cn("turn-card rounded-md py-1.5", isStale && "stale-ghost opacity-50")}
      data-stale={isStale ? "true" : undefined}
    >
      <UserBubble question={record.question} askedAt={record.asked_at} isStale={isStale} />
      <div
        className={cn(
          "assistant-stream group mt-1 flex flex-col items-start",
          weakened && "opacity-60",
        )}
      >
        {/* D5 / issue #722: agent activations owned by this turn open the
            assistant stream -- after the user bubble, before the execution
            they enabled. */}
        {agentHead}
        {/* Header annotations (ADR-0103): the app's read of the question --
            which dataset it named (ADR-0047 active chip) and which mounted
            skills drifted since the answer (issue #381) -- open the stream,
            ahead of the rounds, so the reading order is question -> annotation
            -> execution -> reply. */}
        {(mentionedDataset || drifted.length > 0) && (
          <StreamHeader>
            {mentionedDataset && <TurnActiveChip dataset={mentionedDataset} />}
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
          </StreamHeader>
        )}
        {record.trace.map((round, i) => (
          // The trace is append-only within a turn and never reordered, so the
          // index is a stable key (the same YAGNI call the thread makes).
          <TraceRoundBlock key={i} round={round} thinkingInitiallyExpanded={thinkingInitiallyExpanded} />
        ))}
        <TurnBody
          record={record}
          selectedResult={selectedResult}
          onSelectResult={onSelectResult}
          staleAnchor={staleAnchor}
          hasJumpTarget={hasJumpTarget}
          onStaleChipJump={onStaleChipJump}
          onRetryTurn={onRetryTurn}
          busy={busy}
        />
        {/* Closing meta row (ADR-0103): the outcome glyph ends the exchange --
            state, always visible -- for Materialized/Textual (issue #720 moves
            the Failed/Cancelled glyph to the failure card head). The settle
            facts (reply copy + stamp, honest degrade: no settled_at recorded ->
            no time element) are hover-revealed alongside it (HOVER_REVEAL_CLASS
            rides the assistant-stream group). */}
        {showsMetaRow && (
          <p className="turn-meta m-0 mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            {/* Derived here (not above) so Failed/Cancelled never compute the
                meta-row visual they cannot use -- their glyph derives in
                TurnBody's card head. */}
            {glyphInMeta && (
              <OutcomeGlyph visual={outcomeVisual(intl, record.outcome, isStale)} />
            )}
            <span className={cn("meta-reveal flex items-center gap-1.5", HOVER_REVEAL_CLASS)}>
              {replyText !== null && (
                <CopyButton
                  text={replyText}
                  label={intl.formatMessage({
                    id: "thread.copy.reply",
                    defaultMessage: "Copy reply",
                  })}
                />
              )}
              {record.settled_at !== undefined && (
                <time dateTime={new Date(record.settled_at).toISOString()}>
                  {intl.formatTime(record.settled_at)}
                </time>
              )}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}

// The outcome glyph span (ADR-0047/0050): Lucide icon + accessible label +
// text-* tone, shared by the closing meta row (Materialized/Textual) and the
// failure card head (Failed/Cancelled, issue #720) so the glyph renders
// identically wherever it lands.
function OutcomeGlyph({ visual }: { visual: ReturnType<typeof outcomeVisual> }) {
  const { Icon, label, tone } = visual;
  return (
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
  );
}

// One round of the round-grouped trace (ADR-0103, calibrating ADR-0078): the
// thinking fold (default collapsed, ADR-0078 long-rail posture), the round's
// connective prose (always expanded -- the readability mainstay), and the
// round's step fold (default collapsed). Fold state is session-ephemeral UI
// state; the trace data persists on the TurnRecord / recipe. Absent members
// render nothing (honest degrade: no thinking source -> no thinking fold; a
// pre-v5 migrated round is a bare call list -> just the step fold; an entirely
// empty round -> no chrome at all). The thinking fold + prose are shared with
// the live round block (issue #610) via ThinkingFold + RoundProse, so the
// settle swap does not move them; `thinkingInitiallyExpanded` seeds the
// thinking fold with the live turn's open posture at the settle swap
// (issue #620).
function TraceRoundBlock({
  round,
  thinkingInitiallyExpanded,
}: {
  round: TraceRound;
  thinkingInitiallyExpanded: ReadonlySet<ThinkingTrace> | undefined;
}) {
  const [stepsExpanded, setStepsExpanded] = useState(false);
  // Destructured const so the aliased guard narrows the binding itself (a
  // boolean alias of `round.thinking !== undefined` does not narrow the
  // property access); the render below reads `thinking` with no assertions.
  const { thinking, text, calls } = round;
  const hasThinking = thinking !== undefined;
  const hasCalls = calls.length > 0;
  if (!hasThinking && text === undefined && !hasCalls) return null;
  return (
    <div className="trace-round">
      {hasThinking && (
        <ThinkingFold
          thinking={thinking}
          initialExpanded={thinkingInitiallyExpanded?.has(thinking) ?? false}
        />
      )}
      {text !== undefined && <RoundProse text={text} />}
      {hasCalls && (
        // The round's step fold: the call count reads "Trace · N calls" so a
        // rail scan shows which rounds made multiple calls without expanding.
        <>
          <FoldToggle
            hookClass="trace-toggle"
            expanded={stepsExpanded}
            onToggle={() => setStepsExpanded((v) => !v)}
          >
            <FormattedMessage
              id="thread.trace.toggle"
              defaultMessage="Trace · {count} {count, plural, one {call} other {calls}}"
              values={{ count: calls.length }}
            />
          </FoldToggle>
          {stepsExpanded && <TraceRowList entries={calls} />}
        </>
      )}
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
  onRetryTurn: ((question: string) => void) | undefined;
  busy: boolean;
}

// The shared shell of the Failed/Cancelled outcome cards (issue #720): one
// constant so the two kinds stay isomorphic -- Failed tints it destructive,
// Cancelled mutes it; only the tint utilities and the head content differ.
// No width utility: the card hugs its content (the assistant stream is
// items-start), stretching only as far as a long reason or detail forces.
const OUTCOME_CARD_CLASS = "mt-1 rounded-md border px-2.5 py-2 text-xs leading-snug";

function TurnBody({
  record,
  selectedResult,
  onSelectResult,
  staleAnchor,
  hasJumpTarget,
  onStaleChipJump,
  onRetryTurn,
  busy,
}: TurnBodyProps) {
  const intl = useIntl();
  // Issue #758: the Failed/Cancelled continuation action, shared by the two
  // outcome cards (isomorphic, like their shell). A function, not a hoisted
  // element, per the file's derive-here convention (the meta-row glyph's
  // twin): Materialized/Textual renders never evaluate the retry JSX --
  // including its formatMessage -- for branches that cannot use it. Fires
  // the turn's verbatim question as a fresh turn; disabled while one runs.
  // Absent when the caller wires no handler -- the cards keep their
  // read-only shape.
  const renderRetry = () =>
    onRetryTurn && (
      <Button
        variant="outline"
        size="sm"
        className="mt-1.5"
        disabled={busy}
        onClick={() => onRetryTurn(record.question)}
        aria-label={intl.formatMessage({
          id: "thread.outcome.retryLabel",
          defaultMessage: "Retry this question",
        })}
      >
        <FormattedMessage id="thread.outcome.retry" defaultMessage="Retry" />
      </Button>
    );
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
          <p className="turn-outcome mt-1 text-xs leading-snug">
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
      // The body rides the conversation tier (text-sm, matching UserBubble's
      // question and RoundProse -- the reply is discourse, not chrome).
      return (
        <p
          className={cn(
            "turn-outcome textual mt-1 text-sm leading-snug",
            text_kind.toLowerCase(),
          )}
        >
          {badge && (
            // The kind badge is chrome, not discourse: it keeps the caption
            // tier instead of inheriting the body's conversation tier.
            <span className="textual-kind inline-block mr-1 text-xs text-muted-foreground">
              {badge}
            </span>
          )}
          <span className="textual-body text-foreground">{body}</span>
          <AssumptionNote assumption={assumption} />
        </p>
      );
    }
    case "Failed": {
      // Outcome C (issue #125): render by TurnFailure kind via the locale
      // catalog (no backend Display string crosses IPC). Execute / Resource
      // carry a technical detail under the collapsed fold. Issue #720: one
      // destructive tint card -- the outcome glyph at the card head with the
      // reason on the same line, the fold inside the card below them -- taking
      // the tinted bg + border treatment the shadcn Alert destructive variant
      // consumes (border-destructive/40 bg-destructive/10, DESIGN.md Alerts).
      const failure = record.outcome.data;
      const detail = turnFailureDetail(failure);
      return (
        // <div>, not <p>: a <p> cannot legally contain the <details> fold.
        <div
          className={cn(
            OUTCOME_CARD_CLASS,
            "turn-outcome failed border-destructive/40 bg-destructive/10",
          )}
        >
          <div className="flex items-center gap-1.5">
            {/* Stale never lands here (Materialized only), so the visual is
                derived with stale=false. */}
            <OutcomeGlyph visual={outcomeVisual(intl, record.outcome, false)} />
            <span className="failed-reason text-destructive">
              {formatTurnFailure(failure, intl)}
            </span>
          </div>
          <TechnicalDetailsFold detail={detail} />
          {renderRetry()}
        </div>
      );
    }
    case "Cancelled":
      // Outcome D, same card shape as Failed but muted (issue #720): the glyph
      // head carries the whole body -- no reason text, no fold -- so the card
      // reads as the weakened-grey sibling of the Failed card.
      return (
        <div
          className={cn(
            OUTCOME_CARD_CLASS,
            "turn-outcome cancelled bg-muted text-muted-foreground",
          )}
        >
          <div className="flex items-center gap-1.5">
            <OutcomeGlyph visual={outcomeVisual(intl, record.outcome, false)} />
            <FormattedMessage id="thread.outcome.cancelled" defaultMessage="Cancelled" />
          </div>
          {renderRetry()}
        </div>
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
