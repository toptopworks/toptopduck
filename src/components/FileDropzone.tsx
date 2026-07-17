import { FormattedMessage, useIntl } from "react-intl";
import { open } from "@tauri-apps/plugin-dialog";

export function FileDropzone({
  onIngest,
  loading,
}: {
  onIngest: (path: string) => void;
  loading: boolean;
}) {
  const intl = useIntl();

  async function pick() {
    const selected = await open({
      multiple: false,
      filters: [
        {
          // The file-filter label is shared with WorkingSetList's replace picker
          // (workingSet.fileFilter) so the two pickers read identically.
          name: intl.formatMessage({ id: "workingSet.fileFilter", defaultMessage: "Data files" }),
          extensions: ["csv", "parquet", "json", "jsonl", "ndjson", "xlsx"],
        },
      ],
    });
    if (typeof selected === "string") {
      onIngest(selected);
    }
  }

  // The file-picker button only. Window-level drag-and-drop is handled by a
  // single listener in the shell (App) so N keep-alive SessionPanes do not
  // stack N listeners and fire N ingests per drop; this component is pure UI.
  return (
    <div className="dropzone">
      <button onClick={pick} disabled={loading}>
        {loading
          ? intl.formatMessage({ id: "workingSet.dropzone.loading", defaultMessage: "Loading…" })
          : intl.formatMessage({ id: "workingSet.dropzone.pick", defaultMessage: "Pick a data file" })}
      </button>
      <span className="muted">
        <FormattedMessage
          id="workingSet.dropzone.dragHint"
          defaultMessage="or drop a .csv / .parquet / .json / .xlsx file onto the window"
        />
      </span>
    </div>
  );
}
