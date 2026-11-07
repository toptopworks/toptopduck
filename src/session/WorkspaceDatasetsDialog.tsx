// The workspace dataset management panel (ADR-0141 D4): a modal off the
// sidebar's workspace-section menu -- list, browse-to-add, replace, rename,
// delete, privacy. Visibility follows the workspace, not any session: the
// panel owns the manifest; bound sessions read it live on their next turn.
// The form mirrors the working-set tab's master/detail shell (issue #1475):
// the list reuses WorkingSetList (no active pointer), the detail reuses the
// pure DatasetDetail renderer, and the preview is the manifest's frozen
// sample -- zero new read IPC.
//
// This component is the consumer shell (#1519): the actions, the batch
// feedback machine, and the flight/pending facts all live in the
// useWorkspaceDatasets seam -- what renders here is the module's read
// snapshot plus the action wiring, no mutation or batch state machine.
//
// Copy never says "shared": the panel is this workspace's datasets (the
// dual-name label is user-renamable, the reference name stays the SQL and
// injection anchor). Code and i18n keys keep the workspace.datasets
// namespace.

import { Check, Loader2, Upload, X } from "lucide-react";
import type { ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { DatasetDetail, type DatasetSamplePage } from "../components/dataset/DatasetDetail";
import { ElapsedFace } from "../components/thread/ElapsedFace";
import { WaitElapsedSuffix } from "../components/thread/WaitElapsedSuffix";
import { describeError } from "../lib/error-presentation";
import { WorkingSetList } from "../components/dataset/WorkingSetList";
import type { DatasetDescriptor } from "../types/dataset";
import { useWorkspaceDatasets } from "./useWorkspaceDatasets";
import type { WorkspaceTarget } from "./useWorkspaceDatasets";
import type { ListedWorkspaceDataset } from "../types/workspace-datasets";

interface WorkspaceDatasetsDialogProps {
  workspace: WorkspaceTarget | null;
  onOpenChange: (open: boolean) => void;
}

// The master/detail sections' card chrome -- the working-set tab's
// PANEL_CARD_BASE form (bg-card + border + rounded + shadow + padding), so
// the two management faces read as one family.
const PANEL_CARD_BASE = "panel bg-card border rounded-lg shadow-sm p-4";

// A manifest entry onto the detail renderer's descriptor: the label comes
// from the manifest, the shared format has no rectify step, and a shared
// attach is never stale (staleness is a session-side result concept). The
// fingerprint is the store key (the source bytes' SHA256).
function toDescriptor(d: ListedWorkspaceDataset): DatasetDescriptor {
  return {
    reference_name: d.reference_name,
    display_name: d.display_name,
    source_path: d.source_path,
    columns: d.columns,
    row_count: d.row_count,
    sample: d.sample,
    fingerprint: d.fingerprint,
    size_bytes: d.size_bytes,
    rectify: { kind: "NotApplicable" },
    privacy: d.privacy,
  };
}

export function WorkspaceDatasetsDialog({ workspace, onOpenChange }: WorkspaceDatasetsDialogProps) {
  const intl = useIntl();
  const open = workspace !== null;
  // The seam owns the mutations, the batch machine, and the pending facts;
  // the panel reads the snapshot and wires the actions.
  const ds = useWorkspaceDatasets(workspace);
  const panel = ds.panel;
  const rows = ds.rows;
  // The missing-store-file set flags rows in the list and arms the detail's
  // warning line (the honesty posture, ADR-0141 D8: flagged, not hidden).
  const missingNames = ds.missingNames;
  const shown = ds.shown;

  // The list row's extra marker: a missing store file badges the row
  // (destructive -- the honest flag), the detail carries the long sentence.
  const badgeFor = (d: DatasetDescriptor): ReactNode =>
    missingNames.has(d.reference_name) ? (
      <Badge variant="destructive" className="ml-2">
        <FormattedMessage id="workspace.datasets.missingBadge" defaultMessage="Missing" />
      </Badge>
    ) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The header, the add row and the error banners stay fixed; only the
          dataset management area scrolls (the working-set tab's posture:
          chrome pinned, content scrolls). min-h-0 is what lets the flex-1
          scroll region actually shrink inside the max-h dialog. */}
      {/* No auto-focus on open: Radix would land it on the first focusable
          (the add button), lighting it up before any interaction. Focus
          stays with the opener; Tab still enters the dialog. Same posture
          as ComposerWorkspacePicker. */}
      <DialogContent
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="flex max-h-[80vh] flex-col overflow-hidden sm:max-w-4xl"
      >
        <DialogHeader>
          <DialogTitle>
            <FormattedMessage
              id="workspace.datasets.title"
              defaultMessage="Datasets — {workspace}"
              values={{ workspace: panel?.label ?? "" }}
            />
          </DialogTitle>
          <DialogDescription>
            <FormattedMessage
              id="workspace.datasets.description"
              defaultMessage="Datasets in this workspace are available to every session bound to it — a session picks them up automatically the first time a query mentions them."
            />
          </DialogDescription>
        </DialogHeader>

        <div className="flex h-8 items-center gap-3">
          {ds.badge !== null ? (
            ds.badge.phase === "running" ? (
              // The running badge (issue #1485): the picker's per-file
              // progress as a chip -- the same content model the rail's
              // ingest block carries, down to its elapsed-suffix clock.
              // No dismiss while running: closing a live badge is exactly
              // the vanished-state bug (#1488).
              <Badge variant="secondary" className="min-w-0 shrink max-w-full" role="status">
                <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                <span className="truncate">
                  {ds.badge.mode === "add" ? (
                    <FormattedMessage
                      id="workspace.datasets.adding"
                      defaultMessage="Adding {name} (file {index} of {total})…"
                      values={{ name: ds.badge.name, index: ds.badge.index, total: ds.badge.total }}
                    />
                  ) : (
                    <FormattedMessage
                      id="workspace.datasets.replacing"
                      defaultMessage="Replacing {name}…"
                      values={{ name: ds.badge.name }}
                    />
                  )}
                </span>
                <WaitElapsedSuffix startedAt={ds.badge.startedAt} />
              </Badge>
            ) : (
              // The done badge: ✓ + the landed label + the FROZEN total
              // duration. It parks until dismissed (or the next upload /
              // a reopen overwrites it) -- a replace lands with no other
              // visible trace (same row, same label), so this is the
              // operation's only success face.
              <Badge variant="secondary" className="min-w-0 shrink max-w-full gap-1.5 pr-1">
                <Check aria-hidden />
                <span className="truncate">
                  {ds.badge.mode === "add" ? (
                    <FormattedMessage
                      id="workspace.datasets.addDone"
                      defaultMessage="Added {name}"
                      values={{ name: ds.badge.name }}
                    />
                  ) : (
                    <FormattedMessage
                      id="workspace.datasets.replaceDone"
                      defaultMessage="Replaced {name}"
                      values={{ name: ds.badge.name }}
                    />
                  )}
                </span>
                <ElapsedFace seconds={ds.badge.seconds} />
                {/* The dismiss rides the Button copy-in (the #1488 review
                    round's two judgement calls): ghost's accent hover + the shared
                    focus-visible ring, at a 20px target (16px was the
                    panel's smallest pointer target). */}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="ml-0.5 size-5 rounded-full"
                  aria-label={intl.formatMessage({ id: "common.close" })}
                  onClick={ds.dismissBadge}
                >
                  <X className="size-3" aria-hidden />
                </Button>
              </Badge>
            )
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            disabled={ds.badge?.phase === "running"}
            onClick={() => void ds.pickAndAdd()}
          >
            {/* The idle face only -- the running badge to the left owns the
                in-flight signal; the button just disables (the same
                replace-window posture). */}
            <Upload className="h-4 w-4" aria-hidden />
            <FormattedMessage id="workspace.datasets.add" defaultMessage="Add dataset…" />
          </Button>
        </div>

        {ds.error !== null && (
          <p className="text-destructive text-sm" role="alert">
            {ds.error}
          </p>
        )}
        {ds.listingError != null && (
          <p className="text-destructive text-sm" role="alert">
            {describeError(ds.listingError, intl)}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* A failed listing renders neither face (the banner above is the
              face): the empty card would assert an empty workspace the
              listing never established, and invite an Add it would refuse. */}
          {ds.listingError != null ? null : rows.length === 0 && !ds.listingPending ? (
          // The empty set renders ONE card (the working-set tab's empty
          // form, issue #792): the two-column shell never mounts empty. The
          // header's add button is the only entry (a second button in the
          // card would duplicate it); the centered copy rides a floor
          // height so the card reads as an intentional resting face.
            <section className={`${PANEL_CARD_BASE} flex min-h-64 items-center justify-center`}>
              <p className="text-muted-foreground m-0 text-center">
                <FormattedMessage
                  id="workspace.datasets.empty"
                  defaultMessage="No datasets yet — click Add dataset to import a data file."
                />
              </p>
            </section>
          ) : !ds.listingPending ? (
            <div className="layout working-set-layout">
              <section className={PANEL_CARD_BASE}>
                <h2 className="text-base font-semibold">
                  <FormattedMessage
                    id="workspace.datasets.listHeading"
                    defaultMessage="Datasets · {count}"
                    values={{ count: rows.length }}
                  />
                </h2>
                <WorkingSetList
                  datasets={rows.map(toDescriptor)}
                  activeName={null}
                  selectedName={ds.resolvedName}
                  onSelect={ds.select}
                  onRename={ds.rename}
                  onReplace={ds.replace}
                  onDelete={ds.remove}
                  onPickError={(e: unknown) => ds.setError(describeError(e, intl))}
                  badgeFor={badgeFor}
                  deleteTitleFor={(name) => (
                    <FormattedMessage
                      id="workspace.datasets.delete.confirm"
                      defaultMessage="Remove {name} from this workspace?"
                      values={{ name }}
                    />
                  )}
                  loading={ds.busy}
                />
              </section>
              <section className={PANEL_CARD_BASE}>
                {shown !== null && (
                  <>
                    {shown.file_missing && (
                    // The detail's honest warning (the list row carries the
                    // short badge): the entry renders in full -- meta, schema,
                    // frozen sample, privacy -- and the failure is named.
                      <p
                        className="text-destructive mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
                        role="alert"
                      >
                        <FormattedMessage
                          id="workspace.datasets.detailMissing"
                          defaultMessage="The dataset's underlying file is missing — SQL referencing it will fail until it is re-added or replaced."
                        />
                      </p>
                    )}
                    <DatasetDetail
                      dataset={toDescriptor(shown)}
                      sample={
                      {
                        columns: shown.columns,
                        rows: shown.sample,
                      } satisfies DatasetSamplePage
                      }
                      sampleLoading={false}
                      sampleError={null}
                      loading={ds.privacyBusy}
                      onPrivacyChange={ds.setPrivacy}
                    />
                  </>
                )}
              </section>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
