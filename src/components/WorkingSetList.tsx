import type { DatasetDescriptor } from "../types";

export function WorkingSetList({
  datasets,
  activeName,
  onSelect,
  onRename,
  loading = false,
}: {
  datasets: DatasetDescriptor[];
  activeName: string | null;
  onSelect: (referenceName: string) => void;
  // Display-only rename (ADR-0037, issue #8): the reference name is never
  // touched, so selection / SQL / active references all stay valid.
  onRename: (referenceName: string, newDisplay: string) => void;
  // Disables the rename button while an async op (rename / ingest) is in
  // flight, preventing concurrent IPC from rapid double-clicks.
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

  return (
    <ul className="working-set">
      {datasets.map((d) => (
        <li
          key={d.reference_name}
          className={d.reference_name === activeName ? "active" : ""}
        >
          <button onClick={() => onSelect(d.reference_name)}>
            {d.display_name}
            {d.reference_name === activeName ? " · 当前表" : ""}
            <small> {d.row_count} 行</small>
          </button>
          <button
            className="rename"
            aria-label={`重命名 ${d.display_name}`}
            title="重命名显示名"
            disabled={loading}
            onClick={() => promptRename(d)}
          >
            ✎
          </button>
        </li>
      ))}
    </ul>
  );
}
