import { useState } from "react";
import { FormattedMessage } from "react-intl";
import { useQuery } from "@tanstack/react-query";
import { readRows } from "../../api";
import { sessionKeys } from "../../session/queryKeys";
import { WorkingSetList } from "./WorkingSetList";
import { WorkingSetEmptyState } from "./WorkingSetEmptyState";
import { DatasetDetail, SAMPLE_ROW_LIMIT } from "./DatasetDetail";
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
// way. Issue #865 resolves the same-token card-on-card look (panel bg-card on
// the workspace column's old var(--card) floor) from the floor side: the
// workspace column now rides the canvas token, so this card reads as a layer
// above the page floor (dark mode brightness step; light mode hairline +
// shadow-sm, the system's light depth method).
const PANEL_CARD_BASE = "panel bg-card border rounded-lg shadow-sm p-4";
export function WorkspaceWorkingSet({
  sessionId,
  datasets,
  activeName,
  loading,
  onRename,
  onReplace,
  onDelete,
  onPrivacyChange,
  onAddFiles,
}: {
  // ADR-0056 session addressing: the live sample preview (issue #1061) reads
  // this session's rows through the paged channel.
  sessionId: string;
  datasets: DatasetDescriptor[];
  activeName: string | null;
  loading: boolean;
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
  // Drives both the detail pane and the list's selection band, so the
  // highlight follows the pick (and the deleted-pick fallbacks below).
  const [selected, setSelected] = useState<string | null>(activeName ?? null);

  // Resolved BEFORE the empty-set early return (hooks cannot sit past a
  // conditional return): the preview query's gate needs the same resolved
  // pick the detail pane renders, so there is exactly one resolution.
  const shown = resolveWorkingSetDetail(datasets, selected, activeName);

  // The live sample preview (issue #1061): one fixed first window of the
  // shown dataset through the paged read (ADR-0024). The gate keys on the
  // PICK, never on tab visibility or unmount -- issue #1060 keeps both tab
  // panels mounted across switches, so an unmount-based gate would never
  // fire; enabled:false with no pick simply idles the query. The key nests
  // under the working-set prefix so the rename / replace / delete / privacy
  // invalidations refresh the rows alongside the descriptor (a replaced
  // source's rows would otherwise linger -- staleTime is Infinity app-wide,
  // ADR-0051).
  const preview = useQuery({
    queryKey: sessionKeys.previewRows(sessionId, shown?.reference_name ?? ""),
    queryFn: () => readRows(sessionId, shown!.reference_name, 0, SAMPLE_ROW_LIMIT),
    enabled: shown !== null,
  });

  // The empty set renders ONE card (issue #792): the two-column shell with its
  // near-empty pair does not mount at all. Hooks stay above the early return
  // (the useState / useQuery are unconditional) -- the guard below is the only
  // branch. The initializer seeds the FIRST pick only (issue #1060: both tab
  // panels stay mounted, so re-entering the tab no longer remounts this
  // component to re-seed it; true remounts are session-level). The pick always
  // seeds from activeName: the component mounts on the pane's first render,
  // before any viewed result exists (issue #1065 retired the unreachable
  // viewed-result seed arm).
  if (datasets.length === 0) {
    return (
      <section className={PANEL_CARD_BASE}>
        <WorkingSetEmptyState onAddFiles={onAddFiles} loading={loading} />
      </section>
    );
  }

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
        <h2 className="text-base font-semibold">
          <FormattedMessage
            id="session.workingSet.title"
            defaultMessage="Working set · {count}"
            values={{ count: datasets.length }}
          />
        </h2>
        <WorkingSetList
          datasets={datasets}
          activeName={activeName}
          // The band rides the RESOLVED pick, not the raw state: after a
          // delete the pane falls back (active, then first) and the band
          // follows the pane, never a name that is no longer in the list.
          selectedName={shown?.reference_name ?? null}
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
            // The preview state rides props (issue #1061): the container owns
            // the query, the detail stays a pure renderer. An error wins over
            // a stale cached page; a 0-row page renders no section at all.
            sample={preview.data ?? null}
            sampleLoading={preview.isLoading}
            sampleError={preview.error}
            loading={loading}
            onPrivacyChange={onPrivacyChange}
          />
        ) : null /* unreachable past the empty branch: datasets[0] is the floor */}
      </section>
    </div>
  );
}
