import type { DatasetDescriptor, DatasetPrivacy } from "../types";

interface PrivacyControlsProps {
  dataset: DatasetDescriptor;
  // True while an async op (ingest / rename / replace / privacy) is in flight;
  // disables the controls to prevent concurrent IPC from rapid toggles.
  loading: boolean;
  // Apply a new privacy config to this dataset (ADR-0011, issue #9). Carries the
  // stable reference name + the full new config; the backend swaps it on the
  // descriptor and the parent refreshes from the working set (single source of
  // truth -- no optimistic local state that could drift from the backend).
  onPrivacyChange: (referenceName: string, privacy: DatasetPrivacy) => void;
}

// Per-dataset privacy controls + the honest "current payload" disclosure
// (ADR-0011, issue #9 slice 5). The config lives on the backend descriptor; this
// component only renders it and emits the next whole config on each toggle. The
// future query-loop window assembler (PRD #1) reads the same config to prune the
// actual send -- this slice stores + discloses, it does not prune.
export function PrivacyControls({ dataset, loading, onPrivacyChange }: PrivacyControlsProps) {
  const { privacy, columns, reference_name } = dataset;
  // Treated as a set at read time; intersected with the current columns below so
  // stale entries (after a schema-changing replace) never count as "hidden".
  const typeOnly = new Set(privacy.type_only_columns);

  const toggleSamples = () => {
    onPrivacyChange(reference_name, {
      ...privacy,
      send_samples: !privacy.send_samples,
    });
  };

  const toggleColumn = (name: string) => {
    const nextColumns = typeOnly.has(name)
      ? privacy.type_only_columns.filter((c) => c !== name)
      : [...privacy.type_only_columns, name];
    onPrivacyChange(reference_name, { ...privacy, type_only_columns: nextColumns });
  };

  // Honest disclosure of the *current* effective payload (ADR-0011): which column
  // names + types leave the machine, and whether sample values do. A type-only
  // column contributes only its DuckDB type -- neither its name nor its values.
  const hiddenNames = columns.map((c) => c.name).filter((n) => typeOnly.has(n));
  const sentColumnNames = columns.map((c) => c.name).filter((n) => !typeOnly.has(n));

  return (
    <div className="privacy">
      <h3>隐私控制</h3>

      <label className="privacy-samples">
        <input
          type="checkbox"
          checked={privacy.send_samples}
          disabled={loading}
          onChange={toggleSamples}
        />
        向云端 LLM 发送样本值（加载时冻结的首 3 行）
      </label>
      {!privacy.send_samples && (
        <p className="muted">
          已关闭样本发送：该数据集的任何单元格值都不会进入待发载荷（列名与类型仍按下方列控制发送）。
        </p>
      )}

      <table className="privacy-cols">
        <thead>
          <tr>
            <th scope="col">列</th>
            <th scope="col">DuckDB 类型</th>
            <th scope="col">仅类型（不发值、不发列名）</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c) => (
            <tr key={c.name}>
              <td>{c.name}</td>
              <td>
                <code>{c.canonical_type}</code>
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={typeOnly.has(c.name)}
                  disabled={loading}
                  onChange={() => toggleColumn(c.name)}
                  aria-label={`仅类型 ${c.name}`}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="disclosure-summary">
        <strong>当前待发载荷：</strong>
        {privacy.send_samples ? "发送冻结的首 3 行样本值；" : "不发送任何样本值；"}
        列名与类型：{sentColumnNames.length} 列发送
        {sentColumnNames.length > 0 ? `（${sentColumnNames.join("、")}）` : ""}
        {hiddenNames.length > 0
          ? `，${hiddenNames.length} 列仅类型——列名与值均不发送（仅 DuckDB 类型）。`
          : "。"}
      </p>
      <p className="muted">
        标为「仅类型」的列：其列名与取值都不会发给云端 LLM（仅类型发送，便于 LLM 了解 schema 形状）；样本开启时，这些列在样本中同样被剔除。
        完整数据集永不离开本机；以上控制决定提问时随 schema 一并发送的内容。
      </p>
    </div>
  );
}
