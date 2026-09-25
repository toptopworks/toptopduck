import { FormattedMessage, useIntl } from "react-intl";
import { fmtError } from "../../lib/error-presentation/format";
import { useDeleteImpact } from "../../session/useWorkingSet";

// The delete-confirm dialogs' cascade-impact list (issue #1063): what the
// removal would mark stale, read through `useDeleteImpact`. Three states
// render -- in flight (one muted line, first load and refetch alike: with
// staleTime Infinity the prefix-invalidation reopen path must not show an
// unindicated stale list), failure (one `fmtError` line; the dialog's own
// copy stays untouched and the delete stays executable -- the preview is
// read-only and never a dependency of the removal), else the full list with
// an internal scroll cap. An empty closure renders nothing at all: silence
// reads faster than a line the user must parse to learn the delete is safe.
// The entries arrive in ascending numeric `result_N` order (the backend
// contract, `WorkingSet::stale_impact_preview`). The dialogs mount this list
// conditionally with a non-null target and own the never-blocks-the-delete
// contract (issue #1063's lenient-degrade ruling).
export function DeleteImpactList({
  sessionId,
  referenceName,
}: {
  sessionId: string;
  referenceName: string;
}) {
  const intl = useIntl();
  const { entries, isFetching, error } = useDeleteImpact(sessionId, referenceName);

  if (isFetching) {
    return (
      <p className="text-xs text-muted-foreground">
        <FormattedMessage
          id="workingSet.delete.impactLoading"
          defaultMessage="Checking affected results…"
        />
      </p>
    );
  }
  if (error !== null) {
    return <p className="text-xs text-destructive">{fmtError(error, intl)}</p>;
  }
  if (entries.length === 0) {
    return null;
  }
  return (
    <div className="mt-1">
      <p className="text-xs text-muted-foreground">
        <FormattedMessage
          id="workingSet.delete.impactTitle"
          defaultMessage="Affected results"
        />
      </p>
      {/* The full list, capped: a long cascade scrolls inside the dialog
          instead of stretching it past the viewport (issue #1063). */}
      <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto text-xs">
        {entries.map((entry) => (
          <li key={entry.reference_name}>{entry.display_name}</li>
        ))}
      </ul>
    </div>
  );
}
