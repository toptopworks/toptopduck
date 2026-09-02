import { useState } from "react";
import { useIntl, FormattedMessage } from "react-intl";
import { Download, MoreHorizontal, Pencil, Trash2, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DeleteSessionDialog, RenameSessionDialog } from "./SessionSidebar";
import { resolveDisplayName } from "./displayName";

// Session-header context menu (ADR-0093, issue #512). The management actions
// that previously lived in the sidebar row's context menu (Rename / Save a
// copy / Close / Delete) now live here as session-scoped chrome alongside the
// workspace toggle. The `⋯` trigger mirrors the WorkspaceToggle's ghost-icon
// button rule (ADR-0067 #171: h-7 w-7 button + text-foreground/70; the dots
// glyph uses h-3.5 w-3.5 to match WorkspaceToggle's icon visual weight --
// issue #774: one 28px hit-area spec across the header chrome family).
//
// Rename + Delete open local dialog state (the existing RenameSessionDialog /
// DeleteSessionDialog exported from SessionSidebar); Export + Close fire the
// shell callbacks directly (no dialog needed — Export opens a native save
// dialog via the backend, Close is immediate).

type SessionHeaderMenuProps = {
  /** Raw session name for the rename dialog prefill; resolveDisplayName derives
   *  the display name for export + delete confirmation. */
  sessionName: string;
  /** The bound `.duck` path (ADR-0089: always present since createSession). */
  duckPath: string;
  /** Runtime session id (for close / rename / delete callbacks). */
  sessionId: string;
  /** Shell callback: rename this session's entry. */
  onRename: (sessionId: string, duckPath: string, newName: string) => void;
  /** Shell callback: export a copy of the session directory. */
  onExport: (duckPath: string, displayName: string) => void;
  /** Shell callback: close this session (fires cancel + cleanup). */
  onClose: (sessionId: string) => void;
  /** Shell callback: delete this session permanently. */
  onDelete: (duckPath: string, sessionId: string) => void;
  /** Shell-wide busy gate: disables the trigger during persistence / resume
   *  operations, matching the sidebar's disabled={busy} contract (H1 fix). */
  disabled?: boolean;
};

export function SessionHeaderMenu({
  sessionName,
  duckPath,
  sessionId,
  onRename,
  onExport,
  onClose,
  onDelete,
  disabled = false,
}: SessionHeaderMenuProps) {
  const intl = useIntl();
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);

  const displayName = resolveDisplayName(sessionName, intl);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          // Mirrors WorkspaceToggle's ghost-icon rule (ADR-0067 #171).
          disabled={disabled}
          className="session-header-menu inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-label={intl.formatMessage({
            id: "session.headerMenu.ariaLabel",
            defaultMessage: "Session actions",
          })}
        >
          <MoreHorizontal className="h-3.5 w-3.5" aria-hidden strokeWidth={2.5} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          aria-label={intl.formatMessage({
            id: "session.headerMenu.ariaLabel",
            defaultMessage: "Session actions",
          })}
        >
          <DropdownMenuItem onSelect={() => setDialog("rename")}>
            <Pencil aria-hidden />
            <FormattedMessage
              id="session.headerMenu.rename"
              defaultMessage="Rename"
            />
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => onExport(duckPath, displayName)}
          >
            <Download aria-hidden />
            <FormattedMessage
              id="session.headerMenu.export"
              defaultMessage="Save a copy…"
            />
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onClose(sessionId)}>
            <X aria-hidden />
            <FormattedMessage
              id="common.close"
              defaultMessage="Close"
            />
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setDialog("delete")}
          >
            <Trash2 aria-hidden />
            <FormattedMessage
              id="common.delete"
              defaultMessage="Delete"
            />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog === "rename" && (
        <RenameSessionDialog
          initialName={sessionName}
          onCancel={() => setDialog(null)}
          onSubmit={(newName) => {
            setDialog(null);
            onRename(sessionId, duckPath, newName);
          }}
        />
      )}
      {dialog === "delete" && (
        <DeleteSessionDialog
          name={displayName}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            onDelete(duckPath, sessionId);
          }}
        />
      )}
    </>
  );
}
