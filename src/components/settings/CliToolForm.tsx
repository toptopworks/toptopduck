import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Plus, Trash2 } from "lucide-react";

import type { AppConfig } from "../../types/app-config";
import type { CliToolConfig, CliToolParam } from "../../types/cli-tool";
import { upsertCliTool } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Switch } from "../ui/switch";
import { PaneHeader } from "./settings-chrome";

// Add/edit form for one CLI tool registration (issue #671, ADR-0108
// Decision 2). Form-only (no JSON dual mode -- the MCP form's JSON mode
// exists for pasting server configs; a CLI registration has no such
// copy-source). The name is the identity anchor (tool-table name, approval
// trust key, collision anchor) and locks on edit; every other field is
// open. Client-side checks are UX sugar only -- the backend command is the
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

  return (
    <div>
      <PaneHeader
        title={
          isEdit ? (
            <FormattedMessage
              id="settings.cli.form.editTitle"
              defaultMessage="Edit CLI tool"
            />
          ) : (
            <FormattedMessage
              id="settings.cli.form.addTitle"
              defaultMessage="Register CLI tool"
            />
          )
        }
        description={(
          <FormattedMessage
            id="settings.cli.form.description"
            defaultMessage="A registered tool runs as a direct command line (never a shell): the executable plus fixed arguments, with '{'param'}' placeholders filled from the parameter table."
          />
        )}
        action={(
          <div className="flex items-center gap-1.5">
            <Button type="button" size="sm" variant="outline" onClick={onCancel}>
              <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              <FormattedMessage id="common.save" defaultMessage="Save" />
            </Button>
          </div>
        )}
      />

      <div className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium">
            <FormattedMessage
              id="settings.cli.form.name"
              defaultMessage="Name (locked after save)"
            />
          </span>
          <Input
            className="mt-1"
            value={tool.name}
            disabled={isEdit}
            placeholder="pandoc"
            onChange={(e) => patch({ name: e.target.value })}
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium">
            <FormattedMessage
              id="settings.cli.form.toolDescription"
              defaultMessage="Description (the agent reads this)"
            />
          </span>
          <Input
            className="mt-1"
            value={tool.description}
            placeholder={intl.formatMessage({
              id: "settings.cli.form.descriptionPlaceholder",
              defaultMessage: "Convert documents between formats",
            })}
            onChange={(e) => patch({ description: e.target.value })}
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium">
            <FormattedMessage
              id="settings.cli.form.executable"
              defaultMessage="Executable (PATH name or absolute path)"
            />
          </span>
          <Input
            className="mt-1"
            value={tool.executable}
            placeholder="pandoc"
            onChange={(e) => patch({ executable: e.target.value })}
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium">
            <FormattedMessage
              id="settings.cli.form.argv"
              defaultMessage="Fixed arguments (one per line)"
            />
          </span>
          <Textarea
            className="mt-1 min-h-24 font-mono text-sm"
            value={argvText}
            placeholder={"{input}\n-o\n{output}"}
            onChange={(e) => setArgvText(e.target.value)}
          />
        </label>

        {/* --- Parameter table ------------------------------------------------ */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm font-medium">
              <FormattedMessage
                id="settings.cli.form.params"
                defaultMessage="Parameters"
              />
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                setTool((prev) => ({
                  ...prev,
                  params: [
                    ...prev.params,
                    { name: "", description: "", delivery: "argv", varargs: false },
                  ],
                }))}
            >
              <Plus className="size-4" aria-hidden />
              <FormattedMessage
                id="settings.cli.form.addParam"
                defaultMessage="Add parameter"
              />
            </Button>
          </div>
          <p className="text-muted-foreground mb-2 text-xs">
            <FormattedMessage
              id="settings.cli.form.paramsHint"
              defaultMessage="A '{'name'}' placeholder in the fixed arguments receives the parameter's value. The string[] toggle appends the values at the end of the command line instead (whole-binary wrapper)."
            />
          </p>
          {/* Index keys are safe here by construction: every input is fully
           * controlled (value + onChange come from the params array in
           * state), so an index-keyed re-render after a delete can never
           * show stale DOM values. A stable row-id array would add machinery
           * the wire type cannot carry (rows are keyed by their editable
           * name, which can be empty or duplicate mid-edit). */}
          <div className="space-y-2">
            {tool.params.map((param, index) => (
              <div
                key={index}
                data-testid={`cli-param-row-${index}`}
                className="flex items-center gap-2"
              >
                <Input
                  className="font-mono text-sm"
                  value={param.name}
                  placeholder="input"
                  aria-label={intl.formatMessage(
                    { id: "settings.cli.form.paramName", defaultMessage: "Parameter name (row {row})" },
                    { row: index + 1 },
                  )}
                  onChange={(e) => patchParam(index, { name: e.target.value })}
                />
                <Input
                  className="text-sm"
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
                <label className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
                  <Switch
                    checked={param.varargs}
                    onCheckedChange={(varargs) => patchParam(index, { varargs })}
                    aria-label={intl.formatMessage(
                      { id: "settings.cli.form.varargsLabel", defaultMessage: "string[] (row {row})" },
                      { row: index + 1 },
                    )}
                  />
                  <FormattedMessage
                    id="settings.cli.form.varargs"
                    defaultMessage="string[]"
                  />
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive h-7 w-7 shrink-0 p-0"
                  aria-label={intl.formatMessage(
                    { id: "settings.cli.form.removeParam", defaultMessage: "Remove parameter (row {row})" },
                    { row: index + 1 },
                  )}
                  onClick={() =>
                    setTool((prev) => ({
                      ...prev,
                      params: prev.params.filter((_, i) => i !== index),
                    }))}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </div>
            ))}
          </div>
        </div>

        {/* --- Env editor ------------------------------------------------ */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm font-medium">
              <FormattedMessage
                id="settings.cli.form.env"
                defaultMessage="Environment variables (optional, non-secret)"
              />
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setEnvRows((prev) => [...prev, { key: "", value: "" }])}
            >
              <Plus className="size-4" aria-hidden />
              <FormattedMessage id="settings.cli.form.addEnv" defaultMessage="Add" />
            </Button>
          </div>
          <p className="text-muted-foreground mb-2 text-xs">
            <FormattedMessage
              id="settings.cli.form.envHint"
              defaultMessage="Literal values merged over the inherited environment at launch. Secret-named keys (api key, token, …) are refused."
            />
          </p>
          <div className="space-y-2">
            {envRows.map((row, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  className="font-mono text-sm"
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
                  className="font-mono text-sm"
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
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive h-7 w-7 shrink-0 p-0"
                  aria-label={intl.formatMessage(
                    { id: "settings.cli.form.removeEnv", defaultMessage: "Remove env (row {row})" },
                    { row: index + 1 },
                  )}
                  onClick={() =>
                    setEnvRows((prev) => prev.filter((_, i) => i !== index))}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </div>
            ))}
          </div>
        </div>

        {error && (
          <p className="settings-error text-destructive text-sm">{error}</p>
        )}
      </div>
    </div>
  );
}
