import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

import { fmtError } from "../../lib/error-presentation";
import { log } from "../../lib/log";
import {
  createUserAdapter,
  deleteUserAdapter,
  listUserAdapters,
  probeAdapter,
  setUserAdapterEnabled,
  updateUserAdapter,
  type UserAdapterDraft,
} from "../../api";
import { adapterKeys } from "../../session/queryKeys";
import type { ProbeError, UserAdapterRow } from "../../types/runtime";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { HeaderActionButton, SettingsCard, SettingsRow } from "./settings-chrome";
import { toProbeError } from "./probe-error";
import { formatArgGroups, isSingleTokenCommand, parseArgGroups } from "./user-runtime-form";

// User-defined runtimes (issue #1341): the registry pane under the Local CLI
// tab. Row cards for every `user-adapters.json` row (disabled ones included)
// + an editor dialog (name / command / args / env) + a delete confirm. The
// picker needs NO change -- the backend's `list_adapters` projection merges
// the registry in (same alphabetical order this list renders, one comparator
// server-side), so every CRUD mutation invalidates the shared adapter cache
// too.
//
// The command field is one argv token (no whitespace, no quotes): the file
// picker fills an absolute path verbatim, a bare name resolves through the
// PATH scan. The form rejects a violating hand-typed value immediately; the
// backend boundary re-validates (the IPC backstop).
//
// The editor's Test button reuses the probe IPC, so it needs a PERSISTED row
// to name -- create keeps the dialog open on the saved row (editing mode),
// which lights the button. Saving never requires the test to pass (the probe
// is a diagnostic, not a gate).

/** One editable env row (blank keys are dropped at save). */
interface EnvRow {
  key: string;
  value: string;
}

/** The editor's probe lifecycle, three states on the wire + busy. */
type TestState =
  | { status: "idle" }
  | { status: "probing" }
  | { status: "ok" }
  | { status: "failed"; error: ProbeError };

/** The editor dialog. `row === null` is create mode; a successful create
 *  swaps to editing the minted row (dialog stays open) so Test -- which
 *  names a persisted row -- becomes available. */
function EditorDialog({
  row,
  onClose,
  onSaved,
  onIpcBusy,
}: {
  row: UserAdapterRow | null;
  onClose: () => void;
  /** Reports the persisted row (the create -> edit swap: the dialog stays
   *  open editing the minted row, so Test names a real id). */
  onSaved: (row: UserAdapterRow) => void;
  onIpcBusy: (channel: "probe" | "userAdapter", busy: boolean) => void;
}) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [name, setName] = useState(row?.name ?? "");
  const [command, setCommand] = useState(row?.command ?? "");
  const [argsText, setArgsText] = useState(formatArgGroups(row?.args ?? []));
  const [envRows, setEnvRows] = useState<EnvRow[]>(
    row ? Object.entries(row.env).map(([key, value]) => ({ key, value })) : [],
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ status: "idle" });

  const args = parseArgGroups(argsText);
  const nameOk = name.trim().length > 0;
  const commandOk = isSingleTokenCommand(command.trim());
  const canSave = nameOk && commandOk && args !== null && !saving;
  // Test names the persisted row via the probe IPC; an unsaved create has
  // no id yet (a successful save switches to editing mode and lights it).
  const canTest = row !== null && commandOk && test.status !== "probing";

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: adapterKeys.user() });
    // The picker projection is the merged view -- a row change must land on
    // the shared adapter cache in the same event.
    void queryClient.invalidateQueries({ queryKey: adapterKeys.all() });
  }

  async function handleSave() {
    if (!canSave || args === null) return;
    setSaving(true);
    setSaveError(null);
    onIpcBusy("userAdapter", true);
    try {
      const env: Record<string, string> = {};
      for (const entry of envRows) {
        if (entry.key !== "") env[entry.key] = entry.value;
      }
      const draft: UserAdapterDraft = {
        name: name.trim(),
        command: command.trim(),
        args,
        env,
      };
      const saved = row
        ? await updateUserAdapter(row.id, draft)
        : await createUserAdapter(draft);
      invalidate();
      // Stay open on the saved row (create -> edit swap; the Test button
      // needs the persisted id). A save does not clear a test result.
      onSaved(saved);
      setName(saved.name);
      setCommand(saved.command);
      setArgsText(formatArgGroups(saved.args));
      setEnvRows(Object.entries(saved.env).map(([key, value]) => ({ key, value })));
    } catch (e) {
      log.warn("UserRuntimesSection", "user adapter save failed", e);
      setSaveError(fmtError(e, intl));
    } finally {
      setSaving(false);
      onIpcBusy("userAdapter", false);
    }
  }

  async function handleTest() {
    if (!canTest || row === null) return;
    setTest({ status: "probing" });
    onIpcBusy("probe", true);
    try {
      await probeAdapter(row.id);
      setTest({ status: "ok" });
    } catch (e) {
      log.warn("UserRuntimesSection", "user adapter probe failed", e);
      // The shared narrowing (LocalCliTab's probe face): a structured reject
      // with a KNOWN kind passes through, anything else degrades to the
      // frontend-only unreachable kind.
      setTest({ status: "failed", error: toProbeError(e) });
    } finally {
      onIpcBusy("probe", false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {/* Two static ids, not a conditional one: formatjs extraction
                only sees literal ids (the sections-list ADR-0052 stance -- a
                variable id would slip past the i18n:check gate). */}
            {row ? (
              <FormattedMessage
                id="settings.runtime.userRun.editor.editTitle"
                defaultMessage="Edit custom runtime"
              />
            ) : (
              <FormattedMessage
                id="settings.runtime.userRun.editor.addTitle"
                defaultMessage="Add custom runtime"
              />
            )}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-sm font-medium">
              <FormattedMessage id="settings.runtime.userRun.editor.name" defaultMessage="Name" />
            </span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!nameOk || undefined}
            />
          </label>
          <div className="space-y-1">
            <span className="text-sm font-medium">
              <FormattedMessage id="settings.runtime.userRun.editor.command" defaultMessage="Command" />
            </span>
            <div className="flex gap-2">
              <Input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                aria-invalid={!commandOk || undefined}
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  void (async () => {
                    // The file picker bypasses hand-typing entirely -- the
                    // chosen absolute path fills the field verbatim (one
                    // token by construction).
                    try {
                      const picked = await openFileDialog({
                        title: intl.formatMessage({
                          id: "settings.runtime.userRun.editor.browse",
                          defaultMessage: "Choose the CLI executable",
                        }),
                      });
                      if (typeof picked === "string") setCommand(picked);
                    } catch (e) {
                      // A failed dialog open surfaces on the pane's error
                      // line (the sessions-dir picker posture), never as
                      // an unhandled rejection.
                      log.warn("UserRuntimesSection", "command browse failed", e);
                      setSaveError(fmtError(e, intl));
                    }
                  })();
                }}
              >
                <FolderOpen className="size-3.5" aria-hidden />
                <FormattedMessage id="settings.runtime.userRun.editor.browseAction" defaultMessage="Browse…" />
              </Button>
            </div>
            {!commandOk && (
              <p className="text-destructive text-xs">
                <FormattedMessage
                  id="settings.runtime.userRun.editor.commandInvalid"
                  defaultMessage="Command must be one token — no spaces or quotes. Use Browse… to pick an executable."
                />
              </p>
            )}
          </div>
          <label className="block space-y-1">
            <span className="text-sm font-medium">
              <FormattedMessage id="settings.runtime.userRun.editor.args" defaultMessage="Arguments" />
            </span>
            <Input
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              aria-invalid={args === null || undefined}
            />
            {args === null && (
              <span className="text-destructive text-xs">
                <FormattedMessage
                  id="settings.runtime.userRun.editor.argsInvalid"
                  defaultMessage="Unbalanced quotes in the arguments."
                />
              </span>
            )}
          </label>
          <div className="space-y-1">
            <span className="text-sm font-medium">
              <FormattedMessage id="settings.runtime.userRun.editor.env" defaultMessage="Environment variables" />
            </span>
            {envRows.map((entry, index) => (
              <div key={index} className="flex gap-2">
                <Input
                  value={entry.key}
                  onChange={(e) =>
                    setEnvRows((rows) =>
                      rows.map((row, i) => (i === index ? { ...row, key: e.target.value } : row)),
                    )}
                  placeholder="KEY"
                  className="flex-1"
                />
                <Input
                  value={entry.value}
                  onChange={(e) =>
                    setEnvRows((rows) =>
                      rows.map((row, i) => (i === index ? { ...row, value: e.target.value } : row)),
                    )}
                  placeholder="value"
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setEnvRows((rows) => rows.filter((_, i) => i !== index))}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEnvRows((rows) => [...rows, { key: "", value: "" }])}
            >
              <FormattedMessage id="settings.runtime.userRun.editor.addEnv" defaultMessage="Add variable" />
            </Button>
          </div>
          {test.status === "probing" && (
            <p className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              <FormattedMessage id="settings.runtime.userRun.editor.testing" defaultMessage="Testing…" />
            </p>
          )}
          {test.status === "ok" && (
            <p className="text-sm">
              <Badge variant="default">
                <FormattedMessage id="settings.runtime.userRun.editor.testOk" defaultMessage="Connected" />
              </Badge>
            </p>
          )}
          {test.status === "failed" && (
            <p className="text-destructive text-sm">
              {/* NotDetected is a launch failure (fail_cli); every other
                  probe failure means the CLI started but the ACP channel
                  failed (fail_acp) -- the structured detail carries the
                  stderr tail (issue #542). Two static ids for the same
                  extraction reason as the dialog title. */}
              {test.error.kind === "NotDetected" ? (
                <FormattedMessage
                  id="settings.runtime.userRun.editor.testFailCli"
                  defaultMessage="Could not find or start the command."
                />
              ) : (
                <FormattedMessage
                  id="settings.runtime.userRun.editor.testFailAcp"
                  defaultMessage="The command started, but the ACP handshake failed."
                />
              )}
              {"data" in test.error && test.error.data && (
                <span className="font-mono text-xs"> {test.error.data}</span>
              )}
            </p>
          )}
          {saveError && <p className="text-destructive text-sm">{saveError}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            <FormattedMessage id="common.close" defaultMessage="Close" />
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!canTest}
            onClick={() => void handleTest()}
          >
            {test.status === "probing" && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            <FormattedMessage id="settings.runtime.userRun.editor.test" defaultMessage="Test" />
          </Button>
          <Button type="button" disabled={!canSave} onClick={() => void handleSave()}>
            {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            <FormattedMessage id="common.save" defaultMessage="Save" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The registry pane: every user row as a card + the editor + delete
 *  confirm. The list query rejects on a corrupt registry (management face)
 *  -- the error renders in place of the cards. */
export function UserRuntimesSection({
  onIpcBusy,
}: {
  /** The channels this pane fires: the CRUD writes + the probe test. */
  onIpcBusy: (channel: "probe" | "userAdapter", busy: boolean) => void;
}) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<UserAdapterRow | null | undefined>(undefined);
  // `undefined` = closed; `null` = create; a row = edit.
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data, isPending, isError, error } = useQuery({
    queryKey: adapterKeys.user(),
    queryFn: listUserAdapters,
  });
  const rows = data ?? [];
  const loadError = isError ? fmtError(error, intl) : null;

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: adapterKeys.user() });
    void queryClient.invalidateQueries({ queryKey: adapterKeys.all() });
  }

  async function handleToggle(row: UserAdapterRow) {
    if (busyId !== null) return;
    setBusyId(row.id);
    setToggleError(null);
    onIpcBusy("userAdapter", true);
    try {
      await setUserAdapterEnabled(row.id, !row.enabled);
      invalidate();
    } catch (e) {
      log.warn("UserRuntimesSection", "user adapter toggle failed", e);
      // The toggle is a write on the management face: a failure surfaces,
      // same as save/delete on this pane (a silent badge would lie about
      // the persisted state).
      setToggleError(fmtError(e, intl));
    } finally {
      setBusyId(null);
      onIpcBusy("userAdapter", false);
    }
  }

  async function handleDeleteRow(id: string) {
    onIpcBusy("userAdapter", true);
    try {
      await deleteUserAdapter(id);
      invalidate();
      setDeleteError(null);
      // Close an editor that named the deleted row.
      if (editing?.id === id) setEditing(undefined);
    } catch (e) {
      log.warn("UserRuntimesSection", "user adapter delete failed", e);
      setDeleteError(fmtError(e, intl));
    } finally {
      onIpcBusy("userAdapter", false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">
          <FormattedMessage
            id="settings.runtime.userRun.title"
            defaultMessage="Custom runtimes"
          />
        </span>
        <HeaderActionButton
          label={intl.formatMessage({
            id: "settings.runtime.userRun.add",
            defaultMessage: "Add",
          })}
          icon={Plus}
          onClick={() => setEditing(null)}
        />
      </div>
      {isPending && (
        <p className="text-muted-foreground text-sm">
          <FormattedMessage id="settings.reading" defaultMessage="Reading current config…" />
        </p>
      )}
      {loadError && <p className="text-destructive text-sm">{loadError}</p>}
      {!isPending && !loadError && (
        <SettingsCard>
          {rows.length === 0 && (
            <p className="text-muted-foreground px-4 py-3 text-sm">
              <FormattedMessage
                id="settings.runtime.userRun.empty"
                defaultMessage="No custom runtimes. Add one to connect any ACP-compatible CLI."
              />
            </p>
          )}
          {rows.map((row) => (
            <SettingsRow
              key={row.id}
              title={row.name}
              description={(
                <code className="font-mono text-xs">
                  {row.command}
                  {row.args.length > 0 && ` ${row.args.join(" ")}`}
                </code>
              )}
              action={(
                <div className="flex items-center gap-2">
                  {row.enabled ? (
                    <Badge variant="default">
                      <FormattedMessage id="settings.runtime.userRun.enabled" defaultMessage="Enabled" />
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-muted-foreground font-normal">
                      <FormattedMessage id="settings.runtime.userRun.disabled" defaultMessage="Disabled" />
                    </Badge>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busyId === row.id}
                    onClick={() => void handleToggle(row)}
                  >
                    {busyId === row.id && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                    {row.enabled ? (
                      <FormattedMessage id="settings.runtime.userRun.disable" defaultMessage="Disable" />
                    ) : (
                      <FormattedMessage id="settings.runtime.userRun.enable" defaultMessage="Enable" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditing(row)}
                  >
                    <Pencil className="size-3.5" aria-hidden />
                    <FormattedMessage id="common.edit" defaultMessage="Edit" />
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button type="button" variant="ghost" size="sm">
                        <Trash2 className="size-3.5" aria-hidden />
                        <FormattedMessage id="common.delete" defaultMessage="Delete" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          <FormattedMessage
                            id="settings.runtime.userRun.deleteTitle"
                            defaultMessage="Delete {name}?"
                            values={{ name: row.name }}
                          />
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          <FormattedMessage
                            id="settings.runtime.userRun.deleteBody"
                            defaultMessage="The custom runtime is removed from the picker and this list. Sessions already running on it keep running."
                          />
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>
                          <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
                        </AlertDialogCancel>
                        <AlertDialogAction onClick={() => void handleDeleteRow(row.id)}>
                          <FormattedMessage id="common.delete" defaultMessage="Delete" />
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              )}
            />
          ))}
        </SettingsCard>
      )}
      {deleteError && <p className="text-destructive text-sm">{deleteError}</p>}
      {toggleError && <p className="text-destructive text-sm">{toggleError}</p>}
      {editing !== undefined && (
        <EditorDialog
          row={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(saved) => setEditing(saved)}
          onIpcBusy={onIpcBusy}
        />
      )}
    </div>
  );
}
