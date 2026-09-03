import { useState } from "react";
import { FormattedMessage } from "react-intl";
import { WorkingSetList } from "./WorkingSetList";
import { WorkingSetEmptyState } from "./WorkingSetEmptyState";
import { DatasetDetail } from "./DatasetDetail";
import { resolveWorkingSetDetail } from "../../session/workspace";
import type { DatasetDescriptor, DatasetPrivacy } from "../../types/dataset";

// The "工作集" tab (ADR-0045): source management -- rename / replace / delete /
// privacy. The list + detail pair moved here from the old single-column layout,
// and the component itself out of SessionPane (issue #792) so the tab's shell
// decisions are testable without the pane's IPC mock layer.
//
// Panel card chrome for the master/detail sections (issue #184 + #222): bg-card
// + border + rounded-lg + p-4 carry the surface (ADR-0067 (1) .panel layout hook
// + visual utility); shadow-sm shares the elevation language of the floating
// dialog / popover layer (Tailwind scale, no new token, ADR-0067 (2)).
// Shared by the list and detail sections so the pair reads as one surface, and
// by the empty-state card (issue #792) so the tab reads as one family either
// way.
const PANEL_CARD_BASE = "panel bg-card border rounded-lg shadow-sm p-4";
export function WorkspaceWorkingSet({
  datasets,
  activeName,
  loading,
  viewedDescriptor,
  onRename,
  onReplace,
  onDelete,
  onPrivacyChange,
  onAddFiles,
}: {
  datasets: DatasetDescriptor[];
  activeName: string | null;
  loading: boolean;
  viewedDescriptor: DatasetDescriptor | null;
  onRename: (referenceName: string, newDisplay: string) => void;
  onReplace: (referenceName: string, path: string) => void;
  onDelete: (referenceName: string) => void;
  onPrivacyChange: (
    referenceName: string,
    privacy: DatasetPrivacy,
  ) => void;
  // The empty-state card's inline add entry (issue #792): picked paths route
  // into the SAME handleIngestMany pipeline as the composer's + entry
  // (guided-load dock, error banner, batch queue all live inside it).
  onAddFiles: (paths: string[]) => void;
}) {
  // The 工作集 tab's own selection (which dataset's detail to show). Kept local
  // and separate from viewedResult: picking a dataset here is a management
  // action, not a workspace view selection (ADR-0051 active/viewed split).
  const [selected, setSelected] = useState<string | null>(
    viewedDescriptor?.reference_name ?? activeName ?? null,
  );

  // The empty set renders ONE card (issue #792): the two-column shell with its
  // near-empty pair does not mount at all. Hooks stay above the early return
  // (the useState is unconditional), and remounting per tab entry re-seeds the
  // initial pick -- the guard below is the only branch.
  if (datasets.length === 0) {
    return (
      <section className={PANEL_CARD_BASE}>
        <WorkingSetEmptyState onAddFiles={onAddFiles} loading={loading} />
      </section>
    );
  }

  // Derived, not held (issue #792): a deleted pick falls back to the active
  // dataset, then the first item, so the detail never blanks mid-management.
  const shown = resolveWorkingSetDetail(datasets, selected, activeName);

  return (
    // ADR-0067 (issue #184): the WorkspaceWorkingSet div carries the .layout
    // grid (280px/1fr two-column master-detail, ADR-0067 Decision 1;
    // single-column fallback at container widths <=600px, styles.css issue
    // #791); both sections share the PANEL_CARD_BASE chrome (defined above).
    // The .layout / .working-set-layout / .panel class hooks stay as anchor
    // points; per-consumer margins live on the consumer, not the shared
    // .layout rule.
    <div className="layout working-set-layout">
      <section className={PANEL_CARD_BASE}>
        <h2>
          <FormattedMessage
            id="session.workingSet.title"
            defaultMessage="Working set · {count}"
            values={{ count: datasets.length }}
          />
        </h2>
        <WorkingSetList
          datasets={datasets}
          activeName={activeName}
          onSelect={setSelected}
          onRename={onRename}
          onReplace={onReplace}
          onDelete={onDelete}
          loading={loading}
        />
      </section>
      <section className={PANEL_CARD_BASE}>
        {shown !== null ? (
          <DatasetDetail
            dataset={shown}
            loading={loading}
            onPrivacyChange={onPrivacyChange}
          />
        ) : null /* unreachable past the empty branch: datasets[0] is the floor */}
      </section>
    </div>
  );
}
