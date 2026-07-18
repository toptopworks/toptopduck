import { FormattedMessage } from "react-intl";

import { Input } from "../ui/input";
import { Label } from "../ui/label";
import type { SettingsForm } from "./sections";

// Engine pane (ADR-0065, issue #151): the DuckDB engine defaults (ADR-0005),
// migrated verbatim from SettingsDialog's engine fieldset. A later slice will
// apply these to the live engine; this slice persists + restores them.
export function EngineSection({ form }: { form: SettingsForm }) {
  const { engine, setEngine, saving } = form;
  return (
    <fieldset className="grid gap-2 border-0 p-0 m-0">
      <legend className="text-sm font-medium">
        <FormattedMessage id="settings.engine.legend" defaultMessage="Engine defaults (ADR-0005)" />
      </legend>
      <Label>
        <FormattedMessage id="settings.engine.memoryLimit" defaultMessage="Memory limit:" />
        <Input
          type="text"
          value={engine.memory_limit}
          onChange={(e) => setEngine({ ...engine, memory_limit: e.target.value })}
          disabled={saving}
          placeholder="512MB"
        />
      </Label>
      <Label>
        <FormattedMessage id="settings.engine.threads" defaultMessage="Threads:" />
        <Input
          type="number"
          min={1}
          value={engine.threads}
          onChange={(e) =>
            setEngine({ ...engine, threads: Math.max(1, Number(e.target.value) || 1) })}
          disabled={saving}
        />
      </Label>
      <Label>
        <FormattedMessage id="settings.engine.rowCap" defaultMessage="Result row cap:" />
        <Input
          type="number"
          min={1}
          value={engine.row_cap}
          onChange={(e) =>
            setEngine({ ...engine, row_cap: Math.max(1, Number(e.target.value) || 1) })}
          disabled={saving}
        />
      </Label>
      <Label>
        <FormattedMessage
          id="settings.engine.statementTimeout"
          defaultMessage="Statement timeout (ms):"
        />
        <Input
          type="number"
          min={1}
          value={engine.statement_timeout_ms}
          onChange={(e) =>
            setEngine({
              ...engine,
              statement_timeout_ms: Math.max(1, Number(e.target.value) || 1),
            })}
          disabled={saving}
        />
      </Label>
      <p className="text-muted-foreground text-sm">
        <FormattedMessage
          id="settings.engine.hint"
          defaultMessage="This slice persists and restores these values across restarts; applying them to the live DuckDB engine is a follow-up slice."
        />
      </p>
    </fieldset>
  );
}
