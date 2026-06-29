import { useCallback, useEffect, useState } from "react";
import { FileDropzone } from "./components/FileDropzone";
import { WorkingSetList } from "./components/WorkingSetList";
import { DatasetDetail } from "./components/DatasetDetail";
import { DisclosureBanner } from "./components/DisclosureBanner";
import { GuidedLoadDialog } from "./components/GuidedLoadDialog";
import { QuestionBar } from "./components/QuestionBar";
import { ResultView } from "./components/ResultView";
import {
  activeDataset,
  askQuestion,
  ingestFile,
  ingestFileGuided,
  listWorkingSet,
  renameDataset,
  replaceSource,
  setDatasetPrivacy,
} from "./api";
import { loadErrorMessage } from "./loadErrorMessage";
import type { DatasetDescriptor, GuidanceRequest, SheetGuidance } from "./types";

/** A surfaced error tagged by the operation that produced it, so the displayed
 * prefix matches the action (a rename rejection is never mislabelled a load
 * failure). The backend error crosses IPC as a plain string, so the kind is
 * reconstructed at the call site that knows the operation. */
type AppError = { message: string; kind: "load" | "rename" | "replace" | "privacy" | "ask" };

/** Error prefix per operation kind -- exhaustive over AppError["kind"], so
 * TypeScript catches a missing entry when a new kind is added. */
const ERROR_PREFIX: Record<AppError["kind"], string> = {
  load: "加载失败：",
  rename: "重命名失败：",
  replace: "换源失败：",
  privacy: "隐私设置失败：",
  ask: "提问失败：",
};

/** The most recent materialized turn result, shown in the result pane. */
interface LatestResult {
  referenceName: string;
  assumption: string | null;
}

export default function App() {
  const [datasets, setDatasets] = useState<DatasetDescriptor[]>([]);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  // Pending guided load (ADR-0015): auto-tidy could not confidently rectify, so
  // the explicit header/skip choices must be gathered before loading.
  const [guidance, setGuidance] = useState<{ request: GuidanceRequest; path: string } | null>(
    null,
  );
  const [latestResult, setLatestResult] = useState<LatestResult | null>(null);

  const refresh = useCallback(async () => {
    setDatasets(await listWorkingSet());
    const act = await activeDataset();
    setActiveName(act?.reference_name ?? null);
    setSelected((cur) => cur ?? act?.reference_name ?? null);
  }, []);

  useEffect(() => {
    // Mount-time sync from the Tauri backend (external system -> state): a
    // legitimate one-shot fetch, not the avoidable cascade this rule targets.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  /** Generic mutation hook for simple backend-then-refresh patterns (rename,
   * privacy -- ADR-0037 / ADR-0011). Separates the operation error from a
   * refresh error: a successful backend commit followed by a failed refresh
   * surfaces a distinct message (config saved, display failed to sync), never
   * mislabelling a succeeded operation as a failure. */
  function useSimpleMutation<Args extends unknown[]>(
    kind: AppError["kind"],
    fn: (...args: Args) => Promise<unknown>,
  ) {
    return useCallback(
      async (...args: Args) => {
        setLoading(true);
        setError(null);
        try {
          await fn(...args);
        } catch (e) {
          setError({ message: String(e), kind });
          setLoading(false);
          return;
        }
        try {
          await refresh();
        } catch (refreshErr) {
          setError({
            message: `${ERROR_PREFIX[kind].replace("失败：", "")}已保存，但刷新工作集失败：${String(refreshErr)}`,
            kind,
          });
        }
        setLoading(false);
      },
      [kind, fn],
    );
  }

  const handleIngest = useCallback(
    async (path: string) => {
      setLoading(true);
      setError(null);
      try {
        const outcome = await ingestFile(path);
        if (outcome.kind === "Loaded") {
          await refresh();
          setSelected(outcome.data.reference_name);
        } else if (outcome.kind === "NeedsGuidance") {
          setGuidance({ request: outcome.data, path });
        } else {
          setError({ message: loadErrorMessage(outcome.data), kind: "load" });
        }
      } catch (e) {
        setError({ message: String(e), kind: "load" });
      } finally {
        setLoading(false);
      }
    },
    [refresh],
  );

  const handleGuidedSubmit = useCallback(
    async (sheetGuidance: SheetGuidance[]) => {
      if (!guidance) return;
      const { path } = guidance;
      setLoading(true);
      setError(null);
      try {
        const outcome = await ingestFileGuided(path, sheetGuidance);
        if (outcome.kind === "Loaded") {
          setGuidance(null);
          await refresh();
          setSelected(outcome.data.reference_name);
        } else if (outcome.kind === "Error") {
          setError({ message: loadErrorMessage(outcome.data), kind: "load" });
        } else {
          // NeedsGuidance should not recur after an explicit header pick.
          setError({
            message: "仍无法规整此工作表，请调整表头选择后重试",
            kind: "load",
          });
        }
      } catch (e) {
        setError({ message: String(e), kind: "load" });
      } finally {
        setLoading(false);
      }
    },
    [guidance, refresh],
  );

  const handleRename = useSimpleMutation("rename", renameDataset);

  // Re-upload a file onto an existing dataset reference name (ADR-0042, issue
  // #11): a fresh snapshot takes over the name. Distinct from handleIngest
  // (add) -- the reference name to take over is explicit. The reference name is
  // unchanged, so `selected` stays valid; refresh picks up the swapped
  // descriptor. Errors are tagged "replace" so the prefix matches the action
  // (never mislabelled a load failure).
  const handleReplace = useCallback(
    async (referenceName: string, path: string) => {
      setLoading(true);
      setError(null);
      try {
        const outcome = await replaceSource(referenceName, path);
        if (outcome.kind === "Loaded") {
          await refresh();
          setSelected(outcome.data.reference_name);
        } else if (outcome.kind === "NeedsGuidance") {
          // Structured replace never yields NeedsGuidance; defensive guard.
          setError({
            message: "换源暂不支持需规整引导的文件，请改用结构化文件",
            kind: "replace",
          });
        } else {
          setError({ message: loadErrorMessage(outcome.data), kind: "replace" });
        }
      } catch (e) {
        setError({ message: String(e), kind: "replace" });
      } finally {
        setLoading(false);
      }
    },
    [refresh],
  );

  // Apply a privacy config to a dataset (ADR-0011, issue #9 slice 5): the whole
  // new config crosses IPC, the backend swaps it on the descriptor, and refresh
  // picks up the updated working set (single source of truth). Tagged "privacy"
  // so the error prefix matches the action (never mislabelled a load failure).
  const handlePrivacyChange = useSimpleMutation("privacy", setDatasetPrivacy);

  // Ask one question (issue #22): the orchestrator materializes result_N, which
  // enters the working set and is shown in the result pane. Tagged "ask" so a
  // failure prefix matches the action (never mislabelled a load failure).
  const handleAsk = useCallback(
    async (question: string) => {
      setLoading(true);
      setError(null);
      try {
        const outcome = await askQuestion(question);
        if (outcome.kind === "Materialized") {
          const referenceName = outcome.data.dataset.reference_name;
          // The turn already materialized result_N into the working set, so
          // select it before refresh -- the user sees the result even when the
          // working-set sync fails. A refresh failure is reported distinctly
          // (never mislabel a successful turn as a failed ask), matching the
          // operation-vs-refresh separation useSimpleMutation enforces elsewhere.
          setLatestResult({
            referenceName,
            assumption: outcome.data.assumption,
          });
          setSelected(referenceName);
          try {
            await refresh();
          } catch (e) {
            setError({
              message: `结果已生成，但工作集刷新失败：${String(e)}`,
              kind: "ask",
            });
          }
        }
      } catch (e) {
        setError({ message: String(e), kind: "ask" });
      } finally {
        setLoading(false);
      }
    },
    [refresh],
  );

  const shown = datasets.find((d) => d.reference_name === selected) ?? null;

  return (
    <main>
      <header>
        <h1>toptopduck</h1>
        <DisclosureBanner />
      </header>

      <FileDropzone onIngest={handleIngest} loading={loading} />
      {error && (
        <p className="error">
          {ERROR_PREFIX[error.kind]}{error.message}
        </p>
      )}

      <QuestionBar onSubmit={handleAsk} loading={loading} />
      {latestResult && (
        <section className="panel">
          <ResultView
            key={latestResult.referenceName}
            referenceName={latestResult.referenceName}
            assumption={latestResult.assumption}
          />
        </section>
      )}

      <div className="layout">
        <section className="panel">
          <h2>工作集</h2>
          <WorkingSetList
            datasets={datasets}
            activeName={activeName}
            onSelect={setSelected}
            onRename={handleRename}
            onReplace={handleReplace}
            loading={loading}
          />
        </section>
        <section className="panel">
          {shown ? (
            <DatasetDetail
              dataset={shown}
              loading={loading}
              onPrivacyChange={handlePrivacyChange}
            />
          ) : (
            <p className="muted">选择一个数据集查看其结构。</p>
          )}
        </section>
      </div>

      {guidance && (
        <GuidedLoadDialog
          request={guidance.request}
          loading={loading}
          onSubmit={handleGuidedSubmit}
          onCancel={() => setGuidance(null)}
        />
      )}
    </main>
  );
}
