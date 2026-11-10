// Shared memory-list pieces (issues #1529/#1531): the row + badge the
// workspace memory panel and the settings user-memory pane both render --
// one implementation so the two surfaces read as one family. Row content is
// the same shape the built-in engine's injection block carries (title +
// category badge + hook); reveal-in-folder opens the OS file manager on the
// memory file. The non-component list tokens live in memory-list.ts
// (react-refresh: a component file only exports components).

import { FormattedMessage, useIntl } from "react-intl";
import { FolderSearch } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { Badge } from "../ui/badge";
import { HeaderActionButton } from "../settings/settings-chrome";
import { log } from "../../lib/log";
import type { ListedMemory, MemoryType } from "../../types/workspace-memory";

/** The category badge: four STATIC branches (the i18n catalog guard reads
 * literal ids at call sites -- a dynamically built id would be invisible
 * to the check). */
function TypeBadge({ type }: { type: MemoryType }) {
  return (
    <Badge variant="secondary" className="shrink-0">
      {type === "user" ? (
        <FormattedMessage id="workspace.memory.type.user" defaultMessage="user" />
      ) : type === "feedback" ? (
        <FormattedMessage id="workspace.memory.type.feedback" defaultMessage="feedback" />
      ) : type === "project" ? (
        <FormattedMessage id="workspace.memory.type.project" defaultMessage="project" />
      ) : (
        <FormattedMessage id="workspace.memory.type.reference" defaultMessage="reference" />
      )}
    </Badge>
  );
}

/** One read-only memory row: title + category badge + hook + the reveal
 * button (the row's only action). */
export function MemoryRow({ memory }: { memory: ListedMemory }) {
  const intl = useIntl();
  const revealLabel = intl.formatMessage({
    id: "workspace.memory.reveal",
    defaultMessage: "Reveal in folder",
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
      </div>
      <HeaderActionButton
        label={revealLabel}
        icon={FolderSearch}
        // The opener can refuse (a file deleted after the listing): log it
        // -- the ArtifactHeader posture (the action is simply retryable).
        onClick={() =>
          revealItemInDir(memory.file_path).catch((e: unknown) =>
            log.warn("MemoryRow", "revealItemInDir failed", e),
          )}
      />
    </li>
  );
}
