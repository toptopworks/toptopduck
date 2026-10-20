import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
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
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { cn } from "../../lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import {
  FoldHead,
  NameBadge,
  PaneBackLink,
  PaneHeader,
  RowActionButton,
  SettingsCard,
  SettingsRow,
} from "./settings-chrome";
import { EnvRowsEditor, type EnvRow } from "./EnvRowsEditor";
import { toProbeError } from "./probe-error";
import { formatArgGroups, isSingleTokenCommand, parseArgGroups } from "./user-runtime-form";

// User-defined runtimes (issue #1341): the registry pane under the Local CLI
// tab. Row cards for every `user-adapters.json` row (disabled ones included)
// + a delete confirm. The editor is a full-pane form (the CliToolForm
// posture: back link, form pane header, one card of row-stacked fields, and
// the save footer inside the card) owned by the TAB -- its Add button sits
// in the tab header beside Rescan, and the open form replaces the whole tab.
// The picker needs NO change -- the backend's `list_adapters` projection
// merges the registry in (same alphabetical order this list renders, one
// comparator server-side), so every CRUD mutation invalidates the shared
// adapter cache too.
//
// The command field is one argv token (no whitespace, no quotes): the file
// picker fills an absolute path verbatim, a bare name resolves through the
// PATH scan. Validation rides the McpServerForm posture -- no inline field
// errors; the Add/Save button stays disabled until the shape is valid, and
// the one error line under the card carries write failures. The backend
// boundary re-validates (the IPC backstop).
//
// The form's Test button reuses the probe IPC, so it needs a PERSISTED row
// to name -- it lights in edit mode only (reopen the row with Edit); a
// create save returns straight to the list. Saving never requires the test
// to pass (the probe is a diagnostic, not a gate).

/** Every CRUD mutation lands on BOTH caches in the same event: the registry
 *  pane's own rows and the picker's merged projection -- the backend's
 *  `list_adapters` merges the user rows in, so the shared adapter cache is
 *  stale the moment a row changes. */
function invalidateAdapterQueries(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: adapterKeys.user() });
  void queryClient.invalidateQueries({ queryKey: adapterKeys.all() });
}

/** The editor's probe lifecycle, three states on the wire + busy. */
type TestState =
  | { status: "idle" }
  | { status: "probing" }
  | { status: "ok" }
  | { status: "failed"; error: ProbeError };

/** The editor form, mounted by LocalCliTab (the Add button in the tab
 *  header). `row === null` is create mode; a successful save (either mode)
 *  closes the form back to the list. Test names the persisted row, so it
 *  lights in edit mode only. */
export function EditorForm({
  row,
  onClose,
  onIpcBusy,
}: {
  row: UserAdapterRow | null;
  onClose: () => void;
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
  // The KvEditor fold posture (the CLI tool form): a section starts
  // collapsed when it has no rows; expanding an empty section seeds one
  // blank row to fill.
  const [envExpanded, setEnvExpanded] = useState(() => envRows.length > 0);
  const [saving, setSaving] = useState(false);
  // The form's one error line (the McpServerForm lane): write failures --
  // IPC refusals and browse faults -- land here; validity itself is the
  // save button's disabled state.
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ status: "idle" });

  const args = parseArgGroups(argsText);
  // The Add/Save button is the validity signal (the McpServerForm posture):
  // disabled until the minimum required fields hold -- a name, a
  // single-token program, balanced argument quotes.
  const isFormValid =
    name.trim().length > 0 &&
    isSingleTokenCommand(command.trim()) &&
    args !== null;

  async function handleSave() {
    if (saving || !isFormValid || args === null) return;
    setSaving(true);
    setError(null);
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
      if (row) {
        await updateUserAdapter(row.id, draft);
      } else {
        await createUserAdapter(draft);
      }
      invalidateAdapterQueries(queryClient);
      // A save closes the form back to the list (the McpServerForm flow);
      // the invalidated queries refetch the saved row.
      onClose();
    } catch (e) {
      log.warn("UserRuntimesSection", "user adapter save failed", e);
      setError(fmtError(e, intl));
    } finally {
      setSaving(false);
      onIpcBusy("userAdapter", false);
    }
  }

  async function handleTest() {
    if (row === null || test.status === "probing") return;
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

  function toggleEnv(next: boolean) {
    setEnvExpanded(next);
    if (next && envRows.length === 0) {
      setEnvRows((rows) => [...rows, { key: "", value: "" }]);
    }
  }

  return (
    <div>
      {/* Back link: the discard path out of the form; the in-card footer
       * carries the save + explicit cancel. */}
      <PaneBackLink onClick={onClose} disabled={saving}>
        <FormattedMessage
          id="settings.cli.form.backToList"
          defaultMessage="Back to CLI list"
        />
      </PaneBackLink>

      <PaneHeader
        size="form"
        title={row ? (
          <FormattedMessage
            id="settings.runtime.userRun.editor.editTitle"
            defaultMessage="Edit custom adapter"
          />
        ) : (
          <FormattedMessage
            id="settings.runtime.userRun.editor.addTitle"
            defaultMessage="Add custom adapter"
          />
        )}
        description={(
          <FormattedMessage
            id="settings.runtime.userRun.formDescription"
            defaultMessage="Connect an ACP-compatible CLI tool: pick its program, then optionally add arguments and environment variables."
          />
        )}
      />

      <SettingsCard className="divide-y-0">
        <SettingsRow
          dense
          title={(
            <Label htmlFor="user-runtime-name" className="text-muted-foreground">
              <FormattedMessage id="common.name" defaultMessage="Name" />
            </Label>
          )}
        >
          <Input
            id="user-runtime-name"
            value={name}
            placeholder="my-acp-cli"
            onChange={(e) => setName(e.target.value)}
          />
        </SettingsRow>

        <SettingsRow
          dense
          title={(
            <Label htmlFor="user-runtime-command" className="text-muted-foreground">
              <FormattedMessage id="settings.runtime.userRun.editor.command" defaultMessage="Program" />
            </Label>
          )}
        >
          <div className="flex gap-2">
            <Input
              id="user-runtime-command"
              value={command}
              placeholder="my-cli"
              className="flex-1"
              onChange={(e) => setCommand(e.target.value)}
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
                        defaultMessage: "Choose the program file",
                      }),
                    });
                    if (typeof picked === "string") setCommand(picked);
                  } catch (e) {
                    // A failed dialog open surfaces on the form's error
                    // line (the sessions-dir picker posture), never as an
                    // unhandled rejection.
                    log.warn("UserRuntimesSection", "command browse failed", e);
                    setError(fmtError(e, intl));
                  }
                })();
              }}
            >
              <FolderOpen className="size-3.5" aria-hidden />
              <FormattedMessage id="settings.runtime.userRun.editor.browseAction" defaultMessage="Browse…" />
            </Button>
          </div>
        </SettingsRow>

        <SettingsRow
          dense
          title={(
            <Label htmlFor="user-runtime-args" className="text-muted-foreground">
              <FormattedMessage id="settings.runtime.userRun.editor.args" defaultMessage="Arguments" />
            </Label>
          )}
        >
          <Input
            id="user-runtime-args"
            value={argsText}
            placeholder="--acp --flag value"
            onChange={(e) => setArgsText(e.target.value)}
          />
        </SettingsRow>

        {/* The env editor rides the KvEditor fold chrome (the CLI tool
         * form's posture): chevron fold head, the info tooltip, the Add
         * affordance beside the expanded head, one icon-button row per
         * entry. */}
        <FoldHead
          title={(
            <FormattedMessage id="settings.runtime.userRun.editor.env" defaultMessage="Environment variables" />
          )}
          expanded={envExpanded}
          onExpandedChange={toggleEnv}
          action={(
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEnvRows((rows) => [...rows, { key: "", value: "" }])}
            >
              <Plus className="size-4" aria-hidden />
              <FormattedMessage id="settings.form.envAdd" defaultMessage="Add variable" />
            </Button>
          )}
        >
          <EnvRowsEditor rows={envRows} onChange={setEnvRows} />
        </FoldHead>

        {/* The probe diagnostic's three states (the dialog editor's copy,
         * re-homed onto the card's padding rhythm). */}
        {test.status === "probing" && (
          <p className="text-muted-foreground flex items-center gap-2 px-4 py-1.5 text-sm">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            <FormattedMessage id="common.testing" defaultMessage="Testing…" />
          </p>
        )}
        {test.status === "ok" && (
          <p className="px-4 py-1.5 text-sm">
            <NameBadge variant="success">
              <FormattedMessage id="settings.runtime.userRun.editor.testOk" defaultMessage="Connected" />
            </NameBadge>
          </p>
        )}
        {test.status === "failed" && (
          <p className="text-destructive px-4 py-1.5 text-sm">
            {/* NotDetected is a launch failure (fail_cli); every other
                probe failure means the CLI started but the ACP channel
                failed (fail_acp) -- the structured detail carries the
                stderr tail (issue #542). Two static ids for the formatjs
                extraction gate. */}
            {test.error.kind === "NotDetected" ? (
              <FormattedMessage
                id="settings.runtime.userRun.editor.testFailCli"
                defaultMessage="Could not find or start the program."
              />
            ) : (
              <FormattedMessage
                id="settings.runtime.userRun.editor.testFailAcp"
                defaultMessage="The program started, but the connection failed."
              />
            )}
            {"data" in test.error && test.error.data && (
              // String() degrades a skew payload the same way the built-in
              // fold does -- a bare object child would throw at render.
              <span className="font-mono text-xs"> {String(test.error.data)}</span>
            )}
          </p>
        )}
        {error && (
          <p className="settings-error text-destructive px-4 py-1.5 text-sm">{error}</p>
        )}

        {/* Save / Test / Cancel (the McpServerForm footer posture: the save
         * carries the busy spinner and is disabled until the form is valid;
         * this form appends the outline Test diagnostic at the end). */}
        <div className="flex items-center gap-2 px-4 py-3">
          <Button
            type="button"
            disabled={!isFormValid || saving}
            onClick={() => void handleSave()}
          >
            {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {saving ? (
              <FormattedMessage id="common.saving" defaultMessage="Saving…" />
            ) : row ? (
              <FormattedMessage id="common.save" defaultMessage="Save" />
            ) : (
              <FormattedMessage id="common.add" defaultMessage="Add" />
            )}
          </Button>
          <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>
            <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={row === null || test.status === "probing"}
            onClick={() => void handleTest()}
          >
            {test.status === "probing" && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            <FormattedMessage id="common.test" defaultMessage="Test" />
          </Button>
        </div>
      </SettingsCard>
    </div>
  );
}

/** The registry pane: every user row as a card. Editing hands the row to
 *  `onEdit` -- the tab owns the editor form (its Add button sits in the tab
 *  header). The list query rejects on a corrupt registry (management face)
 *  -- the error renders in place of the cards. */
export function UserRuntimesSection({
  onEdit,
  onIpcBusy,
}: {
  /** Reports the row to edit (the tab swaps itself for the editor form). */
  onEdit: (row: UserAdapterRow) => void;
  /** The channel this pane fires: the CRUD writes (the probe test fires
   *  from the tab-owned editor form). */
  onIpcBusy: (channel: "probe" | "userAdapter", busy: boolean) => void;
}) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // The delete confirmation (the registry-pane lane): the row's Delete
  // button arms a pane-level dialog; the destructive call fires on confirm.
  const [confirmTarget, setConfirmTarget] = useState<UserAdapterRow | null>(
    null,
  );

  const { data, isPending, isError, error } = useQuery({
    queryKey: adapterKeys.user(),
    queryFn: listUserAdapters,
  });
  const rows = data ?? [];
  const loadError = isError ? fmtError(error, intl) : null;

  async function handleToggle(row: UserAdapterRow) {
    if (busyId !== null) return;
    setBusyId(row.id);
    setToggleError(null);
    onIpcBusy("userAdapter", true);
    try {
      await setUserAdapterEnabled(row.id, !row.enabled);
      invalidateAdapterQueries(queryClient);
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
      invalidateAdapterQueries(queryClient);
      setDeleteError(null);
    } catch (e) {
      log.warn("UserRuntimesSection", "user adapter delete failed", e);
      setDeleteError(fmtError(e, intl));
    } finally {
      onIpcBusy("userAdapter", false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm font-medium">
        <FormattedMessage
          id="settings.runtime.userRun.title"
          defaultMessage="Custom adapters"
        />
      </p>
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
                defaultMessage="No custom adapters yet. Add one to connect any ACP-compatible CLI."
              />
            </p>
          )}
          {rows.map((row) => (
            <div key={row.id} className="hover:bg-accent px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "text-sm font-medium truncate",
                        // A disabled adapter is dormant (ADR-0106): the
                        // quieted name keeps the row's state legible.
                        !row.enabled && "text-muted-foreground",
                      )}
                    >
                      {row.name}
                    </span>
                    {!row.enabled && (
                      <NameBadge>
                        <FormattedMessage
                          id="settings.runtime.userRun.disabled"
                          defaultMessage="Disabled"
                        />
                      </NameBadge>
                    )}
                  </div>
                  <div className="text-muted-foreground mt-1 truncate font-mono text-xs">
                    {row.command}
                    {row.args.length > 0 && ` ${row.args.join(" ")}`}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  {/* The enable toggle (ADR-0106): the row's machine-level
                   * state, before the action buttons so it reads as the
                   * row's primary control, not an action. */}
                  <Switch
                    className="mr-1.5"
                    checked={row.enabled}
                    disabled={busyId === row.id}
                    onCheckedChange={() => void handleToggle(row)}
                    aria-label={intl.formatMessage(
                      {
                        id: "settings.runtime.userRun.toggleLabel",
                        defaultMessage: "Toggle adapter {name}",
                      },
                      { name: row.name },
                    )}
                  />
                  <RowActionButton
                    label={intl.formatMessage(
                      {
                        id: "settings.runtime.userRun.editLabel",
                        defaultMessage: "Edit adapter {name}",
                      },
                      { name: row.name },
                    )}
                    icon={Pencil}
                    onClick={() => onEdit(row)}
                  />
                  <RowActionButton
                    destructive
                    label={intl.formatMessage(
                      {
                        id: "settings.runtime.userRun.deleteLabel",
                        defaultMessage: "Delete adapter {name}",
                      },
                      { name: row.name },
                    )}
                    icon={Trash2}
                    onClick={() => setConfirmTarget(row)}
                  />
                </div>
              </div>
            </div>
          ))}
        </SettingsCard>
      )}
      {deleteError && <p className="text-destructive text-sm">{deleteError}</p>}
      {toggleError && <p className="text-destructive text-sm">{toggleError}</p>}
      <AlertDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <FormattedMessage
                id="settings.runtime.userRun.deleteTitle"
                defaultMessage="Delete {name}?"
                values={{ name: confirmTarget?.name ?? "" }}
              />
            </AlertDialogTitle>
            <AlertDialogDescription>
              <FormattedMessage
                id="settings.runtime.userRun.deleteBody"
                defaultMessage="The adapter is removed from the runtime picker; sessions already running on it keep running."
              />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmTarget) void handleDeleteRow(confirmTarget.id);
              }}
            >
              <FormattedMessage id="common.delete" defaultMessage="Delete" />
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
