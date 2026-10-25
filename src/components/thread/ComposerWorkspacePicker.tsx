import { useState } from "react";
import { useIntl } from "react-intl";
import { useQuery } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { Ban, Check, ChevronDown, FolderOpen } from "lucide-react";

import { cn } from "@/lib/utils";
import { listWorkspaces } from "../../api";
import { workspaceKeys } from "../../session/queryKeys";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { LABEL_HIDE_NARROW } from "./composer-visual";

// The session-creation workspace selector (ADR-0137/0138, issue #1384): the
// muted strip pressed against the composer card's underside that picks the
// workspace the NEXT minted session binds.
// Two states (issue #1384): unbound shows the "Select workspace" prompt and
// the popover offers the recent list + a folder browse; bound shows the
// workspace's label (never its full path) and the popover additionally
// offers "No workspace" -- the undo back to the default lazy mint. The
// selection is shell-held pending state, consumed ONCE by createSession's
// directory parameter at the mint and reset to unbound afterwards; an
// unbound submit keeps the pre-#1384 behavior (lazy mint at the first disk
// need). Same-den continuation rides the recent list's first row -- the
// registry's LRU head.
//
// The recent list is the registry's LRU view (backend-filtered for existing
// directories); this surface slices the top 10 (older workspaces resurface
// through the browse). Each popover open refetches -- every session bind or
// mint changes the LRU order.

/** The popover's display cap (issue #1384): the registry stores everything,
 *  the floating layer shows the freshest 10. */
const RECENT_LIMIT = 10;

/** The shell-held pending selection: the directory to bind at the next
 *  mint, plus its display label (the browse face derives the tail here --
 *  the backend projects the same derivation for list rows). */
export type PendingWorkspace = {
  path: string;
  label: string;
};

/** A picked directory's display name: the final path segment, separator-
 *  agnostic (the backend's canonical spelling is OS-native). Unexported:
 *  the browse flow is its only consumer (react-refresh keeps the module
 *  component-only). */
function workspaceTail(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function ComposerWorkspacePicker({
  value,
  onChange,
}: {
  /** The current pending selection; null = the default lazy mint. */
  value: PendingWorkspace | null;
  onChange: (next: PendingWorkspace | null) => void;
}) {
  const intl = useIntl();
  const [openState, setOpenState] = useState(false);

  const { data } = useQuery({
    queryKey: workspaceKeys.all(),
    queryFn: listWorkspaces,
    // Only the open popover needs the rows; every open refetches so the
    // LRU order reflects the latest bind/mint.
    enabled: openState,
  });
  const recent = (data ?? []).slice(0, RECENT_LIMIT);

  async function browse() {
    const picked = await open({ directory: true });
    // null = cancelled; the multi-select shapes never arise (no `multiple`).
    if (typeof picked === "string") {
      onChange({ path: picked, label: workspaceTail(picked) });
      setOpenState(false);
    }
  }

  return (
    <Popover open={openState} onOpenChange={setOpenState}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={value
            ? intl.formatMessage(
                {
                  id: "composer.workspace.triggerAria",
                  defaultMessage: "Workspace: {label}",
                },
                { label: value.label },
              )
            : intl.formatMessage({
                id: "composer.workspace.select",
                defaultMessage: "Select workspace",
              })}
          // The unbound face is a ghost text control (folder icon + prompt +
          // chevron, no border or surface -- the quiet footer-entry family);
          // the bound face highlights on the accent token pair (DESIGN.md
          // badge-accent -- the same face the GuidedLoadDialog selected row
          // uses), marking that the selection is set.
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm transition-colors cursor-pointer",
            LABEL_HIDE_NARROW,
            value
              ? "border border-accent/40 bg-accent text-accent-foreground hover:bg-accent"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <FolderOpen className="size-4 shrink-0" aria-hidden />
          <span className="truncate">
            {value
              ? value.label
              : intl.formatMessage({
                  id: "composer.workspace.select",
                  defaultMessage: "Select workspace",
                })}
          </span>
          <ChevronDown className="size-3.5 shrink-0 opacity-70" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1">
        {recent.length > 0 && (
          <ul className="max-h-72 overflow-y-auto">
            {recent.map((w) => {
              const selected = value?.path === w.path;
              return (
                <li key={w.path}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    // A row click commits the pending selection and closes
                    // the layer -- one consumption per open (issue #1384).
                    onClick={() => {
                      onChange(w);
                      setOpenState(false);
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <Check
                      className={cn(
                        "size-4 shrink-0",
                        selected ? "opacity-100" : "opacity-0",
                      )}
                      aria-hidden
                    />
                    <span className="truncate">{w.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {recent.length > 0 && <div className="my-1 border-t border-border" />}
        <button
          type="button"
          onClick={() => void browse()}
          className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <FolderOpen className="size-4 shrink-0" aria-hidden />
          {intl.formatMessage({
            id: "composer.workspace.browse",
            defaultMessage: "Browse folders…",
          })}
        </button>
        {value !== null && (
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpenState(false);
            }}
            className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <Ban className="size-4 shrink-0" aria-hidden />
            {intl.formatMessage({
              id: "composer.workspace.none",
              defaultMessage: "No workspace",
            })}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
