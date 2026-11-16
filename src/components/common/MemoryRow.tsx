// Shared memory-list pieces (issues #1529/#1531/#1591): the row + badge the
// workspace memory panel and the settings user-memory pane both render --
// one implementation so the two surfaces read as one family. Row content is
// the same shape the built-in engine's injection block carries (title +
// category badge + hook). The row's actions: open the memory file in the
// system editor (the editing surface -- any editor, the #1540 ruling; the
// folder stays reachable at the panel's header), and when the host passes
// a callback, delete (workspace-layer only -- the user layer is
// hand-written files, #1531 D4). The non-component list tokens live in
// memory-list.ts (react-refresh: a component file only exports components).

import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { FilePenLine, Trash2 } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";

import { Badge } from "../ui/badge";
import { RowActionButton } from "../settings/settings-chrome";
import { log } from "../../lib/log";
import { describeError } from "../../lib/error-presentation";
import type { ListedMemory, MemoryType } from "../../types/workspace-memory";

/** The category badge: four STATIC branches (the i18n catalog guard reads
 * literal ids at call sites -- a dynamically built id would be invisible
 * to the check). */
function TypeBadge({ type }: { type: MemoryType }) {
  return (
    <Badge variant="secondary" className="shrink-0">
      {type === "user" ? (
        <FormattedMessage id="workspace.memory.type.user" defaultMessage="User" />
      ) : type === "feedback" ? (
        <FormattedMessage id="workspace.memory.type.feedback" defaultMessage="Feedback" />
      ) : type === "project" ? (
        <FormattedMessage id="workspace.memory.type.project" defaultMessage="Project" />
      ) : (
        <FormattedMessage id="workspace.memory.type.reference" defaultMessage="Reference" />
      )}
    </Badge>
  );
}

/** One memory row: title + category badge + hook + the row actions (open
 * in the system editor, and delete when the host supplies the callback --
 * the confirm lives with the host, which owns the workspace scope). */
export function MemoryRow({
  memory,
  onDelete,
}: {
  memory: ListedMemory;
  onDelete?: (memory: ListedMemory) => void;
}) {
  const intl = useIntl();
  // A refused file open (#1543): the opener can refuse (a file deleted
  // after the listing). Row-local state -- the two hosts (the workspace
  // panel and the settings pane) get the same face by construction, and a
  // successful retry clears it.
  const [openFailure, setOpenFailure] = useState<string | null>(null);
  const openLabel = intl.formatMessage({
    id: "workspace.memory.open",
    defaultMessage: "Open",
  });
  const deleteLabel = intl.formatMessage({
    id: "common.delete",
    defaultMessage: "Delete",
  });
  return (
    <li className="flex items-start gap-2 border-b border-border py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{memory.title}</span>
          <TypeBadge type={memory.type} />
        </div>
        {memory.hook.length > 0 && (
          <p className="m-0 truncate text-xs text-muted-foreground" title={memory.hook}>
            {memory.hook}
          </p>
        )}
        {openFailure !== null && (
          <p className="m-0 text-xs text-destructive" role="alert">
            {openFailure}
          </p>
        )}
      </div>
      <RowActionButton
        label={openLabel}
        icon={FilePenLine}
        onClick={() => {
          openPath(memory.file_path)
            .then(() => setOpenFailure(null))
            .catch((e: unknown) => {
              log.warn("MemoryRow", "open memory file failed", e);
              setOpenFailure(describeError(e, intl));
            });
        }}
      />
      {onDelete !== undefined && (
        // Delete rides the row-action family's destructive hover (the
        // #958 convention: Delete hovers red, the rest to foreground).
        <RowActionButton
          label={deleteLabel}
          icon={Trash2}
          destructive
          onClick={() => onDelete(memory)}
        />
      )}
    </li>
  );
}
