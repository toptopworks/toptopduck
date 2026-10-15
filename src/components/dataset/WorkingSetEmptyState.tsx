import { useIntl, FormattedMessage } from "react-intl";
import { Button } from "../ui/button";
import { pickDataFiles } from "./pickDataFiles";

// The working-set tab's empty face (issue #792): the empty set renders ONE
// card -- not the two-column master/detail shell with a near-empty pair. The
// card keeps the drop hint (the window dropzone still works) and carries the
// inline add entry the old copy only pointed at: the picker routes through
// the same handleIngestMany pipeline as the composer's + entry, so the
// guided-load dock, error banner, and batch queue all apply unchanged. The
// caller wraps this in the tab's panel chrome (PANEL_CARD_BASE).
export function WorkingSetEmptyState({
  onAddFiles,
  loading = false,
}: {
  onAddFiles: (paths: string[]) => void;
  // The execution-window gate (ADR-0040): a turn or mutation in flight locks
  // source additions, same as the composer's + entry.
  loading?: boolean;
}) {
  const intl = useIntl();
  const pick = async () => {
    const paths = await pickDataFiles(intl);
    if (paths.length === 0) return;
    onAddFiles(paths);
  };
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="m-0 text-muted-foreground">
        <FormattedMessage
          id="workingSet.empty"
          defaultMessage="Working set is empty — drop or pick a data file to start."
        />
      </p>
      <Button type="button" disabled={loading} onClick={() => void pick()}>
        <FormattedMessage id="workingSet.empty.add" defaultMessage="Add data file" />
      </Button>
    </div>
  );
}
