import { FormattedMessage, useIntl } from "react-intl";
import { SquareArrowOutUpRight, X } from "lucide-react";

import type { SkillEntry } from "../../types/skills";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { DialogHeaderButton } from "./settings-chrome";
import { AcquiredLabel } from "./SkillRow";

/** The row's read-only detail dialog (issue #1033's row-click face): the
 *  name header, the description / scope / status metadata, and the SKILL.md
 *  path bar. There is no form here -- creation rides the conversation
 *  channel and edits happen in the external editor the path link opens, so
 *  this dialog only SHOWS the skill and points at where it lives. */
type SkillDetailDialogProps = {
  skill: SkillEntry;
  /** The absolute SKILL.md path the path bar links; null before a local
   *  row's registry root resolved, or when a linked row's link target is
   *  unreadable (the link then stays disabled). */
  file: string | null;
  /** The local-row face when the registry root failed to resolve (issue
   *  #1039); null on every other row and phase. */
  pathUnavailable: string | null;
  /** The open-file failure's dialog-level face (null = no error shown). */
  error: string | null;
  onClose: () => void;
  /** Open the SKILL.md file in the OS default editor. */
  onOpenFile: () => void;
};

export function SkillDetailDialog({
  skill,
  file,
  pathUnavailable,
  error,
  onClose,
  onOpenFile,
}: SkillDetailDialogProps) {
  const intl = useIntl();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      {/* The default header X is the sole dismissal chrome; ESC and the
          overlay click still close via Radix. */}
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          {/* The close chrome matches the sibling import dialog: the
              DialogHeaderButton ghost in the header row, not the floating
              corner X (the #964 dialog-action posture). */}
          <div className="flex items-center justify-between gap-2">
            <DialogTitle>{skill.name}</DialogTitle>
            <DialogHeaderButton
              label={intl.formatMessage({
                id: "common.close",
                defaultMessage: "Close",
              })}
              icon={X}
              onClick={onClose}
            />
          </div>
        </DialogHeader>
        <div className="grid gap-5">
          <div className="grid gap-1.5">
            <p className="text-foreground text-sm">
              <FormattedMessage
                id="common.description"
                defaultMessage="Description"
              />
            </p>
            <DialogDescription className="text-sm leading-relaxed">
              {skill.description}
            </DialogDescription>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <p className="text-foreground text-sm">
                <FormattedMessage
                  id="settings.skills.sourceLabel"
                  defaultMessage="Source"
                />
              </p>
              <p className="text-muted-foreground text-sm">
                <AcquiredLabel acquired={skill.acquired} />
              </p>
            </div>
            <div className="grid gap-1.5">
              <p className="text-foreground text-sm">
                <FormattedMessage
                  id="settings.skills.statusLabel"
                  defaultMessage="Status"
                />
              </p>
              <p className="text-muted-foreground text-sm">
                {skill.enabled ? (
                  <FormattedMessage
                    id="settings.skills.statusEnabled"
                    defaultMessage="Enabled"
                  />
                ) : (
                  <FormattedMessage
                    id="settings.skills.statusDisabled"
                    defaultMessage="Disabled"
                  />
                )}
              </p>
            </div>
          </div>
          <div className="grid gap-1.5">
            <p className="text-foreground text-sm">
              <FormattedMessage
                id="settings.skills.pathLabel"
                defaultMessage="File path"
              />
            </p>
            {/* The path is the open-file link (the direct-edit channel):
                hover underlines it, click opens SKILL.md in the OS default
                editor; the glyph rides inline as the affordance. */}
            <button
              type="button"
              onClick={onOpenFile}
              disabled={!file}
              aria-label={intl.formatMessage(
                {
                  id: "settings.skills.openFile",
                  defaultMessage: "Open file {path}",
                },
                { path: file ?? "" },
              )}
              className="text-muted-foreground hover:text-foreground w-fit max-w-full text-left font-mono text-xs underline-offset-2 hover:underline disabled:pointer-events-none disabled:opacity-50"
            >
              <span className="break-all">{file}</span>
              <SquareArrowOutUpRight
                className="ml-1.5 inline-block size-3.5 align-text-bottom"
                aria-hidden
              />
            </button>
            {/* One error line for the path area's two failure faces,
                mutually exclusive: the failed root fetch (issue #1039)
                shows only while the link above is inert, the open failure
                only after a click on a resolved link. */}
            {(pathUnavailable ?? error) && (
              <p className="text-destructive text-xs" role="alert">
                {pathUnavailable ?? error}
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
