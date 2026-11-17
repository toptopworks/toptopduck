import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useIntl, FormattedMessage } from "react-intl";
import { Pencil, RefreshCw, Trash2, X } from "lucide-react";
import { Badge } from "../ui/badge";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../ui/context-menu";
import { Button } from "../ui/button";
import { buttonVariants } from "../ui/button-variants";
import { DeleteImpactList } from "./DeleteImpactList";
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
import {
  sameTipKey,
  useRowHints,
  type RowTipControls,
  type RowTipKind,
  type TipKey,
} from "./rowHints";
import { cn } from "../../lib/utils";
import type { DatasetDescriptor, WorkingSetRow } from "../../types/dataset";

// ADR-0067 (issue #184): the .working-set button rule (all: unset + cursor +
// padding + radius + display:block + width:100%) retired onto Tailwind
// utilities. Tailwind v4's Preflight already resets the button's background
// to transparent, inherits font/color, and zeroes margin/padding, so only the
// residual visual contract is re-stated here: strip the native border +
// appearance and set the var(--radius) corner. Issue #790 splits the former
// single full-width constant into the two row shapes below (select + icon).
// Both shapes take the app.css base hand (button:not(:disabled)) with no
// per-shape cursor class -- the hand is the default, and where the pill
// overlaps the select button's tail the cursor stays one continuous hand.
const BUTTON_CHROME = "appearance-none border-0 rounded-md";
// The select button: fills the row's leftover width (flex-1 + min-w-0 so the
// label can truncate inside), compact padding, left alignment (UA button text
// is centered). The active dataset's font-semibold emphasis layers on via
// cn() at the call site. The selection band and the hover tint are NOT here:
// both live on the row <li> (see DatasetRow) so the pointer anywhere on the
// row -- the action pill included -- lights the same full-height band. The
// row's content splits left/right inside the button: the label plus its
// S/M / stale chips hug the left (the label truncates first -- min-w-0, no
// grow), the row count pins to the far right (ml-auto) and is the pill's
// only cover target on hover -- the session sidebar row's
// actions-over-timestamp posture.
const SELECT_BUTTON_BASE = `${BUTTON_CHROME} p-[0.4rem_0.5rem] flex-1 min-w-0 flex items-center gap-1 text-left`;
// The row-actions overlay: the rename/replace/delete actions sit in an
// absolutely-positioned pill anchored inside the label-tail wrapper (the
// flow child holding the select button, see DatasetRow), floating ABOVE the
// row-count zone -- an un-hovered row gives the count the row tail (the
// S/M / stale chips hug the label's tail, far from the strip), and a
// hovered row reveals the pill OVER the count while the
// count fades out under the same reveal conditions (the session sidebar
// row's actions-over-timestamp posture; the pill has no ground, so a visible
// count would peek through between the icons). The strip is
// packed tight -- no gap, no inlay: the 28px squares butt together into one
// compact bar (the glyphs keep ~7px of visual air inside their own hit
// areas). The wrapper spans exactly the row's bg-clip-content band (the li's
// py frames it), so inset-y-0 puts hover band, selected band and action
// strip all at one height. The pill carries NO ground of its own: the
// hover band underneath (the li's transit tint) shows straight through, so
// the strip reads as part of the row rather than a floating widget -- a
// translucent pill would double-tint over the band, and an opaque one can
// never match an alpha band. When the count is narrower than the strip
// (short counts), the pill's left edge lands on the truncated label's tail
// -- the same under-the-pill truncate point the sidebar row carries;
// hover-transient, accepted. The working-set-row-actions class hook is what
// the count's has() hide leg scopes to (keep in sync with the small below).
// Visibility is the #865 hover-reveal
// contract moved one
// level up: the CONTAINER owns opacity-0 + pointer-events-none, restored on
// row hover (group-hover) or keyboard focus-visible -- any tabbed-into
// action lights the whole pill. Keyboard recovery keys off
// has-[:focus-visible] rather than focus-within: closing a dialog restores
// focus to the opening button, and a focus-WITHIN pill would glow forever
// after that restore even with the pointer parked elsewhere -- focus-visible
// follows the keyboard heuristic, which a script restore after a keyboard
// dialog flow still matches (that window is what the row-hint focus-restore
// gate suppresses, see rowHints.ts), so the mouse flow closes clean. Tab
// order and aria-labels are untouched; `invisible` stays rejected (it drops
// the buttons from the a11y tree). Show/hide snaps (no transition): a
// per-row 150ms fade cross-fades the outgoing row's icons with the incoming
// row's on every row-to-row sweep, which reads as the strip flashing.
const ROW_ACTIONS_OVERLAY = `working-set-row-actions absolute inset-y-0 right-1 z-10 flex items-center gap-0 rounded-md opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto has-[:focus-visible]:opacity-100 has-[:focus-visible]:pointer-events-auto`;
// The per-row icon actions (issue #790): a 28px square hit area (h-7 w-7)
// wrapping a 14px glyph -- the #774 header-chrome spec. Visibility is owned
// by the ROW_ACTIONS_OVERLAY container (see above); the buttons carry only
// the per-icon emphasis: the glyph rests muted and highlights to foreground
// on hover / keyboard focus -- on the pill's transit ground there is no
// further background tint to layer (a hover:bg-transit would be invisible
// against it), so color alone marks the hot icon. The hand rides the
// app.css base rule; the loading state dims like every
// other action surface (disabled:opacity-50, the sidebar / result forms) --
// the pill container owns visibility, so the dim only marks the one hovered
// row's mid-load state.
const ICON_BUTTON_BASE = `${BUTTON_CHROME} h-7 w-7 flex items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-progress disabled:opacity-50`;

// One row-action icon button + its controlled hint tooltip (the shared shape
// of rename / replace / delete): the pointer / focus / Radix entries below
// are the guarded open paths of the row-hint protocol (rowHints.ts sequences
// 2-3), pointer-leave / blur / activation close the hint, and activation
// hands to the caller on a clean slot. disableHoverableContent: terse
// non-copyable labels -- Radix's invisible hover bridge would hold the
// tooltip open after the pointer has left the icon and shadow the row above.
function RowActionButton({
  hintKey,
  open,
  tip,
  title,
  ariaLabel,
  actionClass,
  icon,
  disabled,
  onActivate,
}: {
  hintKey: TipKey;
  open: boolean;
  tip: RowTipControls;
  title: string;
  ariaLabel: string;
  actionClass: string;
  icon: ReactNode;
  disabled: boolean;
  onActivate: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
  const { setTip, pointerEnter, focusOpen, hintOpenChange } = tip;
  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => hintOpenChange(hintKey, next)}
      disableHoverableContent
    >
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(ICON_BUTTON_BASE, actionClass)}
          aria-label={ariaLabel}
          disabled={disabled}
          onPointerEnter={(e) => pointerEnter(hintKey, e.pointerType)}
          onPointerLeave={() => setTip(hintKey, false)}
          onFocus={(e) => focusOpen(hintKey, e.target)}
          onBlur={() => setTip(hintKey, false)}
          onClick={(e) => {
            setTip(hintKey, false);
            onActivate(e);
          }}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent
        data-hit-transparent
        className="pointer-events-none data-[state=closed]:animate-none!"
      >
        {title}
      </TooltipContent>
    </Tooltip>
  );
}

// One working-set row: the select button (label + S/M / stale badges + row
// count inside it), the floating action pill (rename / replace / delete via
// RowActionButton), and the row-level sr-only described-by carriers. See
// the constants above for the band / pill / icon contracts and rowHints.ts
// for the row-tooltip mutex the hints share.
function DatasetRow({
  d,
  isActive,
  isSelected,
  loading,
  tip,
  extraBadge,
  onSelect,
  onOpenRename,
  onOpenDelete,
  onPickReplace,
}: {
  d: WorkingSetRow;
  // The ACTIVE dataset (server truth): bolds the label. The accent band is
  // NOT this state's -- it follows the selection (see isSelected), since a
  // management click must move the highlight with the detail pane.
  isActive: boolean;
  // The detail pick: which row's detail the right pane shows. Puts the
  // accent band on the row -- the same element that carries the hover band,
  // so a picked row and a hovered row read at exactly the same height.
  isSelected: boolean;
  loading: boolean;
  tip: RowTipControls;
  // An optional extra marker at the row's tail, after the label-tail
  // wrapper (the right-sidebar panel flags a missing store file here); the
  // private face passes none.
  extraBadge?: ReactNode;
  onSelect: (referenceName: string) => void;
  // The trigger argument is the focus-restorable opener element: the pill
  // button on the pointer path, the row <li> on the context-menu path.
  onOpenRename: (d: DatasetDescriptor, trigger: HTMLElement) => void;
  onOpenDelete?: (d: DatasetDescriptor, trigger: HTMLElement) => void;
  onPickReplace?: (d: DatasetDescriptor) => void;
}) {
  const { openKey, setTip } = tip;
  const intl = useIntl();
  const key = (kind: RowTipKind): TipKey => ({ row: d.reference_name, kind });
  const isTipOpen = (kind: RowTipKind) => openKey !== null && sameTipKey(openKey, key(kind));
  // The stale causal sentence, formatted once for both consumers (#1062):
  // the tooltip's copy and the sr-only described-by carrier stay one
  // source, so the keyboard/AT path and the visual hover path can never
  // drift apart.
  const staleCause = d.stale
    ? intl.formatMessage(
        {
          id: "workingSet.staleRow.hint",
          defaultMessage:
            "Invalidated because {name} was {reason, select, Deleted {deleted} Replaced {updated} other {changed}}",
        },
        { name: d.stale.display_name, reason: d.stale.reason },
      )
    : undefined;
  // The origin face (issue #1597): the badge's short tooltip label and its
  // locale-neutral monogram letter as ONE mapping, so a future provenance
  // variant can never render a stale letter -- the two axes move together.
  // The label is formatted once for the tooltip AND the keyboard carrier
  // (the #1062 one-source pattern: the sr-only aria-describedby node at the
  // row level; the badge itself carries no aria-label). The long
  // cross-reference sentence (the de-conflicted alias arm) retired with the
  // letter swap -- the full origin stays on the detail face. An uploaded row
  // derives null -- no badge, the quiet default.
  const provenanceFace = (() => {
    switch (d.provenance) {
      case "shared":
        return {
          letter: "S",
          label: intl.formatMessage({
            id: "workingSet.provenance.sharedShort",
            defaultMessage: "Shared dataset",
          }),
        };
      case "materialized":
        return {
          letter: "M",
          label: intl.formatMessage({
            id: "workingSet.provenance.materializedShort",
            defaultMessage: "Materialized result",
          }),
        };
      case "uploaded":
      case undefined:
        // An uploaded row and the manifest face (a plain descriptor): no
        // badge, the quiet default.
        return null;
      default: {
        // Exhaustiveness guard: `d.provenance` narrows to never here, so a
        // future provenance variant is a compile error instead of a silent
        // badge gap (the ResumeProgress issue #205 posture).
        const unhandled: never = d.provenance;
        throw new Error(`Unhandled DatasetProvenance: ${JSON.stringify(unhandled)}`);
      }
    }
  })();
  // The keyboard/a11y carriers (#1062): the sentences live in sr-only nodes
  // at the row level and ride the select button's aria-describedby -- the
  // badges sit INSIDE the button (phrasing content, hugging the label), and
  // a tabIndex there would be an invalid interactive descendant. Described-by
  // keeps the sentence in the AT read on button focus without a nested tab
  // stop -- and without polluting the button's accessible name: the carriers
  // are button SIBLINGS, not button content.
  const originDescIds = [
    provenanceFace !== null ? `${d.reference_name}-origin-desc` : null,
    d.stale ? `${d.reference_name}-stale-desc` : null,
  ].filter((id): id is string => id !== null);
  // The context menu captures its target from the row it opens on (#1570):
  // the <li> is both the trigger and the focus-restorable opener element, so
  // the dialog-close restore lands back on the row (mirroring the pill
  // path's button capture). tabIndex -1 keeps the row out of the Tab
  // sequence while making the programmatic restore landable.
  const rowRef = useRef<HTMLLIElement | null>(null);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li
          ref={rowRef}
          tabIndex={-1}
          className={cn(
            "group relative flex items-center gap-1 rounded-md py-[0.1rem] bg-clip-content hover:bg-transit",
            isActive && "active",
            isSelected && "selected bg-accent hover:bg-accent",
            d.stale && "stale",
          )}
        >
          {/* The label-tail wrapper: the flow child filling the row's leftover
          width. It owns the select button AND the action pill's positioning
          anchor -- the pill's right edge lands over the row-count zone, the
          count hiding under the same reveal conditions (see the small below;
          the session sidebar's actions-over-timestamp posture). The wrapper
          spans the li's content box, i.e. exactly the bg-clip-content band. */}
          <div className="relative flex-1 min-w-0 flex">
            <button
              type="button"
              className={cn(SELECT_BUTTON_BASE, isActive && "font-semibold")}
              onClick={() => onSelect(d.reference_name)}
              aria-describedby={originDescIds.length > 0 ? originDescIds.join(" ") : undefined}
            >
              {/* The truncated label's full text rides the OS-native title:
            truncation recovery without any Radix machinery (no popper to
            keep pointer-transparent, no mutex slot, no open/close handlers).
            Unlike the action hints' theme-following Radix tooltips (#865
            rejected native titles there -- chrome follows the OS), the name
            surfaces only its own text, so the OS chrome costs nothing. The
            hand cursor on the button below no longer flips when the
            affordance surfaces -- a native title never touches the cursor. */}
              <span className="min-w-0 truncate" title={d.display_name}>
                {d.display_name}
              </span>
              {provenanceFace !== null && (
              // The origin badge (issue #1597): the single-letter S/M monogram
              // pill riding right after the label (never the row tail -- a
              // tail-side chip collides with the hover pill over narrow
              // counts). A plain, NON-interactive span: the tooltip is the
              // pointer path; the keyboard path rides the button's
              // aria-describedby via the row-level sr-only carrier (#1062) --
              // a tabIndex inside the button would be an invalid interactive
              // descendant. stopPropagation keeps a stray click on the
              // informational chip from selecting the row. The letter is a
              // hardcoded literal, not an i18n key: S/M are locale-neutral
              // monograms, so no catalog entry exists for them (the
              // delete-dialog precedent does not apply -- there is no message
              // here to translate). The rowHints mutex owns the open (the
              // "provenance" kind); the badge keeps no handlers of its own.
                <Tooltip open={isTipOpen("provenance")} onOpenChange={(next) => setTip(key("provenance"), next)}>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="secondary"
                      className="provenance-badge"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {provenanceFace.letter}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent
                    data-hit-transparent
                    className="pointer-events-none data-[state=closed]:animate-none!"
                  >
                    {provenanceFace.label}
                  </TooltipContent>
                </Tooltip>
              )}
              {d.stale && (
              // #793: a short chip with the full causal sentence on the tooltip --
              // the sentence used to wrap inside the badge and break the chip shape
              // in narrow columns. No action outlet here: the rerun path lives with
              // the result panel's stale banner (#758). Same non-interactive
              // posture as the origin badge: the keyboard path rides the
              // button's aria-describedby carrier (#1062), not a nested tab
              // stop; stopPropagation keeps the click from selecting the row.
              // The badge-variants base already carries shrink-0, so the call
              // site stays lean.
                <Tooltip open={isTipOpen("stale")} onOpenChange={(next) => setTip(key("stale"), next)}>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="secondary"
                      className="stale-badge"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <FormattedMessage id="workingSet.staleRow" defaultMessage="Stale" />
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent
                    data-hit-transparent
                    className="pointer-events-none data-[state=closed]:animate-none!"
                  >
                    {staleCause}
                  </TooltipContent>
                </Tooltip>
              )}
              {/* font-normal overrides the active button's font-semibold so the
            row-count annotation stays muted-weight in either state;
            shrink-0 + nowrap keep truncation from ever eliding the note.
            text-xs pins the caption token: the preflight small rule (80%)
            would resolve an unsized small at 11.2px under the panel's 14px
            baseline (issue #864) -- below the ladder's 12px floor. Pinned to
            the row's far right (ml-auto), alone on the tail -- the pill's
            only cover target. On hover -- or keyboard
            focus inside the action pill -- the count fades under the
            revealed pill: the pill has no ground, so a visible count would
            peek through between the icons (the sidebar timestamp posture).
            The has() leg scopes to the pill's working-set-row-actions hook
            (keep in sync with ROW_ACTIONS_OVERLAY above) so a focused badge
            or label never hides the count. */}
              <small className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground font-normal group-hover:opacity-0 group-has-[.working-set-row-actions_:focus-visible]:opacity-0">
                {" "}
                <FormattedMessage
                  id="workingSet.rowCount"
                  defaultMessage="{count, plural, one {# row} other {# rows}}"
                  values={{ count: d.row_count }}
                />
              </small>
            </button>
            {/* The action pill (ROW_ACTIONS_OVERLAY): floats over the label's
            tail inside the wrapper; Radix Tooltip renders no DOM wrapper of
            its own, so the pill div is the buttons' direct flex parent and
            the has-focus-visible hook sees each tabbed-into action. */}
            <div className={ROW_ACTIONS_OVERLAY}>
              <RowActionButton
                hintKey={key("rename")}
                open={isTipOpen("rename")}
                tip={tip}
                title={intl.formatMessage({ id: "common.rename", defaultMessage: "Rename" })}
                ariaLabel={intl.formatMessage(
                  { id: "workingSet.rename.ariaLabel", defaultMessage: "Rename {name}" },
                  { name: d.display_name },
                )}
                actionClass="rename"
                icon={<Pencil className="h-3.5 w-3.5" aria-hidden="true" />}
                disabled={loading}
                onActivate={(e) => onOpenRename(d, e.currentTarget)}
              />
              {onPickReplace && (
                <RowActionButton
                  hintKey={key("replace")}
                  open={isTipOpen("replace")}
                  tip={tip}
                  title={intl.formatMessage({
                    id: "workingSet.replace.hint",
                    defaultMessage: "Replace",
                  })}
                  ariaLabel={intl.formatMessage(
                    { id: "workingSet.replace.ariaLabel", defaultMessage: "Replace source {name}" },
                    { name: d.display_name },
                  )}
                  actionClass="replace"
                  icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
                  disabled={loading}
                  onActivate={() => onPickReplace(d)}
                />
              )}
              {onOpenDelete && (
                <RowActionButton
                  hintKey={key("delete")}
                  open={isTipOpen("delete")}
                  tip={tip}
                  title={intl.formatMessage({
                    id: "common.delete",
                    defaultMessage: "Delete",
                  })}
                  ariaLabel={intl.formatMessage(
                    { id: "workingSet.delete.ariaLabel", defaultMessage: "Delete {name}" },
                    { name: d.display_name },
                  )}
                  actionClass="delete"
                  icon={<X className="h-3.5 w-3.5" aria-hidden="true" />}
                  disabled={loading}
                  onActivate={(e) => onOpenDelete(d, e.currentTarget)}
                />
              )}
            </div>
          </div>
          {extraBadge}
          {/* The #1062 keyboard carriers: sr-only sentence nodes referenced
          by the select button's aria-describedby (see originDescIds). Row
          SIBLINGS, not button content -- a described-by target inside the
          button would join its accessible-name computation. */}
          {provenanceFace !== null && (
            <span id={`${d.reference_name}-origin-desc`} className="sr-only">
              {provenanceFace.label}
            </span>
          )}
          {d.stale && (
            <span id={`${d.reference_name}-stale-desc`} className="sr-only">
              {staleCause}
            </span>
          )}
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={d.display_name}>
        {/* Icon + text rows mirror the session-header menu's item shape
            (ADR-0093), and the labels reuse its catalog keys instead of a
            menu-specific namespace (delete rides Trash2 there, not X). */}
        <ContextMenuItem
          disabled={loading}
          onSelect={() => {
            if (rowRef.current) onOpenRename(d, rowRef.current);
          }}
        >
          <Pencil aria-hidden />
          <FormattedMessage id="common.rename" defaultMessage="Rename" />
        </ContextMenuItem>
        {onPickReplace && (
          <ContextMenuItem disabled={loading} onSelect={() => onPickReplace(d)}>
            <RefreshCw aria-hidden />
            <FormattedMessage id="workingSet.replace.hint" defaultMessage="Replace" />
          </ContextMenuItem>
        )}
        {onOpenDelete && (
          <ContextMenuItem
            disabled={loading}
            variant="destructive"
            onSelect={() => {
              if (rowRef.current) onOpenDelete(d, rowRef.current);
            }}
          >
            <Trash2 aria-hidden />
            <FormattedMessage id="common.delete" defaultMessage="Delete" />
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

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
            <FormattedMessage id="common.rename" defaultMessage="Rename" />
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
  sessionId,
  target,
  titleFor,
  onCancel,
  onConfirm,
}: {
  // Session addressing for the impact preview (issue #1063); the right-sidebar
  // panel has no session, and its confirm renders without the preview.
  sessionId?: string;
  target: DatasetDescriptor;
  // The confirm title's copy slot: the private face names the working set,
  // the right-sidebar panel overrides with its own neutral wording. A renderer
  // over the display name -- NOT a {id, defaultMessage} data shape, whose
  // dynamic id is invisible to the formatjs extractor and would leave the
  // catalog entry dangling as `extra` in the CI guard. Both faces therefore
  // spell their title as a static <FormattedMessage> literal at their own
  // call site.
  titleFor?: (name: string) => ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog defaultOpen>
      <AlertDialogContent onEscapeKeyDown={(e) => e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {titleFor !== undefined ? (
              titleFor(target.display_name)
            ) : (
              <FormattedMessage
                id="workingSet.delete.confirm"
                defaultMessage="Remove {name} from the working set?"
                values={{ name: target.display_name }}
              />
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>
            <FormattedMessage
              id="workingSet.delete.description"
              defaultMessage="The dataset is removed and its name is released — any SQL reading from it will fail. This cannot be undone; the file must be re-uploaded to restore it."
            />
          </AlertDialogDescription>
        </AlertDialogHeader>
        {/* The pre-delete impact preview (issue #1063); DeleteImpactList
            owns the rendering contract. Session-scoped: the right-sidebar
            panel's confirm (no session) renders without it. */}
        {sessionId !== undefined && (
          <DeleteImpactList sessionId={sessionId} referenceName={target.reference_name} />
        )}
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
  sessionId,
  datasets,
  activeName,
  selectedName,
  onSelect,
  onRename,
  onReplace,
  onDelete,
  onPickError,
  badgeFor,
  deleteTitleFor,
  loading = false,
}: {
  // Session addressing for the delete dialog's impact preview (issue #1063);
  // the rows themselves render from the `datasets` snapshot prop. Optional:
  // the right-sidebar panel (no session) omits it, and its delete confirm
  // renders without the impact preview.
  sessionId?: string;
  datasets: WorkingSetRow[];
  // The ACTIVE dataset (server truth, ADR-0051): bolds the row's label. The
  // authoritative naming is the tab header's Targets chip; bold is the row's
  // only VISUAL in-list active marker (since #793 retired the " · current
  // table" suffix, the label weight is the sole visual carrier -- the
  // .active hook stays a pure selector anchor, and the accent band moved to
  // the selection with it).
  activeName: string | null;
  // The detail pick (which row's detail the right pane shows): drives the
  // accent band. The session face passes the RESOLVED pick
  // (resolveWorkingSetDetail output), so the band rides the deleted-pick
  // fallbacks (active, then first) with the pane and never diverges from
  // what is shown; the right-sidebar panel resolves its own pick-then-first
  // chain inline (no active pointer), under the same contract.
  selectedName: string | null;
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
  // Remove a source from the working set (issue #38, ADR-0040). On the
  // session face the backend detaches the snapshot, deletes its file, drops
  // the reference name, and appends a Deleted source lifecycle event; the
  // right-sidebar panel's delete is a manifest edit (bound sessions keep their
  // store links, ADR-0141 D7). Optional only so tests that don't exercise
  // delete can skip it; App always supplies it, and the button is hidden
  // when it is absent (no silent no-op).
  onDelete?: (referenceName: string) => void;
  // A picker-open failure's error channel: the right-sidebar panel routes it to
  // its banner. Absent, the rejection is dropped (the private face's
  // long-standing posture).
  onPickError?: (e: unknown) => void;
  // Disables the action buttons while an async op (rename / ingest / replace /
  // delete) is in flight OR while a turn is in flight (ADR-0040 execution
  // window: ask in flight -> source management disabled), preventing concurrent
  // IPC and source-vs-turn interleaving.
  loading?: boolean;
  // An extra per-row marker at the row's tail, after the label-tail
  // wrapper: the right-sidebar panel flags a missing store file. Undefined
  // rows render nothing; the private face passes none.
  badgeFor?: (d: WorkingSetRow) => ReactNode;
  // The delete confirm's title copy slot (see WorkingSetDeleteDialog); the
  // private face keeps its working-set wording.
  deleteTitleFor?: (name: string) => ReactNode;
}) {
  const intl = useIntl();
  // Which row's rename / delete dialog is open (issue #759). The dialogs
  // mount/unmount on these targets, so each open starts from fresh draft state.
  const [renameTarget, setRenameTarget] = useState<DatasetDescriptor | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DatasetDescriptor | null>(null);
  // The row-tooltip protocol -- mutex, suppression window, focus-restore
  // gate, and the dialog-close handoff -- lives in useRowHints (rowHints.ts
  // carries the narrative): this list captures the opening trigger, mounts
  // the dialog targets and clears them through the handoff, and attaches
  // the hook's listRef as the fallback focus target.
  const { tip, listRef, captureTrigger, closeDialog } = useRowHints();
  const closeRename = () => closeDialog(() => setRenameTarget(null));
  const closeDelete = () => closeDialog(() => setDeleteTarget(null));
  const openRename = (d: DatasetDescriptor, trigger: HTMLElement) => {
    captureTrigger(trigger);
    setRenameTarget(d);
  };
  const openDelete = (d: DatasetDescriptor, trigger: HTMLElement) => {
    captureTrigger(trigger);
    setDeleteTarget(d);
  };

  // The empty set never reaches this list: RightSidebarWorkingSet renders the
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
    }).catch((e: unknown) => {
      onPickError?.(e);
      return null;
    });
    if (typeof selected === "string") {
      onReplace?.(d.reference_name, selected);
    }
  };

  return (
    // ADR-0067 (issue #184): the working-set list / button / active-state /
    // small visuals ride Tailwind utility on each element below + the
    // BUTTON_CHROME-derived constants above (select + icon actions, issue
    // #790). Two row states layer via cn(): the SELECTION puts the accent
    // band on the row <li> (see DatasetRow's isSelected for the band
    // contract), and the ACTIVE dataset bolds the select button's label.
    // The class hooks (.working-set
    // / .rename / .replace / .delete / .active / .selected / .stale) stay on
    // the elements as anchor points for selector queries and future
    // migration slices.
    <>
      <ul ref={listRef} tabIndex={-1} className="working-set list-none m-0 p-0 outline-none">
        {datasets.map((d) => (
          <DatasetRow
            key={d.reference_name}
            d={d}
            isActive={d.reference_name === activeName}
            isSelected={d.reference_name === selectedName}
            loading={loading}
            tip={tip}
            extraBadge={badgeFor?.(d)}
            onSelect={onSelect}
            onOpenRename={openRename}
            onPickReplace={onReplace ? pickReplace : undefined}
            onOpenDelete={onDelete ? openDelete : undefined}
          />
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
          sessionId={sessionId}
          target={deleteTarget}
          titleFor={deleteTitleFor}
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
