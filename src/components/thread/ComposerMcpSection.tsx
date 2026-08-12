import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Plus } from "lucide-react";

import { Input } from "../ui/input";
import { TruncatingTooltip } from "./TruncatingTooltip";
import { listMcpServerStatus, toggleMcpServer } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import { sessionKeys } from "../../session/queryKeys";
import type { McpEnabledSource } from "../../types/mcp";

// The MCP tools section of the MCP trigger popover (issue #369). Rendered inside
// ComposerMcpTrigger's PopoverContent -- the trigger chip carries the icon +
// count header, so this component is pure content: search + checkbox list +
// add-server footer. Renders each configured MCP server as a three-state row:
// - off: not enabled, checkbox unchecked, clickable (can toggle on)
// - on-user: user-enabled, checkbox checked, clickable (can toggle off)
// - on-skill: skill-declared, checkbox checked + DISABLED (v1 read-only, issue
//   #369 spec), labeled "via skill <name>"
//
// The section always renders (never returns null) -- when no servers are
// configured it shows an empty state + the add-server footer. The
// turn-in-flight `loading` gate disables user-toggle rows.

const ROW_CLASS =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none";

export type ComposerMcpSectionProps = {
  /** The session whose MCP enablement this section reads / writes. */
  sessionId: string;
  /** The session is mid-turn or mid-mutation: user-toggle rows are gated off
   *  (the toggle is meaningless mid-turn -- the change lands next turn). */
  loading: boolean;
  /** Hop to the settings MCP section (the server CRUD surface). Shell-owned
   *  navigation -- the parent threads the App.openSettings callback through. */
  onOpenSettingsMcp: () => void;
};

export function ComposerMcpSection({ sessionId, loading, onOpenSettingsMcp }: ComposerMcpSectionProps) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const { data: mcpStatus, error: queryError, isLoading } = useQuery({
    queryKey: sessionKeys.mcpStatus(sessionId),
    queryFn: () => listMcpServerStatus(sessionId),
  });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: sessionKeys.mcpStatus(sessionId) });
  }

  const toggleMutation = useMutation({
    mutationFn: (args: { id: string; enabled: boolean }) =>
      toggleMcpServer(sessionId, args.id, args.enabled),
    onSuccess: () => {
      setError(null);
      setPendingId(null);
      invalidate();
    },
    onError: (e) => {
      setError(fmtError(e, intl));
      setPendingId(null);
      invalidate();
    },
  });

  function handleToggle(id: string, source: McpEnabledSource | null) {
    if (source?.kind === "skill") return;
    const currentlyEnabled = source !== null;
    setPendingId(id);
    toggleMutation.mutate({ id, enabled: !currentlyEnabled });
  }

  const servers = useMemo(() => mcpStatus ?? [], [mcpStatus]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched =
      q === "" ? servers : servers.filter((s) => s.display_name.toLowerCase().includes(q));
    // Pin enabled (selected) servers to the top; Array.prototype.sort is
    // stable, so the server order is preserved within each group.
    return [...matched].sort((a, b) => Number(b.enabled) - Number(a.enabled));
  }, [servers, search]);

  const displayError = error ?? (queryError ? fmtError(queryError, intl) : null);
  const empty = !isLoading && servers.length === 0;
  const noMatches = !empty && filtered.length === 0;

  return (
    <div className="composer-mcp-section grid gap-1.5">
      <Input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={intl.formatMessage({
          id: "composer.contextPanel.mcpSearchPlaceholder",
          defaultMessage: "Search…",
        })}
        aria-label={intl.formatMessage({
          id: "composer.contextPanel.mcpSearchPlaceholder",
          defaultMessage: "Search…",
        })}
        className="h-7 px-2 text-xs dark:bg-background"
      />
      {/* minmax(0,1fr) caps the implicit grid track at the popover width so
          long names hit the row's truncate instead of widening the track;
          min-h-0 lets max-h-44 actually cap the list height (without it, the
          grid item's default min-height:auto overrides max-height and the
          list grows unbounded); overflow-x-hidden keeps the vertical scroller
          from ever growing a horizontal one. */}
      <ul className="grid max-h-44 min-h-0 grid-cols-[minmax(0,1fr)] gap-0.5 overflow-x-hidden overflow-y-auto pr-0.5">
        {filtered.map((srv) => {
          const src = srv.source;
          const isSkillSourced = src?.kind === "skill";
          const isUserSourced = src?.kind === "user";
          const skillName = src?.kind === "skill" ? src.name : null;
          // One string for the row suffix AND its hover tooltip, so the
          // title always matches the visible (possibly truncated) label.
          const viaSkillLabel =
            skillName !== null
              ? intl.formatMessage(
                  { id: "composer.contextPanel.mcpViaSkill", defaultMessage: "via skill {name}" },
                  { name: skillName },
                )
              : null;
          const disabled = loading || isSkillSourced || pendingId === srv.id;
          return (
            <li key={srv.id}>
              <label className={ROW_CLASS}>
                <input
                  type="checkbox"
                  checked={srv.enabled}
                  disabled={disabled}
                  onChange={() => handleToggle(srv.id, srv.source)}
                  className="size-3.5 cursor-pointer accent-primary disabled:cursor-not-allowed"
                  aria-label={intl.formatMessage(
                    {
                      id: "composer.contextPanel.mcpToggleAria",
                      defaultMessage: "Toggle MCP server {name}",
                    },
                    { name: srv.display_name },
                  )}
                />
                <TruncatingTooltip text={srv.display_name} className="truncate">
                  {srv.display_name}
                </TruncatingTooltip>
                {viaSkillLabel !== null && (
                  <TruncatingTooltip
                    text={viaSkillLabel}
                    className="text-muted-foreground ml-auto truncate text-[10px]"
                  >
                    {viaSkillLabel}
                  </TruncatingTooltip>
                )}
                {isUserSourced && srv.connected && srv.tool_count > 0 && (
                  <span className="text-muted-foreground ml-auto shrink-0 text-[10px]">
                    {srv.tool_count}
                  </span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
      {empty && !displayError && (
        <span className="text-muted-foreground px-2 py-2 text-xs">
          <FormattedMessage
            id="composer.contextPanel.mcpEmpty"
            defaultMessage="No MCP servers"
          />
        </span>
      )}
      {noMatches && (
        <span className="text-muted-foreground px-2 py-2 text-xs">
          <FormattedMessage
            id="composer.contextPanel.mcpNoMatches"
            defaultMessage="No MCP servers match your search."
          />
        </span>
      )}
      {displayError && (
        <p className="text-destructive px-2 text-xs" role="alert">
          {displayError}
        </p>
      )}
      <div className="border-t border-border" />
      <button
        type="button"
        onClick={onOpenSettingsMcp}
        className="hover:bg-accent focus-visible:outline-ring -mx-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <Plus className="size-3.5" aria-hidden />
        <FormattedMessage
          id="composer.contextPanel.addMcp"
          defaultMessage="Add MCP server"
        />
      </button>
    </div>
  );
}
