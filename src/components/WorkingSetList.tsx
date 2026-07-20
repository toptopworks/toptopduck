import { open } from "@tauri-apps/plugin-dialog";
import { useIntl, FormattedMessage } from "react-intl";
import { Badge } from "./ui/badge";
import { cn } from "../lib/utils";
import type { DatasetDescriptor } from "../types";

// ADR-0067 (issue #184): the .working-set button rule (all: unset + cursor +
// padding + radius + display:block + width:100%) retired onto this shared
// utility constant. Tailwind v4's Preflight already resets the button's
// background to transparent, inherits font/color, and zeroes margin/padding, so
// only the residual visual contract is re-stated here: strip the native border
// + appearance, set the compact padding, the var(--radius) corner, the
// full-width block layout, and left alignment (UA button text is centered).
// Active state (bg-accent + font-semibold) layers on via cn() at the call site.
const BUTTON_BASE =
  "appearance-none border-0 cursor-pointer p-[0.4rem_0.5rem] rounded-md block w-full text-left";

export function WorkingSetList({
  datasets,
  activeName,
  onSelect,
  onRename,
  onReplace,
  onDelete,
  loading = false,
}: {
  datasets: DatasetDescriptor[];
  activeName: string | null;
  onSelect: (referenceName: string) => void;
  // Display-only rename (ADR-0037, issue #8): the reference name is never
  // touched, so selection / SQL / active references all stay valid.
  onRename: (referenceName: string, newDisplay: string) => void;
  // Re-upload a file onto this dataset's reference name (ADR-0042, issue #11):
  // a fresh snapshot takes over the name. Distinct from the dropzone's add --
  // the reference name to take over is explicit. Structured files only (the
  // backend rejects xlsx in this slice), so the picker excludes xlsx to match,
  // keeping the two entries (add vs replace) visually distinct (AC4). Optional
  // only so tests that don't exercise replace can skip it; App always supplies
  // it, and the button is hidden when it is absent (no silent no-op).
  onReplace?: (referenceName: string, path: string) => void;
  // Remove a source from the working set (issue #38, ADR-0040). The backend
  // detaches the snapshot, deletes its file, drops the reference name, and
  // appends a Deleted source lifecycle event. Optional only so tests that don't
  // exercise delete can skip it; App always supplies it, and the button is
  // hidden when it is absent (no silent no-op).
  onDelete?: (referenceName: string) => void;
  // Disables the action buttons while an async op (rename / ingest / replace /
  // delete) is in flight OR while a turn is in flight (ADR-0040 execution
  // window: ask in flight -> source management disabled), preventing concurrent
  // IPC and source-vs-turn interleaving.
  loading?: boolean;
}) {
  const intl = useIntl();

  if (datasets.length === 0) {
    return (
      <p className="muted">
        <FormattedMessage
          id="workingSet.empty"
          defaultMessage="Working set is empty — drop or pick a data file to start."
        />
      </p>
    );
  }

  // Prompt for a new display label. The answer is trimmed; a blank or
  // no-change result is ignored. A collision is rejected by the backend.
  const promptRename = (d: DatasetDescriptor) => {
    const next = window.prompt(
      intl.formatMessage({ id: "workingSet.rename.title", defaultMessage: "Rename display label" }),
      d.display_name,
    );
    if (!next) return; // cancelled
    const trimmed = next.trim();
    if (trimmed && trimmed !== d.display_name) {
      onRename(d.reference_name, trimmed);
    }
  };

  // Pick a structured file to swap in under this dataset's reference name. The
  // picker excludes .xlsx on purpose: the backend's replace path is structured-
  // only, so this keeps the two entries (add vs replace) visually distinct and
  // avoids offering a choice the backend would then reject.
  const pickReplace = async (d: DatasetDescriptor) => {
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: intl.formatMessage({ id: "workingSet.fileFilter", defaultMessage: "Data files" }),
          extensions: ["csv", "parquet", "json", "jsonl", "ndjson"],
        },
      ],
    });
    if (typeof selected === "string") {
      onReplace?.(d.reference_name, selected);
    }
  };

  // Confirm before removing a source: deletion drops the reference name from
  // the shared namespace (any SQL FROM it will fail) and is irreversible in v1
  // (the file must be re-uploaded). A no answer is ignored. The backend refuses
  // the active source and any removal while results exist, surfacing those as a
  // "删源失败" error in App -- the confirm here is only the user's intent gate.
  const confirmDelete = (d: DatasetDescriptor) => {
    const ok = window.confirm(
      intl.formatMessage(
        { id: "workingSet.delete.confirm", defaultMessage: "Remove {name} from the working set?" },
        { name: d.display_name },
      ),
    );
    if (ok) {
      onDelete?.(d.reference_name);
    }
  };

  return (
    // ADR-0067 (issue #184): the working-set list / button / active-state /
    // small visuals ride Tailwind utility on each element below + the
    // BUTTON_BASE constant above (shared by the select + icon buttons). The
    // active STATE drives the select button's own conditional className
    // (bg-accent + font-semibold). The class hooks (.working-set / .rename /
    // .replace / .delete / .active / .stale) stay on the elements as anchor
    // points for selector queries and future migration slices.
    <ul className="working-set list-none m-0 p-0">
      {datasets.map((d) => (
        <li
          key={d.reference_name}
          className={cn(
            "my-[0.2rem]",
            d.reference_name === activeName && "active",
            d.stale && "stale",
          )}
        >
          <button
            type="button"
            className={cn(
              BUTTON_BASE,
              d.reference_name === activeName && "bg-accent font-semibold",
            )}
            onClick={() => onSelect(d.reference_name)}
          >
            {d.display_name}
            {d.reference_name === activeName ? (
              <FormattedMessage id="workingSet.activeSuffix" defaultMessage=" · current table" />
            ) : null}
            {/* font-normal overrides the active button's font-semibold so the
                row-count annotation stays muted-weight in either state. */}
            <small className="text-muted-foreground font-normal">
              {" "}
              <FormattedMessage
                id="workingSet.rowCount"
                defaultMessage="{count, plural, one {# row} other {# rows}}"
                values={{ count: d.row_count }}
              />
            </small>
          </button>
          {d.stale && (
            <Badge variant="secondary" className="stale-badge">
              <FormattedMessage
                id="workingSet.staleRow"
                defaultMessage="Invalidated because {name} was {reason, select, Deleted {deleted} Replaced {updated} other {changed}}"
                values={{ name: d.stale.display_name, reason: d.stale.reason }}
              />
            </Badge>
          )}
          <button
            type="button"
            className={cn(BUTTON_BASE, "rename")}
            aria-label={intl.formatMessage(
              { id: "workingSet.rename.ariaLabel", defaultMessage: "Rename {name}" },
              { name: d.display_name },
            )}
            title={intl.formatMessage({ id: "workingSet.rename.title", defaultMessage: "Rename display label" })}
            disabled={loading}
            onClick={() => promptRename(d)}
          >
            ✎
          </button>
          {onReplace && (
            <button
              type="button"
              className={cn(BUTTON_BASE, "replace")}
              aria-label={intl.formatMessage(
                { id: "workingSet.replace.ariaLabel", defaultMessage: "Replace source {name}" },
                { name: d.display_name },
              )}
              title={intl.formatMessage({
                id: "workingSet.replace.title",
                defaultMessage: "Re-upload to replace this dataset (keeps the reference name)",
              })}
              disabled={loading}
              onClick={() => void pickReplace(d)}
            >
              ↻
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className={cn(BUTTON_BASE, "delete")}
              aria-label={intl.formatMessage(
                { id: "workingSet.delete.ariaLabel", defaultMessage: "Delete {name}" },
                { name: d.display_name },
              )}
              title={intl.formatMessage({
                id: "workingSet.delete.title",
                defaultMessage: "Remove this dataset from the working set",
              })}
              disabled={loading}
              onClick={() => confirmDelete(d)}
            >
              ✕
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
