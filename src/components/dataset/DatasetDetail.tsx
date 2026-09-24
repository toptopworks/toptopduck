import { FormattedMessage, useIntl } from "react-intl";
import type { ColumnSchema, DatasetDescriptor, DatasetPrivacy } from "../../types/dataset";
import { PrivacyControls } from "./PrivacyControls";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Badge } from "../ui/badge";
import { staleChipVerb } from "../thread/turn-visual";
import { fmtError } from "../../lib/error-presentation/format";

// What the container hands the preview renderer: the column list plus one
// page of rows. Narrow on purpose -- total / offset / limit are the paged
// reader's bookkeeping, while the detail pane renders one fixed window.
export interface DatasetSamplePage {
  columns: ColumnSchema[];
  rows: string[][];
}

interface DatasetDetailProps {
  dataset: DatasetDescriptor;
  // The live preview state, owned by the working-set container (issue
  // #1061): the fetched page (null = nothing yet), its in-flight flag, and
  // the raw read error (formatted one-line inside). Error wins over a stale
  // cached page -- an honest error never hides behind old rows.
  sample: DatasetSamplePage | null;
  sampleLoading: boolean;
  sampleError: unknown;
  // Forwarded to PrivacyControls: disables the toggles while an async op is in
  // flight, and applies a new privacy config to this dataset (ADR-0011, #9).
  loading?: boolean;
  onPrivacyChange?: (referenceName: string, privacy: DatasetPrivacy) => void;
}

export function DatasetDetail({
  dataset,
  sample,
  sampleLoading,
  sampleError,
  loading = false,
  onPrivacyChange,
}: DatasetDetailProps) {
  const intl = useIntl();
  // The preview's one visible state (issue #1061): a read error, the
  // in-flight line, the fetched table, or NOTHING -- a 0-row read renders no
  // sample section at all (no skeleton, no empty shell; the meta line's row
  // count already says it). Everything else in the pane keeps working
  // whichever state the preview lands in: a failed local read never takes
  // the management surface down.
  const previewState = sampleError
    ? ("error" as const)
    : sampleLoading
      ? ("loading" as const)
      : sample && sample.rows.length > 0
        ? ("table" as const)
        : null;
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
      <h2 className="m-0 mb-1 text-base font-semibold">
        {dataset.display_name}{" "}
        <small className="text-muted-foreground font-normal">
          <FormattedMessage
            id="workingSet.detail.referenceName"
            defaultMessage="(reference name: {name})"
            values={{ name: dataset.reference_name }}
          />
        </small>
        {dataset.stale && (
          // A stale dataset stays previewable (its data still reads, ADR-0013)
          // and carries a plain muted Badge (ADR-0050 stale semantic) whose
          // wording shares the thread stale chip's verb helper -- Replaced /
          // Deleted never diverge between the two surfaces. A LABEL, not the
          // thread's clickable chip: no button semantics, no jump promise.
          <Badge variant="secondary" className="stale-badge ml-2">
            {staleChipVerb(intl, dataset.stale.reason)}
          </Badge>
        )}
      </h2>
      {/* #793: the meta line keeps Rows only -- the fingerprint is near-zero
          value at a glance (it exists to prove "the file really did change"
          during troubleshooting) and lives with the source-file provenance
          block at the bottom instead. */}
      <p className="meta text-muted-foreground mt-1 mb-3">
        <FormattedMessage
          id="workingSet.detail.meta"
          defaultMessage="Rows: {rows}"
          values={{ rows: dataset.row_count }}
        />
      </p>

      <h3 className="text-base font-semibold">
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
              <TableCell><code className="font-mono text-[13px] break-words whitespace-pre-wrap">{c.canonical_type}</code></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {previewState !== null && (
        <>
          <h3 className="text-base font-semibold">
            {/* Plain heading by design (issue #1061 review): the count the
                table actually shows varies with the dataset's total, and the
                meta line already carries the authoritative row count -- a
                hardcoded window in the label would lie for smaller datasets. */}
            <FormattedMessage
              id="workingSet.detail.sampleHeading"
              defaultMessage="Data sample"
            />
          </h3>
          {previewState === "error" && (
            <p className="text-destructive">{fmtError(sampleError, intl)}</p>
          )}
          {previewState === "loading" && (
            <p className="text-muted-foreground">
              <FormattedMessage
                id="workingSet.detail.sampleLoading"
                defaultMessage="Loading rows…"
              />
            </p>
          )}
          {previewState === "table" && sample && (
            // The disclosure threshold (issue #1061): max-height + internal
            // scroll. The cap keeps the schema table and the management area
            // in view in every layout, including the <=600px single-column
            // fallback (issue #791); the cut-off row at the edge signals the
            // rest. Overflow on both axes: wide tables scroll horizontally
            // inside the same cap.
            <div className="sample-body max-h-64 overflow-auto">
              <Table className="sample">
                <TableHeader>
                  <TableRow>
                    {sample.columns.map((c) => (
                      <TableHead key={c.name}>{c.name}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sample.rows.map((row, i) => (
                    <TableRow key={i}>
                      {row.map((cell, j) => (
                        <TableCell key={j}>{cell}</TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}

      {onPrivacyChange && (
        <PrivacyControls
          dataset={dataset}
          loading={loading}
          onPrivacyChange={onPrivacyChange}
        />
      )}

      {/* The source provenance block: hidden entirely when the source path is
          empty (no file provenance to show -- the fingerprint is a file-change
          proof, so it has nothing to attach to either), and the full
          fingerprint sits directly under the path so a troubleshooting check
          needs no hover. Both lines break-all: a long path / the 64-char
          fingerprint wrap instead of stretching the panel. */}
      {dataset.source_path !== "" && (
        <>
          <p className="source text-muted-foreground text-[0.85rem] break-all">
            <FormattedMessage
              id="workingSet.detail.sourceFile"
              defaultMessage="Source file: {path}"
              values={{ path: dataset.source_path }}
            />
          </p>
          <p className="fingerprint text-muted-foreground text-[0.85rem] break-all">
            <FormattedMessage
              id="workingSet.detail.fingerprint"
              defaultMessage="Fingerprint: {fingerprint}"
              values={{
                // The hex value rides the {typography.code} mono token (the
                // schema-type <code> form): a 64-char data identifier reads
                // best monospaced, the prose prefix stays in the body font.
                fingerprint: (
                  <code className="font-mono text-[13px]">{dataset.fingerprint}</code>
                ),
              }}
            />
          </p>
        </>
      )}
    </section>
  );
}
