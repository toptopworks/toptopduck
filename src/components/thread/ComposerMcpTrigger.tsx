import { useState } from "react";
import { useIntl } from "react-intl";
import { useQuery } from "@tanstack/react-query";
import { Cable } from "lucide-react";

import { listMcpServerStatus } from "../../api";
import { sessionKeys } from "../../session/queryKeys";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ComposerMcpSection } from "./ComposerMcpSection";

// The MCP trigger chip, rendered in the QuestionBar container's top row
// (SessionPane header slot). Shows the cable icon + enabled/total count.
// Click opens a popover with the search + checkbox list + add-server footer.
// The count query shares its cache key with ComposerMcpSection.

export type ComposerMcpTriggerProps = {
  sessionId: string;
  loading: boolean;
  onOpenSettingsMcp: () => void;
};

const CHIP_CLASS =
  "composer-mcp-trigger inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted cursor-pointer";

export function ComposerMcpTrigger({
  sessionId,
  loading,
  onOpenSettingsMcp,
}: ComposerMcpTriggerProps) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);

  const { data: mcpStatus } = useQuery({
    queryKey: sessionKeys.mcpStatus(sessionId),
    queryFn: () => listMcpServerStatus(sessionId),
  });

  const enabledCount = (mcpStatus ?? []).filter((s) => s.enabled).length;
  const totalCount = (mcpStatus ?? []).length;
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
        />
      </PopoverContent>
    </Popover>
  );
}
