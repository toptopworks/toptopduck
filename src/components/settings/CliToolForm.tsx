import { useState } from "react";
import { ArrowLeft, Loader2, Plus, Trash2 } from "lucide-react";
import { FormattedMessage, useIntl } from "react-intl";

import type { AppConfig } from "../../types/app-config";
import type { CliToolConfig, CliToolParam } from "../../types/cli-tool";
import { upsertCliTool } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import {
  FieldHint,
  FoldHead,
  PaneHeader,
  RowRemoveButton,
  SETTINGS_TOOLTIP_CLASS,
  SettingsCard,
  SettingsRow,
} from "./settings-chrome";

// Add/edit form for one CLI tool registration (issue #671, ADR-0108
// Decision 2). A full-page replacement for the tool list (the McpServerForm
// posture: back link, pane header, one card of row-stacked fields, and the
// save footer inside the card). Form-only (no JSON dual mode -- the MCP
// form's JSON mode exists for pasting server configs; a CLI registration has
// no such copy-source). The name is the identity anchor (tool-table name,
// approval trust key, collision anchor) and locks on edit; every other field
// is open. Client-side checks are UX sugar only -- the backend command is the
// validation authority (kebab shape, reserved names, template/param
// consistency) and its refusal surfaces through the same error lane.

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function CliToolForm({
  initialTool,
  isEdit,
  onSaved,
  onCancel,
}: {
  initialTool: CliToolConfig;
  isEdit: boolean;
  /** Receives the updated FULL app-config the backend command returned
   *  (ADR-0109 Decision 9); the section commits it wholesale. */
  onSaved: (next: AppConfig) => void;
  onCancel: () => void;
}) {
  const intl = useIntl();
  const [tool, setTool] = useState<CliToolConfig>(initialTool);
  const [argvText, setArgvText] = useState(initialTool.argv_template.join("\n"));
  const [envRows, setEnvRows] = useState(
    Object.entries(initialTool.env).map(([key, value]) => ({ key, value })),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The MCP form's KvEditor posture: a section starts collapsed when it has
  // no rows; expanding an empty section seeds one blank row to fill.
  const [paramsExpanded, setParamsExpanded] = useState(
    () => initialTool.params.length > 0,
  );
  const [envExpanded, setEnvExpanded] = useState(() => envRows.length > 0);

  function addBlankParam() {
    setTool((prev) => ({
      ...prev,
      params: [
        ...prev.params,
        { name: "", description: "", delivery: "argv", varargs: false },
      ],
    }));
  }

  function addBlankEnv() {
    setEnvRows((prev) => [...prev, { key: "", value: "" }]);
  }

  function toggleParams(next: boolean) {
    setParamsExpanded(next);
    if (next && tool.params.length === 0) addBlankParam();
  }

  function toggleEnv(next: boolean) {
    setEnvExpanded(next);
    if (next && envRows.length === 0) addBlankEnv();
  }

  function patch(partial: Partial<CliToolConfig>) {
    setTool((prev) => ({ ...prev, ...partial }));
  }

  function patchParam(index: number, partial: Partial<CliToolParam>) {
    setTool((prev) => ({
      ...prev,
      params: prev.params.map((p, i) => (i === index ? { ...p, ...partial } : p)),
    }));
  }

  /** Client-side pre-flight (UX only): the obvious shape issues get an
   *  immediate message; the backend remains the authority. */
  function preflightProblem(): string | null {
    if (!KEBAB_RE.test(tool.name)) {
      return intl.formatMessage({
        id: "settings.cli.form.nameHint",
        defaultMessage:
          "Name must be kebab-case (lowercase letters, digits, single hyphens).",
      });
    }
    if (!tool.description.trim() || !tool.executable.trim()) {
      return intl.formatMessage({
        id: "settings.cli.form.requiredHint",
        defaultMessage: "Description and executable are required.",
      });
    }
    // A folded-away blank parameter row (expanding an empty section seeds
    // one) must fail here by name, not at the backend -- the row can be
    // collapsed out of view when Save is clicked.
    if (tool.params.some((param) => param.name.trim().length === 0)) {
      return intl.formatMessage({
        id: "settings.cli.form.paramNameRequired",
        defaultMessage: "Parameter name cannot be empty.",
      });
    }
    return null;
  }

  async function handleSave() {
    const problem = preflightProblem();
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const argv = argvText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const env = Object.fromEntries(
        envRows
          .filter((row) => row.key.trim().length > 0)
          .map((row) => [row.key.trim(), row.value]),
      );
      const next = await upsertCliTool({ ...tool, argv_template: argv, env });
      onSaved(next);
    } catch (e) {
      setError(fmtError(e, intl));
    } finally {
      setSaving(false);
    }
  }

  const title = isEdit ? (
    <FormattedMessage
      id="settings.cli.form.editTitle"
      defaultMessage="Edit CLI tool"
    />
  ) : (
    <FormattedMessage
      id="settings.cli.form.addTitle"
      defaultMessage="Register CLI tool"
    />
  );

  return (
    <div>
      {/* Back link (the McpServerForm posture): the discard path out of the
       * form; the in-card footer carries the save + explicit cancel. */}
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground mb-2 flex items-center gap-1.5 text-sm"
        onClick={onCancel}
        disabled={saving}
      >
        <ArrowLeft className="size-4" aria-hidden />
        <FormattedMessage
          id="settings.cli.form.backToList"
          defaultMessage="Back to CLI list"
        />
      </button>

      <PaneHeader
        className="mb-3"
        title={title}
        description={(
          <FormattedMessage
            id="settings.cli.form.description"
            defaultMessage="A registered tool runs as a direct command line (never a shell): the executable plus fixed arguments, with '{'param'}' placeholders filled from the parameter table."
          />
        )}
      />

      <SettingsCard className="divide-y-0">
        <SettingsRow
          dense
          title={(
            <Label htmlFor="cli-tool-name" className="text-muted-foreground">
              <FormattedMessage
                id="settings.cli.form.name"
                defaultMessage="Name (locked after save)"
              />
            </Label>
          )}
        >
          <Input
            id="cli-tool-name"
            value={tool.name}
            disabled={isEdit}
            placeholder="my-pandoc"
            onChange={(e) => patch({ name: e.target.value })}
          />
        </SettingsRow>

        <SettingsRow
          dense
          title={(
            <Label htmlFor="cli-tool-description" className="text-muted-foreground">
              <FormattedMessage
                id="settings.cli.form.toolDescription"
                defaultMessage="Description (the agent reads this)"
              />
            </Label>
          )}
        >
          {/* A prose field, not mono: the description rides the tool
           * definition to the model, so registrations legitimately carry
           * multi-sentence text -- the textarea's field-sizing-content
           * auto-grow keeps long copy readable and editable where a
           * single-line input would scroll it out of view. */}
          <Textarea
            id="cli-tool-description"
            value={tool.description}
            placeholder={intl.formatMessage({
              id: "settings.cli.form.descriptionPlaceholder",
              defaultMessage: "Convert documents between formats",
            })}
            onChange={(e) => patch({ description: e.target.value })}
          />
        </SettingsRow>

        <SettingsRow
          dense
          title={(
            <Label htmlFor="cli-tool-executable" className="text-muted-foreground">
              <FormattedMessage
                id="settings.cli.form.executable"
                defaultMessage="Executable (PATH name or absolute path)"
              />
            </Label>
          )}
        >
          <Input
            id="cli-tool-executable"
            value={tool.executable}
            placeholder="pandoc"
            onChange={(e) => patch({ executable: e.target.value })}
          />
        </SettingsRow>

        <SettingsRow
          dense
          title={(
            <Label htmlFor="cli-tool-argv" className="text-muted-foreground">
              <FormattedMessage
                id="settings.cli.form.argv"
                defaultMessage="Fixed arguments (one per line)"
              />
            </Label>
          )}
        >
          <Textarea
            id="cli-tool-argv"
            className="min-h-24 font-mono text-sm"
            value={argvText}
            placeholder={"{input}\n-o\n{output}"}
            onChange={(e) => setArgvText(e.target.value)}
          />
        </SettingsRow>

        {/* --- Parameter table ------------------------------------------------ */}
        {/* The KvEditor fold chrome plus a FieldHint beside the title: a
         * chevron fold head (expanding an empty section seeds one blank
         * row), the info tooltip, the Add affordance beside the expanded
         * head, and one icon-button row per entry. */}
        <FoldHead
          title={(
            <FormattedMessage
              id="settings.cli.form.params"
              defaultMessage="Parameters"
            />
          )}
          hint={(
            <FieldHint
              label={intl.formatMessage({
                id: "settings.cli.form.paramsHintAria",
                defaultMessage: "Parameters explanation",
              })}
            >
              <FormattedMessage
                id="settings.cli.form.paramsHint"
                defaultMessage="A '{'name'}' placeholder in the fixed arguments receives the parameter's value (argv) or its temp-file path (file); a stdin parameter is written to the tool's standard input instead. The string[] toggle lets a parameter take multiple values, appended at the end of the command line."
              />
            </FieldHint>
          )}
          expanded={paramsExpanded}
          onExpandedChange={toggleParams}
          action={(
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={addBlankParam}
            >
              <Plus className="size-4" aria-hidden />
              <FormattedMessage
                id="settings.cli.form.addParam"
                defaultMessage="Add parameter"
              />
            </Button>
          )}
        >
          {/* Index keys are safe here by construction: every input is fully
         * controlled (value + onChange come from the params array in
         * state), so an index-keyed re-render after a delete can never
         * show stale DOM values. A stable row-id array would add machinery
         * the wire type cannot carry (rows are keyed by their editable
         * name, which can be empty or duplicate mid-edit). */}
          {tool.params.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              <FormattedMessage
                id="settings.cli.form.paramsEmpty"
                defaultMessage="No parameters. Click Add parameter to create one."
              />
            </p>
          ) : (
            <div className="space-y-1.5">
              {tool.params.map((param, index) => (
                <div
                  key={index}
                  data-testid={`cli-param-row-${index}`}
                  className="flex items-center gap-2"
                >
                  <Input
                    className="w-40 font-mono text-xs"
                    value={param.name}
                    placeholder="input"
                    aria-label={intl.formatMessage(
                      { id: "settings.cli.form.paramName", defaultMessage: "Parameter name (row {row})" },
                      { row: index + 1 },
                    )}
                    onChange={(e) => patchParam(index, { name: e.target.value })}
                  />
                  <Input
                    className="flex-1 text-xs"
                    value={param.description}
                    placeholder={intl.formatMessage({
                      id: "settings.cli.form.paramDescription",
                      defaultMessage: "What the agent should pass here",
                    })}
                    aria-label={intl.formatMessage(
                      { id: "settings.cli.form.paramDescriptionLabel", defaultMessage: "Parameter description (row {row})" },
                      { row: index + 1 },
                    )}
                    onChange={(e) => patchParam(index, { description: e.target.value })}
                  />
                  {/* Delivery (issue #672, ADR-0108 Decision 4): how the value
                 * reaches the child, declared per parameter. The varargs
                 * block is an argv-tail construct, so its delivery locks to
                 * argv when the toggle is on (the backend refuses the
                 * combination -- this keeps the form honest up front). */}
                  <Select
                    value={param.varargs ? "argv" : param.delivery}
                    disabled={param.varargs}
                    onValueChange={(delivery) =>
                      patchParam(index, { delivery: delivery as CliToolParam["delivery"] })}
                  >
                    <SelectTrigger
                      className="cli-delivery h-8 w-36 shrink-0 text-xs"
                      aria-label={intl.formatMessage(
                        {
                          id: "settings.cli.form.deliveryLabel",
                          defaultMessage: "Value delivery (row {row})",
                        },
                        { row: index + 1 },
                      )}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="argv">
                        <FormattedMessage
                          id="settings.cli.form.deliveryArgv"
                          defaultMessage="Command line (argv)"
                        />
                      </SelectItem>
                      <SelectItem value="file">
                        <FormattedMessage
                          id="settings.cli.form.deliveryFile"
                          defaultMessage="Temp file (path on the command line)"
                        />
                      </SelectItem>
                      <SelectItem value="stdin">
                        <FormattedMessage
                          id="settings.cli.form.deliveryStdin"
                          defaultMessage="Standard input (stdin)"
                        />
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {/* The varargs toggle: the tooltip + the aria-label carry
                   * the meaning, no visible text. TooltipTrigger asChild
                   * would clobber the Switch's data-state -- the span
                   * isolates the trigger. */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <Switch
                          checked={param.varargs}
                          onCheckedChange={(varargs) =>
                            patchParam(index, { varargs, ...(varargs ? { delivery: "argv" } : {}) })}
                          aria-label={intl.formatMessage(
                            { id: "settings.cli.form.varargsLabel", defaultMessage: "string[] (row {row})" },
                            { row: index + 1 },
                          )}
                        />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className={SETTINGS_TOOLTIP_CLASS}>
                      <FormattedMessage
                        id="settings.cli.form.varargsTooltip"
                        defaultMessage="Lets this parameter take multiple values, appended at the end of the command line."
                      />
                    </TooltipContent>
                  </Tooltip>
                  <RowRemoveButton
                    label={intl.formatMessage(
                      { id: "settings.cli.form.removeParam", defaultMessage: "Remove parameter (row {row})" },
                      { row: index + 1 },
                    )}
                    icon={Trash2}
                    onClick={() =>
                      setTool((prev) => ({
                        ...prev,
                        params: prev.params.filter((_, i) => i !== index),
                      }))}
                  />
                </div>
              ))}
            </div>
          )}
        </FoldHead>

        {/* --- Env editor (the KvEditor fold chrome, same posture) --------- */}
        <FoldHead
          title={(
            <FormattedMessage
              id="settings.cli.form.env"
              defaultMessage="Environment variables (optional, non-secret)"
            />
          )}
          hint={(
            <FieldHint
              label={intl.formatMessage({
                id: "settings.cli.form.envHintAria",
                defaultMessage: "Environment variables explanation",
              })}
            >
              <FormattedMessage
                id="settings.cli.form.envHint"
                defaultMessage="Literal values merged over the inherited environment at launch. Secret-named keys (api key, token, …) are refused."
              />
            </FieldHint>
          )}
          expanded={envExpanded}
          onExpandedChange={toggleEnv}
          action={(
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={addBlankEnv}
            >
              <Plus className="size-4" aria-hidden />
              <FormattedMessage
                id="settings.cli.form.addEnv"
                defaultMessage="Add variable"
              />
            </Button>
          )}
        >
          {envRows.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              <FormattedMessage
                id="settings.cli.form.envEmpty"
                defaultMessage="No environment variables. Click Add variable to create one."
              />
            </p>
          ) : (
            <div className="space-y-1.5">
              {envRows.map((row, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    className="w-40 font-mono text-xs"
                    value={row.key}
                    placeholder="LOG_LEVEL"
                    aria-label={intl.formatMessage(
                      { id: "settings.cli.form.envKey", defaultMessage: "Env name (row {row})" },
                      { row: index + 1 },
                    )}
                    onChange={(e) =>
                      setEnvRows((prev) =>
                        prev.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)),
                      )}
                  />
                  <Input
                    className="flex-1 font-mono text-xs"
                    value={row.value}
                    placeholder="info"
                    aria-label={intl.formatMessage(
                      { id: "settings.cli.form.envValue", defaultMessage: "Env value (row {row})" },
                      { row: index + 1 },
                    )}
                    onChange={(e) =>
                      setEnvRows((prev) =>
                        prev.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)),
                      )}
                  />
                  <RowRemoveButton
                    label={intl.formatMessage(
                      { id: "settings.cli.form.removeEnv", defaultMessage: "Remove env (row {row})" },
                      { row: index + 1 },
                    )}
                    icon={Trash2}
                    onClick={() =>
                      setEnvRows((prev) => prev.filter((_, i) => i !== index))}
                  />
                </div>
              ))}
            </div>
          )}
        </FoldHead>

        {error && (
          <p className="settings-error text-destructive px-4 py-1.5 text-sm">{error}</p>
        )}

        {/* Save / Cancel (the McpServerForm footer: the save carries the
         * busy spinner; the ghost Cancel sits beside it). */}
        <div className="flex items-center gap-2 px-4 py-3">
          <Button
            type="button"
            disabled={saving}
            onClick={() => void handleSave()}
          >
            {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {saving ? (
              <FormattedMessage id="common.saving" defaultMessage="Saving…" />
            ) : isEdit ? (
              <FormattedMessage id="common.save" defaultMessage="Save" />
            ) : (
              <FormattedMessage id="common.add" defaultMessage="Add" />
            )}
          </Button>
          <Button type="button" variant="ghost" disabled={saving} onClick={onCancel}>
            <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
          </Button>
        </div>
      </SettingsCard>
    </div>
  );
}
