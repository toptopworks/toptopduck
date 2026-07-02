import { open } from "@tauri-apps/plugin-dialog";
import type { DatasetDescriptor } from "../types";

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
  if (datasets.length === 0) {
    return <p className="muted">工作集为空 — 拖入或拾取一个数据文件开始。</p>;
  }

  // Prompt for a new display label. The answer is trimmed; a blank or
  // no-change result is ignored. A collision is rejected by the backend.
  const promptRename = (d: DatasetDescriptor) => {
    const next = window.prompt("重命名显示名", d.display_name);
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
          name: "数据文件",
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
    const ok = window.confirm(`确定从工作集删除「${d.display_name}」？`);
    if (ok) {
      onDelete?.(d.reference_name);
    }
  };

  return (
    <ul className="working-set">
      {datasets.map((d) => (
        <li
          key={d.reference_name}
          className={d.reference_name === activeName ? "active" : ""}
        >
          <button type="button" onClick={() => onSelect(d.reference_name)}>
            {d.display_name}
            {d.reference_name === activeName ? " · 当前表" : ""}
            <small> {d.row_count} 行</small>
          </button>
          <button
            type="button"
            className="rename"
            aria-label={`重命名 ${d.display_name}`}
            title="重命名显示名"
            disabled={loading}
            onClick={() => promptRename(d)}
          >
            ✎
          </button>
          {onReplace && (
            <button
              type="button"
              className="replace"
              aria-label={`换源 ${d.display_name}`}
              title="重新上传替换此数据集（沿用引用名）"
              disabled={loading}
              onClick={() => void pickReplace(d)}
            >
              ↻
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className="delete"
              aria-label={`删除 ${d.display_name}`}
              title="从工作集删除此数据集"
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
