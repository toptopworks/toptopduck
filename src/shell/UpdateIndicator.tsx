import { useIntl } from "react-intl";
import { ArrowUpCircle } from "lucide-react";

import { useUpdateAvailable } from "./useUpdateCheck";
import { Button } from "../components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";

/** The standalone update indicator (ADR-0143, issue #1509): an independent
 *  topbar icon that renders ONLY while the shared update-check cache carries
 *  an update -- self-showing on discovery, self-hiding the moment the cache
 *  reads null, no dismiss state, no badge on any other control. Update
 *  availability is a PERSISTENT state, so the indicator lives on shell chrome
 *  that exists in every view (workspace, cold start, settings overlay) --
 *  never inside a per-session surface, which cold start does not render.
 *  The tooltip names the target version; the click opens Settings on the
 *  General pane, where the update block (state machine + notes) lives. */
export function UpdateIndicator({ onOpenSettings }: { onOpenSettings: () => void }) {
  const intl = useIntl();
  const update = useUpdateAvailable();
  if (update === null) return null;
  const label = intl.formatMessage(
    {
      id: "header.updateAvailable.ariaLabel",
      defaultMessage: "New version {version} available",
    },
    { version: update.version },
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-primary h-7 w-7"
          aria-label={label}
          onClick={onOpenSettings}
        >
          <ArrowUpCircle className="size-4" aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
