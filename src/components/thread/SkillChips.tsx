import { ComposerSkillChips } from "./ComposerSkillChips";
import { useSkillChips } from "./useSkillChips";

// The App-facing chips bundle (issue #961): a component so the hook's
// queries execute INSIDE the QueryClientProvider subtree -- the App shell
// owns the client instance and sits above the provider, so calling the hook
// from App's own body would leave the queries clientless.

interface SkillChipsProps {
  /** The active session; null on the cold-start bar. */
  sessionId: string | null;
  /** The caller-held pre-activation intents, in pick order. */
  intents: string[];
  /** Drop one intent from the caller-held state (the ADR-0112 half). */
  onIntentRemove: (name: string) => void;
  /** Surface an unmount reject (the shell error face). */
  onRemoveError: (error: unknown) => void;
}

export function SkillChips({
  sessionId,
  intents,
  onIntentRemove,
  onRemoveError,
}: SkillChipsProps) {
  const { names, remove } = useSkillChips({
    sessionId,
    intents,
    onIntentRemove,
    onRemoveError,
  });
  return <ComposerSkillChips names={names} onRemove={remove} />;
}
