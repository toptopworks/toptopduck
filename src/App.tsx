import { useCallback, useEffect, useState } from "react";
import { FileDropzone } from "./components/FileDropzone";
import { WorkingSetList } from "./components/WorkingSetList";
import { DatasetDetail } from "./components/DatasetDetail";
import { DisclosureBanner } from "./components/DisclosureBanner";
import { GuidedLoadDialog } from "./components/GuidedLoadDialog";
import {
  activeDataset,
  ingestFile,
  ingestFileGuided,
  listWorkingSet,
  renameDataset,
} from "./api";
import { loadErrorMessage } from "./loadErrorMessage";
import type { DatasetDescriptor, GuidanceRequest, SheetGuidance } from "./types";

/** A surfaced error tagged by the operation that produced it, so the displayed
 * prefix matches the action (a rename rejection is never mislabelled a load
 * failure). The backend's RenameError crosses IPC as a plain string, so the
 * kind is reconstructed at the call site that knows the operation. */
type AppError = { message: string; kind: "load" | "rename" };

export default function App() {
  const [datasets, setDatasets] = useState<DatasetDescriptor[]>([]);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  // Pending guided load (ADR-0015): auto-tidy couldn't confidently rectify, so
  // the user's explicit header/skip choices must be gathered before loading.
  const [guidance, setGuidance] = useState<{ request: GuidanceRequest; path: string } | null>(
    null,
  );

  const refresh = useCallback(async () => {
    setDatasets(await listWorkingSet());
    const act = await activeDataset();
    setActiveName(act?.reference_name ?? null);
    setSelected((cur) => cur ?? act?.reference_name ?? null);
  }, []);

  useEffect(() => {
    // Mount-time sync from the Tauri backend (external system → state): a
    // legitimate one-shot fetch, not the avoidable cascade this rule targets.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

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
          // NeedsGuidance shouldn't recur after an explicit header pick.
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

  const handleRename = useCallback(
    async (referenceName: string, newDisplay: string) => {
      setError(null);
      setLoading(true);
      try {
        await renameDataset(referenceName, newDisplay);
        await refresh();
        // `selected` is keyed by the stable reference name, so it survives the
        // display rename -- the UI-level proof of the ADR-0037 decoupling.
      } catch (e) {
        setError({ message: String(e), kind: "rename" });
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
          {error.kind === "load" ? "加载失败：" : "重命名失败："}
          {error.message}
        </p>
      )}

      <div className="layout">
        <section className="panel">
          <h2>工作集</h2>
          <WorkingSetList
            datasets={datasets}
            activeName={activeName}
            onSelect={setSelected}
            onRename={handleRename}
            loading={loading}
          />
        </section>
        <section className="panel">
          {shown ? (
            <DatasetDetail dataset={shown} />
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
