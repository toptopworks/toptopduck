import type { DatasetDescriptor } from "../types";

export function WorkingSetList({
  datasets,
  activeName,
  onSelect,
}: {
  datasets: DatasetDescriptor[];
  activeName: string | null;
  onSelect: (referenceName: string) => void;
}) {
  if (datasets.length === 0) {
    return <p className="muted">工作集为空 — 拖入或拾取一个数据文件开始。</p>;
  }
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
        </li>
      ))}
    </ul>
  );
}
