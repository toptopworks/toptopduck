// The per-segment runtime attribution marker (ADR-0101, issue #588): a muted
// one-line caption the thread renders above the FIRST turn of each runtime
// segment, so a mixed thread reads back as "who ran which stretch" without
// repeating the marker on every row. External segments name their adapter id
// verbatim (layer-4 content -- today the id equals the spec's display name;
// divergence would need a name map, left as a follow-up); an external turn
// recorded before the id existed degrades to the honest "not recorded" note;
// the built-in segment names the app's own loop. No vendor logos (ADR-0101
// leaves iconography to DESIGN.md). DESIGN.md self-audit: deliberately NOT
// the badge recipe (its capsule + medium weight would shout on every
// segment head) -- this is the SkillMarker / skill-drift family of quiet
// muted captions, tokens only.

import { FormattedMessage } from "react-intl";
import { Cpu, Terminal } from "lucide-react";
import type { TurnRuntime } from "../../types/thread";

export function RuntimeAttributionMarker({ runtime }: { runtime: TurnRuntime }) {
  const isExternal = runtime.kind === "external";
  const Icon = isExternal ? Terminal : Cpu;
  // One branch on the kind, not two tests of the same discriminant: the
  // external arm falls back to the honest "not recorded" note when the id
  // is null (adapter_id is string | null, so ?? matches the old != null
  // check bit for bit).
  const label = isExternal ? (
    runtime.data.adapter_id ?? (
      <FormattedMessage
        id="thread.runtime.externalUnrecorded"
        defaultMessage="External (not recorded)"
      />
    )
  ) : (
    <FormattedMessage id="thread.runtime.builtIn" defaultMessage="Built-in" />
  );
  return (
    <p
      className="runtime-attribution m-0 mb-0.5 flex items-center gap-1 text-xs text-muted-foreground"
      data-runtime-kind={runtime.kind}
    >
      <Icon aria-hidden="true" className="h-3 w-3 shrink-0" />
      {label}
    </p>
  );
}
