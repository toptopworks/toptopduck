import { useState } from "react";
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
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button-variants";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// The session dialogs shared by the two row/menu hosts (SessionHeaderMenu and
// the sidebar's RowActionsMenu): Rename + Delete live in one module so both
// menu species import from a neutral home (issue #1325).

// Strong-confirm delete dialog (ADR-0060, issue #81): deletion is irreversible,
// so the dialog names the recipe.json explicitly and requires an explicit confirm.
// The shell is a Radix AlertDialog (issue #105): role="alertdialog" + focus-trap
// + scroll-lock come from the primitive. AlertDialog blocks overlay-click
// dismiss by default (destructive guard -- a stray pointer-down cannot drop the
// session). ESC routes to onCancel via onEscapeKeyDown, NOT onOpenChange:
// AlertDialogAction's built-in auto-close fires onOpenChange(false) after a
// confirm click, so an onOpenChange-to-onCancel bridge would invoke cancel on
// every Delete; onEscapeKeyDown isolates the keyboard-cancel path, leaving the
// Cancel/Action button routing (and their Radix auto-close) untouched. Cancel
// renders before Action so Radix auto-focuses it (the safe escape). The
// destructive Action passes buttonVariants({ variant: "destructive" }); twMerge
// (in cn) lets it override AlertDialogAction's built-in default variant, reusing
// the destructive look without forking the copy-in component.
// Exported for component-level testing (issue #111); the dialog is rendered
// by SessionHeaderMenu and by the sidebar's row actions menu (ADR-0133, issue
// #1319), but the destructive-semantics + ESC routing contract is verified in
// isolation.
export function DeleteSessionDialog({
  name,
  onCancel,
  onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog defaultOpen>
      <AlertDialogContent onEscapeKeyDown={() => onCancel()}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <FormattedMessage id="session.delete.title" defaultMessage="Delete this session?" />
          </AlertDialogTitle>
          <AlertDialogDescription>
            <FormattedMessage
              id="session.delete.body"
              defaultMessage="“{name}” will be permanently deleted. This cannot be undone."
              values={{ name }}
            />
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>
            <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
          </AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            onClick={onConfirm}
          >
            <FormattedMessage id="session.delete.confirm" defaultMessage="Delete permanently" />
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Rename dialog (ADR-0060, single entry point). Pre-fills the current name (or
// empty for a never-saved session); blank submit is refused (Save disabled).
// The shell is now a Radix Dialog (issue #105): portal + focus-trap +
// scroll-lock + ESC + overlay-click dismiss come from the primitive, replacing
// the hand-written overlay div. showCloseButton={false} lets Radix auto-focus
// the Input (preserving the prior input autoFocus); ESC / overlay-click route
// to onCancel via onOpenChange. The Input + Label are copy-in primitives
// (ADR-0050: standard surface uses shadcn primitives). aria-describedby={undefined}
// opts out of a Description (the visible Label already names the field), which
// also silences Radix's missing-description warning.
// Exported for component-level testing (issue #111); the dialog is rendered
// by SessionHeaderMenu and by the sidebar's row actions menu (ADR-0133, issue
// #1319), but the onOpenChange-to-onCancel bridge + blank guard are verified
// in isolation.
export function RenameSessionDialog({
  initialName,
  onCancel,
  onSubmit,
}: {
  initialName: string;
  onCancel: () => void;
  onSubmit: (newName: string) => void;
}) {
  const [value, setValue] = useState(initialName);
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent showCloseButton={false} aria-describedby={undefined}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) onSubmit(value);
          }}
          className="grid gap-4"
        >
          <DialogTitle>
            <FormattedMessage id="session.rename.title" defaultMessage="Rename session" />
          </DialogTitle>
          <div className="grid gap-2">
            <Label htmlFor="rename-session-input">
              <FormattedMessage id="session.rename.label" defaultMessage="Session name" />
            </Label>
            <Input
              id="rename-session-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={onCancel}>
              <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
            </Button>
            <Button type="submit" disabled={!value.trim()}>
              <FormattedMessage id="common.save" defaultMessage="Save" />
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
