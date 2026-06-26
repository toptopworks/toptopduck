import { useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

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
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (typeof selected === "string") {
      onIngest(selected);
    }
  }

  // Drag-and-drop: accept dropped .csv paths (Tauri webview event).
  useEffect(() => {
    const app = getCurrentWebviewWindow();
    const unlisten = app.onDragDropEvent((event) => {
      if (event.payload.type === "drop" && event.payload.paths.length > 0) {
        onIngest(event.payload.paths[0]);
      }
    });
    return () => {
      void unlisten.then((u) => u());
    };
  }, [onIngest]);

  return (
    <div className="dropzone">
      <button onClick={pick} disabled={loading}>
        {loading ? "加载中…" : "选择 CSV 文件"}
      </button>
      <span className="muted">或把 .csv 文件拖到窗口</span>
    </div>
  );
}
