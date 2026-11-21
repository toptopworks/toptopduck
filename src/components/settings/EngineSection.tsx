import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import type { AppConfig, EngineDefaults, ExtensionChannel } from "../../types/app-config";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
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

/** The unit Select's items: the byte-multiple units users actually set an
 *  engine ceiling in. A stored unit outside this list degrades to "" until
 *  the user re-picks one (save then composes a canonical value). */
const MEMORY_UNITS = ["MB", "GB"] as const;

/** Split a stored memory-limit string ("512MB") into the number-input +
 *  unit-select draft pair. Mirrors the backend gate's split-at-first-letter
 *  grammar; an unknown unit degrades to "" (the Select shows nothing until
 *  the user re-picks -- save then composes a canonical value). */
function toMemoryDraft(memoryLimit: string): { amount: string; unit: string } {
  const split = memoryLimit.search(/[a-zA-Z]/);
  const amount = (split === -1 ? memoryLimit : memoryLimit.slice(0, split)).trim();
  const unit = (split === -1 ? "" : memoryLimit.slice(split)).trim().toUpperCase();
  return { amount, unit: (MEMORY_UNITS as readonly string[]).includes(unit) ? unit : "" };
}

/** Local string draft of the engine defaults. The memory limit rides the
 *  structured pair (amount + unit) so the composed value always passes the
 *  backend's well-formedness gate; the numeric fields are held as the raw
 *  text the user typed (including "") so a field can be cleared and retyped
 *  instead of snapping back to 1 -- parsing + clamping happen at the save
 *  boundary (an explicit save is not a correctness gate). */
type EngineDraft = {
  memoryAmount: string;
  memoryUnit: string;
  threads: string;
  row_cap: string;
};

function toEngineDraft(e: EngineDefaults): EngineDraft {
  const memory = toMemoryDraft(e.memory_limit);
  return {
    memoryAmount: memory.amount,
    memoryUnit: memory.unit,
    threads: String(e.threads),
    row_cap: String(e.row_cap),
  };
}

type SavingField = "memory" | "threads" | "row_cap";

/** Apply one numeric draft field onto the latest app-config's engine
 *  (read-modify-write keeps sibling fields intact); parses + clamps to a
 *  safe minimum of 1. */
function patchEngine(cfg: AppConfig, field: "threads" | "row_cap", raw: string): AppConfig {
  const engine = { ...cfg.engine };
  const parsed = Number(raw);
  engine[field] = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1;
  return { ...cfg, engine };
}

/** Compose the memory-limit string from the structured draft ("512" + "MB"
 *  → "512MB"). The amount must ride the backend gate's grammar -- ASCII
 *  digits with at most one dot, value > 0 -- so a step="any" number input's
 *  exponent forms ("1e3") fall back to the stored value instead of
 *  composing a string the gate would reject; combined with a picked unit,
 *  this keeps the composed value well-formed and the silent sanitize
 *  revert unreachable (the explicit-save-is-not-a-correctness-gate
 *  precedent governs the fallback). */
function patchMemoryLimit(cfg: AppConfig, draft: EngineDraft): AppConfig {
  const engine = { ...cfg.engine };
  const raw = draft.memoryAmount.trim();
  const amount = Number(raw);
  if (/^\d*\.?\d+$/.test(raw) && amount > 0 && draft.memoryUnit !== "") {
    engine.memory_limit = `${raw}${draft.memoryUnit}`;
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
  const [savingField, setSavingField] = useState<SavingField | null>(null);
  const [savingChannel, setSavingChannel] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveField(field: "threads" | "row_cap") {
    setSavingField(field);
    setError(null);
    const err = await onCommit((cfg) => patchEngine(cfg, field, draft[field]));
    setError(err);
    setSavingField(null);
  }

  /** Commit the memory limit composed from the structured amount + unit
   *  draft (patchMemoryLimit keeps the stored value when the pair is not
   *  saveable); the pending draft stays for retry on failure. */
  async function saveMemoryLimit() {
    setSavingField("memory");
    setError(null);
    const err = await onCommit((cfg) => patchMemoryLimit(cfg, draft));
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

  function saveButton(field: SavingField) {
    const save = field === "memory" ? saveMemoryLimit : () => saveField(field);
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => void save()}
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
            defaultMessage="Default settings for the analysis engine. Changes apply to sessions created afterwards."
          />
        )}
      />

      <SettingsCard>
        <SettingsRow
          title={<FormattedMessage id="settings.engine.memoryLimit" defaultMessage="Memory limit" />}
          description={(
            <FormattedMessage
              id="settings.engine.memoryLimit.description"
              defaultMessage="How much memory a session's engine may use, such as 512MB. Covers query processing and table-data caching."
            />
          )}
          action={saveButton("memory")}
        >
          {/* Number + unit compose the stored "512MB"-style string at save
              time; the composer refuses any pair outside the gate's grammar,
              so the composed value can never be one the gate rejects and the
              silent sanitize revert is unreachable from this UI. */}
          <div className="flex items-center gap-2">
            <Input
              type="number"
              step="any"
              aria-label={intl.formatMessage({
                id: "settings.engine.memoryLimit",
                defaultMessage: "Memory limit",
              })}
              value={draft.memoryAmount}
              onChange={(e) => setDraft({ ...draft, memoryAmount: e.target.value })}
              disabled={saving}
              className="min-w-0 flex-1"
            />
            <Select
              value={draft.memoryUnit}
              onValueChange={(v) => setDraft({ ...draft, memoryUnit: v })}
              disabled={saving}
            >
              <SelectTrigger
                className="w-24 shrink-0"
                aria-label={intl.formatMessage({
                  id: "settings.engine.memoryLimit.unit",
                  defaultMessage: "Memory limit unit",
                })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MEMORY_UNITS.map((unit) => (
                  <SelectItem key={unit} value={unit}>
                    {unit}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SettingsRow>

        <SettingsRow
          title={<FormattedMessage id="settings.engine.threads" defaultMessage="Threads" />}
          description={(
            <FormattedMessage
              id="settings.engine.threads.description"
              defaultMessage="How many threads the engine may use to run queries in parallel."
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
          title={<FormattedMessage id="settings.engine.rowCap" defaultMessage="Result row cap" />}
          description={(
            <FormattedMessage
              id="settings.engine.rowCap.description"
              defaultMessage="The maximum number of rows a single query may return."
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
      <SettingsCard className="mt-4">
        <SettingsRow
          title={(
            <FormattedMessage
              id="settings.engine.extensionChannel"
              defaultMessage="Extension installs"
            />
          )}
          description={(
            <FormattedMessage
              id="settings.engine.extensionChannel.description"
              defaultMessage="DuckDB extensions enhance the engine with more file formats, new data types, and domain-specific functionality; when on, the agent can install and load official extensions during a session."
            />
          )}
          action={(
            <Switch
              checked={channel !== "off"}
              disabled={channelDisabled}
              aria-label={intl.formatMessage({
                id: "settings.engine.extensionChannel",
                defaultMessage: "Extension installs",
              })}
              onCheckedChange={(on) => void saveChannel(on ? "core" : "off")}
            />
          )}
        />

        <SettingsRow
          title={(
            <FormattedMessage
              id="settings.engine.extensionChannel.community"
              defaultMessage="Community extensions"
            />
          )}
          description={(
            <FormattedMessage
              id="settings.engine.extensionChannel.community.description"
              defaultMessage="Also allow extensions from the community registry. These are community-maintained, without an official maintenance or security-response commitment."
            />
          )}
          action={(
            <Switch
              checked={channel === "community"}
              disabled={channelDisabled || channel === "off"}
              aria-label={intl.formatMessage({
                id: "settings.engine.extensionChannel.community",
                defaultMessage: "Community extensions",
              })}
              onCheckedChange={(on) => void saveChannel(on ? "community" : "core")}
            />
          )}
        />
      </SettingsCard>

      {error && <p className="settings-error mt-3 text-destructive text-sm">{error}</p>}
    </div>
  );
}
