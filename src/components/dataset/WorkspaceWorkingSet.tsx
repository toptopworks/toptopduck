import { useState } from "react";
import { FormattedMessage } from "react-intl";
import { useWorkingSet, type UseWorkingSetSurfaces } from "../../session/useWorkingSet";
import { ActiveSourceDeleteDialog } from "./ActiveSourceDeleteDialog";
import { WorkingSetList } from "./WorkingSetList";
import { WorkingSetEmptyState } from "./WorkingSetEmptyState";
import { DatasetDetail } from "./DatasetDetail";

// The "工作集" tab (ADR-0045): source management -- rename / replace / delete /
// privacy. The list + detail pair moved here from the old single-column layout,
// and the component itself out of SessionPane (issue #792) so the tab's shell
// decisions are testable without the pane's IPC mock layer. ADR-0123: the
// component consumes the useWorkingSet seam directly -- the queries, the four
// mutations, the active-source delete machine, and the pick resolution all
// live in the hook; this shell keeps the pick's useState (the seam's
// parameter) and the rendering, and the delete confirm dialog mounts with the
// machine. The seam's error / busy / persist reports flow through the injected
// surfaces (the pane-level strip that stays visible from both tabs,
// issue #1060).
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
  busy,
  onAddFiles,
  surfaces,
}: {
  // ADR-0056 session addressing: the seam's queries (including the live
  // sample preview, issue #1061) read this session's rows.
  sessionId: string;
  /** The pane's execution-window gate (turn || mutation in flight,
   *  ADR-0040): the seam's own mutations round-trip through the pane-level
   *  busy union back into this prop, so the buttons disable for all three
   *  domains alike. */
  busy: boolean;
  // The empty-state card's inline add entry (issue #792): picked paths route
  // into the SAME handleIngestMany pipeline as the composer's + entry
  // (guided-load dock, error banner, batch queue all live inside it) -- the
  // pane hands the ingest entry down; the seam never owns it (ADR-0123
  // Decision 3).
  onAddFiles: (paths: string[]) => void;
  /** The session-level mutation surfaces the seam reports into (ADR-0123):
   *  the pane passes useSessionState's sinks through, the same ones the
   *  ingest flow consumes. */
  surfaces: UseWorkingSetSurfaces;
}) {
  // The 工作集 tab's own selection (which dataset's detail to show). Kept local
  // and separate from viewedResult: picking a dataset here is a management
  // action, not a workspace view selection (ADR-0051 active/viewed split).
  // ADR-0123 Decision 2: the useState stays HERE, the seam takes it as a
  // parameter and owns the resolution (pick ?? active ?? first). The pick
  // starts unset, so a fresh mount follows the active dataset until the user
  // picks; the resolution carries the deleted-pick fallbacks.
  const [selected, setSelected] = useState<string | null>(null);
  const ws = useWorkingSet(sessionId, selected, surfaces);

  // Destructured for narrowing through the JSX guard below: TS narrows a
  // const across the guard + the candidates filter closure, but not a member
  // access like ws.pendingActiveDelete.
  const { pendingActiveDelete } = ws;

  return (
    <>
      {ws.datasets.length === 0 ? (
        // The empty set renders ONE card (issue #792): the two-column shell
        // with its near-empty pair does not mount at all. Both tab panels
        // stay mounted across switches (issue #1060), so this branch is a
        // render choice, never a remount.
        <section className={PANEL_CARD_BASE}>
          <WorkingSetEmptyState onAddFiles={onAddFiles} loading={busy} />
        </section>
      ) : (
        // ADR-0067 (issue #184): the layout div carries the .layout grid
        // (280px/1fr two-column master-detail, ADR-0067 Decision 1;
        // single-column fallback at container widths <=600px, styles.css
        // issue #791); both sections share the PANEL_CARD_BASE chrome
        // (defined above). The .layout / .working-set-layout / .panel class
        // hooks stay as anchor points; per-consumer margins live on the
        // consumer, not the shared .layout rule.
        <div className="layout working-set-layout">
          <section className={PANEL_CARD_BASE}>
            <h2 className="text-base font-semibold">
              <FormattedMessage
                id="session.workingSet.title"
                defaultMessage="Working set · {count}"
                values={{ count: ws.datasets.length }}
              />
            </h2>
            <WorkingSetList
              datasets={ws.datasets}
              activeName={ws.activeName}
              // The band rides the RESOLVED pick, not the raw state: after a
              // delete the seam falls back (active, then first) and the band
              // follows what the detail pane shows, never a name that is no
              // longer in the list.
              selectedName={ws.shown?.reference_name ?? null}
              onSelect={setSelected}
              onRename={ws.handleRename}
              onReplace={ws.handleReplace}
              onDelete={ws.handleDelete}
              loading={busy}
            />
          </section>
          <section className={PANEL_CARD_BASE}>
            {ws.shown !== null ? (
              <DatasetDetail
                dataset={ws.shown}
                // The preview state rides the seam (issue #1061): the hook
                // owns the query, the detail stays a pure renderer. An error
                // wins over a stale cached page; a 0-row page renders no
                // section at all.
                sample={ws.sample}
                sampleLoading={ws.sampleLoading}
                sampleError={ws.sampleError}
                loading={busy}
                onPrivacyChange={ws.handlePrivacyChange}
              />
            ) : null /* unreachable past the empty branch: datasets[0] is the floor */}
          </section>
        </div>
      )}
      {/* ADR-0123 Decision 4: the confirm dialog mounts with the state
          machine on the working-set side (the pane's hoisting retired); the
          Radix portal escapes the hidden panel, so the modal renders above
          everything whichever tab is visible. */}
      {pendingActiveDelete && (
        <ActiveSourceDeleteDialog
          target={pendingActiveDelete}
          candidates={ws.datasets.filter(
            (d) => d.reference_name !== pendingActiveDelete.reference_name,
          )}
          onConfirm={ws.handleConfirmActiveDelete}
          onCancel={ws.handleCancelActiveDelete}
        />
      )}
    </>
  );
}
