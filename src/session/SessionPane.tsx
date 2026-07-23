import { useState } from "react";
import { useIntl, FormattedMessage } from "react-intl";
import { useQueryClient } from "@tanstack/react-query";
import { fmtError, errorDetail, formatTurnFailure, turnFailureDetail } from "../api";
import { useSessionState } from "./useSessionState";
import { ActiveSourceDeleteDialog } from "../components/dataset/ActiveSourceDeleteDialog";
import { DatasetDetail } from "../components/dataset/DatasetDetail";
import { ErrorBanner } from "../components/common/ErrorBanner";
import { ErrorBoundary } from "../components/common/ErrorBoundary";
import { FileDropzone } from "../components/dataset/FileDropzone";
import { GuidedLoadDialog } from "../components/dataset/GuidedLoadDialog";
import { QuestionBar } from "../components/thread/QuestionBar";
import { ResultView } from "../components/thread/ResultView";
import { TechnicalDetailsFold } from "../components/common/TechnicalDetailsFold";
import { Thread } from "../components/thread/Thread";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { WorkingSetList } from "../components/dataset/WorkingSetList";
import { cn } from "@/lib/utils";
import type { DatasetDescriptor, DatasetPrivacy } from "../types/dataset";
import type { ThreadEntry } from "../types/thread";
import type { NonMaterializedTurn, WorkspaceContent } from "./workspace";
import { sessionKeys } from "./queryKeys";

// The per-session pane (ADR-0051). One `<SessionPane key={sid} sessionId={sid} />`
// owns ALL of a session's server state (via useSessionState -> TanStack Query)
// and client UI state (viewedResult / pinnedToHistory / loading / dialogs).
// The shell (<App>) places this as the right grid block (rail + workspace +
// QuestionBar); the session sidebar is a separate, full-height column (R1).

interface SessionPaneProps {
  sessionId: string;
  /** A pending data-file drop routed to this session's ingest (ADR-0061,
   *  #81 A1; issue #205). Set by a cold-start drop (ingested once on mount) OR
   *  by a drop onto an already-active session (ingested when the prop changes).
   *  null once consumed or for sessions opened by a non-drop action. */
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
      <section
        className="session-rail"
        aria-label={intl.formatMessage({ id: "session.rail.ariaLabel", defaultMessage: "Conversation timeline" })}
      >
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
          // ADR-0067 (issue #185): the .rail-empty visual rule (font-size +
          // padding) + the .muted color rule retired onto utility; the class
          // hooks had no selector / test dependents and are dropped.
          <p className="text-[0.85rem] p-2 text-muted-foreground">
            <FormattedMessage
              id="session.rail.empty"
              defaultMessage="No conversations yet. Ask a question below or load data to begin."
            />
          </p>
        )}
      </section>

      {/* --- Workspace (ADR-0045/0062 R2) -------------------------------- */}
      <section
        className="session-workspace"
        aria-label={intl.formatMessage({ id: "session.workspace.ariaLabel", defaultMessage: "Workspace" })}
      >
        {/* ADR-0067 (issue #173): the .workspace-tabs visual chrome (padding,
            border-bottom, background) + the [role=tab] base + .active
            primary-underline retired from styles.css onto this component as
            utility + ADR-0050 token. The .workspace-tabs hook + bare "active"
            class stay for selector / test stability; twMerge picks
            border-b-primary over border-b-transparent when the tab is active. */}
        <div
          className="workspace-tabs flex items-center gap-2 px-4 py-1.5 border-b bg-background"
          role="tablist"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "result"}
            className={cn(
              "px-3 py-1.5 cursor-pointer text-sm border-b-2 border-b-transparent text-muted-foreground",
              tab === "result" && "active text-primary border-b-primary font-semibold",
            )}
            onClick={() => setTab("result")}
          >
            <FormattedMessage id="session.tab.result" defaultMessage="Results" />
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "workingSet"}
            className={cn(
              "px-3 py-1.5 cursor-pointer text-sm border-b-2 border-b-transparent text-muted-foreground",
              tab === "workingSet" && "active text-primary border-b-primary font-semibold",
            )}
            onClick={() => setTab("workingSet")}
          >
            <FormattedMessage id="session.tab.workingSet" defaultMessage="Working set" />
          </button>
          {/* active (server truth, ADR-0051/0060) shown read-only here so the
                user sees what the next question targets by default. Naming it
                here, not in QuestionBar, keeps QuestionBar presentational. */}
          {s.activeName && (
            <Badge
              variant="default"
              className="active-chip"
              title={intl.formatMessage({
                id: "session.activeChip.title",
                defaultMessage: "The next question targets this table by default",
              })}
            >
              <FormattedMessage
                id="session.activeChip.label"
                defaultMessage="Targets {name}"
                values={{
                  name:
                    s.datasets.find((d) => d.reference_name === s.activeName)?.display_name ??
                    s.activeName,
                }}
              />
            </Badge>
          )}
        </div>

        {/* ADR-0067 (issue #173): the .workspace-body visual rule (padding)
            retired from styles.css; the flex-1 + overflow-y-auto layout could
            move too, but the hook stays for selector / test stability. */}
        <div className="workspace-body flex-1 overflow-y-auto p-4">
          {s.error && <ErrorBanner error={s.error} />}
          {s.persistError && (
            // ADR-0067 (issue #172): the bespoke .persist-warning container
            // (hardcoded amber #fff4e5 / #ffd9a0 / #8a5200) retired into a
            // shadcn Alert warning variant, which consumes the --warning token.
            // role="status" overrides the Alert's assertive "alert" default:
            // the disk fell behind but the in-memory work is intact, so it
            // reads as a polite caution, not an interrupting emergency.
            <Alert variant="warning" role="status" className="mt-1.5">
              <AlertDescription>
                <p className="m-0">
                  <FormattedMessage
                    id="error.persist.banner"
                    defaultMessage="Auto-save failed: {reason} (the latest in-memory changes were not written to disk; retry the save before closing the app.)"
                    values={{ reason: fmtError(s.persistError, intl) }}
                  />
                </p>
                <TechnicalDetailsFold detail={persistDetail} />
              </AlertDescription>
            </Alert>
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
      // ADR-0067 (issue #173): the .workspace-hero visual rule (flex column,
      // centered, gap, padding, text-align) retired from styles.css onto
      // utility; the .workspace-hero hook stays for selector stability.
      return (
        <div className="workspace-hero flex flex-col items-center gap-4 p-8 text-center">
          <FileDropzone onIngest={onIngest} loading={loading} />
          <p className="text-muted-foreground">
            {hasData ? (
              <FormattedMessage
                id="session.hero.hasData"
                defaultMessage="Data loaded. Ask a question below to start analyzing, or manage it in the Working set tab."
              />
            ) : (
              <FormattedMessage
                id="session.hero.empty"
                defaultMessage="Drop or select a data file to start analyzing."
              />
            )}
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
//
// ADR-0067 (issue #173): the .textual-card visual rule (padding/bg/border/
// radius) + the per-outcome border-left retired from styles.css onto this
// component as utility + ADR-0050 token. The semantic class hooks
// (.textual-card / .textual-card.{clarify,refuse,failed,cancelled}) are kept on
// the <article> for selector / test stability (Shell.test.tsx queries
// .textual-card.failed); the hook doubles as the variant-utility lookup key.
// Issue #222: shadow-sm lifts the in-content card so it shares one elevation
// language with the floating dialog (shadow-lg) / popover (shadow-md) layer --
// a Tailwind scale utility, not a new --shadow-* token (ADR-0067 (2)).
const TEXTUAL_CARD_BASE =
  "textual-card p-4 bg-card border border-border rounded-lg shadow-sm";
// The variant key set is a closed domain -- Lowercase<TextKind> ("clarify" |
// "refuse") for the Textual arm + "failed" + "cancelled" for the other two
// outcome kinds. A literal-union Record catches key typos at compile time and
// stays exhaustive if TextKind grows, matching the `default: never` pattern
// used by the outcome switch below.
const TEXTUAL_CARD_VARIANT: Record<"clarify" | "refuse" | "failed" | "cancelled", string> = {
  clarify: "border-l-[3px] border-l-primary",
  refuse: "border-l-[3px] border-l-muted-foreground",
  failed: "border-l-[3px] border-l-destructive",
  cancelled: "opacity-60",
};
function TextualOutcomeCard({ turn }: { turn: NonMaterializedTurn }) {
  const intl = useIntl();
  switch (turn.outcome.kind) {
    case "Textual": {
      const { text_kind, body, assumption } = turn.outcome.data;
      const isClarify = text_kind === "Clarify";
      // "clarify" | "refuse" -- the lowercase text_kind is both the kept class
      // hook and the variant-utility lookup key. Cast to the literal union so
      // the TEXTUAL_CARD_VARIANT lookup is exhaustive-checked (TextKind is
      // "Clarify" | "Refuse", so the cast is sound).
      const variantHook = text_kind.toLowerCase() as "clarify" | "refuse";
      return (
        <article className={cn(TEXTUAL_CARD_BASE, variantHook, TEXTUAL_CARD_VARIANT[variantHook])}>
          <h3 className="m-0 mb-2">
            {isClarify ? (
              <FormattedMessage id="thread.outcome.clarify" defaultMessage="Needs clarification" />
            ) : (
              <FormattedMessage id="thread.outcome.refused" defaultMessage="Cannot fulfill" />
            )}
          </h3>
          <p className="textual-body my-1 leading-normal">{body}</p>
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
        <article className={cn(TEXTUAL_CARD_BASE, "failed", TEXTUAL_CARD_VARIANT.failed)}>
          <h3 className="m-0 mb-2">
            <FormattedMessage id="thread.outcome.failed" defaultMessage="Failed" />
          </h3>
          <p className="textual-body my-1 leading-normal">{formatTurnFailure(failure, intl)}</p>
          <TechnicalDetailsFold detail={detail} />
        </article>
      );
    }
    case "Cancelled":
      return (
        <article className={cn(TEXTUAL_CARD_BASE, "cancelled", TEXTUAL_CARD_VARIANT.cancelled)}>
          <h3 className="m-0 mb-2">
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
//
// Panel card chrome for the master/detail sections (issue #184 + #222): bg-card
// + border + rounded-lg + p-4 carry the surface (ADR-0067 (1) .panel layout hook
// + visual utility); shadow-sm shares the elevation language of the workspace
// textual-card / dialog / popover (Tailwind scale, no new token, ADR-0067 (2)).
// Shared by the list and detail sections so the pair reads as one surface.
const PANEL_CARD_BASE = "panel bg-card border rounded-lg shadow-sm p-4";
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
    // ADR-0067 (issue #184): the WorkspaceWorkingSet div carries the .layout
    // grid (280px/1fr two-column master-detail, ADR-0067 Decision 1); both
    // sections share the PANEL_CARD_BASE chrome (defined above). The .layout /
    // .working-set-layout / .panel class hooks stay as anchor points;
    // per-consumer margins live on the consumer, not the shared .layout rule.
    <div className="layout working-set-layout">
      <section className={PANEL_CARD_BASE}>
        <h2>
          <FormattedMessage id="session.workingSet.title" defaultMessage="Working set" />
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
        {shown ? (
          <DatasetDetail
            dataset={shown}
            loading={loading}
            onPrivacyChange={onPrivacyChange}
          />
        ) : (
          <p className="text-muted-foreground">
            <FormattedMessage
              id="session.workingSet.emptyDetail"
              defaultMessage="Select a dataset to see its structure."
            />
          </p>
        )}
      </section>
    </div>
  );
}

// Re-exported for tests that want to assert on the thread type without reaching
// into ../types directly.
export type { ThreadEntry };
