// A skill lifecycle event rendered as a non-interactive timeline marker
// (ADR-0086, issue #366; ADR-0110, issue #698): a sibling species to
// SourceMarker -- no question / outcome glyph. Issue #721 nodification: the
// kind glyph rides inside a circular node (bg-background punch + 1px tone
// border), the verb text sits right of the node; the retired form was a
// full-width bar (border-l-2 prefix line + bg-muted fill). Mount = active
// (Plug + border-primary); Activate = the persistent promotion (Zap +
// border-primary -- same present-tense tier as Mount, #698's minimal form;
// the actor distinction landed with #701: the copy picks the user / agent key
// off the event's actor); Unmount = weakened (Unplug +
// border-muted-foreground). The tier mapping migrated from the border-l
// prefix line to the node unchanged (issue #721). A name
// the registry no longer carries (resume drift: deleted / renamed / external
// library uninstalled since the event was recorded) overrides the kind tone
// to a destructive warning + TriangleAlert glyph + "no longer exists"
// suffix, so the event stays in the timeline (it happened) but the reader
// sees the skill is gone. When the registry index is not wired by the
// caller, the marker renders the verb + name from the event alone -- no MCP
// tooltip, no missing-skill warning (honest degrade: the timeline is always
// readable, the registry only enriches it).

import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import { Plug, TriangleAlert, Unplug, Zap, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { TruncatingTooltip } from "./TruncatingTooltip";
import type {
  SkillEntry,
  SkillLifecycleActor,
  SkillLifecycleEvent,
  SkillLifecycleKind,
} from "../../types/skills";

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
  actor: SkillLifecycleActor | null,
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
    case "Activate":
      // The initiation actor picks the copy (issue #701, ADR-0110 Decision
      // 4): the pre-existing key stays the user's; the agent's meta-tool
      // activation gets its own. The actor is present IFF the kind is
      // Activate (the wire contract), so the ternary covers User and there
      // is no defensive null branch.
      return {
        Icon: Zap,
        text:
          actor === "Agent"
            ? intl.formatMessage(
                {
                  id: "thread.skill.activateAgent",
                  defaultMessage: "Agent activated skill \"{name}\"",
                },
                { name },
              )
            : intl.formatMessage(
                { id: "thread.skill.activate", defaultMessage: "Activated skill \"{name}\"" },
                { name },
              ),
      };
    default: {
      const unhandled: never = kind;
      throw new Error(`unhandled skill lifecycle kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

export function SkillMarker({
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
  const { Icon, text } = skillMarkerText(intl, event.kind, event.name, event.actor);
  const skill = skillIndex?.get(event.name);
  // Three-way lookup distinguishes "registry not wired" (honest degrade, no
  // drift signal) from "registry wired but name absent" (drift warning). The
  // missing branch fires only when the caller passed an index AND the name
  // is not in it -- a caller that skips the index opts out of drift detection.
  const missing = skillIndex !== undefined && skill === undefined;
  // Each branch is a literal utility so the Tailwind scanner keeps the class;
  // a computed `border-${x}` string would be tree-shaken away. Missing
  // overrides the kind tone (destructive > kind) so drift is unmistakable.
  // Mount and Activate share the primary present-tense tier; Unmount is the
  // weakened one (exhaustive over SkillLifecycleKind). The tone rides the
  // node's 1px border (issue #721 -- the retired bar carried it as border-l).
  const nodeTone = missing
    ? "border-destructive"
    : event.kind === "Unmount"
      ? "border-muted-foreground"
      : "border-primary"; // Mount | Activate.
  // The MCP declaration is registry state, not carried by the event.
  // Disclosed only on a Mount whose skill is still carried -- the declaration
  // is operative only while the skill is mounted; an Unmount's declaration is
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
        "skill-lifecycle flex items-center gap-1.5 m-0 py-0.5 text-xs",
        // Kind tone rides text-muted-foreground by default; missing flips to
        // text-destructive so the warning reads at a glance.
        missing ? "text-destructive" : "text-muted-foreground",
        // Hook class kept for kind-targeted selectors/tests
        // (.skill-lifecycle.mount/unmount etc.), matching SourceMarker.
        event.kind.toLowerCase(),
      )}
    >
      {/* The kind glyph rides inside a circular node (issue #721): the
          bg-background fill punches the run-connector line behind it, the 1px
          border carries the kind tone; relative + z-10 keeps the circle above
          the li::before segment. The h-4 w-4 node + the row's py-0.5 are the
          geometry contract owned by the styles.css data-run rule (single
          source of truth for the offsets). */}
      <span
        className={cn(
          "skill-node relative z-10 flex h-4 w-4 shrink-0 items-center justify-center",
          "rounded-full border bg-background",
          nodeTone,
        )}
      >
        <MarkerIcon className="skill-icon w-2.5 h-2.5 shrink-0" aria-hidden="true" />
      </span>
      <TruncatingTooltip text={tooltipText} className="skill-text min-w-0 truncate">
        {text}
        {missingSuffix && <span className="skill-missing">{missingSuffix}</span>}
      </TruncatingTooltip>
    </p>
  );
}
