import type { ModelPosture } from "../../types/app-config";
import { heldPostureParts } from "./posture-catalog";

// The posture trigger's readout verdict, extracted from
// ComposerProviderPicker as a pure projection (the same face as
// posture-catalog.ts / posture-directory.ts): one call feeds both display
// faces, the button label and the built-in tooltip's model slot. The
// component keeps what is not a posture ruling -- the i18n copies, the
// " · " join, the provider readout (ADR-0071), and the no-key / keychain
// mark assembly.
//
// The label priority chain (ADR-0099 Decision 3 / issue #573, extended by
// #1639):
// - built-in shows the HELD pair first (a session-level selection is the
//   next turn's posture, same readout form as external), falling back to
//   the active profile's pinned model -- an unselected model runs the
//   pinned model next turn (ADR-0154), so a lone held strength reads
//   "{pinned} · {strength}" and the bare strength alone never does (issue
//   #1648) -- then to the honest no-model state (an unpinned profile with
//   nothing held: the next turn refuses -- so does a lone held strength
//   on an unpinned profile, whose bare-strength label stays). Zero
//   profiles read "not configured", never a fake default.
// - external shows the held pair -- either side omitted when unset, the
//   two dimensions independently reachable on ACP adapters so a lone
//   thought level has its own held form (issue #584) -- or the
//   default-recommended verdict when nothing is held, anchored to
//   never-selected-or-cleared per dimension (ADR-0100 Decision 1: the CLI
//   default is real there).
// - the turn-end live currents never touch the label (issue #586,
//   user-supplied form): they ride the trigger's tooltip, so the
//   unselected verdict keeps the label on its default copy.
//
// An empty-string field counts as unset, matching the menu guards'
// convention (the held-pair predicate in posture-catalog.ts), so a
// hand-edited blank cannot blank the button or the tooltip slot.

export type PostureReadoutReads = {
  // The displayed posture pair (the session's held dimensions, pending
  // merge already applied by the caller).
  posture: ModelPosture;
  isExternal: boolean;
  noProfiles: boolean;
  // The active profile's pinned model (the built-in fallback half; the
  // external arm never reads it for the label).
  builtInModel: string | null;
};

// The label's verdict: the held pair as display parts, or one of the three
// honest states. The component resolves the verdict into i18n copies and
// joins the parts.
export type PostureReadoutLabelKind =
  | { kind: "notConfigured" }
  | { kind: "noModel" }
  | { kind: "defaultRecommended" }
  | { kind: "held"; parts: string[] };

export type PostureReadout = {
  labelKind: PostureReadoutLabelKind;
  // The tooltip preview's model half: the held model, else the pinned
  // default, else null -- the honest empty state the component renders as
  // the no-model copy.
  tooltipModel: string | null;
};

export function derivePostureReadout(reads: PostureReadoutReads): PostureReadout {
  const { posture, isExternal, noProfiles, builtInModel } = reads;
  const heldParts = heldPostureParts(posture);
  // The model half both built-in faces read: the held model, else the
  // pinned profile model.
  const effectiveModel = posture.model || builtInModel;
  const builtInParts = heldPostureParts({
    model: effectiveModel,
    thought_level: posture.thought_level,
  });
  const labelKind: PostureReadoutLabelKind = !isExternal
    ? noProfiles
      ? { kind: "notConfigured" }
      : builtInParts.length > 0
        ? { kind: "held", parts: builtInParts }
        : { kind: "noModel" }
    : heldParts.length > 0
      ? { kind: "held", parts: heldParts }
      : { kind: "defaultRecommended" };
  // The tooltip slot rides the same chain's model half (held -> pinned ->
  // the honest empty state); the external arm pins null -- its tooltip
  // names the adapter and never reads this half.
  const tooltipModel = isExternal ? null : effectiveModel || null;
  return { labelKind, tooltipModel };
}
