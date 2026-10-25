import { useState } from "react";
import { useIntl } from "react-intl";
import { useQuery } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, ChevronDown, FolderOpen, FolderX, Plus, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { createWorkspace, listWorkspaces } from "../../api";
import { workspaceKeys } from "../../session/queryKeys";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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
// directories); unfiltered this surface slices the top 10 (older workspaces
// resurface through the browse). Each popover open refetches -- every session
// bind or mint changes the LRU order.
//
// The floating layer's content (issue #1393): a search box riding the same
// scroll band as the list (typing widens the data face to the FULL registry
// -- the second recall channel for older workspaces; the untyped view keeps
// the top 10 cap), row faces aligned to the reference product (folder icon
// leading, accent check trailing, the selected row on the accent pair), and
// a "New workspace" entry that swaps the layer to a naming subview: creating
// mints the named directory immediately (backend command) and seats it as
// the pending selection; an existing same-name directory selects it. The
// search term and naming state reset on every layer close.

/** The popover's display cap (issue #1384): the registry stores everything,
 *  the floating layer shows the freshest 10. */
const RECENT_LIMIT = 10;

/** The shared face of the layer's full-width entries -- the list rows and
 *  the fixed actions (new workspace, browse, no workspace); the rows add
 *  the selected accent pair on top. */
const ENTRY_CLASS =
  "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** The name cap and illegal-character set for a named workspace (issue
 *  #1393): the backend re-validates, this guard only keeps the create button
 *  honest. Rejecting beats rewriting -- a renamed directory would not match
 *  what the user expects to find later. */
const NAME_MAX_CHARS = 64;

/** Whether a name carries a control or path-illegal character (issue
 *  #1393): a charCode walk, not a regex -- the control range is a linted
 *  pattern face better kept explicit. */
function hasIllegalNameChar(name: string): boolean {
  for (const c of name) {
    const code = c.codePointAt(0)!;
    // The control set mirrors Rust's char::is_control(): C0, DEL, and C1.
    if (
      code <= 0x1f ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f) ||
      "\\/:*?\"<>|".includes(c)
    ) {
      return true;
    }
  }
  return false;
}

/** The shell-held pending selection: the directory to bind at the next
 *  mint, plus its display label (the browse face derives the tail here --
 *  the backend projects the same derivation for list rows). */
export type PendingWorkspace = {
  path: string;
  label: string;
};

/** A picked directory's display name: the final path segment, separator-
 *  agnostic (the backend's canonical spelling is OS-native). Unexported:
 *  the browse flow and the search matcher are its only consumers
 *  (react-refresh keeps the module component-only). */
function workspaceTail(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The search matcher (issue #1393): the display label (the record's title
 *  or the derived tail) or the path's tail segment, case-insensitive. */
function rowMatches(w: { path: string; label: string }, needle: string): boolean {
  return (
    w.label.toLowerCase().includes(needle) ||
    workspaceTail(w.path).toLowerCase().includes(needle)
  );
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
  const [query, setQuery] = useState("");
  const [naming, setNaming] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: workspaceKeys.all(),
    queryFn: listWorkspaces,
    // Only the open popover needs the rows; every open refetches so the
    // LRU order reflects the latest bind/mint. The app default is
    // staleTime: Infinity (ADR-0051 -- invalidate after mutations); no
    // mutation knows to invalidate this key, so the query opts out itself.
    enabled: openState,
    staleTime: 0,
  });
  const recent = data ?? [];
  // The typed view widens to the full registry (issue #1393's second recall
  // channel); the untyped view keeps the top-10 cap.
  const trimmedQuery = query.trim().toLowerCase();
  const visible = trimmedQuery
    ? recent.filter((w) => rowMatches(w, trimmedQuery))
    : recent.slice(0, RECENT_LIMIT);

  // The naming guard, mirrored from the backend (which re-validates as the
  // trust boundary): empty after trimming, over the cap, or carrying a
  // path-illegal/control character.
  const trimmedName = nameInput.trim();
  const nameInvalid =
    trimmedName.length === 0 ||
    // Code points, matching the backend's chars().count().
    [...trimmedName].length > NAME_MAX_CHARS ||
    hasIllegalNameChar(trimmedName);

  // A layer close resets the transient faces (issue #1393): the search term
  // and the naming subview never survive into the next open.
  function handleOpenChange(next: boolean) {
    setOpenState(next);
    if (!next) {
      setQuery("");
      setNaming(false);
      setNameInput("");
      setCreateError(null);
    }
  }

  async function browse() {
    const picked = await open({ directory: true });
    // null = cancelled; the multi-select shapes never arise (no `multiple`).
    if (typeof picked === "string") {
      onChange({ path: picked, label: workspaceTail(picked) });
      handleOpenChange(false);
    }
  }

  async function createNamed() {
    setCreateError(null);
    try {
      const w = await createWorkspace(trimmedName);
      onChange(w);
      handleOpenChange(false);
    } catch (e) {
      // The guard above already rejects the frontend-checkable shapes; this
      // is the backend's refusal (the trust boundary), surfaced inline.
      setCreateError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Popover open={openState} onOpenChange={handleOpenChange}>
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
          // One ghost face for BOTH states (issue #1393 follow-up, user
          // 2026-10-25): muted text, no border or surface -- the quiet
          // footer-entry family. The bound state carries no accent surface;
          // the workspace's label itself (vs the "Select workspace"
          // prompt) marks that the selection is set.
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors cursor-pointer hover:text-foreground",
            LABEL_HIDE_NARROW,
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
      <PopoverContent
        align="start"
        className="w-64 p-1"
        // An open must NOT drop the focus into the search box (user
        // 2026-10-25): the ring stays on the trigger; the naming subview's
        // input takes its own focus at mount, which this open-time default
        // would fight anyway.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {naming ? (
          <div className="flex flex-col gap-2 p-1">
            <Input
              autoFocus
              value={nameInput}
              onChange={(e) => {
                setNameInput(e.target.value);
                setCreateError(null);
              }}
              placeholder={intl.formatMessage({
                id: "composer.workspace.namePlaceholder",
                defaultMessage: "Workspace name",
              })}
              aria-label={intl.formatMessage({
                id: "composer.workspace.namePlaceholder",
                defaultMessage: "Workspace name",
              })}
              aria-invalid={nameInvalid && trimmedName.length > 0}
            />
            {nameInvalid && trimmedName.length > 0 && (
              <p className="text-xs text-destructive">
                {intl.formatMessage(
                  {
                    id: "composer.workspace.invalidName",
                    defaultMessage:
                      "Must be 1-64 characters, no \\ / : * ? \" < > |",
                  },
                )}
              </p>
            )}
            {createError !== null && (
              <p className="text-xs text-destructive">{createError}</p>
            )}
            <div className="flex justify-end gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setNaming(false)}
              >
                {intl.formatMessage({
                  id: "composer.workspace.cancel",
                  defaultMessage: "Cancel",
                })}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={nameInvalid}
                onClick={() => void createNamed()}
              >
                {intl.formatMessage({
                  id: "composer.workspace.create",
                  defaultMessage: "Create",
                })}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {recent.length > 0 && (
              // One scroll band for the search box + the list (issue #1393):
              // the cap leaves the search box plus about six rows; the thumb
              // stays transparent until the pointer is anywhere over the
              // panel (the styles.css reveal keyed on this element).
              <div className="ws-picker-scroll max-h-56 overflow-y-auto">
                <div className="relative mb-1">
                  <Search
                    className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <Input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={intl.formatMessage({
                      id: "composer.workspace.searchPlaceholder",
                      defaultMessage: "Search workspaces",
                    })}
                    aria-label={intl.formatMessage({
                      id: "composer.workspace.searchPlaceholder",
                      defaultMessage: "Search workspaces",
                    })}
                    className="pl-7"
                  />
                </div>
                {visible.length > 0 ? (
                  <ul>
                    {visible.map((w) => {
                      const selected = value?.path === w.path;
                      return (
                        <li key={w.path}>
                          <button
                            type="button"
                            aria-pressed={selected}
                            // A row click commits the pending selection and
                            // closes the layer -- one consumption per open
                            // (issue #1384). The selected row rides the accent
                            // token pair (DESIGN.md badge-accent -- the
                            // GuidedLoadDialog selected-row face); the check
                            // mark leads the row's tail.
                            onClick={() => {
                              onChange(w);
                              handleOpenChange(false);
                            }}
                            className={cn(
                              ENTRY_CLASS,
                              selected && "bg-accent text-accent-foreground",
                            )}
                          >
                            <FolderOpen
                              className={cn(
                                "size-4 shrink-0",
                                !selected && "text-muted-foreground",
                              )}
                              aria-hidden
                            />
                            <span className="truncate">{w.label}</span>
                            {selected && (
                              <Check className="ml-auto size-4 shrink-0" aria-hidden />
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">
                    {intl.formatMessage({
                      id: "composer.workspace.noMatches",
                      defaultMessage: "No matching workspaces",
                    })}
                  </p>
                )}
              </div>
            )}
            {recent.length > 0 && <div className="my-1 border-t border-border" />}
            <button
              type="button"
              onClick={() => setNaming(true)}
              className={ENTRY_CLASS}
            >
              <Plus className="size-4 shrink-0" aria-hidden />
              {intl.formatMessage({
                id: "composer.workspace.newWorkspace",
                defaultMessage: "New workspace",
              })}
            </button>
            <button
              type="button"
              onClick={() => void browse()}
              className={ENTRY_CLASS}
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
                  handleOpenChange(false);
                }}
                className={cn(
                  ENTRY_CLASS,
                  "text-muted-foreground hover:text-foreground",
                )}
              >
                <FolderX className="size-4 shrink-0" aria-hidden />
                {intl.formatMessage({
                  id: "composer.workspace.none",
                  defaultMessage: "No workspace",
                })}
              </button>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
