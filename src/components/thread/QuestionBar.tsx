import { useRef, useState, type ReactNode } from "react";
import { useIntl } from "react-intl";
import { ArrowUp, Square } from "lucide-react";
import { materializeQuotes } from "../../lib/quoteText";
import { Button } from "../ui/button";
import { SkillPickerPanel } from "./SkillPickerPanel";
import { skillPickerOptionId } from "./skillPickerLogic";
import { useSkillPicker } from "./useSkillPicker";

type QuestionBarProps = {
  onSubmit: (question: string) => void;
  /** Fire while a turn is in flight (ADR-0021 cancel). Hidden when not loading. */
  onCancel: () => void;
  loading: boolean;
  /** The composer question's queued posture (issue #1500): a submit that
   *  landed while an ingest batch is in flight sits in the session's pending
   *  slot -- the input is disabled and the status slot carries the queued
   *  copy until the batch settles (auto-send on full load, seed-back to the
   *  draft on halt). A NEW axis, deliberately separate from `loading` (the
   *  turn domain, ADR-0021): the bar's own paths never raise both, but the
   *  ask-again direct fire can open a turn while a question sits queued, so
   *  the render cedes the feedback slot to loading (never folded into one
   *  flag). Optional so embedders / tests that don't exercise the queue
   *  omit it. */
  queued?: boolean;
  /** Left-side toolbar controls rendered inside the unified container (the
   *  composer "+" / auth-mode slots threaded from the shell, ADR-0092). */
  children?: ReactNode;
  /** Right-side toolbar controls, seated before the submit/stop
   *  button (the runtime / model picker threaded from the shell, ADR-0092). */
  trailing?: ReactNode;
  /** Skill picker channel (ADR-0112, issue #716): "/" opens the global panel
   *  and "$" the skills-direct panel at the textarea; a selection consumes
   *  the trigger span from the draft and reports the skill name -- the
   *  caller stages this turn's user invocation (ADR-0119). Omitted by embedders /
   *  tests that exercise no picker behavior (the surface is then fully
   *  disabled, queries included). */
  skillPicker?: {
    onPick: (name: string) => void;
    /** The pre-activation chips (ADR-0112, issue #716) travel as a REQUIRED
     *  bundle with the picker surface (issue #718): the chip node renders
     *  inline in the input area before the textarea (each chip joins the
     *  input row's flex wrap, so the caret seats right after the last chip),
     *  and Backspace at the draft's start (caret 0, no selection) fires
     *  onBackspace to withdraw the most recent chip -- the chips seat before
     *  the draft's first char, so the last one deletes like a text char.
     *  Bundling makes the two unmoored shapes -- a chips slot hanging
     *  outside the picker channel, and a picker channel with no chips slot
     *  -- inexpressible in the type layer. */
    chips: {
      node: ReactNode;
      onBackspace: () => void;
    };
  };
  /** Quote chips channel (#1573): the selection surface's staged passages.
   *  The node (ComposerQuoteChips) seats BEFORE the skill chips -- the quote
   *  is the question's leading material. The staged texts ride alongside
   *  because the submit materializes them itself: each becomes a `> `
   *  blockquote, the block prepended to the draft (NOT the ADR-0112
   *  invocation channel -- quotes must reach the question TEXT). Backspace
   *  withdrawal shares the skill bundle's single draft-start channel: the
   *  shell routes it (last skill chip, then last quote). Omitted by
   *  embedders / tests that exercise no quotes. */
  quoteChips?: {
    node: ReactNode;
    quotes: readonly string[];
  };
} & {
  /** Controlled draft pair (ADR-0092 useComposerState). Both must be provided
   *  together so the parent owns the draft state. When omitted, QuestionBar
   *  falls back to local state (used by tests that render QuestionBar in
   *  isolation). Partial binding is a type error to prevent the silent
   *  input-freeze / stale-value desync that independent optionals would
   *  allow. */
} & (
  | { draft: string; setDraft: (value: string) => void }
  | { draft?: never; setDraft?: never }
);

// Natural-language question entry (PRD #1, issue #22). A blank or in-flight
// submit is ignored client-side; the orchestrator runs one turn at a time
// (ADR-0021 single in-flight). While a turn runs the input is disabled and a
// stop button replaces the submit so the user can cancel the in-flight query.
// The in-flight turn's wait feedback lives on the rail's activity line (#1612
// re-host: the phase face + the turn clock) -- the bar carries no phase
// mirror. The whole bar's chrome (placeholder, aria-label, button labels)
// ships through the react-intl catalog (ADR-0052); see the questionBar.* keys.
//
// Unified composer container: a rounded border + shadow box. The input area
// flows the pre-activation chips inline with the textarea (the caret seats
// right after the last chip); a toolbar row at the bottom carries the
// composer slot controls (passed as children) on the left and the
// submit/stop button on the right. Enter submits (Shift+Enter inserts a
// newline).

// The skill picker panel's DOM id (ADR-0112): the textarea's aria-controls
// points at it while the panel is open, and the panel derives its option ids
// from it for the aria-activedescendant hand-off (focus never leaves the
// textarea).
const SKILL_PICKER_PANEL_ID = "question-bar-skill-picker";
/** The textarea's DOM id -- the shell's one anchor for seating focus on the
 *  composer (the create exit's focus hand-off, issue #1040). */
export const COMPOSER_INPUT_ID = "question-bar-input";
export function QuestionBar({ onSubmit, onCancel, loading, queued = false, draft, setDraft, children, trailing, skillPicker, quoteChips }: QuestionBarProps) {
  const intl = useIntl();
  const [localDraft, setLocalDraft] = useState("");
  const value = draft ?? localDraft;
  const setValue = setDraft ?? setLocalDraft;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const picker = useSkillPicker({
    onPick: skillPicker?.onPick ?? (() => {}),
    setValue,
    enabled: skillPicker !== undefined,
  });
  // The single narrowing point (issue #718): the snapshot's status is the
  // one judge of the panel's posture -- everything panel-shaped reads
  // `panel`, never a re-check of its own.
  const panel = picker.state.status === "open" ? picker.state : null;

  function submit() {
    // Submit materialization (#1573): the staged quotes serialize into the
    // question's leading blockquote block, prepended to the draft with a
    // blank line. A staging with an empty draft submits the quotes alone --
    // the chips ARE submission material (the button's enablement below
    // agrees).
    const prefix = materializeQuotes(quoteChips?.quotes ?? []);
    const q = (prefix === "" ? value : `${prefix}\n\n${value}`).trim();
    // A submit is a turn boundary: close an open picker panel first (its
    // trigger char + query ride along as plain text, the same as Esc).
    picker.close();
    // ADR-0021 single in-flight: a second submit while a turn runs is
    // ignored client-side (the input is also disabled, this is the
    // belt-and-suspenders guard). The queued posture joins the same guard
    // (#1500): a form-submit bypass while a question waits behind an ingest
    // batch must not fire out from under the pending slot.
    if (!q || loading || queued) return;
    onSubmit(q);
  }

  return (
    // ADR-0067 (issue #172): the .question-bar input/button visual rules
    // (focus outline, primary submit, outline cancel) retired into shadcn
    // Input + Button (default + outline variants). The .question-bar class
    // hook stays for selector / test stability. The unified container layout
    // (vertical: textarea on top, toolbar below) replaces the former flat
    // horizontal row.
    <form
      className="question-bar @container relative flex flex-col rounded-lg border border-border bg-card shadow-md"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {/* Input area: pre-activation chips flow inline with the draft -- they
          wrap as flex items and the textarea takes the remainder of the last
          row, so the caret seats right after the last chip. With no chips
          the textarea alone fills the row (the plain composer). */}
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1 px-3 pt-3 pb-2">
        {quoteChips?.node}
        {skillPicker?.chips.node}
        <textarea
          id={COMPOSER_INPUT_ID}
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            const next = e.target.value;
            const cursor = e.target.selectionStart ?? next.length;
            setValue(next);
            picker.handleChange(next, cursor);
          }}
          placeholder={intl.formatMessage({ id: "questionBar.placeholder", defaultMessage: "Ask in natural language…" })}
          aria-label={intl.formatMessage({ id: "questionBar.ariaLabel", defaultMessage: "Question" })}
          // Combobox semantics while the panel is open (the ARIA 1.2
          // combobox pattern): focus never leaves the textarea, so the
          // active-option hand-off rides aria-activedescendant HERE -- on
          // the focused element, where AT actually tracks it. Closed, the
          // textarea is a plain textbox again (no role override).
          role={panel ? "combobox" : undefined}
          aria-expanded={panel ? true : undefined}
          aria-controls={panel ? SKILL_PICKER_PANEL_ID : undefined}
          aria-haspopup={panel ? "listbox" : undefined}
          aria-autocomplete={panel ? "list" : undefined}
          aria-activedescendant={
            // The null highlight (empty filtered list) names no option --
            // the guard is the sentinel itself, not a row-count re-check.
            panel && panel.highlightIndex !== null
              ? skillPickerOptionId(SKILL_PICKER_PANEL_ID, panel.highlightIndex)
              : undefined
          }
          disabled={loading || queued}
          rows={3}
          className="min-w-40 flex-1 resize-none border-0 bg-transparent p-0 text-sm outline-none placeholder:text-muted-foreground focus:outline-none focus:ring-0 disabled:cursor-not-allowed disabled:opacity-50"
          onKeyDown={(e) => {
            // The pre-activation chips seat before the draft's first char:
            // with the caret at the very start and no selection, Backspace
            // withdraws the last chip like a text char (ADR-0112 Decision 3
            // removability). Native Backspace is inert at caret 0, so no
            // preventDefault is needed. Guarded on the panel being closed
            // (an open panel means a picker flow, and caret 0 is outside
            // its span) and on IME composition, matching the Enter paths.
            if (
              e.key === "Backspace" &&
              !panel &&
              !e.nativeEvent.isComposing &&
              e.currentTarget.selectionStart === 0 &&
              e.currentTarget.selectionEnd === 0
            ) {
              skillPicker?.chips.onBackspace();
            }
            // The picker consumes its keys first (ADR-0112): with the panel
            // open, Enter selects and Esc closes -- never submit. The
            // textarea keeps focus; it carries the combobox semantics and
            // names the highlighted row via aria-activedescendant.
            if (picker.handleKeyDown(e)) return;
            // Enter submits; Shift+Enter inserts a newline (standard chat
            // composer behavior). The form onSubmit is the belt-and-suspenders
            // guard for test-driven submit events.
            // Guard against IME composition confirmation (CJK input methods):
            // Enter confirms the in-progress composition, but isComposing is
            // still true on this keydown. Without the guard the raw pre-
            // composition value would be submitted prematurely.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          // Blur closes an open panel; the draft is untouched (the trigger
          // span stays plain text) and a re-focus does not reopen (ADR-0112
          // Decision 5).
          onBlur={picker.close}
        />
      </div>
      {/* The panel anchors to the bar itself (the form is the positioned
          ancestor) and floats above its top edge with a gap -- it never
          overlaps the composer, matching the reference surface. */}
      {panel && (
        <SkillPickerPanel
          id={SKILL_PICKER_PANEL_ID}
          mode={panel.mode}
          skills={panel.rows}
          query={panel.query}
          totalSkills={panel.totalSkills}
          registryError={panel.registryError}
          highlightIndex={panel.highlightIndex}
          onHoverIndex={picker.setHighlight}
          onSelect={(skill) =>
            picker.select(
              skill,
              value,
              textareaRef.current?.selectionStart ?? value.length,
            )}
        />
      )}
      {/* Toolbar row: composer controls (children) on the left, the
          submit/stop button on the right. */}
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <div className="flex items-center gap-1.5">
          {children}
        </div>
        {/* min-w-0 lets the trailing cluster shrink inside the
            justify-between row: without it the cluster's automatic minimum
            size locks to the posture label's content width and the whole
            cluster (label + runtime trigger + submit) paints past the bar's
            right border on narrow bars. */}
        <div className="flex min-w-0 items-center gap-2">
          {trailing}
          {queued && !loading && (
            // The queued posture's feedback slot (issue #1500), seated where
            // the retired wait-feedback slot sat (the turn wait feedback
            // moved to the rail's activity line, #1612): the held question
            // waits behind the queue window -- an ingest batch or a source
            // replace flight (#1512) -- and the copy describes the wait so
            // the disabled bar reads as intent, not a freeze. role="status"
            // + aria-live, carried over from the retired phase slot.
            //
            // One neutral tier for every window kind is the #1516 ruling,
            // not an oversight: the slot's exit contract is kind-agnostic
            // (auto-send on success, draft seed-back on failure); naming
            // the running task belongs to the progress surfaces (the rail
            // live region), not the bar; windows can overlap (a batch
            // alongside a replace flight) where a per-kind tier could not
            // say which is running; and per-kind copy would need a kind
            // mirror lifecycle-paired to the window host -- drift-prone
            // for zero copy gain.
            <span
              className="flex min-w-0 items-baseline text-[0.82rem] text-muted-foreground @max-[340px]:hidden"
              role="status"
              aria-live="polite"
            >
              <span className="truncate">
                {intl.formatMessage({
                  id: "questionBar.queued",
                  defaultMessage: "Queued until the current task finishes…",
                })}
              </span>
            </span>
          )}
          {loading ? (
            // Cancel is the only actionable control while a turn runs: the input is
            // disabled (single in-flight, ADR-0021), so submit would be inert. The
            // stop button fires the cancel token -> the in-flight ask lands as
            // Cancelled (ADR-0028 D). Outline circle with a filled square -- the
            // universal "stop" glyph. The sr-only span carries the accessible
            // name (NOT aria-label) so getByLabelText stays scoped to the
            // textarea whose aria-label is the same zh-CN word "提问".
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              className="size-8 shrink-0 rounded-full p-0"
            >
              <Square className="size-3.5 fill-current" aria-hidden />
              <span className="sr-only">
                {intl.formatMessage({ id: "common.stop", defaultMessage: "Stop" })}
              </span>
            </Button>
          ) : (
            // Primary submit: filled teal circle with an upward arrow (standard
            // chat-composer send glyph). The sr-only span carries the accessible
            // name (NOT aria-label) so getByLabelText stays scoped to the
            // textarea whose aria-label is the same zh-CN word "提问".
            <Button
              type="submit"
              disabled={value.trim() === "" && (quoteChips?.quotes.length ?? 0) === 0}
              className="size-8 shrink-0 rounded-full p-0"
            >
              <ArrowUp className="size-4" aria-hidden />
              <span className="sr-only">
                {intl.formatMessage({ id: "common.ask", defaultMessage: "Ask" })}
              </span>
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
