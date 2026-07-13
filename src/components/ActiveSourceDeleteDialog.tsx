import { useState } from "react";
import type { DatasetDescriptor } from "../types";
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

// Issue #39 / ADR-0035 confirm dialog: shown when the user removes the ACTIVE
// source while OTHER sources remain. Removing the active source would silently
// move the user's focus -- instead the user explicitly picks one of the
// remaining sources to continue with, or cancels (no IPC call, no change).
//
// `candidates` is the FULL remaining source set (AC5: every source but the one
// being removed). Exactly one must be chosen before Confirm is enabled; the
// first candidate is pre-selected so a single Confirm suffices for the common
// case (the user already chose to delete; picking a continuation is the path of
// least resistance, and they can re-pick any other). A Cancel is a no-op --
// nothing crosses IPC and the working set stays put (AC3).
//
// The shell is now a Radix AlertDialog (issue #105): role="alertdialog" +
// focus-trap + scroll-lock come from the primitive. AlertDialog semantics
// (destructive confirm) intentionally do NOT dismiss on ESC or overlay click --
// the user must take an explicit 中止 / 继续 action, so the hand-written window
// ESC listener is gone. The candidate list keeps native radios (the issue scope
// is the AlertDialog shell, not a form-control sweep; native radios keep
// toBeChecked reliable in the tests). defaultOpen keeps this uncontrolled: the
// parent mounts/unmounts via pendingActiveDelete. AlertDialogCancel owns its
// close (dismiss = cancel); AlertDialogAction preventDefault-defers close so
// the parent's async remove decides unmount on success (a failure leaves it
// open for retry), so no onOpenChange double-routing is needed.
export function ActiveSourceDeleteDialog({
  target,
  candidates,
  onConfirm,
  onCancel,
}: {
  target: DatasetDescriptor;
  candidates: DatasetDescriptor[];
  onConfirm: (continueWith: string) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState(candidates[0]?.reference_name ?? "");

  return (
    <AlertDialog defaultOpen>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除焦点源「{target.display_name}」</AlertDialogTitle>
          <AlertDialogDescription>
            此源是当前焦点表。删除后请在剩余源中选一个继续分析（或中止，工作集保持不变）。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="dialog-list">
          {candidates.map((d) => (
            <li key={d.reference_name}>
              <label>
                <input
                  type="radio"
                  name="active-delete-continue-with"
                  value={d.reference_name}
                  checked={selected === d.reference_name}
                  onChange={() => setSelected(d.reference_name)}
                />
                {d.display_name}
              </label>
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>中止</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              if (selected) {
                // AlertDialogAction auto-closes on click (Radix
                // composeEventHandlers). preventDefault defers close so the
                // parent's async remove decides unmount -- a failure leaves
                // the dialog open for retry (useSessionState contract).
                e.preventDefault();
                onConfirm(selected);
              }
            }}
            disabled={!selected}
          >
            继续
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
