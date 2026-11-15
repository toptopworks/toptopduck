import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import type { AppConfig, EngineDefaults, ExtensionChannel } from "../../types/app-config";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
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

/** Set the extension channel tier wholesale (ADR-0150, issue #1583). The tier
 *  is one coupling unit -- the main switch maps off↔core, the community
 *  child switch maps core↔community -- so both switches commit through this
 *  single read-modify-write patch (no draft state: a two-state toggle's
 *  clicked position IS the final value). */
function patchExtensionChannel(cfg: AppConfig, next: ExtensionChannel): AppConfig {
  return { ...cfg, engine: { ...cfg.engine, extension_channel: next } };
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
  const intl = useIntl();
  const [draft, setDraft] = useState<EngineDraft>(toEngineDraft(appConfig.engine));
  const [savingField, setSavingField] = useState<keyof EngineDraft | null>(null);
  const [savingChannel, setSavingChannel] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveField(field: keyof EngineDraft) {
    setSavingField(field);
    setError(null);
    const err = await onCommit((cfg) => patchEngine(cfg, field, draft[field]));
    setError(err);
    setSavingField(null);
  }

  /** Commit a tier flip immediately (the toggle's clicked position is final).
   *  The optimistic write flips the parent's app-config, so the switches
   *  re-render from the new tier; on failure the parent reverts and the
   *  error surfaces on the pane's shared error line. */
  async function saveChannel(next: ExtensionChannel) {
    setSavingChannel(true);
    setError(null);
    const err = await onCommit((cfg) => patchExtensionChannel(cfg, next));
    setError(err);
    setSavingChannel(false);
  }

  const saving = savingField !== null;
  const channel = appConfig.engine.extension_channel;
  const channelDisabled = saving || savingChannel;

  function saveButton(field: keyof EngineDraft) {
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

      {/* ADR-0150: the extension-channel tier as a linked switch pair. The
       *  main switch flips off↔core; the community child switch (operable
       *  only while the main switch is on) flips core↔community. Both commit
       *  through one read-modify-write patch -- the tier is a single coupling
       *  unit, so the two switches can never save two half-states. */}
      <SettingsCard>
        <SettingsRow
          title={(
            <FormattedMessage
              id="settings.engine.extensionChannel"
              defaultMessage="Extension channel:"
            />
          )}
          description={(
            <FormattedMessage
              id="settings.engine.extensionChannel.description"
              defaultMessage="Allow the agent to run explicit INSTALL / LOAD statements for DuckDB extensions. Applies to new sessions."
            />
          )}
        >
          <Switch
            checked={channel !== "off"}
            disabled={channelDisabled}
            aria-label={intl.formatMessage({
              id: "settings.engine.extensionChannel",
              defaultMessage: "Extension channel:",
            })}
            onCheckedChange={(on) => void saveChannel(on ? "core" : "off")}
          />
        </SettingsRow>

        <SettingsRow
          title={(
            <FormattedMessage
              id="settings.engine.extensionChannel.community"
              defaultMessage="Community extensions:"
            />
          )}
          description={(
            <FormattedMessage
              id="settings.engine.extensionChannel.community.description"
              defaultMessage="Also allow INSTALL ... FROM community. Community builds ship without an official maintenance or security-response promise."
            />
          )}
        >
          <Switch
            checked={channel === "community"}
            disabled={channelDisabled || channel === "off"}
            aria-label={intl.formatMessage({
              id: "settings.engine.extensionChannel.community",
              defaultMessage: "Community extensions:",
            })}
            onCheckedChange={(on) => void saveChannel(on ? "community" : "core")}
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
