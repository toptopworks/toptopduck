import { useState } from "react";
import { useSessionState, errorPrefix } from "./useSessionState";
import { ActiveSourceDeleteDialog } from "../components/ActiveSourceDeleteDialog";
import { DatasetDetail } from "../components/DatasetDetail";
import { FileDropzone } from "../components/FileDropzone";
import { GuidedLoadDialog } from "../components/GuidedLoadDialog";
import { QuestionBar } from "../components/QuestionBar";
import { ResultView } from "../components/ResultView";
import { Thread } from "../components/Thread";
import { WorkingSetList } from "../components/WorkingSetList";
import type {
  DatasetDescriptor,
  ThreadEntry,
  TurnRecord,
} from "../types";
import type { WorkspaceContent } from "./workspace";

// The per-session pane (ADR-0051). One `<SessionPane key={sid} sessionId={sid} />`
// owns ALL of a session's server state (via useSessionState -> TanStack Query)
// and client UI state (viewedResult / pinnedToHistory / loading / dialogs).
// The shell (<App>) places this as the right grid block (rail + workspace +
// QuestionBar); the session sidebar is a separate, full-height column (R1).

interface SessionPaneProps {
  sessionId: string;
}

export function SessionPane({ sessionId }: SessionPaneProps) {
  const s = useSessionState(sessionId);
  // Workspace tab (ADR-0045: 工作集 is a workspace tab, not a persistent
  // column). 结果 = the derived chart+table stage; 工作集 = source management.
  const [tab, setTab] = useState<"result" | "workingSet">("result");

  const viewedReference = s.viewedResult?.referenceName ?? null;
  const viewedDescriptor = viewedReference
    ? s.datasets.find((d) => d.reference_name === viewedReference) ?? null
    : null;

  return (
    <div className="session-pane">
      {/* --- Thread rail (ADR-0045/0047) ------------------------------------- */}
      <section className="session-rail" aria-label="对话时间线">
        <Thread
          entries={s.thread}
          selectedResult={viewedReference}
          onSelectResult={s.handleSelectResult}
          staleByReference={s.staleByReference}
        />
        {s.thread.length === 0 && (
          <p className="rail-empty muted">尚无对话。在下方提问或加载数据开始。</p>
        )}
      </section>

      {/* --- Workspace (ADR-0045/0062 R2) ----------------------------------- */}
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
            <span className="active-chip" title="下一个提问默认作用于此表">
              作用于 {s.datasets.find((d) => d.reference_name === s.activeName)?.display_name ?? s.activeName}
            </span>
          )}
        </div>

        <div className="workspace-body">
          {s.error && (
            <p className="error" role="alert">
              {errorPrefix(s.error.kind)}
              {s.error.message}
            </p>
          )}
          {s.persistError && (
            <p className="persist-warning" role="status">
              自动保存失败：{s.persistError}（内存中的最新更改未写入磁盘，关闭 app 前请重试保存）
            </p>
          )}

          {tab === "result" ? (
            <WorkspaceResult
              content={s.workspaceContent}
              sessionId={sessionId}
              onIngest={s.handleIngest}
              loading={s.loading}
              hasData={s.datasets.length > 0}
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
      {s.pendingActiveDelete && (
        <ActiveSourceDeleteDialog
          target={s.pendingActiveDelete}
          candidates={s.datasets.filter(
            (d) => d.reference_name !== s.pendingActiveDelete!.reference_name,
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
}: {
  content: WorkspaceContent;
  sessionId: string;
  onIngest: (path: string) => void;
  loading: boolean;
  hasData: boolean;
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
      return (
        <ResultView
          sessionId={sessionId}
          referenceName={content.referenceName}
          assumption={content.assumption}
          viz={content.viz}
          staleAnchor={content.staleAnchor}
        />
      );
    default: {
      const unhandled: never = content;
      throw new Error(`unhandled workspace content: ${JSON.stringify(unhandled)}`);
    }
  }
}

// The textual outcome rendered full-width in the workspace (ADR-0062 R2
// lastTurnText). Mirrors the rail's outcome encoding (ADR-0047) but at workspace
// scale so a clarify/refuse/failed/cancelled is readable and actionable.
function TextualOutcomeCard({ turn }: { turn: TurnRecord }) {
  switch (turn.outcome.kind) {
    case "Textual": {
      const { text_kind, body, assumption } = turn.outcome.data;
      const isClarify = text_kind === "Clarify";
      return (
        <article className={`textual-card ${text_kind.toLowerCase()}`}>
          <h3>{isClarify ? "需要澄清" : "无法处理"}</h3>
          <p className="textual-body">{body}</p>
          {assumption && <p className="assumption">假设：{assumption}</p>}
        </article>
      );
    }
    case "Failed":
      return (
        <article className="textual-card failed">
          <h3>提问失败</h3>
          <p className="textual-body">{turn.outcome.data.reason}</p>
        </article>
      );
    case "Cancelled":
      return (
        <article className="textual-card cancelled">
          <h3>已取消</h3>
        </article>
      );
    case "Materialized":
      // A Materialized turn never reaches this card (workspaceContent routes it
      // to ResultView). Defensive guard so the union stays exhaustive.
      return null;
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
    privacy: import("../types").DatasetPrivacy,
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
