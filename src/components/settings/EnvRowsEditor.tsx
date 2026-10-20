import { FormattedMessage, useIntl } from "react-intl";
import { Trash2 } from "lucide-react";

import { Input } from "../ui/input";
import { RowRemoveButton } from "./settings-chrome";

/** One editable env row (blank keys are dropped at save). */
export interface EnvRow {
  key: string;
  value: string;
}

/** The `{ key, value }` row-editor skeleton the env sections share (issue
 *  #1343): the empty-state hint plus one mono key / value / remove row per
 *  entry. Deliberately NOT the McpServerForm `KvEditor` -- that one is
 *  folded around secret / keychain / MCP i18n coupling; this is the bare
 *  row list, so the fold chrome (head, tooltip, Add affordance) and the
 *  expand-seeds-a-blank-row policy stay with each consumer. */
export function EnvRowsEditor({
  rows,
  onChange,
  keyPlaceholder = "KEY",
  valuePlaceholder = "value",
}: {
  rows: EnvRow[];
  /** Receives the full next row list (immutably updated). */
  onChange: (rows: EnvRow[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const intl = useIntl();
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        <FormattedMessage
          id="settings.form.envEmpty"
          defaultMessage="No environment variables. Click Add variable to create one."
        />
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            className="w-40 font-mono text-xs"
            value={row.key}
            placeholder={keyPlaceholder}
            aria-label={intl.formatMessage(
              { id: "settings.cli.form.envKey", defaultMessage: "Env name (row {row})" },
              { row: index + 1 },
            )}
            onChange={(e) =>
              onChange(rows.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)))}
          />
          <Input
            className="flex-1 font-mono text-xs"
            value={row.value}
            placeholder={valuePlaceholder}
            aria-label={intl.formatMessage(
              { id: "settings.cli.form.envValue", defaultMessage: "Env value (row {row})" },
              { row: index + 1 },
            )}
            onChange={(e) =>
              onChange(rows.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)))}
          />
          <RowRemoveButton
            label={intl.formatMessage(
              { id: "settings.cli.form.removeEnv", defaultMessage: "Remove env (row {row})" },
              { row: index + 1 },
            )}
            icon={Trash2}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          />
        </div>
      ))}
    </div>
  );
}
