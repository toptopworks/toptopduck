import { useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronRight, Plus, RefreshCw } from "lucide-react";

import type {
  DiscoveredSkill,
  ImportMode,
  SkillSource,
} from "../../types/skills";
import { importSkills, listSkillSources } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import { skillKeys } from "../../session/queryKeys";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
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
// commit too, so no status is cached beyond the preview. The bottom dropdown
// picks link (symlink / junction -> linked) vs copy (recursive -> local) for
// the whole batch; the Import action is gray at zero selections.

type Props = {
  onClose: () => void;
};

export function ImportSkillsDialog({ onClose }: Props) {
  const intl = useIntl();
  const queryClient = useQueryClient();

  const [customPaths, setCustomPaths] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [mode, setMode] = useState<ImportMode>("link");
  const [error, setError] = useState<string | null>(null);

  const sourcesKey = skillKeys.sources(customPaths);
  const { data: sources, refetch, isFetching } = useQuery({
    queryKey: sourcesKey,
    queryFn: () => listSkillSources(customPaths),
  });

  function invalidateAfterImport() {
    void queryClient.invalidateQueries({ queryKey: skillKeys.all() });
    void queryClient.invalidateQueries({ queryKey: sourcesKey });
  }

  const importMutation = useMutation({
    mutationFn: () => {
      const items = [...selected].map((source_dir) => ({ source_dir }));
      return importSkills(items, mode);
    },
    onSuccess: (outcomes) => {
      invalidateAfterImport();
      const failed = outcomes.filter((o) => o.kind === "failed");
      if (failed.length === 0) {
        onClose();
        return;
      }
      // Partial failure: fold the FIRST failure's typed reject + stay open so
      // the user sees which import did not land (the rest imported fine). A
      // full success closes the dialog; a full failure surfaces the same way.
      setError(fmtError(failed[0].data, intl));
    },
    onError: (e) => setError(fmtError(e, intl)),
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
    importMutation.mutate();
  }

  const sourceList = sources ?? [];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl" showCloseButton>
        <DialogHeader>
          <div className="flex items-center justify-between gap-2">
            <DialogTitle>
              <FormattedMessage
                id="settings.skills.importTitle"
                defaultMessage="Import skills"
              />
            </DialogTitle>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              aria-label={intl.formatMessage({
                id: "settings.skills.importRefresh",
                defaultMessage: "Refresh sources",
              })}
              onClick={() => void refetch()}
            >
              <RefreshCw
                className={cn("size-4", isFetching && "animate-spin")}
                aria-hidden
              />
            </Button>
          </div>
          <DialogDescription>
            <FormattedMessage
              id="settings.skills.importDescription"
              defaultMessage="Link or copy skills from external agent libraries. Linked skills are read-only; copied skills are editable."
            />
          </DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[60vh] gap-1 overflow-y-auto">
          {sourceList.length === 0 ? (
            <p className="text-muted-foreground px-4 py-8 text-center text-sm">
              <FormattedMessage
                id="settings.skills.importEmpty"
                defaultMessage={"No skill sources found. Click \"+ Add custom path\" to browse."}
              />
            </p>
          ) : (
            sourceList.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
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
              defaultMessage="+ Add custom path"
            />
          </button>
        </div>

        {error && (
          <p className="settings-error text-destructive text-sm">{error}</p>
        )}

        <DialogFooter>
          <label htmlFor="import-mode" className="flex items-center gap-2 text-sm">
            <FormattedMessage
              id="settings.skills.importModeLabel"
              defaultMessage="Mode"
            />
            <select
              id="import-mode"
              data-testid="import-mode-select"
              className="border-border bg-background text-foreground h-9 rounded-md border px-2 text-sm"
              value={mode}
              onChange={(e) => setMode(e.target.value as ImportMode)}
            >
              <option value="link">
                {intl.formatMessage({
                  id: "settings.skills.importModeLink",
                  defaultMessage: "Link (default)",
                })}
              </option>
              <option value="copy">
                {intl.formatMessage({
                  id: "settings.skills.importModeCopy",
                  defaultMessage: "Copy",
                })}
              </option>
            </select>
          </label>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={importMutation.isPending}
          >
            <FormattedMessage
              id="settings.skills.cancel"
              defaultMessage="Cancel"
            />
          </Button>
          <Button
            type="button"
            data-testid="import-action"
            onClick={handleImport}
            disabled={selectedCount === 0 || importMutation.isPending}
          >
            {importMutation.isPending ? (
              <FormattedMessage
                id="settings.skills.importing"
                defaultMessage="Importing…"
              />
            ) : (
              <FormattedMessage
                id="settings.skills.importAction"
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
  expanded: boolean;
  selected: Set<string>;
  onToggleExpand: () => void;
  onToggleSourceAll: () => void;
  onToggleSkill: (dir: string) => void;
};

function SourceRow({
  source,
  expanded,
  selected,
  onToggleExpand,
  onToggleSourceAll,
  onToggleSkill,
}: SourceRowProps) {
  const intl = useIntl();
  const importableDirs = source.skills
    .filter((s) => s.status === "importable")
    .map((s) => s.source_dir);
  const selectedInSource = importableDirs.filter((d) => selected.has(d)).length;
  const allSelected =
    importableDirs.length > 0 && selectedInSource === importableDirs.length;

  return (
    <div className="border-border rounded-lg border">
      {/* Collapsed header: select-all checkbox + single expand toggle carrying
          label + path + count badge + chevron (one aria-expanded element, not
          two — P2 fix). The aria-label carries the expand/collapse action so
          the path / badge text never leaks into the accessible name. */}
      <div className="hover:bg-accent/50 flex items-center gap-2 px-3 py-2.5">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={onToggleSourceAll}
          disabled={importableDirs.length === 0}
          aria-label={source.label}
          className="size-4"
        />
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-label={
            expanded
              ? intl.formatMessage(
                  {
                    id: "settings.skills.importCollapse",
                    defaultMessage: "Collapse {label}",
                  },
                  { label: source.label },
                )
              : intl.formatMessage(
                  {
                    id: "settings.skills.importExpand",
                    defaultMessage: "Expand {label}",
                  },
                  { label: source.label },
                )
          }
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="truncate text-sm font-medium">{source.label}</span>
          <span className="text-muted-foreground truncate font-mono text-xs">
            {source.path}
          </span>
          <Badge variant="secondary" className="ml-auto shrink-0">
            {source.skills.length}
          </Badge>
          <ChevronRight
            className={cn(
              "size-4 shrink-0 transition-transform",
              expanded && "rotate-90",
            )}
            aria-hidden
          />
        </button>
      </div>

      {/* Expanded: skill checkboxes + selected M / N + select-all link. */}
      {expanded && (
        <div className="border-border border-t px-3 py-2">
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
        </div>
      )}
    </div>
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
          <span className="truncate font-mono text-xs">{skill.name}</span>
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
        {skill.description && (
          <p className="text-muted-foreground truncate text-xs">
            {skill.description}
          </p>
        )}
      </label>
    </div>
  );
}
