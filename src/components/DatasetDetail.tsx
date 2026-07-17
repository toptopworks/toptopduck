import { FormattedMessage } from "react-intl";
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
        {dataset.display_name}{" "}
        <small>
          <FormattedMessage
            id="workingSet.detail.referenceName"
            defaultMessage="(reference name: {name})"
            values={{ name: dataset.reference_name }}
          />
        </small>
      </h2>
      <p className="meta">
        <FormattedMessage
          id="workingSet.detail.meta"
          defaultMessage="Rows: {rows} · fingerprint: {fingerprint}…"
          values={{ rows: dataset.row_count, fingerprint: dataset.fingerprint.slice(0, 12) }}
        />
      </p>

      <h3>
        <FormattedMessage
          id="workingSet.detail.columnsHeading"
          defaultMessage="Columns & inferred types"
        />
      </h3>
      <Table className="schema">
        <TableHeader>
          <TableRow>
            <TableHead>
              <FormattedMessage id="column.col" defaultMessage="Column" />
            </TableHead>
            <TableHead>
              <FormattedMessage id="column.type" defaultMessage="DuckDB type" />
            </TableHead>
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

      <h3>
        <FormattedMessage
          id="workingSet.detail.sampleHeading"
          defaultMessage="First 3 rows frozen at load time"
        />
      </h3>
      {dataset.sample.length === 0 ? (
        <p className="muted">
          <FormattedMessage id="result.emptyRows" defaultMessage="(no data rows)" />
        </p>
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

      <p className="source">
        <FormattedMessage
          id="workingSet.detail.sourceFile"
          defaultMessage="Source file: {path}"
          values={{ path: dataset.source_path }}
        />
      </p>
    </section>
  );
}
