import { useIntl } from "react-intl";
import { ArrowUpCircle } from "lucide-react";

import { useStartupUpdateCheck, useUpdateAvailable } from "./useUpdateCheck";
import { useUpdateInstall } from "./useUpdateInstall";
import { UpdateConfirmDialog } from "./UpdateConfirmDialog";
import { Button } from "../components/ui/button";
import { toast } from "../components/ui/use-toast";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";

/** The sidebar-footer update indicator (ADR-0143, issue #1509): an
 *  independent icon that renders ONLY while the shared update-check cache
 *  carries an update -- self-showing on discovery, self-hiding the moment the
 *  cache reads null, no dismiss state, no badge on any other control. Update
 *  availability is a PERSISTENT state, so the indicator lives on shell chrome
 *  that stays mounted in every view -- the sidebar footer beside the settings
 *  gear, which persists across workspace, cold start, and the settings
 *  overlay (the settings-mode CSS hides the sidebar with display:none but
 *  never unmounts it).
 *  The click installs DIRECTLY (the active-turn confirm gates it when tasks
 *  are in flight); the in-flight feedback is the install overlay's job
 *  (UpdateInstallOverlay), an install failure lands as a destructive toast,
 *  and the shared install slice disables this button while one runs. Chrome
 *  follows the footer family (the gear's ghost icon Button posture); the
 *  glyph alone carries the status accent (text-primary).
 *
 *  This component also OWNS the startup auto-check mount (ADR-0143 Decision
 *  4): App's body sits above the QueryClientProvider, so the check hook must
 *  live in a component inside the provider -- and this is the one update-face
 *  component that rides the sidebar footer, mounted for the rest of the
 *  process once app-config resolves it (the staleTime:Infinity slice makes
 *  any transient remount a no-op, so the 1s delayed check is effectively
 *  once per process). */
export function UpdateIndicator() {
  const intl = useIntl();
  useStartupUpdateCheck();
  const update = useUpdateAvailable();
  const { installing, confirmOpen, setConfirmOpen, requestInstall, startInstall } =
    useUpdateInstall((message) => {
      toast({
        variant: "destructive",
        title: intl.formatMessage({
          id: "settings.update.installFailedToast",
          defaultMessage: "Update failed",
        }),
        description: message,
      });
    });

  if (update === null) return null;

  const label = intl.formatMessage(
    {
      id: "header.updateAvailable.ariaLabel",
      defaultMessage: "New version {version} available",
    },
    { version: update.version },
  );

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={label}
            disabled={installing}
            onClick={() => void requestInstall()}
          >
            <ArrowUpCircle className="text-primary size-4" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <UpdateConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={() => void startInstall()}
      />
    </>
  );
}
