import { FormattedMessage, useIntl } from "react-intl";
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
  const intl = useIntl();
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
  const colNames = columns.map((c) => c.name);
  const hiddenNames = colNames.filter((n) => typeOnly.has(n));
  const sentColumnNames = colNames.filter((n) => !typeOnly.has(n));

  // The sent-column list is formatted with Intl.ListFormat so it follows the
  // same Intl.* pipeline the rest of i18n uses (ADR-0052 layer 2), instead of
  // ad-hoc intl.locale branching (zh dunhao 、 vs en ", "). narrow + conjunction
  // yields "id、name" / "id, name" with no "and" token. The column names are
  // layer-4 hardline (passed through verbatim) -- ListFormat only picks the
  // separator between them. The disclosure summary stays a run of direct text
  // nodes under <p>, keeping the cross-punctuation getByText assertions intact.
  const listFormatter = new Intl.ListFormat(intl.locale, {
    style: "narrow",
    type: "conjunction",
  });

  return (
    <div className="privacy">
      <h3>
        <FormattedMessage id="privacy.heading" defaultMessage="Privacy controls" />
      </h3>

      <label className="privacy-samples">
        <input
          type="checkbox"
          checked={privacy.send_samples}
          disabled={loading}
          onChange={toggleSamples}
        />
        <FormattedMessage
          id="privacy.sendSamples"
          defaultMessage="Send sample values to the cloud LLM (first 3 rows frozen at load time)"
        />
      </label>
      {!privacy.send_samples && (
        <p className="muted">
          <FormattedMessage
            id="privacy.samplesOff"
            defaultMessage="Sample sending is off: no cell value from this dataset enters the outgoing payload (column names and types still follow the column controls below)."
          />
        </p>
      )}

      <table className="privacy-cols">
        <thead>
          <tr>
            <th scope="col">
              <FormattedMessage id="column.col" defaultMessage="Column" />
            </th>
            <th scope="col">
              <FormattedMessage id="column.type" defaultMessage="DuckDB type" />
            </th>
            <th scope="col">
              <FormattedMessage
                id="privacy.typeOnlyHeader"
                defaultMessage="Type only (no values, no column name)"
              />
            </th>
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
                  aria-label={intl.formatMessage(
                    { id: "privacy.typeOnlyAria", defaultMessage: "Type only {name}" },
                    { name: c.name },
                  )}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="disclosure-summary">
        <strong>
          {intl.formatMessage({
            id: "privacy.summary.heading",
            defaultMessage: "Current outgoing payload:",
          })}
        </strong>
        {privacy.send_samples
          ? intl.formatMessage({
              id: "privacy.summary.samplesOn",
              defaultMessage: " Sending the first 3 sample rows frozen at load time;",
            })
          : intl.formatMessage({
              id: "privacy.summary.samplesOff",
              defaultMessage: " No sample values are sent;",
            })}
        {intl.formatMessage(
          { id: "privacy.summary.columnsSent", defaultMessage: " column names and types: {count} sent" },
          { count: sentColumnNames.length },
        )}
        {sentColumnNames.length > 0
          ? intl.formatMessage(
              { id: "privacy.summary.sentList", defaultMessage: " ({names})" },
              { names: listFormatter.format(sentColumnNames) },
            )
          : ""}
        {hiddenNames.length > 0
          ? intl.formatMessage(
              {
                id: "privacy.summary.typeOnlySuffix",
                defaultMessage:
                  ", {count, plural, one {# column type-only — neither its name nor its value is sent (only the DuckDB type).} other {# columns type-only — neither their names nor their values are sent (only the DuckDB types).}}",
              },
              { count: hiddenNames.length },
            )
          : intl.formatMessage({ id: "privacy.summary.period", defaultMessage: "." })}
      </p>
      <p className="muted">
        <FormattedMessage
          id="privacy.note.typeOnly"
          defaultMessage='Columns marked "Type only": neither their names nor their values are sent to the cloud LLM (only the type, so the LLM can still reason about the schema shape). When samples are on, these columns are also dropped from the samples.'
        />{" "}
        <FormattedMessage
          id="privacy.note.localOnly"
          defaultMessage="The full dataset never leaves this machine; the controls above decide what is sent alongside the schema when you ask."
        />
      </p>
    </div>
  );
}
