import type { DatasetDescriptor, DatasetPrivacy } from "../types";
import { PrivacyControls } from "./PrivacyControls";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

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
      <Table className="schema">
        <TableHeader>
          <TableRow>
            <TableHead>列</TableHead>
            <TableHead>DuckDB 类型</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {dataset.columns.map((c) => (
            <TableRow key={c.name}>
              <TableCell>{c.name}</TableCell>
              <TableCell><code>{c.canonical_type}</code></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <h3>加载时冻结的首 3 行样本</h3>
      {dataset.sample.length === 0 ? (
        <p className="muted">（无数据行）</p>
      ) : (
        <Table className="sample">
          <TableHeader>
            <TableRow>
              {dataset.columns.map((c) => (
                <TableHead key={c.name}>{c.name}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {dataset.sample.map((row, i) => (
              <TableRow key={i}>
                {row.map((cell, j) => (
                  <TableCell key={j}>{cell}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
