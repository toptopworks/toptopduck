// The per-turn runtime attribution marker (ADR-0101, issue #818): a muted
// one-line caption opening EVERY external turn's assistant stream, so a
// mid-thread scan can tell who ran each turn (the retired segment-start form
// announced only attribution changes). Only a runtime that can name its
// adapter renders -- the built-in default and both unrecorded shapes stay
// silent, so an unmarked stretch reads as the default runtime. External
// turns name their adapter id verbatim (layer-4 content -- today the id
// equals the spec's display name; divergence would need a name map, left as
// a follow-up). No vendor logos (ADR-0101 leaves iconography to DESIGN.md).
// DESIGN.md self-audit: deliberately NOT the badge recipe (its capsule +
// medium weight would shout on every turn head) -- this is the SkillMarker /
// skill-drift family of quiet muted captions, tokens only.

import { Terminal } from "lucide-react";

export function RuntimeAttributionMarker({ adapterId }: { adapterId: string }) {
  return (
    <p className="runtime-attribution m-0 mb-0.5 flex items-center gap-1 text-xs text-muted-foreground">
      <Terminal aria-hidden="true" className="h-3 w-3 shrink-0" />
      {adapterId}
    </p>
  );
}
