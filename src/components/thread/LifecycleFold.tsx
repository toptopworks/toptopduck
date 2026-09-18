// The collapsed row for a run of consecutive same-kind lifecycle markers
// (issue #737): batch operations materialize long same-kind stretches
// (Added×N on sequential ingest), which bury the surrounding turns -- a
// stretch at/above LIFECYCLE_FOLD_THRESHOLD (3, turn-visual.ts) renders as
// THIS one row instead. An accessible disclosure (button + aria-expanded +
// rotating chevron, the FoldToggle language): expanding is the one way to
// see the member names (no hover tooltip: the count label never overflows,
// so a truncation-recovery tooltip would be dead chrome; ruled during
// implementation). The kind glyph + tone mirror the scatter rows exactly
// (SourceMarker; the timeline's skill species retired with ADR-0119 --
// only source events fold) so the collapsed row reads as the same species
// at a glance. The aggregated disclosure rides the row: the summed
// invalidation count reuses the scatter suffix id, and the combined
// member row below keeps each name's individual warning.

import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import {
  ChevronRight,
  Plus,
  RefreshCw,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { staleDerivativeCount, type LifecycleFoldInfo } from "./turn-visual";
import type { ThreadEntry } from "../../types/thread";

// Lucide glyph + i18n'd count text per (species, kind) -- the scatter rows'
// verb (Mounted/Activated/…), pluralized over the count (ICU plural with all
// branches; zh carries no plural, a plain {count}). Exhaustiveness guards
// mirroring skillMarkerText/sourceMarkerText: a future variant must add a
// branch here.
function foldText(
  intl: IntlShape,
  group: LifecycleFoldInfo,
): { Icon: LucideIcon; text: string } {
  // Source-only (ADR-0119 Decision 2): the skill kinds retired with the
  // timeline's skill species.
  const count = group.memberIdxs.length;
  const sourceKind = group.kind;
  switch (sourceKind) {
    case "Added":
      return {
        Icon: Plus,
        text: intl.formatMessage(
          {
            id: "thread.fold.addSources",
            defaultMessage: "Loaded {count, plural, one {# dataset} other {# datasets}}",
          },
          { count },
        ),
      };
    case "Deleted":
      return {
        Icon: Trash2,
        text: intl.formatMessage(
          {
            id: "thread.fold.deleteSources",
            defaultMessage: "Deleted {count, plural, one {# dataset} other {# datasets}}",
          },
          { count },
        ),
      };
    case "Replaced":
      return {
        Icon: RefreshCw,
        text: intl.formatMessage(
          {
            id: "thread.fold.replaceSources",
            defaultMessage: "Replaced {count, plural, one {# dataset} other {# datasets}}",
          },
          { count },
        ),
      };
    default: {
      const unhandled: never = sourceKind;
      throw new Error(`unhandled source lifecycle kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

export function LifecycleFold({
  group,
  expanded,
  onToggle,
}: {
  group: LifecycleFoldInfo;
  expanded: boolean;
  onToggle: () => void;
}) {
  const intl = useIntl();
  const { Icon, text } = foldText(intl, group);
  // The kind's identity cue, riding the glyph color exactly as the scatter
  // rows paint it. Each branch is a literal utility so the Tailwind scanner
  // keeps the class; a computed `text-${x}` string would be tree-shaken away.
  const iconTone =
    group.kind === "Replaced"
      ? "text-accent-foreground"
      : group.kind === "Deleted"
        ? "text-destructive"
        : "text-primary"; // Added.
  // The two aggregate suffixes reuse the scatter rows' disclosure shape: the
  // invalidation count rides the scatter stale-suffix id verbatim, and a
  // group holding missing skill names adds the drift count. Both paint
  // destructive so the warning reads at a glance; the expanded rows below
  // keep their individual (named) warnings either way.
  const invalidatedSuffix =
    group.invalidatedCount > 0 ? (
      <FormattedMessage
        id="thread.source.staleSuffix"
        defaultMessage=" · invalidated {count}"
        values={{ count: group.invalidatedCount }}
      />
    ) : null;
  return (
    <button
      type="button"
      className={cn(
        // The hook class carries the kind for kind-targeted selectors/tests,
        // matching the scatter rows' .skill-lifecycle.mount / .source-lifecycle.added.
        "lifecycle-fold",
        group.kind.toLowerCase(),
        // The marker line's only interactive control, so it carries the full
        // state set (DESIGN.md: focus rings are teal {colors.primary} at 2px
        // outline-offset; hover brightens, matching FoldToggle).
        "flex w-full items-center gap-1.5 m-0 py-0.5 text-xs text-muted-foreground cursor-pointer hover:text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
      )}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {/* The kind glyph rides in an invisible h-4 w-4 box: the box + the
          row's py-0.5 are the geometry contract owned by the styles.css
          data-run rule (the connector starts at the box's bottom edge) --
          the fold row is its segment's single node, so it must present the
          same box the scatter rows do. relative + z-10 mirror the scatter
          siblings so the species cannot drift apart. */}
      <span className="lifecycle-fold-node relative z-10 flex h-4 w-4 shrink-0 items-center justify-center">
        <Icon
          className={cn("w-3 h-3 shrink-0", iconTone)}
          aria-hidden="true"
        />
      </span>
      <span className="min-w-0 truncate">
        {text}
        {invalidatedSuffix && (
          <span className="text-destructive">{invalidatedSuffix}</span>
        )}
      </span>
      {/* The disclosure chevron, the FoldToggle language: ChevronRight
          rotating 90° on expand. */}
      <ChevronRight
        aria-hidden="true"
        className={cn("w-3.5 h-3.5 shrink-0 transition-transform", expanded && "rotate-90")}
      />
    </button>
  );
}

// The expanded half of a fold (issue #737, combined-member ruling): ONE
// row under the kept-in-place head listing every member name side by side
// as a wrapping text flow -- a long skill stretch stays one screen line or
// two instead of re-stretching the timeline N rows deep. Each name keeps
// its individual warning suffix (a missing skill's drift note, a
// Replaced/Deleted source's invalidation count) where the fold row carries
// only the aggregate; the jump contract (ADR-0047 exact-event semantics)
// lands on the NAME, not the row: the matched member span takes the
// highlight (bg wash + ring, the source-row language) while the scroll
// anchor is this <li> (the caller wires one ref covering every member
// index). Member names are layer-4 content and pass through untranslated;
// pl-[22px] aligns the flow with the head's label column (16px node box +
// 6px gap).
//
// The row also CONDUCTS the run connector when the head sits mid-run
// (continueConnector): the head's own down-segment stops 6px past its <li>,
// so without a conducting segment here the line would visually break across
// the combined row -- data-run-continue rides the <li> and styles.css draws
// the through-line at the same left offset the node connectors use.
export function LifecycleFoldMembers({
  group,
  entries,
  staleCountsByKey,
  highlightedIdx,
  continueConnector,
  rowRef,
}: {
  group: LifecycleFoldInfo;
  entries: readonly ThreadEntry[];
  staleCountsByKey: ReadonlyMap<string, number>;
  highlightedIdx: number | null;
  continueConnector: boolean;
  rowRef?: (el: HTMLLIElement | null) => void;
}) {
  const members = group.memberIdxs.map((idx) => {
    const entry = entries[idx];
    // The projector only points fold rows at Source entries (the skill
    // species renders no row at all, ADR-0119 Decision 2).
    if (entry.entry !== "Source") return null;
    return {
      idx,
      name: entry.data.display_name,
      stale: staleDerivativeCount(entry.data, staleCountsByKey),
    };
  });
  return (
    <li
      ref={rowRef}
      data-run-continue={continueConnector ? "true" : undefined}
      className="lifecycle-fold-members m-0 py-0.5 pl-[22px] flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted-foreground"
    >
      {members.map((m) =>
        m === null ? null : (
          <span
            key={m.idx}
            data-entry-idx={m.idx}
            data-highlighted={highlightedIdx === m.idx ? "true" : undefined}
            className={cn("rounded-sm", highlightedIdx === m.idx && "bg-accent ring-1 ring-primary px-0.5")}
          >
            {m.name}
            {m.stale > 0 && (
              <span className="text-destructive">
                <FormattedMessage
                  id="thread.source.staleSuffix"
                  defaultMessage=" · invalidated {count}"
                  values={{ count: m.stale }}
                />
              </span>
            )}
          </span>
        ),
      )}
    </li>
  );
}
