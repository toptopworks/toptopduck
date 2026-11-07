import { FormattedMessage } from "react-intl";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";

/** The active-turn confirm (ADR-0143 Decision 5, issue #1509): shown before
 *  an install that would interrupt in-progress tasks. Pure presentation --
 *  the gate + open state live in `useUpdateInstall`, and every update face
 *  (the sidebar indicator's direct install, the About block's button) mounts
 *  this same dialog so the interruption warning reads identically from
 *  wherever the update was started. */
export function UpdateConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <FormattedMessage
              id="settings.update.confirmTitle"
              defaultMessage="Update now?"
            />
          </AlertDialogTitle>
          <AlertDialogDescription>
            <FormattedMessage
              id="settings.update.confirmBody"
              defaultMessage="In-progress tasks will be interrupted. The app restarts when the update finishes."
            />
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
          </AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            <FormattedMessage
              id="settings.update.confirmOk"
              defaultMessage="Update and restart"
            />
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
