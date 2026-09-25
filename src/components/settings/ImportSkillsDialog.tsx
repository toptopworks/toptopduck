import { useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useQuery } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { Plus, RefreshCw, X } from "lucide-react";

import type {
  DiscoveredSkill,
  ImportItem,
  ImportMode,
  SkillSource,
} from "../../types/skills";
import { listSkillSources } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import { skillKeys } from "../../session/queryKeys";
import { useSkillsRegistry } from "../../skills/registry";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DialogHeaderButton, FieldHint, SourceFold } from "./settings-chrome";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

// Two-stage drill-down import dialog (issue #367, ADR-0086). The collapsed
// state lists discovered external sources (Claude Code ~/.claude/skills, Codex
// CLI ~/.codex/skills, + user-added custom paths); expanding one reveals its
// resident skills as checkboxes. The dialog classifies each skill importable /
// already_exists / invalid against the registry snapshot the backend read at
// discovery time -- the backend re-validates + re-checks the registry at
// commit too, so no status is cached beyond the preview. The import batch
// rides the registry seam's mutation, whose invalidation carries the cascade
// contract (this dialog's own discovery read is invalidated with the
// listing).
// The staging state machine -- selection, expansion, mode -- stays here. The
// bottom dropdown picks link (symlink / junction -> linked) vs copy
// (recursive -> local) for the whole batch; the Import action is gray at
// zero selections.

type Props = {
  onClose: () => void;
};

export function ImportSkillsDialog({ onClose }: Props) {
  const intl = useIntl();

  const [customPaths, setCustomPaths] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [mode, setMode] = useState<ImportMode>("link");
  const [error, setError] = useState<string | null>(null);

  const { importSkillsMutation } = useSkillsRegistry();

  const sourcesKey = skillKeys.sources(customPaths);
  const { data: sources, error: sourcesError, refetch, isFetching } = useQuery({
    queryKey: sourcesKey,
    queryFn: () => listSkillSources(customPaths),
  });

  // The selectable set is the union of `importable` skills across all sources,
  // keyed by source_dir (unique). Already-exists + invalid skills are never
  // selectable (excluded from the registry, never overwritten).
  const importableDirsBySource = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const source of sources ?? []) {
      const dirs = source.skills
        .filter((s) => s.status === "importable")
        .map((s) => s.source_dir);
      map.set(source.id, dirs);
    }
    return map;
  }, [sources]);

  const selectedCount = selected.size;
  const totalDiscovered = [...importableDirsBySource.values()].reduce(
    (sum, dirs) => sum + dirs.length,
    0,
  );

  function toggleSkill(dir: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) {
        next.delete(dir);
      } else {
        next.add(dir);
      }
      return next;
    });
  }

  function toggleSourceAll(sourceId: string) {
    const dirs = importableDirsBySource.get(sourceId) ?? [];
    const allSelected = dirs.every((d) => selected.has(d));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        dirs.forEach((d) => next.delete(d));
      } else {
        dirs.forEach((d) => next.add(d));
      }
      return next;
    });
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function addCustomPath() {
    // Directory picker: `multiple: false` narrows the plugin's union return to
    // string | null in practice; the typeof guard is the defensive normalize
    // (parallel to ComposerContextPanel.pickFiles).
    const picked = await open({ directory: true, multiple: false });
    const path = typeof picked === "string" ? picked : null;
    if (!path) return;
    if (customPaths.includes(path)) return;
    setError(null);
    setCustomPaths((prev) => [...prev, path]);
    // Auto-expand the new source so the user sees its skills immediately.
    setExpanded((prev) => new Set(prev).add(path));
  }

  function handleImport() {
    setError(null);
    const items: ImportItem[] = [...selected].map((source_dir) => ({
      source_dir,
    }));
    importSkillsMutation.mutate(
      { items, mode },
      {
        // The per-call half (the registry owns the cache work): prune
        // successfully imported items from `selected` so a retry does not
        // re-send them (the backend would reject with NameTaken). The
        // outcomes parallel the input items in order.
        onSuccess: (outcomes, vars) => {
          const importedDirs = vars.items
            .filter((_, i) => outcomes[i]?.kind === "imported")
            .map((item) => item.source_dir);
          if (importedDirs.length > 0) {
            setSelected((prev) => {
              const next = new Set(prev);
              importedDirs.forEach((d) => next.delete(d));
              return next;
            });
          }
          const failed = outcomes.filter((o) => o.kind === "failed");
          if (failed.length === 0) {
            onClose();
            return;
          }
          // Partial failure: surface the first typed reject + the total
          // failure count so the user knows how many imports did not land.
          // The rest imported fine; a full success closes the dialog.
          const firstError = fmtError(failed[0].data, intl);
          setError(
            failed.length > 1
              ? intl.formatMessage(
                  {
                    id: "settings.skills.importPartialFailure",
                    defaultMessage: "{error} (+{count} more)",
                  },
                  { error: firstError, count: failed.length - 1 },
                )
              : firstError,
          );
        },
        onError: (e) => setError(fmtError(e, intl)),
      },
    );
  }

  const sourceList = sources ?? [];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-2xl"
        showCloseButton={false}
        onEscapeKeyDown={(e) => {
          if (importSkillsMutation.isPending) e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          if (importSkillsMutation.isPending) e.preventDefault();
        }}
      >
        <DialogHeader>
          <div className="flex items-center justify-between gap-2">
            <DialogTitle>
              <FormattedMessage
                id="settings.skills.importTitle"
                defaultMessage="Import skills"
              />
            </DialogTitle>
            <div className="flex items-center gap-1">
              <DialogHeaderButton
                label={intl.formatMessage({
                  id: "settings.skills.importRefresh",
                  defaultMessage: "Refresh sources",
                })}
                icon={RefreshCw}
                spinning={isFetching}
                onClick={() => void refetch()}
              />
              <DialogHeaderButton
                label={intl.formatMessage({
                  id: "common.close",
                  defaultMessage: "Close",
                })}
                icon={X}
                disabled={importSkillsMutation.isPending}
                onClick={onClose}
              />
            </div>
          </div>
          <DialogDescription>
            <FormattedMessage
              id="settings.skills.importDescription"
              defaultMessage="Import skills from other apps on this computer. Link to the original folder, or make an editable copy."
            />
          </DialogDescription>
        </DialogHeader>

        {sourcesError && (
          <p className="settings-error text-destructive text-sm">
            {fmtError(sourcesError, intl)}
          </p>
        )}

        <div className="flex min-h-[40vh] max-h-[60vh] flex-col gap-1 overflow-y-auto">
          {sourceList.length === 0 ? (
            <p className="text-muted-foreground px-4 py-8 text-center text-sm">
              <FormattedMessage
                id="settings.skills.importEmpty"
                defaultMessage={"No skills found yet. Click \"+ Add custom path\" to choose a folder."}
              />
            </p>
          ) : (
            sourceList.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                importableDirs={importableDirsBySource.get(source.id) ?? []}
                expanded={expanded.has(source.id)}
                selected={selected}
                onToggleExpand={() => toggleExpand(source.id)}
                onToggleSourceAll={() => toggleSourceAll(source.id)}
                onToggleSkill={toggleSkill}
              />
            ))
          )}

          <button
            type="button"
            data-testid="import-add-custom-path"
            onClick={() => void addCustomPath()}
            className="hover:bg-accent focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2 flex items-center gap-2 rounded-md px-3 py-2.5 text-sm outline-none"
          >
            <Plus className="size-4" aria-hidden />
            <FormattedMessage
              id="settings.skills.importAddCustomPath"
              defaultMessage="Add custom path"
            />
          </button>
        </div>

        {error && (
          <p className="settings-error text-destructive text-sm">{error}</p>
        )}

        <DialogFooter className="sm:items-center">
          <span className="text-muted-foreground text-sm">
            <FormattedMessage
              id="settings.skills.importDiscovered"
              defaultMessage="Discovered {count} importable {count, plural, one {skill} other {skills}}"
              values={{ count: totalDiscovered }}
            />
          </span>
          <Select
            value={mode}
            onValueChange={(v) => setMode(v as ImportMode)}
          >
            <SelectTrigger data-testid="import-mode-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="link">
                {intl.formatMessage({
                  id: "settings.skills.importModeLink",
                  defaultMessage: "Link",
                })}
              </SelectItem>
              <SelectItem value="copy">
                {intl.formatMessage({
                  id: "settings.skills.importModeCopy",
                  defaultMessage: "Copy",
                })}
              </SelectItem>
            </SelectContent>
          </Select>
          <FieldHint
            label={intl.formatMessage({
              id: "settings.skills.importModeHintAria",
              defaultMessage: "Import mode explanation",
            })}
            title={intl.formatMessage({
              id: "settings.skills.importModeHintTitle",
              defaultMessage: "Import mode",
            })}
          >
            {mode === "link" ? (
              <FormattedMessage
                id="settings.skills.importModeLinkHint"
                defaultMessage="Uses the skill in its original folder. Changes there apply automatically, but the skill stops working if the folder moves or is deleted."
              />
            ) : (
              <FormattedMessage
                id="settings.skills.importModeCopyHint"
                defaultMessage="Copies the skill into the app. Later changes in the original folder won't apply."
              />
            )}
          </FieldHint>
          <Button
            type="button"
            variant="ghost"
            className="sm:ml-auto"
            onClick={onClose}
            disabled={importSkillsMutation.isPending}
          >
            <FormattedMessage
              id="common.cancel"
              defaultMessage="Cancel"
            />
          </Button>
          <Button
            type="button"
            data-testid="import-action"
            onClick={handleImport}
            disabled={selectedCount === 0 || importSkillsMutation.isPending}
          >
            {importSkillsMutation.isPending ? (
              <FormattedMessage
                id="common.importing"
                defaultMessage="Importing…"
              />
            ) : (
              <FormattedMessage
                id="common.importCount"
                defaultMessage="Import {count}"
                values={{ count: selectedCount }}
              />
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type SourceRowProps = {
  source: SkillSource;
  importableDirs: string[];
  expanded: boolean;
  selected: Set<string>;
  onToggleExpand: () => void;
  onToggleSourceAll: () => void;
  onToggleSkill: (dir: string) => void;
};

function SourceRow({
  source,
  importableDirs,
  expanded,
  selected,
  onToggleExpand,
  onToggleSourceAll,
  onToggleSkill,
}: SourceRowProps) {
  const selectedInSource = importableDirs.filter((d) => selected.has(d)).length;
  const allSelected =
    importableDirs.length > 0 && selectedInSource === importableDirs.length;

  return (
    <SourceFold
      label={source.label}
      path={source.path}
      count={source.skills.length}
      expanded={expanded}
      onToggleExpand={onToggleExpand}
      selectAll={{
        checked: allSelected,
        disabled: importableDirs.length === 0,
        onToggleAll: onToggleSourceAll,
      }}
    >
      {/* Expanded panel: skill checkboxes + selected M / N + select-all
          link. */}
      <div className="text-muted-foreground mb-1.5 flex items-center justify-between text-xs">
        <span>
          <FormattedMessage
            id="settings.skills.importSelectedCount"
            defaultMessage="Selected {selected} / {total}"
            values={{
              selected: selectedInSource,
              total: importableDirs.length,
            }}
          />
        </span>
        <button
          type="button"
          onClick={onToggleSourceAll}
          disabled={importableDirs.length === 0}
          className="hover:text-foreground disabled:opacity-50"
        >
          <FormattedMessage
            id="settings.skills.importSelectAll"
            defaultMessage="Select all"
          />
        </button>
      </div>
      <div className="grid gap-0.5">
        {source.skills.map((skill) => (
          <SkillRow
            key={skill.source_dir}
            skill={skill}
            checked={selected.has(skill.source_dir)}
            onToggle={() => onToggleSkill(skill.source_dir)}
          />
        ))}
      </div>
    </SourceFold>
  );
}

type SkillRowProps = {
  skill: DiscoveredSkill;
  checked: boolean;
  onToggle: () => void;
};

function SkillRow({ skill, checked, onToggle }: SkillRowProps) {
  // Invalid: disabled + a native title tooltip carrying the English reason
  // (ADR-0052 layer 4 -- the locale catalog owns the section wording, NOT the
  // per-row reason, which is the dynamic backend detail).
  const disabled = skill.status !== "importable";
  // The checkbox carries its own aria-label so the accessible name is the skill
  // name alone (the wrapping pattern would fold the description + badges into
  // the name); a separate <label htmlFor> provides the click-to-toggle target
  // without re-naming the control.
  const cbId = `import-skill-${skill.source_dir}`;
  return (
    <div
      data-testid="import-skill-row"
      title={skill.reason ?? undefined}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded px-2 py-1.5 text-sm",
        disabled ? "opacity-60" : "hover:bg-accent",
      )}
    >
      <input
        id={cbId}
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        disabled={disabled}
        aria-label={skill.name}
        className="size-4 shrink-0"
      />
      <label
        htmlFor={cbId}
        className="min-w-0 flex-1 cursor-pointer"
      >
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{skill.name}</span>
          {skill.status === "already_exists" && (
            <Badge variant="secondary" className="shrink-0">
              <FormattedMessage
                id="settings.skills.importAlreadyExists"
                defaultMessage="exists"
              />
            </Badge>
          )}
          {skill.status === "invalid" && (
            <Badge variant="outline" className="shrink-0">
              <FormattedMessage
                id="settings.skills.importInvalid"
                defaultMessage="invalid"
              />
            </Badge>
          )}
        </div>
      </label>
    </div>
  );
}
