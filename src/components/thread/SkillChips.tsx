import { ComposerSkillChips } from "./ComposerSkillChips";
import { useSkillChips, type UseSkillChipsOpts } from "./useSkillChips";

// The App-facing chips bundle (issue #961): a component so the hook's
// queries execute INSIDE the QueryClientProvider subtree -- the App shell
// owns the client instance and sits above the provider, so calling the hook
// from App's own body would leave the queries clientless. The props ARE the
// hook's opts (no field-by-field restatement: adding a hook field cannot
// leave this component forwarding a stale shape).

export type SkillChipsProps = UseSkillChipsOpts;

export function SkillChips(opts: SkillChipsProps) {
  const { names, remove } = useSkillChips(opts);
  return <ComposerSkillChips names={names} onRemove={remove} />;
}
