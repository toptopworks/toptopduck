import type { DatasetDescriptor, DatasetPrivacy } from "../types";
import { PrivacyControls } from "./PrivacyControls";

interface DatasetDetailProps {
  dataset: DatasetDescriptor;
  // Forwarded to PrivacyControls: disables the toggles while an async op is in
  // flight, and applies a new privacy config to this dataset (ADR-0011, #9).
  loading?: boolean;
  onPrivacyChange?: (referenceName: string, privacy: DatasetPrivacy) => void;
}

export function DatasetDetail({ dataset, loading = false, onPrivacyChange }: DatasetDetailProps) {
  return (
    <section className="dataset-detail">
      <h2>
        {dataset.display_name} <small>(引用名：{dataset.reference_name})</small>
      </h2>
      <p className="meta">
        行数：{dataset.row_count} · 指纹：{dataset.fingerprint.slice(0, 12)}…
      </p>

      <h3>列与推断类型</h3>
      <table className="schema">
        <thead>
          <tr>
            <th>列</th>
            <th>DuckDB 类型</th>
          </tr>
        </thead>
        <tbody>
          {dataset.columns.map((c) => (
            <tr key={c.name}>
              <td>{c.name}</td>
              <td><code>{c.canonical_type}</code></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>加载时冻结的首 3 行样本</h3>
      {dataset.sample.length === 0 ? (
        <p className="muted">（无数据行）</p>
      ) : (
        <table className="sample">
          <thead>
            <tr>
              {dataset.columns.map((c) => (
                <th key={c.name}>{c.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dataset.sample.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {onPrivacyChange && (
        <PrivacyControls
          dataset={dataset}
          loading={loading}
          onPrivacyChange={onPrivacyChange}
        />
      )}

      <p className="source">来源文件：{dataset.source_path}</p>
    </section>
  );
}
