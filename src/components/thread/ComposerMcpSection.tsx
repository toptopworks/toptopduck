import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormattedMessage, useIntl } from "react-intl";

import { listMcpServerStatus, toggleMcpServer } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import { sessionKeys } from "../../session/queryKeys";
import type { McpEnabledSource } from "../../types/mcp";

// The MCP tools section of the composer "+" panel (issue #369). Renders each
// configured MCP server as a three-state row:
// - off: not enabled, checkbox unchecked, clickable (can toggle on)
// - on-user: user-enabled, checkbox checked, clickable (can toggle off)
// - on-skill: skill-declared, checkbox checked + DISABLED (v1 read-only, issue
//   #369 spec), labeled "via skill <name>"
//
// The effective enabled set is computed server-side: enabled_mcp (user intent)
// ∪ (mounted skills' metadata.toptopduck_mcp_servers ∩ configured). Mount /
// unmount invalidates this query (driven from ComposerSkillsSection), so the
// section re-reads when the skill-declared contribution changes.
//
// The turn-in-flight `loading` gate disables user-toggle rows (the backend
// toggle_mcp_server does not refuse mid-turn, but toggling during a turn is
// meaningless -- the change lands next turn).

const ROW_CLASS =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none";

export type ComposerMcpSectionProps = {
  /** The session whose MCP enablement this section reads / writes. */
  sessionId: string;
  /** The session is mid-turn or mid-mutation: user-toggle rows are gated off
   *  (the toggle is meaningless mid-turn -- the change lands next turn). */
  loading: boolean;
};

export function ComposerMcpSection({ sessionId, loading }: ComposerMcpSectionProps) {
  const intl = useIntl();
  const queryClient = useQueryClient();

  const { data: mcpStatus, error: queryError } = useQuery({
    queryKey: sessionKeys.mcpStatus(sessionId),
    queryFn: () => listMcpServerStatus(sessionId),
  });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: sessionKeys.mcpStatus(sessionId) });
  }

  const toggleMutation = useMutation({
    mutationFn: (args: { id: string; enabled: boolean }) =>
      toggleMcpServer(sessionId, args.id, args.enabled),
    onSuccess: invalidate,
    onError: invalidate,
  });

  function handleToggle(id: string, source: McpEnabledSource | null) {
    // Skill-enabled servers are read-only (v1, issue #369 spec).
    if (source?.kind === "skill") return;
    const currentlyEnabled = source !== null;
    toggleMutation.mutate({ id, enabled: !currentlyEnabled });
  }

  const servers = mcpStatus ?? [];
  const displayError = queryError ? fmtError(queryError, intl) : null;

  if (servers.length === 0) {
    return null;
  }

  return (
    <section className="composer-mcp-section grid gap-1.5">
      <span className="text-sm font-medium">
        <FormattedMessage
          id="composer.contextPanel.mcpTitle"
          defaultMessage="MCP tools"
        />
      </span>
      <ul className="grid max-h-44 gap-0.5 overflow-y-auto pr-0.5">
        {servers.map((srv) => {
          const src = srv.source;
          const isSkillSourced = src?.kind === "skill";
          const isUserSourced = src?.kind === "user";
          const skillName = src?.kind === "skill" ? src.name : null;
          const disabled = loading || isSkillSourced || toggleMutation.isPending;
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
                <span className="truncate">{srv.display_name}</span>
                {isSkillSourced && (
                  <span className="text-muted-foreground ml-auto shrink-0 text-[10px]">
                    <FormattedMessage
                      id="composer.contextPanel.mcpViaSkill"
                      defaultMessage="via skill {name}"
                      values={{ name: skillName }}
                    />
                  </span>
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
      {displayError && (
        <p className="text-destructive px-2 text-xs" role="alert">
          {displayError}
        </p>
      )}
    </section>
  );
}
