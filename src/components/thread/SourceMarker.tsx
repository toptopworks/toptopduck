// A source lifecycle event rendered as a non-interactive timeline marker
// (ADR-0040/0047): distinct species from a turn (no question, no outcome icon).
// Added = Plus (a source entered the working set); Deleted = Trash2 (a source
// left it); Replaced = RefreshCw (a source's backing snapshot was swapped under
// the same reference name, ADR-0025). A Replaced/Deleted marker names how many
// derivatives it invalidated when that count is non-zero. The marker is thin and
// full-width so the two species read as visually distinct at a glance. The
// display name is layer-4 canonical (ADR-0037) and passes through the {name} ICU
// placeholder untranslated.
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
