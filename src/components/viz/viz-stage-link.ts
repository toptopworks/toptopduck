// The stream -> stage link for fence charts (issue #1093). RoundProse's
// markdown components maps are module-level constants (the streaming
// contract, ADR-0120 Decision 4), so the settled `pre` door cannot receive
// the stage handler through a per-render prop -- it reads this context
// instead. The provider lives in RoundProse; the handler flows into it as
// plain optional props from TurnCard/Thread. A null link = the surface is
// static (the delegation trace dialog and the md artifact renderer mount
// RoundProse bare), and the live `pre` door never reads it (the placeholder
// has no chart body to click).

import { createContext } from "react";

/** The wired link: the handler that promotes a fence body onto the
 *  workspace stage, plus the staged body for the selection mirror (a
 *  fence lights when its raw text EQUALS the staged spec -- two fences
 *  sharing a body share the identity, by design). */
export interface VizStageLink {
  onSelectViz: (spec: string) => void;
  selectedVizSpec: string | null;
}

export const VizStageLinkContext = createContext<VizStageLink | null>(null);
