import { useState } from "react";
import { FormattedMessage } from "react-intl";

import type { AppConfig, EngineDefaults } from "../../types/app-config";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { PaneHeader, SettingsCard, SettingsRow } from "./settings-chrome";

// Engine pane (ADR-0075, issue #281): the three DuckDB engine defaults
// (ADR-0005) as three INDEPENDENT explicit-save rows (governing principle case
// c -- restart / explicit-apply fields keep a per-field Save). Each field owns
// its own local draft + Save button and commits ONLY its own field via a
// read-modify-write over the latest app-config (save-unit = coupling boundary:
// the numbers are independent, so saving one must not clobber or smuggle the
// others' pending edits). A failed save surfaces an inline error and keeps
// the typed draft so the user can retry (the parent's onCommit reverts the
// optimistic app-config write; the draft is unaffected either way). Saved
// values are consumed at session construction as the session-level snapshot
// (issue #741): a change only reaches sessions created after it.

/** Local string draft of the engine defaults. Numeric fields are held as the
 *  raw text the user typed (including "") so a number field can be cleared and
 *  retyped instead of snapping back to 1; parsing + clamping happen at the save
 *  boundary (governing principle: an explicit save is not a correctness gate,
 *  so an empty / invalid value clamps to the safe minimum there). */
type EngineDraft = {
  memory_limit: string;
  threads: string;
  row_cap: string;
};

function toEngineDraft(e: EngineDefaults): EngineDraft {
  return {
    memory_limit: e.memory_limit,
    threads: String(e.threads),
    row_cap: String(e.row_cap),
  };
}

/** Apply one draft field onto the latest app-config's engine (read-modify-write
 *  keeps sibling fields intact). memory_limit falls back to the stored value
 *  when blank; numeric fields parse + clamp to a safe minimum of 1. */
function patchEngine(cfg: AppConfig, field: keyof EngineDraft, raw: string): AppConfig {
  const engine = { ...cfg.engine };
  if (field === "memory_limit") {
    engine.memory_limit = raw.trim() || cfg.engine.memory_limit;
  } else {
    const parsed = Number(raw);
    engine[field] = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1;
  }
  return { ...cfg, engine };
}

export type EngineSectionProps = {
  appConfig: AppConfig;
  /** Commit a patch (optimistic); on IPC failure the parent reverts + returns
   *  the formatted error (null on success). */
  onCommit: (mutate: (cfg: AppConfig) => AppConfig) => Promise<string | null>;
};

export function EngineSection({ appConfig, onCommit }: EngineSectionProps) {
  // Local editable drafts, seeded from the committed engine defaults. Each
  // field commits independently; the drafts hold pending edits until saved.
  const [draft, setDraft] = useState<EngineDraft>(toEngineDraft(appConfig.engine));
  const [savingField, setSavingField] = useState<keyof EngineDraft | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function saveField(field: keyof EngineDraft) {
    setSavingField(field);
    setError(null);
    const err = await onCommit((cfg) => patchEngine(cfg, field, draft[field]));
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
          <FormattedMessage id="common.saving" defaultMessage="Saving…" />
        ) : (
          <FormattedMessage id="common.save" defaultMessage="Save" />
        )}
      </Button>
    );
  }

  return (
    <div>
      <PaneHeader
        title={<FormattedMessage id="settings.nav.databaseEngine" defaultMessage="Analysis Engine" />}
        description={(
          <FormattedMessage
            id="settings.engine.description"
            defaultMessage="Engine defaults. Saved values apply to newly created sessions."
          />
        )}
      />

      <SettingsCard>
        <SettingsRow
          title={<FormattedMessage id="settings.engine.memoryLimit" defaultMessage="Memory limit:" />}
          description={(
            <FormattedMessage
              id="settings.engine.memoryLimit.description"
              defaultMessage="Maximum memory the engine may use, e.g. 512MB."
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
              defaultMessage="Parallel worker threads the engine may schedule."
            />
          )}
          action={saveButton("threads")}
        >
          <Input
            type="number"
            min={1}
            value={draft.threads}
            onChange={(e) => setDraft({ ...draft, threads: e.target.value })}
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
            onChange={(e) => setDraft({ ...draft, row_cap: e.target.value })}
            disabled={saving}
          />
        </SettingsRow>
      </SettingsCard>

      <p className="text-muted-foreground mt-3 text-sm">
        <FormattedMessage
          id="settings.engine.hint"
          defaultMessage="Changes affect new sessions only; existing sessions keep the limits they were created with."
        />
      </p>
      {error && <p className="settings-error mt-3 text-destructive text-sm">{error}</p>}
    </div>
  );
}
