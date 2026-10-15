// A source lifecycle event rendered as a non-interactive timeline marker
// (ADR-0040/0047): distinct species from a turn (no question, no outcome icon).
// Added = Plus (a source entered the working set); Deleted = Trash2 (a source
// left it); Replaced = RefreshCw (a source's backing snapshot was swapped under
// the same reference name, ADR-0025). A Replaced/Deleted marker names how many
// derivatives it invalidated when that count is non-zero. Issue #721
// nodification: the kind glyph leads the row as a bare tone-colored icon
// (no node chrome), the verb text sits right of it, so the species stays
// visually distinct from turn cards at a glance. The display name is
// layer-4 canonical (ADR-0037) and passes through the {name} ICU
// placeholder untranslated.
//
// ADR-0067 (issue #169): the marker's visual details migrated here from
// styles.css's `.thread .source-lifecycle*` rules. The three lifecycle kinds
// each carry a tailwind text-* utility over the ADR-0050 token so the kind
// is readable at a glance (Added=primary / Replaced=accent-foreground /
// Deleted=destructive, ADR-0047 source-marker species). The tone rides the
// glyph color (the retired bar carried it as a border-l prefix line, then
// the #721 circle as a border), and the jump-select highlight (ADR-0047
// chip-trace) lands as "node ring + row wash" -- ring-2 ring-primary on the
// node box, bg-accent on the row. The `highlighted` flag is derived by the caller
// from data-highlighted on the wrapping <li>; the data attribute and the
// scrollIntoView hookup are unchanged (chip-trace semantics conserved).

import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import { Plus, RefreshCw, Trash2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { TruncatingTooltip } from "./TruncatingTooltip";
import type { SourceLifecycleEvent, SourceLifecycleKind } from "../../types/lifecycle";

// Lucide glyph + i18n'd text per source lifecycle kind (ADR-0050 glyph mapping,
// ADR-0052 i18n). The verb + display name ride one ICU message so the quoting
// convention (zh vs en) follows the locale. Exhaustiveness guard mirroring
// Rust's compile-time match on `SourceLifecycleKind`: a future variant must add
// a branch here. `types/lifecycle.ts` is the hand-maintained mirror of the Rust
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

export function SourceMarker({
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
  // The three-way hue is the kind's identity cue (ADR-0047), riding the
  // glyph color. Each branch is a literal utility so the Tailwind scanner
  // keeps the class; a computed `text-${kind}` string would be tree-shaken
  // away.
  const iconTone =
    event.kind === "Added"
      ? "text-primary"
      : event.kind === "Replaced"
        ? "text-accent-foreground"
        : "text-destructive"; // Deleted (exhaustive over SourceLifecycleKind).
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
        "source-lifecycle flex items-center gap-1.5 m-0 py-0.5",
        "text-xs text-muted-foreground",
        // Hook class kept for kind-targeted selectors/tests (.source-lifecycle.added etc.).
        event.kind.toLowerCase(),
        // Jump-select highlight (ADR-0047 chip-trace, issue #721): the row
        // keeps the bg-accent wash; the ring lands on the node below.
        highlighted && "bg-accent",
      )}
    >
      {/* The kind glyph rides in an invisible h-4 w-4 box: the box + the
          row's py-0.5 are the geometry contract owned by the styles.css
          data-run rule (the connector starts at the box's bottom edge).
          rounded-full + relative + z-10 stay for the jump-select ring: the
          ring reads round and paints above the connector segment. */}
      <span
        className={cn(
          "source-node relative z-10 flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
          highlighted && "ring-2 ring-primary",
        )}
      >
        <Icon className={cn("source-icon w-3 h-3 shrink-0", iconTone)} aria-hidden="true" />
      </span>
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
