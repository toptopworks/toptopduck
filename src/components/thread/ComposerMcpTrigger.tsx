import { useState } from "react";
import { useIntl } from "react-intl";
import { useQuery } from "@tanstack/react-query";
import { Cable } from "lucide-react";

import { listMcpServerStatus } from "../../api";
import { sessionKeys } from "../../session/queryKeys";
import type { McpServerRegistry } from "../../types/mcp";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ComposerMcpSection } from "./ComposerMcpSection";

// The MCP trigger chip, rendered in the QuestionBar container's top row
// (the shell-level bar's header slot). Shows the cable icon + enabled/total
// count. Click opens a popover with the search + checkbox list + add-server
// footer. The count query shares its cache key with ComposerMcpSection.
//
// Cold start (ADR-0092 Decision 6, #500): sessionId is null on the centered
// bar before any session exists. The per-session status query needs a live
// session, so draft mode reads the SESSION-AGNOSTIC app-config registry
// (the same list the settings MCP section manages) for the rows + total
// count; the caller-held pending list drives the enabled count, and toggles
// write to it via onPendingMcpServersChange. The shell enables every pick on
// the session the first submit mints.

export type ComposerMcpTriggerProps = {
  /** The session whose MCP enablement this trigger reads. null on the
   *  cold-start shell-level bar (ADR-0092): the chip reads the registry +
   *  pendingMcpServers instead of the per-session status query. */
  sessionId: string | null;
  loading: boolean;
  onOpenSettingsMcp: () => void;
  /** The user-configured MCP server registry (AppConfig.mcp_servers). The
   *  draft-mode row source when sessionId is null (#500); unused when a
   *  session is active (the per-session status query carries the rows). */
  registry?: McpServerRegistry;
  /** When sessionId is null (cold-start bar, ADR-0092 / #500), the
   *  shell-held pending enable list behind the chip's enabled count. */
  pendingMcpServers?: string[];
  /** When sessionId is null (cold-start bar, ADR-0092 / #500), a popover
   *  toggle writes to the shell-level pending list via this callback instead
   *  of the per-session enable IPC. Undefined when sessionId is non-null. */
  onPendingMcpServersChange?: (next: string[]) => void;
};

const CHIP_CLASS =
  "composer-mcp-trigger inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted cursor-pointer";

export function ComposerMcpTrigger({
  sessionId,
  loading,
  onOpenSettingsMcp,
  registry,
  pendingMcpServers,
  onPendingMcpServersChange,
}: ComposerMcpTriggerProps) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);

  // Null sessionId (cold-start bar, ADR-0092): the query is disabled — no IPC
  // round-trip; the registry + pending list drive the counts.
  const { data: mcpStatus } = useQuery({
    // The queryKey uses a stable placeholder when sessionId is null — the key
    // is inert (enabled:false prevents the queryFn from running, so no IPC).
    queryKey: sessionKeys.mcpStatus(sessionId ?? ""),
    queryFn: () => listMcpServerStatus(sessionId as string),
    enabled: sessionId !== null,
  });

  const enabledCount =
    sessionId === null
      ? (pendingMcpServers ?? []).length
      : (mcpStatus ?? []).filter((s) => s.enabled).length;
  const totalCount =
    sessionId === null
      ? (registry?.servers ?? []).length
      : (mcpStatus ?? []).length;
  const label = intl.formatMessage(
    {
      id: "composer.mcpTrigger.label",
      defaultMessage: "MCP ({enabled}/{total})",
    },
    { enabled: enabledCount, total: totalCount },
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={CHIP_CLASS} aria-label={label}>
          <Cable className="size-3.5" aria-hidden />
          {/* @max-[320px]:hidden collapses the label when the QuestionBar
              @container narrows, leaving the icon -- the same threshold the
              auth-mode chip uses. aria-label keeps the full label (with
              counts) as the accessible name at every width. */}
          <span className="@max-[320px]:hidden">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-64 p-3">
        <ComposerMcpSection
          sessionId={sessionId}
          loading={loading}
          onOpenSettingsMcp={() => {
            setOpen(false);
            onOpenSettingsMcp();
          }}
          registry={registry}
          pendingMcpServers={pendingMcpServers}
          onPendingMcpServersChange={onPendingMcpServersChange}
        />
      </PopoverContent>
    </Popover>
  );
}
