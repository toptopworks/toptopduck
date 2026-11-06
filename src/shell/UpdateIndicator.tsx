import { useIntl } from "react-intl";
import { ArrowUpCircle } from "lucide-react";

import { useUpdateAvailable } from "./useUpdateCheck";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";

// The topbar ghost family posture (NavButtons' NAV_BUTTON_CLASS shape):
// 28px hit area + 14px glyph, muted foreground lifting on hover, ring focus.
// The single source for THIS button so it cannot drift from the family.
const INDICATOR_BUTTON_CLASS =
  "inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** The standalone topbar update indicator (ADR-0143, issue #1509): an
 *  independent topbar icon that renders ONLY while the shared update-check
 *  cache carries an update -- self-showing on discovery, self-hiding the
 *  moment the cache reads null, no dismiss state, no badge on any other
 *  control. Update availability is a PERSISTENT state, so the indicator
 *  lives on shell chrome that exists in every view (workspace, cold start,
 *  settings overlay) -- never inside a per-session surface, which cold start
 *  does not render. The tooltip names the target version; the click opens
 *  Settings on the About pane, where the update block (state machine +
 *  notes) lives. Chrome follows the topbar ghost family (the NavButtons
 *  posture: 28px hit area, text-foreground/70, accent hover, ring focus);
 *  the glyph alone carries the status accent (text-primary). */
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
        <button
          type="button"
          className={INDICATOR_BUTTON_CLASS}
          aria-label={label}
          onClick={onOpenSettings}
        >
          <ArrowUpCircle className="text-primary size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
