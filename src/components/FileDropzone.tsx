import { open } from "@tauri-apps/plugin-dialog";

export function FileDropzone({
  onIngest,
  loading,
}: {
  onIngest: (path: string) => void;
  loading: boolean;
}) {
  async function pick() {
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: "数据文件",
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
        {loading ? "加载中…" : "选择数据文件"}
      </button>
      <span className="muted">或把 .csv / .parquet / .json / .xlsx 文件拖到窗口</span>
    </div>
  );
}
