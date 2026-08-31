import { FormattedMessage } from "react-intl";
import type { DatasetDescriptor, DatasetPrivacy } from "../../types/dataset";
import { PrivacyControls } from "./PrivacyControls";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

interface DatasetDetailProps {
  dataset: DatasetDescriptor;
  // Forwarded to PrivacyControls: disables the toggles while an async op is in
  // flight, and applies a new privacy config to this dataset (ADR-0011, #9).
  loading?: boolean;
  onPrivacyChange?: (referenceName: string, privacy: DatasetPrivacy) => void;
}

export function DatasetDetail({ dataset, loading = false, onPrivacyChange }: DatasetDetailProps) {
  return (
    // ADR-0067 (issue #184): the caller-scoped visual rules that lived under
    // .dataset-detail h2 / .dataset-detail small / .meta / .source / .schema td
    // code in styles.css retired onto Tailwind utility on each element below.
    // The class hooks (.dataset-detail / .meta / .source / .schema) stay on the
    // elements for selector stability. ADR-0067 (issue #185): the empty-rows
    // <p> used to ride the global .muted color rule; that rule is now retired
    // too, so the <p> carries text-muted-foreground inline (and the <code> in
    // the schema column carries font-mono, replacing the global code element
    // rule). Deliberate drop: the retired element rule listed "Cascadia Code"
    // in its font stack; font-mono resolves to the Tailwind v4 default mono
    // stack (ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, ...) which
    // omits Cascadia Code -- accepted to align with the other font-mono
    // consumers (<pre> error-stack in TechnicalDetailsFold) and avoid a
    // bespoke --font-mono token override (ADR-0067 Decision 2).
    <section className="dataset-detail">
      <h2 className="m-0 mb-1">
        {dataset.display_name}{" "}
        <small className="text-muted-foreground font-normal">
          <FormattedMessage
            id="workingSet.detail.referenceName"
            defaultMessage="(reference name: {name})"
            values={{ name: dataset.reference_name }}
          />
        </small>
      </h2>
      <p className="meta text-muted-foreground mt-1 mb-3">
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
              <FormattedMessage id="column.type" defaultMessage="Data type" />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {dataset.columns.map((c) => (
            <TableRow key={c.name}>
              <TableCell>{c.name}</TableCell>
              {/* Nested DuckDB types (STRUCT(...)/LIST(...)) wrap instead of
                  overflowing the panel. */}
              <TableCell><code className="font-mono break-words whitespace-pre-wrap">{c.canonical_type}</code></TableCell>
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
        <p className="text-muted-foreground">
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

      <p className="source text-muted-foreground text-[0.85rem] break-all">
        <FormattedMessage
          id="workingSet.detail.sourceFile"
          defaultMessage="Source file: {path}"
          values={{ path: dataset.source_path }}
        />
      </p>
    </section>
  );
}
