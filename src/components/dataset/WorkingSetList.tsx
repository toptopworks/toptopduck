import { useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useIntl, FormattedMessage } from "react-intl";
import { Pencil, RefreshCw, X } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { buttonVariants } from "../ui/button-variants";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "../ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";
import type { DatasetDescriptor } from "../../types/dataset";

// ADR-0067 (issue #184): the .working-set button rule (all: unset + cursor +
// padding + radius + display:block + width:100%) retired onto Tailwind
// utilities. Tailwind v4's Preflight already resets the button's background
// to transparent, inherits font/color, and zeroes margin/padding, so only the
// residual visual contract is re-stated here: strip the native border +
// appearance and set the var(--radius) corner. Issue #790 splits the former
// single full-width constant into the two row shapes below (select + icon).
// The hand cursor rides the select base only: the icon strip keeps the
// default arrow (the session-list pattern -- the hover highlight carries the
// affordance, no hand cursor on the icons).
const BUTTON_CHROME = "appearance-none border-0 rounded-md";
// The select button: fills the row's leftover width (flex-1 + min-w-0 so the
// label can truncate inside), compact padding, left alignment (UA button text
// is centered). Active state (bg-accent + font-semibold) layers on via cn()
// at the call site. The hover tint is NOT here: it lives on the row <li> (see
// below) so the pointer anywhere on the row -- the action pill included --
// lights the same full-height band. The hand cursor is NOT here either: it
// rides the label span (see below), so the button's exposed slivers (the
// padding bands, the gap beside the pill) keep the plain arrow -- a
// button-level pointer cursor made the cursor flap between hand and arrow
// while slowly edging into the action strip across those slivers.
const SELECT_BUTTON_BASE = `${BUTTON_CHROME} p-[0.4rem_0.5rem] flex-1 min-w-0 flex items-center gap-1 text-left`;
// The row-actions overlay: the rename/replace/delete actions sit in an
// absolutely-positioned pill anchored to the row's trailing edge, floating
// ABOVE the truncated label instead of reserving flow width -- an un-hovered
// row gives the label the full row width, and a hovered row reveals the pill
// over the label's tail (the session-list hover pattern; the select button's
// truncate point sits under the pill). The strip is packed tight -- no gap,
// no inlay: the 28px squares butt together into one compact bar (the glyphs
// keep ~7px of visual air inside their own hit areas). The pill is inset by
// the row's py (inset-y-[0.1rem]), matching the bg-clip-content band exactly:
// name band, active band and action strip all read at one height. The pill's
// ground is bg-accent -- the same tint a hovered row carries -- so the strip
// reads as part of the row rather than a floating widget (the
// border/shadow/card-ground floating form was tried and retired for exactly
// that reason); being opaque, it still keeps the label underneath from
// bleeding through. Visibility is the #865 hover-reveal contract moved one
// level up: the CONTAINER owns opacity-0 + pointer-events-none, restored on
// row hover (group-hover) or keyboard focus-visible -- any tabbed-into
// action lights the whole pill. Keyboard recovery keys off
// has-[:focus-visible] rather than focus-within: closing a dialog restores
// focus to the opening button, and a focus-WITHIN pill would glow forever
// after that restore even with the pointer parked elsewhere -- focus-visible
// is only set by real keyboard navigation, so the mouse flow closes clean.
// Tab order and aria-labels are untouched; `invisible` stays rejected (it
// drops the buttons from the a11y tree). Show/hide snaps (no transition): a
// per-row 150ms fade cross-fades the outgoing row's icons with the incoming
// row's on every row-to-row sweep, which reads as the strip flashing.
// Known trade: on a stale row the revealed pill covers the trailing Stale
// chip while hovered -- the chip's tooltip and un-hovered visibility are
// untouched.
const ROW_ACTIONS_OVERLAY = `absolute inset-y-[0.1rem] right-1 z-10 flex items-center gap-0 rounded-md bg-accent opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto has-[:focus-visible]:opacity-100 has-[:focus-visible]:pointer-events-auto`;
// The per-row icon actions (issue #790): a 28px square hit area (h-7 w-7)
// wrapping a 14px glyph -- the #774 header-chrome spec. Visibility is owned
// by the ROW_ACTIONS_OVERLAY container (see above); the buttons carry only
// the per-icon emphasis: the glyph rests muted and highlights to foreground
// on hover / keyboard focus -- on the pill's accent ground there is no
// further background tint to layer (a hover:bg-accent would be invisible
// against it), so color alone marks the hot icon. The cursor stays the
// default arrow (see BUTTON_CHROME); the loading state rides
// disabled:cursor-progress alone: the former disabled:opacity-50 dimming was
// retired with the weak-visibility form in #865, because a dim layered over
// opacity-0 would resurface every row's disabled actions mid-load.
const ICON_BUTTON_BASE = `${BUTTON_CHROME} h-7 w-7 flex items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-progress`;
// The openTip keys of the pointer-driven action hints (see setTip): while one
// of these owns the row's tooltip slot, a late open request from a hoverable
// trigger's leftover timer is rejected.
const HINT_ACTION_SUFFIXES = new Set([":rename", ":replace", ":delete"]);

// Rename dialog (issue #759, ADR-0037): display label only -- the reference
// name is never touched, so selection / SQL / active references all stay
// valid. The shell is a Radix Dialog (issue #105 lineage): portal + focus-trap
// + scroll-lock + ESC + overlay-click dismiss come from the primitive, and ESC
// / overlay-click route to onCancel via onOpenChange. showCloseButton={false}
// lets Radix auto-focus the Input (the RenameSessionDialog pattern);
// aria-describedby={undefined} opts out of a Description (the visible Label
// already names the field), which also silences Radix's missing-description
// warning. The submit guard expresses the old window.prompt's blank / no-change
// ignore: Save stays disabled while the trimmed draft is blank or still the
// current display name, so onSubmit can only fire with a real, trimmed label.
// Submit closes immediately (the parent's async rename runs after; a backend
// rejection -- display-label collision -- surfaces via the existing error
// channel, same as the native prompt's "dialog gone, async after" shape).
function WorkingSetRenameDialog({
  target,
  onCancel,
  onSubmit,
}: {
  target: DatasetDescriptor;
  onCancel: () => void;
  onSubmit: (newDisplay: string) => void;
}) {
  const [value, setValue] = useState(target.display_name);
  const trimmed = value.trim();
  const canSubmit = trimmed !== "" && trimmed !== target.display_name;
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent showCloseButton={false} aria-describedby={undefined}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) onSubmit(trimmed);
          }}
          className="grid gap-4"
        >
          <DialogTitle>
            <FormattedMessage id="workingSet.rename.title" defaultMessage="Rename" />
          </DialogTitle>
          <div className="grid gap-2">
            <Label htmlFor="working-set-rename-input">
              <FormattedMessage id="common.displayName" defaultMessage="Display name" />
            </Label>
            <Input
              id="working-set-rename-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={onCancel}>
              <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              <FormattedMessage id="common.save" defaultMessage="Save" />
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Delete dialog (issue #759, ADR-0040): the AlertDialog shell keeps the old
// window.confirm's semantics -- the title names the display name, confirm
// removes, cancel is a no-op -- and adds the irreversibility description
// (deletion drops the reference name from the shared namespace; any SQL FROM
// it will fail, and the file must be re-uploaded). Dismiss is explicit-only
// (issue #105 destructive-confirm intent, same as ActiveSourceDeleteDialog):
// the AlertDialog primitive blocks pointer-outside interactions itself, and
// the onEscapeKeyDown guard below blocks ESC too (the primitive does NOT --
// an unguarded AlertDialog still closes on ESC). An irreversible removal must
// go through 取消 / 删除. The Action closes on click (Radix auto-close, NO
// preventDefault -- the deferred-close retry pattern stays with
// ActiveSourceDeleteDialog's candidate flow): the parent's async remove runs
// after the dialog is gone, and a backend refusal (active source, results
// exist) surfaces via the existing error channel. The destructive variant
// marks the irreversible action (DESIGN.md).
function WorkingSetDeleteDialog({
  target,
  onCancel,
  onConfirm,
}: {
  target: DatasetDescriptor;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog defaultOpen>
      <AlertDialogContent onEscapeKeyDown={(e) => e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <FormattedMessage
              id="workingSet.delete.confirm"
              defaultMessage="Remove {name} from the working set?"
              values={{ name: target.display_name }}
            />
          </AlertDialogTitle>
          <AlertDialogDescription>
            <FormattedMessage
              id="workingSet.delete.description"
              defaultMessage="The source file is removed and its reference name is dropped from the shared namespace — any SQL reading from it will fail. This cannot be undone; the file must be re-uploaded to restore the source."
            />
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>
            <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
          </AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            onClick={onConfirm}
          >
            <FormattedMessage id="common.delete" defaultMessage="Delete" />
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function WorkingSetList({
  datasets,
  activeName,
  onSelect,
  onRename,
  onReplace,
  onDelete,
  loading = false,
}: {
  datasets: DatasetDescriptor[];
  activeName: string | null;
  onSelect: (referenceName: string) => void;
  // Display-only rename (ADR-0037, issue #8): the reference name is never
  // touched, so selection / SQL / active references all stay valid.
  onRename: (referenceName: string, newDisplay: string) => void;
  // Re-upload a file onto this dataset's reference name (ADR-0042, issue #11):
  // a fresh snapshot takes over the name. Distinct from the dropzone's add --
  // the reference name to take over is explicit. Structured files only (the
  // backend rejects xlsx in this slice), so the picker excludes xlsx to match,
  // keeping the two entries (add vs replace) visually distinct (AC4). Optional
  // only so tests that don't exercise replace can skip it; App always supplies
  // it, and the button is hidden when it is absent (no silent no-op).
  onReplace?: (referenceName: string, path: string) => void;
  // Remove a source from the working set (issue #38, ADR-0040). The backend
  // detaches the snapshot, deletes its file, drops the reference name, and
  // appends a Deleted source lifecycle event. Optional only so tests that don't
  // exercise delete can skip it; App always supplies it, and the button is
  // hidden when it is absent (no silent no-op).
  onDelete?: (referenceName: string) => void;
  // Disables the action buttons while an async op (rename / ingest / replace /
  // delete) is in flight OR while a turn is in flight (ADR-0040 execution
  // window: ask in flight -> source management disabled), preventing concurrent
  // IPC and source-vs-turn interleaving.
  loading?: boolean;
}) {
  const intl = useIntl();
  // Which row's rename / delete dialog is open (issue #759). The dialogs
  // mount/unmount on these targets, so each open starts from fresh draft state.
  const [renameTarget, setRenameTarget] = useState<DatasetDescriptor | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DatasetDescriptor | null>(null);
  // SINGLE-SOURCE tooltip mutex for a row: every tooltip on the row (name,
  // the three action hints, stale) is controlled off this one value, so a
  // second tooltip opening necessarily closes the first. Radix's own
  // tooltip.open broadcast cannot be relied on here: the action hints are
  // opened by our own pointer-enter -- bypassing Radix's trigger path, which
  // gates every open behind the provider-wide isPointerInTransit flag that a
  // HOVERABLE tooltip (the name tooltip, kept hoverable so the full display
  // name stays copyable) sets while the pointer crosses its exit grace area
  // -- and a controlled open never broadcasts. Each Tooltip therefore bridges
  // Radix's internal open/close intent (delayed-open timers, grace-area
  // keeps) through onOpenChange into this state; the action hints keep their
  // direct pointer-enter/-leave/focus/-blur handlers on top of it.
  const [openTip, setOpenTip] = useState<string | null>(null);
  // Closing a dialog lifts Radix's modal pointer-events lock on <body>, and
  // Chromium answers that by re-dispatching a pointer enter at the pointer's
  // current position -- which re-opens the hint that was showing before the
  // click. Hints ignore pointer enters within 300ms of a dialog close; real
  // pointer travel always arrives later than that.
  const dialogClosedAtRef = useRef(0);
  // True while closeDialog's programmatic focus restore is in flight: that
  // restore is not user navigation, so it must not re-open a hint (the
  // keyboard heuristic makes the restored focus :focus-visible).
  const focusRestoreRef = useRef(false);
  const setTip = (key: string, next: boolean) =>
    setOpenTip((current) => {
      if (!next) return current === key ? null : current;
      // A late delayed-open from a hoverable trigger (name/stale open through
      // Radix's cancellable setTimeout) must not steal the slot back once an
      // action hint owns it: on a fast downward sweep that timer fires after
      // the pointer has already claimed the slot with an action hint, and the
      // stale request would flip the row back to the name tooltip while the
      // pointer sits on an icon. Real triggers always clear their slot on
      // pointer-leave before the next one opens, so the only requests this
      // guard rejects are exactly those timer leftovers.
      if (
        current !== null &&
        current !== key &&
        HINT_ACTION_SUFFIXES.has(current.slice(current.lastIndexOf(":")))
      ) {
        return current;
      }
      return key;
    });
  // The row button that opened the dialog. Radix's close-time focus restore
  // targets the DialogTrigger context ref, but the openers here are the list's
  // per-row buttons (not DialogTrigger), so the restore is wired by hand:
  // captured on open, re-focused on close (issue #759 focus-management AC).
  const openTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Fallback restore target for the action-close paths (see closeDialog): the
  // list container is focusable programmatically only (tabIndex -1), so a
  // disabled opener does not strand keyboard focus on <body>.
  const listRef = useRef<HTMLUListElement | null>(null);
  const closeDialog = (clear: () => void) => {
    dialogClosedAtRef.current = Date.now();
    clear();
    // Deferred past the focus trap: while the scope is still mounted the trap
    // re-focuses the dialog content on any focus-out, and Radix's own
    // unmount-time restore (also a setTimeout(0)) targets a DialogTrigger ref
    // the list's per-row buttons never fill. Restoring on the same tick order
    // lands the close back on the opener. On Save / Delete-confirm the
    // mutation's loading gate has already disabled the opener (onRename /
    // onDelete fire before the close and runSimpleMutation sets loading
    // synchronously, batched into this same commit), and focus() on a
    // disabled button is ignored -- fall back to the list so keyboard users
    // keep a place in the working-set region.
    setTimeout(() => {
      focusRestoreRef.current = true;
      const trigger = openTriggerRef.current;
      if (trigger && trigger.isConnected && !trigger.disabled) {
        trigger.focus();
      } else {
        listRef.current?.focus();
      }
      // The focus handler consumed the flag synchronously if the restore
      // landed; clear it regardless so a later real Tab isn't suppressed.
      setTimeout(() => {
        focusRestoreRef.current = false;
      }, 0);
    }, 0);
  };
  const closeRename = () => closeDialog(() => setRenameTarget(null));
  const closeDelete = () => closeDialog(() => setDeleteTarget(null));
  const openRename = (d: DatasetDescriptor, trigger: HTMLButtonElement) => {
    openTriggerRef.current = trigger;
    setRenameTarget(d);
  };
  const openDelete = (d: DatasetDescriptor, trigger: HTMLButtonElement) => {
    openTriggerRef.current = trigger;
    setDeleteTarget(d);
  };

  // The empty set never reaches this list: WorkspaceWorkingSet renders the
  // single empty-state card instead (issue #792), so the two-column shell and
  // this list mount only for a non-empty set.

  // Pick a structured file to swap in under this dataset's reference name. The
  // picker excludes .xlsx on purpose: the backend's replace path is structured-
  // only, so this keeps the two entries (add vs replace) visually distinct and
  // avoids offering a choice the backend would then reject.
  const pickReplace = async (d: DatasetDescriptor) => {
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: intl.formatMessage({ id: "workingSet.fileFilter", defaultMessage: "Data files" }),
          extensions: ["csv", "parquet", "json", "jsonl", "ndjson"],
        },
      ],
    });
    if (typeof selected === "string") {
      onReplace?.(d.reference_name, selected);
    }
  };

  return (
    // ADR-0067 (issue #184): the working-set list / button / active-state /
    // small visuals ride Tailwind utility on each element below + the
    // BUTTON_CHROME-derived constants above (select + icon actions, issue
    // #790). The active STATE drives the select button's own conditional
    // className (bg-accent + font-semibold). The class hooks (.working-set /
    // .rename / .replace / .delete / .active / .stale) stay on the elements as
    // anchor points for selector queries and future migration slices.
    <>
      <ul ref={listRef} tabIndex={-1} className="working-set list-none m-0 p-0 outline-none">
        {datasets.map((d) => (
          // One horizontal row per dataset (issue #790): the select button
          // fills the row and the icon actions ride the ROW_ACTIONS_OVERLAY
          // pill floating over the label's tail; `relative` is the pill's
          // anchor and `group` is the hover hook its hover-reveal keys off
          // (#865). The hover tint lives HERE on the li, not on the select
          // button: the pointer anywhere on the row -- pill included -- lights
          // one full-height band, and the pill's accent ground merges into it.
          // The band draws INSIDE the padding (bg-clip-content): the li still
          // spans the full row pitch so hover never drops between rows, but
          // the painted band is inset by the padding on both edges -- two
          // adjacent accent rows keep a visible gutter instead of fusing into
          // one slab.
          // The band switches INSTANTLY (no transition-colors): a 150ms fade
          // on each row means a row-to-row sweep cross-fades two bands at
          // once, which reads as the strip flashing on every crossing.
          // A stale dataset renders its short chip after the overlay
          // in flow order (issue #793 retired the #790 basis-full badge +
          // flex-wrap second line -- the chip is an inline shrink-0 peer, so
          // the row stays one flex line at any column width; a hovered row's
          // pill covers it, see the overlay's trade note).
          <li
            key={d.reference_name}
            className={cn(
              "group relative flex items-center gap-1 rounded-md py-[0.1rem] bg-clip-content hover:bg-accent",
              d.reference_name === activeName && "active bg-accent bg-clip-content",
              d.stale && "stale",
            )}
          >
            <button
              type="button"
              className={cn(
                SELECT_BUTTON_BASE,
                d.reference_name === activeName && "font-semibold",
              )}
              onClick={() => onSelect(d.reference_name)}
            >
              {/* The truncated label's full text rides the app-standard Radix
                  tooltip (the ADR-0050/0054 truncation-recovery mapping,
                  #865), with the trigger on the LABEL SPAN rather than the
                  whole button: the action pill floats over the button's tail,
                  and a pointer crossing the pill's edges / the button's
                  exposed slivers would otherwise pop the name tooltip. On the
                  span, the tooltip fires on the name text alone and stays
                  mutually exclusive with the action strip. */}
              <Tooltip
                open={openTip === `${d.reference_name}:name`}
                onOpenChange={(next) => setTip(`${d.reference_name}:name`, next)}
                disableHoverableContent
              >
                <TooltipTrigger asChild>
                  <span
                    className="min-w-0 flex-1 truncate"
                    // Same controlled pattern as the action hints: Radix's own
                    // trigger path is refused (preventDefault in the composed
                    // handler -- its open rides the provider's
                    // instant/delayed flip-flop that a sweep can cancel), and
                    // our pointer handlers open/close directly. Enter opens
                    // immediately, leave closes immediately
                    // (disableHoverableContent -- no bridge), so the name
                    // tooltip behaves exactly like the action hints.
                    onPointerEnter={(e) => {
                      e.preventDefault();
                      if (e.pointerType === "mouse") setTip(`${d.reference_name}:name`, true);
                    }}
                    onPointerLeave={(e) => {
                      e.preventDefault();
                      setTip(`${d.reference_name}:name`, false);
                    }}
                  >
                    {d.display_name}
                  </span>
                </TooltipTrigger>
                {/* sideOffset lifts the content clear of the row: at 0 it
                    sits flush on the span and its bottom edge overlaps the
                    li's top band -- a pointer slowly crossing that band
                    flips the hit-test between the tooltip and the row,
                    dropping :hover (band + action pill) and lighting it
                    again on every pass. The content is pointer-transparent
                    like the action hints: pure display, no hit-testing. */}
                <TooltipContent sideOffset={8} className="pointer-events-none data-[state=closed]:animate-none!">
                  {d.display_name}
                </TooltipContent>
              </Tooltip>
              {/* font-normal overrides the active button's font-semibold so
                  the row-count annotation stays muted-weight in either
                  state; shrink-0 + nowrap keep truncation from ever
                  eliding the note. text-xs pins the caption token: the
                  preflight small rule (80%) would resolve an unsized small
                  at 11.2px under the panel's 14px baseline (issue #864) --
                  below the ladder's 12px floor. */}
              <small className="shrink-0 whitespace-nowrap text-xs text-muted-foreground font-normal">
                {" "}
                <FormattedMessage
                  id="workingSet.rowCount"
                  defaultMessage="{count, plural, one {# row} other {# rows}}"
                  values={{ count: d.row_count }}
                />
              </small>
            </button>
            {/* The action pill (ROW_ACTIONS_OVERLAY): floats over the label's
                tail; Radix Tooltip renders no DOM wrapper of its own, so the
                pill div is the buttons' direct flex parent and the focus-within
                hook sees each tabbed-into action. Each hint sets
                disableHoverableContent: these are terse, non-copyable labels,
                and Radix's default invisible hover bridge (over the gap and
                the content box) holds the tooltip open after the pointer has
                left the icon -- the closed tooltip then shadows the row above.
                The long-form tooltips (full display name, stale sentence) keep
                the default hoverable content for reading / copying. */}
            <div className={ROW_ACTIONS_OVERLAY}>
              <Tooltip
                open={openTip === `${d.reference_name}:rename`}
                onOpenChange={(next) => setTip(`${d.reference_name}:rename`, next)}
                disableHoverableContent
              >
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={cn(ICON_BUTTON_BASE, "rename")}
                    aria-label={intl.formatMessage(
                      { id: "workingSet.rename.ariaLabel", defaultMessage: "Rename {name}" },
                      { name: d.display_name },
                    )}
                    disabled={loading}
                    onPointerEnter={(e) => {
                      if (e.pointerType === "mouse" && Date.now() - dialogClosedAtRef.current > 300)
                        setTip(`${d.reference_name}:rename`, true);
                    }}
                    onPointerLeave={() => setTip(`${d.reference_name}:rename`, false)}
                    onFocus={(e) => {
                      // Radix's own trigger wiring opens the tooltip on any
                      // focus (composeEventHandlers skips it when the
                      // user handler preventDefaults): the dialog-close
                      // focus restore must not re-open the hint.
                      e.preventDefault();
                      if (e.target.matches(":focus-visible") && !focusRestoreRef.current)
                        setTip(`${d.reference_name}:rename`, true);
                    }}
                    onBlur={() => setTip(`${d.reference_name}:rename`, false)}
                    onClick={(e) => {
                      setTip(`${d.reference_name}:rename`, false);
                      openRename(d, e.currentTarget);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="pointer-events-none data-[state=closed]:animate-none!">
                  {intl.formatMessage({ id: "workingSet.rename.title", defaultMessage: "Rename" })}
                </TooltipContent>
              </Tooltip>
              {onReplace && (
                <Tooltip
                  open={openTip === `${d.reference_name}:replace`}
                  onOpenChange={(next) => setTip(`${d.reference_name}:replace`, next)}
                  disableHoverableContent
                >
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn(ICON_BUTTON_BASE, "replace")}
                      aria-label={intl.formatMessage(
                        { id: "workingSet.replace.ariaLabel", defaultMessage: "Replace source {name}" },
                        { name: d.display_name },
                      )}
                      disabled={loading}
                      onPointerEnter={(e) => {
                        if (e.pointerType === "mouse" && Date.now() - dialogClosedAtRef.current > 300)
                          setTip(`${d.reference_name}:replace`, true);
                      }}
                      onPointerLeave={() => setTip(`${d.reference_name}:replace`, false)}
                      onFocus={(e) => {
                        e.preventDefault();
                        if (e.target.matches(":focus-visible") && !focusRestoreRef.current)
                          setTip(`${d.reference_name}:replace`, true);
                      }}
                      onBlur={() => setTip(`${d.reference_name}:replace`, false)}
                      onClick={() => {
                        setTip(`${d.reference_name}:replace`, false);
                        void pickReplace(d);
                      }}
                    >
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="pointer-events-none data-[state=closed]:animate-none!">
                    {intl.formatMessage({
                      id: "workingSet.replace.title",
                      defaultMessage: "Replace",
                    })}
                  </TooltipContent>
                </Tooltip>
              )}
              {onDelete && (
                <Tooltip
                  open={openTip === `${d.reference_name}:delete`}
                  onOpenChange={(next) => setTip(`${d.reference_name}:delete`, next)}
                  disableHoverableContent
                >
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn(ICON_BUTTON_BASE, "delete")}
                      aria-label={intl.formatMessage(
                        { id: "workingSet.delete.ariaLabel", defaultMessage: "Delete {name}" },
                        { name: d.display_name },
                      )}
                      disabled={loading}
                      onPointerEnter={(e) => {
                        if (e.pointerType === "mouse" && Date.now() - dialogClosedAtRef.current > 300)
                          setTip(`${d.reference_name}:delete`, true);
                      }}
                      onPointerLeave={() => setTip(`${d.reference_name}:delete`, false)}
                      onFocus={(e) => {
                        e.preventDefault();
                        if (e.target.matches(":focus-visible") && !focusRestoreRef.current)
                          setTip(`${d.reference_name}:delete`, true);
                      }}
                      onBlur={() => setTip(`${d.reference_name}:delete`, false)}
                      onClick={(e) => {
                        setTip(`${d.reference_name}:delete`, false);
                        openDelete(d, e.currentTarget);
                      }}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="pointer-events-none data-[state=closed]:animate-none!">
                    {intl.formatMessage({
                      id: "workingSet.delete.title",
                      defaultMessage: "Delete",
                    })}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            {d.stale && (
              // #793: a short chip with the full causal sentence on the
              // tooltip -- the sentence used to wrap inside the badge and
              // break the chip shape in narrow columns (#865 moved it from
              // the OS-native title to the theme-following Radix tooltip). No
              // action outlet here: the rerun path lives with the result
              // panel's stale banner (#758).
              <Tooltip
                open={openTip === `${d.reference_name}:stale`}
                onOpenChange={(next) => setTip(`${d.reference_name}:stale`, next)}
              >
                <TooltipTrigger asChild>
                  <Badge variant="secondary" className="stale-badge shrink-0">
                    <FormattedMessage id="workingSet.staleRow" defaultMessage="Stale" />
                  </Badge>
                </TooltipTrigger>
                <TooltipContent className="pointer-events-none data-[state=closed]:animate-none!">
                  {intl.formatMessage(
                    {
                      id: "workingSet.staleRow.title",
                      defaultMessage:
                        "Invalidated because {name} was {reason, select, Deleted {deleted} Replaced {updated} other {changed}}",
                    },
                    { name: d.stale.display_name, reason: d.stale.reason },
                  )}
                </TooltipContent>
              </Tooltip>
            )}
          </li>
        ))}
      </ul>
      {renameTarget && (
        <WorkingSetRenameDialog
          target={renameTarget}
          onCancel={closeRename}
          onSubmit={(newDisplay) => {
            onRename(renameTarget.reference_name, newDisplay);
            closeRename();
          }}
        />
      )}
      {deleteTarget && (
        <WorkingSetDeleteDialog
          target={deleteTarget}
          onCancel={closeDelete}
          onConfirm={() => {
            onDelete?.(deleteTarget.reference_name);
            closeDelete();
          }}
        />
      )}
    </>
  );
}
