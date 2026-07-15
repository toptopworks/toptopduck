import { useState } from "react";
import { useIntl, FormattedMessage } from "react-intl";
import { useQueryClient } from "@tanstack/react-query";
import { fmtError, errorDetail, formatTurnFailure, turnFailureDetail } from "../api";
import { useSessionState, errorPrefix } from "./useSessionState";
import { ActiveSourceDeleteDialog } from "../components/ActiveSourceDeleteDialog";
import { DatasetDetail } from "../components/DatasetDetail";
import { ErrorBanner } from "../components/ErrorBanner";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { FileDropzone } from "../components/FileDropzone";
import { GuidedLoadDialog } from "../components/GuidedLoadDialog";
import { QuestionBar } from "../components/QuestionBar";
import { ResultView } from "../components/ResultView";
import { Thread } from "../components/Thread";
import { Badge } from "../components/ui/badge";
import { WorkingSetList } from "../components/WorkingSetList";
import type {
  DatasetDescriptor,
  DatasetPrivacy,
  ThreadEntry,
} from "../types";
import type { NonMaterializedTurn, WorkspaceContent } from "./workspace";
import { sessionKeys } from "./queryKeys";

// The per-session pane (ADR-0051). One `<SessionPane key={sid} sessionId={sid} />`
// owns ALL of a session's server state (via useSessionState -> TanStack Query)
// and client UI state (viewedResult / pinnedToHistory / loading / dialogs).
// The shell (<App>) places this as the right grid block (rail + workspace +
// QuestionBar); the session sidebar is a separate, full-height column (R1).

interface SessionPaneProps {
  sessionId: string;
  /** A drop-on-cold-start path to ingest once on mount (ADR-0061, #81 A1).
   *  null for sessions opened by a non-drop action. */
  pendingIngestPath: string | null;
  /** Shell callback after the pending ingest is kicked off, so OpenSession is
   *  cleared and a remount cannot re-ingest (#81 A1). */
  onIngestConsumed: () => void;
}

export function SessionPane({ sessionId, pendingIngestPath, onIngestConsumed }: SessionPaneProps) {
  const s = useSessionState(sessionId, pendingIngestPath, onIngestConsumed);
  const intl = useIntl();
  const persistDetail = s.persistError ? errorDetail(s.persistError) : null;
  const queryClient = useQueryClient();
  // Workspace tab (ADR-0045: 工作集 is a workspace tab, not a persistent
  // column). 结果 = the derived chart+table stage; 工作集 = source management.
  const [tab, setTab] = useState<"result" | "workingSet">("result");

  // ADR-0058 L2 partition retry: each region's onReset REMOVES its slice of the
  // session query cache so the key-bump remount re-fetches fresh data -- NOT the
  // stale page that crashed it. invalidateQueries would leave the cache in place
  // and let useQuery hand the remounted children the same throwing data via its
  // stale-then-refetch render; removeQueries drops it so the remount mounts into
  // a loading state and refetches clean. The session-body boundary and the
  // granular Thread/ResultView boundaries all drop the whole session prefix:
  // cheap (a few IPC) and avoids the re-throw.
  const resetSessionCache = () => {
    queryClient.removeQueries({ queryKey: sessionKeys.all(sessionId) });
  };

  const viewedReference = s.viewedResult?.referenceName ?? null;
  const viewedDescriptor = viewedReference
    ? s.datasets.find((d) => d.reference_name === viewedReference) ?? null
    : null;
  // Non-stale dataset labels for the rail's conditional active chip (ADR-0047):
  // a turn's question lights up a chip only when it explicitly names a dataset.
  // Stale datasets are excluded -- they cannot be the target of a new question.
  const datasetLabels = s.datasets.filter((d) => !d.stale);
  // Hoisted so the ActiveSourceDeleteDialog filter callback reads it without a
  // non-null assertion: TS narrows a const across the JSX guard + closure, but
  // not a member access like s.pendingActiveDelete.
  const pendingActiveDelete = s.pendingActiveDelete;

  return (
    <div className="session-pane">
      {/* ADR-0058 L2 partition boundaries: Thread rail and ResultView each get
          their own ErrorBoundary so a render crash in one degrades only that
          block (the QuestionBar -- a session-skeleton element, ADR-0062 R1 --
          is a sibling and always survives). The session-level isolation
          boundary lives one level up in <App> (wrapping each <SessionPane>) so
          a render crash elsewhere in the pane degrades only THAT session.
          KNOWN LIMITATION (React 19 + TanStack Query external store): in the
          real App tree the per-session boundary is an ANCESTOR of these region
          boundaries, so a Query-driven re-render throw inside Thread/ResultView
          can be caught by the outer session boundary first (degrading the whole
          pane) instead of the granular region boundary. First-render throws are
          caught by the region boundary as expected; the cross-boundary case
          surfaces only with external-store-driven updates and could not be
          reproduced in isolation, so black-box tests assert "degrade card
          visible + session isolated + retry" rather than "region boundary
          catches precisely". See memory: react19-nested-errorboundary-outer-
          catches. */}
      {/* --- Thread rail (ADR-0045/0047) ---------------------------------- */}
      <section className="session-rail" aria-label="对话时间线">
        <ErrorBoundary name="thread" onReset={resetSessionCache}>
          <Thread
            entries={s.thread}
            selectedResult={viewedReference}
            onSelectResult={s.handleSelectResult}
            staleByReference={s.staleByReference}
            datasetLabels={datasetLabels}
          />
        </ErrorBoundary>
        {s.thread.length === 0 && (
          <p className="rail-empty muted">尚无对话。在下方提问或加载数据开始。</p>
        )}
      </section>

      {/* --- Workspace (ADR-0045/0062 R2) -------------------------------- */}
      <section className="session-workspace" aria-label="工作区">
        <div className="workspace-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "result"}
            className={tab === "result" ? "active" : undefined}
            onClick={() => setTab("result")}
          >
            结果
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "workingSet"}
            className={tab === "workingSet" ? "active" : undefined}
            onClick={() => setTab("workingSet")}
          >
            工作集
          </button>
          {/* active (server truth, ADR-0051/0060) shown read-only here so the
                user sees what the next question targets by default. Naming it
                here, not in QuestionBar, keeps QuestionBar presentational. */}
          {s.activeName && (
            <Badge variant="default" className="active-chip" title="下一个提问默认作用于此表">
              作用于 {s.datasets.find((d) => d.reference_name === s.activeName)?.display_name ?? s.activeName}
            </Badge>
          )}
        </div>

        <div className="workspace-body">
          {s.error && (
            <ErrorBanner
              message={`${errorPrefix(s.error.kind)}${s.error.message}`}
              detail={s.error.detail}
            />
          )}
          {s.persistError && (
            <div className="persist-warning" role="status">
              <p className="error-message">
                <FormattedMessage
                  id="error.persist.banner"
                  defaultMessage="Auto-save failed: {reason} (the latest in-memory changes were not written to disk; retry the save before closing the app.)"
                  values={{ reason: fmtError(s.persistError, intl) }}
                />
              </p>
              {persistDetail && (
                <details className="error-details">
                  <summary className="muted">
                    <FormattedMessage
                      id="errorBoundary.details"
                      defaultMessage="Technical details"
                    />
                  </summary>
                  <pre className="error-stack">{persistDetail}</pre>
                </details>
              )}
            </div>
          )}

          {tab === "result" ? (
            <WorkspaceResult
              content={s.workspaceContent}
              sessionId={sessionId}
              onIngest={s.handleIngest}
              loading={s.loading}
              hasData={s.datasets.length > 0}
              onResetRegion={resetSessionCache}
            />
          ) : (
            <WorkspaceWorkingSet
              datasets={s.datasets}
              activeName={s.activeName}
              loading={s.loading}
              viewedDescriptor={viewedDescriptor}
              onRename={s.handleRename}
              onReplace={s.handleReplace}
              onDelete={s.handleDelete}
              onPrivacyChange={s.handlePrivacyChange}
            />
          )}
        </div>
      </section>

      {/* --- QuestionBar (ADR-0062 R1: spans rail + workspace only) --------- */}
      <div className="session-questionbar">
        <QuestionBar
          onSubmit={s.handleAsk}
          onCancel={s.handleCancel}
          loading={s.loading}
          phase={s.phase}
        />
      </div>

      {/* --- Dialogs (guidance + active-source delete) ---------------------- */}
      {s.guidance && (
        <GuidedLoadDialog
          request={s.guidance.request}
          loading={s.loading}
          onSubmit={s.handleGuidedSubmit}
          onCancel={s.handleGuidedCancel}
        />
      )}
      {pendingActiveDelete && (
        <ActiveSourceDeleteDialog
          target={pendingActiveDelete}
          candidates={s.datasets.filter(
            (d) => d.reference_name !== pendingActiveDelete.reference_name,
          )}
          onConfirm={(cw) => s.handleConfirmActiveDelete(cw)}
          onCancel={s.handleCancelActiveDelete}
        />
      )}
    </div>
  );
}

// The "结果" tab content: derived from (viewedResult, thread last turn,
// pinnedToHistory) via workspaceContent. Three states per ADR-0062 R2.
function WorkspaceResult({
  content,
  sessionId,
  onIngest,
  loading,
  hasData,
  onResetRegion,
}: {
  content: WorkspaceContent;
  sessionId: string;
  onIngest: (path: string) => void;
  loading: boolean;
  hasData: boolean;
  /** ADR-0058 L2 result-partition retry: remove the session slice so a
   *  remounted ResultView re-fetches fresh rows instead of re-throwing against
   *  the stale page that crashed it. */
  onResetRegion: () => void;
}) {
  switch (content.kind) {
    case "hero":
      // Hero empty state (ADR-0061): the primary "load data" CTA. FileDropzone
      // drives both the drop target and the file picker. After a source is
      // loaded (hasData) the prompt pivots to "ask a question".
      return (
        <div className="workspace-hero">
          <FileDropzone onIngest={onIngest} loading={loading} />
          <p className="muted">
            {hasData
              ? "数据已加载。在下方提问开始分析，或在「工作集」管理数据。"
              : "拖入或选择一个数据文件开始分析。"}
          </p>
        </div>
      );
    case "lastTurnText":
      // ADR-0062 R2: the last turn is a non-materialized B/C/D and the user has
      // not pinned to a history result -- show the textual card so the user can
      // read / respond (ADR-0048 clarification flows through the next turn).
      return <TextualOutcomeCard turn={content.turn} />;
    case "result":
      // The chart + table for the viewed Materialized result (ADR-0062 R4).
      // ADR-0058 L2 result partition: a render crash inside ResultView (Vega's
      // own try/catch stays internal per ADR-0033/0058 L0; this catches the
      // rest) degrades only this block, not the Thread rail or QuestionBar.
      return (
        <ErrorBoundary name="result" onReset={onResetRegion}>
          <ResultView
            sessionId={sessionId}
            referenceName={content.referenceName}
            assumption={content.assumption}
            viz={content.viz}
            staleAnchor={content.staleAnchor}
          />
        </ErrorBoundary>
      );
    default: {
      const unhandled: never = content;
      throw new Error(`unhandled workspace content: ${JSON.stringify(unhandled)}`);
    }
  }
}

// The textual outcome rendered full-width in the workspace (ADR-0062 R2
// lastTurnText). Mirrors the rail's outcome encoding (ADR-0047) but at workspace
// scale so a clarify/refuse/failed/cancelled is readable and actionable. The
// turn is already narrowed to NonMaterializedTurn (workspace.ts), so Materialized
// is excluded at the type level and the switch ends in `default: never` -- no
// defensive `return null` for an unreachable case.
function TextualOutcomeCard({ turn }: { turn: NonMaterializedTurn }) {
  const intl = useIntl();
  switch (turn.outcome.kind) {
    case "Textual": {
      const { text_kind, body, assumption } = turn.outcome.data;
      const isClarify = text_kind === "Clarify";
      return (
        <article className={`textual-card ${text_kind.toLowerCase()}`}>
          <h3>
            {isClarify ? (
              <FormattedMessage id="thread.outcome.clarify" defaultMessage="Needs clarification" />
            ) : (
              <FormattedMessage id="thread.outcome.refused" defaultMessage="Cannot fulfill" />
            )}
          </h3>
          <p className="textual-body">{body}</p>
          {assumption && (
            <p className="assumption">
              <FormattedMessage
                id="thread.assumption"
                defaultMessage="Assumption: {text}"
                values={{ text: assumption }}
              />
            </p>
          )}
        </article>
      );
    }
    case "Failed": {
      // Outcome C (issue #125): render by TurnFailure kind via the locale
      // catalog (no backend Display string crosses IPC); Execute / Resource
      // carry a technical detail under the collapsed fold.
      const failure = turn.outcome.data;
      const detail = turnFailureDetail(failure);
      return (
        <article className="textual-card failed">
          <h3>
            <FormattedMessage id="thread.outcome.failed" defaultMessage="Failed" />
          </h3>
          <p className="textual-body">{formatTurnFailure(failure, intl)}</p>
          {detail && (
            <details className="error-details">
              <summary className="muted">
                <FormattedMessage id="errorBoundary.details" defaultMessage="Technical details" />
              </summary>
              <pre className="error-stack">{detail}</pre>
            </details>
          )}
        </article>
      );
    }
    case "Cancelled":
      return (
        <article className="textual-card cancelled">
          <h3>
            <FormattedMessage id="thread.outcome.cancelled" defaultMessage="Cancelled" />
          </h3>
        </article>
      );
    default: {
      const unhandled: never = turn.outcome;
      throw new Error(`unhandled turn outcome: ${JSON.stringify(unhandled)}`);
    }
  }
}

// The "工作集" tab (ADR-0045): source management -- rename / replace / delete /
// privacy. The list + detail pair moved here from the old single-column layout.
function WorkspaceWorkingSet({
  datasets,
  activeName,
  loading,
  viewedDescriptor,
  onRename,
  onReplace,
  onDelete,
  onPrivacyChange,
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
}) {
  // The 工作集 tab's own selection (which dataset's detail to show). Kept local
  // and separate from viewedResult: picking a dataset here is a management
  // action, not a workspace view selection (ADR-0051 active/viewed split).
  const [selected, setSelected] = useState<string | null>(
    viewedDescriptor?.reference_name ?? activeName ?? null,
  );
  const shown = datasets.find((d) => d.reference_name === selected) ?? null;

  return (
    <div className="layout working-set-layout">
      <section className="panel">
        <h2>工作集</h2>
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
      <section className="panel">
        {shown ? (
          <DatasetDetail
            dataset={shown}
            loading={loading}
            onPrivacyChange={onPrivacyChange}
          />
        ) : (
          <p className="muted">选择一个数据集查看其结构。</p>
        )}
      </section>
    </div>
  );
}

// Re-exported for tests that want to assert on the thread type without reaching
// into ../types directly.
export type { ThreadEntry };
