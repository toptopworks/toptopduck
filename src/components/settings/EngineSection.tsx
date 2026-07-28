import { useState } from "react";
import { FormattedMessage } from "react-intl";

import type { AppConfig, EngineDefaults } from "../../types/app-config";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { PaneHeader, SettingsCard, SettingsRow } from "./settings-chrome";

// Engine pane (ADR-0075, issue #281): the four DuckDB engine defaults
// (ADR-0005) as four INDEPENDENT explicit-save rows (governing principle case
// c -- restart / explicit-apply fields keep a per-field Save). Each field owns
// its own local draft + Save button and commits ONLY its own field via a
// read-modify-write over the latest app-config (save-unit = coupling boundary:
// the four numbers are independent, so saving one must not clobber or smuggle
// the others' pending edits). A failed save surfaces an inline error and keeps
// the typed draft so the user can retry (the parent's onCommit reverts the
// optimistic app-config write; the draft is unaffected either way). Applying
// these to the live DuckDB engine is still a follow-up slice.

export type EngineSectionProps = {
  appConfig: AppConfig;
  /** Commit a patch (optimistic); on IPC failure the parent reverts + returns
   *  the formatted error (null on success). */
  onCommit: (mutate: (cfg: AppConfig) => AppConfig) => Promise<string | null>;
};

export function EngineSection({ appConfig, onCommit }: EngineSectionProps) {
  // Local editable drafts, seeded from the committed engine defaults. Each
  // field commits independently; the drafts hold pending edits until saved.
  const [draft, setDraft] = useState<EngineDefaults>(appConfig.engine);
  const [savingField, setSavingField] = useState<keyof EngineDefaults | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function saveField(field: keyof EngineDefaults) {
    const value = draft[field];
    setSavingField(field);
    setError(null);
    const err = await onCommit((cfg) => ({
      ...cfg,
      engine: { ...cfg.engine, [field]: value },
    }));
    setError(err);
    setSavingField(null);
  }

  const saving = savingField !== null;

  function saveButton(field: keyof EngineDefaults) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => void saveField(field)}
        disabled={saving}
      >
        {savingField === field ? (
          <FormattedMessage id="settings.saving" defaultMessage="Saving…" />
        ) : (
          <FormattedMessage id="settings.save" defaultMessage="Save" />
        )}
      </Button>
    );
  }

  return (
    <div>
      <PaneHeader
        title={<FormattedMessage id="settings.nav.engine" defaultMessage="Engine" />}
        description={(
          <FormattedMessage
            id="settings.engine.description"
            defaultMessage="DuckDB engine defaults. Saved values persist and apply to new sessions."
          />
        )}
      />

      <SettingsCard>
        <SettingsRow
          title={<FormattedMessage id="settings.engine.memoryLimit" defaultMessage="Memory limit:" />}
          description={(
            <FormattedMessage
              id="settings.engine.memoryLimit.description"
              defaultMessage="Maximum memory DuckDB may use, e.g. 512MB."
            />
          )}
          action={saveButton("memory_limit")}
        >
          <Input
            type="text"
            value={draft.memory_limit}
            onChange={(e) => setDraft({ ...draft, memory_limit: e.target.value })}
            disabled={saving}
            placeholder="512MB"
          />
        </SettingsRow>

        <SettingsRow
          title={<FormattedMessage id="settings.engine.threads" defaultMessage="Threads:" />}
          description={(
            <FormattedMessage
              id="settings.engine.threads.description"
              defaultMessage="Parallel worker threads DuckDB may schedule."
            />
          )}
          action={saveButton("threads")}
        >
          <Input
            type="number"
            min={1}
            value={draft.threads}
            onChange={(e) =>
              setDraft({ ...draft, threads: Math.max(1, Number(e.target.value) || 1) })}
            disabled={saving}
          />
        </SettingsRow>

        <SettingsRow
          title={<FormattedMessage id="settings.engine.rowCap" defaultMessage="Result row cap:" />}
          description={(
            <FormattedMessage
              id="settings.engine.rowCap.description"
              defaultMessage="Ceiling on a materialized result's row count."
            />
          )}
          action={saveButton("row_cap")}
        >
          <Input
            type="number"
            min={1}
            value={draft.row_cap}
            onChange={(e) =>
              setDraft({ ...draft, row_cap: Math.max(1, Number(e.target.value) || 1) })}
            disabled={saving}
          />
        </SettingsRow>

        <SettingsRow
          title={(
            <FormattedMessage
              id="settings.engine.statementTimeout"
              defaultMessage="Statement timeout (ms):"
            />
          )}
          description={(
            <FormattedMessage
              id="settings.engine.statementTimeout.description"
              defaultMessage="Per-statement timeout in milliseconds."
            />
          )}
          action={saveButton("statement_timeout_ms")}
        >
          <Input
            type="number"
            min={1}
            value={draft.statement_timeout_ms}
            onChange={(e) =>
              setDraft({
                ...draft,
                statement_timeout_ms: Math.max(1, Number(e.target.value) || 1),
              })}
            disabled={saving}
          />
        </SettingsRow>
      </SettingsCard>

      <p className="text-muted-foreground mt-3 text-sm">
        <FormattedMessage
          id="settings.engine.hint"
          defaultMessage="This slice persists and restores these values across restarts; applying them to the live DuckDB engine is a follow-up slice."
        />
      </p>
      {error && <p className="settings-error mt-3 text-destructive text-sm">{error}</p>}
    </div>
  );
}
