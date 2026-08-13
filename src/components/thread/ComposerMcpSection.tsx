import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Plus } from "lucide-react";

import { Input } from "../ui/input";
import { TruncatingTooltip } from "./TruncatingTooltip";
import { listMcpServerStatus, toggleMcpServer } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import { log } from "../../lib/log";
import { sessionKeys } from "../../session/queryKeys";
import type { McpEnabledSource, McpServerRegistry, McpServerStatusEntry } from "../../types/mcp";

// The MCP tools section of the MCP trigger popover (issue #369). Rendered inside
// ComposerMcpTrigger's PopoverContent -- the trigger chip carries the icon +
// count header, so this component is pure content: search + checkbox list +
// add-server footer. Renders each configured MCP server as a three-state row:
// - off: not enabled, checkbox unchecked, clickable (can toggle on)
// - on-user: user-enabled, checkbox checked, clickable (can toggle off)
// - on-skill: skill-declared, checkbox checked + DISABLED (v1 read-only, issue
//   #369 spec), labeled "via skill <name>"
//
// Cold start (ADR-0092 Decision 6, #500): sessionId is null on the centered
// bar before any session exists. The section runs in DRAFT mode: the rows
// come from the session-agnostic app-config REGISTRY (never the per-session
// status query, which needs a live session), checked-state mirrors the
// caller-held pending list (source is always user -- no skills are mounted
// yet), and a toggle rewrites the list through onPendingMcpServersChange.
// The shell enables every pick on the session the first submit mints.
//
// The section always renders (never returns null) -- when no servers are
// configured it shows an empty state + the add-server footer. The
// turn-in-flight `loading` gate disables user-toggle rows.

const ROW_CLASS =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none";

export type ComposerMcpSectionProps = {
  /** The session whose MCP enablement this section reads / writes. null on
   *  the cold-start shell-level bar (ADR-0092 / #500): the section reads the
   *  registry + pendingMcpServers and writes via onPendingMcpServersChange
   *  instead of the per-session enable IPC. */
  sessionId: string | null;
  /** The session is mid-turn or mid-mutation: user-toggle rows are gated off
   *  (the toggle is meaningless mid-turn -- the change lands next turn). */
  loading: boolean;
  /** Hop to the settings MCP section (the server CRUD surface). Shell-owned
   *  navigation -- the parent threads the App.openSettings callback through. */
  onOpenSettingsMcp: () => void;
  /** The user-configured MCP server registry (AppConfig.mcp_servers). The
   *  draft-mode row source when sessionId is null (#500). */
  registry?: McpServerRegistry;
  /** When sessionId is null (cold-start bar), the shell-held pending enable
   *  list rendered as the section's checked rows. */
  pendingMcpServers?: string[];
  /** When sessionId is null (cold-start bar), a toggle hands the NEXT pending
   *  list (id appended / removed) to the shell via this callback. Undefined
   *  when sessionId is non-null. */
  onPendingMcpServersChange?: (next: string[]) => void;
};

export function ComposerMcpSection({
  sessionId,
  loading,
  onOpenSettingsMcp,
  registry,
  pendingMcpServers,
  onPendingMcpServersChange,
}: ComposerMcpSectionProps) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Null sessionId (cold-start bar, ADR-0092): the query is disabled — the
  // draft rows below derive from the registry, no IPC round-trip.
  const { data: mcpStatus, error: queryError, isLoading } = useQuery({
    // The queryKey uses a stable placeholder when sessionId is null — the key
    // is inert (enabled:false prevents the queryFn from running, so no IPC).
    queryKey: sessionKeys.mcpStatus(sessionId ?? ""),
    queryFn: () => listMcpServerStatus(sessionId as string),
    enabled: sessionId !== null,
  });

  // Draft-mode rows (#500): one status-shaped entry per configured server,
  // checked-state mirrored from the pending list. connected / tool_count /
  // error stay at their not-connected values (nothing has run yet); source is
  // user-or-null (no skills are mounted before the session exists).
  const draftRows = useMemo<McpServerStatusEntry[]>(() => {
    if (sessionId !== null) return [];
    const pending = new Set(pendingMcpServers ?? []);
    return (registry?.servers ?? []).map((srv) => {
      const enabled = pending.has(srv.id);
      return {
        id: srv.id,
        display_name: srv.display_name,
        enabled,
        source: enabled ? ({ kind: "user" } as const) : null,
        connected: false,
        tool_count: 0,
        tools: [],
        error: null,
      };
    });
  }, [sessionId, registry, pendingMcpServers]);

  function invalidate() {
    // Session mode only: the draft rows are registry-derived and invalidate
    // with app-config, not the session status cache.
    if (sessionId === null) return;
    void queryClient.invalidateQueries({ queryKey: sessionKeys.mcpStatus(sessionId) });
  }

  const toggleMutation = useMutation({
    mutationFn: (args: { id: string; enabled: boolean }) =>
      // `as string` is safe: handleToggle routes null-sessionId toggles to the
      // pending-list path and never mutates (draft mode is IPC-free).
      toggleMcpServer(sessionId as string, args.id, args.enabled),
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
    // Null sessionId (cold-start bar, ADR-0092 / #500): rewrite the
    // caller-held pending list synchronously — no IPC, no per-id pending
    // gate. When the callback is absent the toggle is logged and discarded so
    // an unwired cold-start bar is observable instead of silently swallowed.
    if (sessionId === null) {
      if (onPendingMcpServersChange) {
        const current = pendingMcpServers ?? [];
        const next = currentlyEnabled
          ? current.filter((serverId) => serverId !== id)
          : [...current, id];
        onPendingMcpServersChange(next);
      } else {
        log.warn(
          "ComposerMcpSection",
          "toggle called with null sessionId but no onPendingMcpServersChange handler — selection discarded",
        );
      }
      return;
    }
    setPendingId(id);
    toggleMutation.mutate({ id, enabled: !currentlyEnabled });
  }

  const servers = useMemo(
    () => (sessionId === null ? draftRows : (mcpStatus ?? [])),
    [sessionId, draftRows, mcpStatus],
  );
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
