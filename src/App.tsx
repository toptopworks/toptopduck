import { useCallback, useEffect, useState } from "react";
import { FileDropzone } from "./components/FileDropzone";
import { WorkingSetList } from "./components/WorkingSetList";
import { DatasetDetail } from "./components/DatasetDetail";
import { DisclosureBanner } from "./components/DisclosureBanner";
import { GuidedLoadDialog } from "./components/GuidedLoadDialog";
import { activeDataset, ingestFile, ingestFileGuided, listWorkingSet } from "./api";
import type { DatasetDescriptor, GuidanceRequest, LoadError, SheetGuidance } from "./types";

function loadErrorMessage(err: LoadError): string {
  if (err === "LegacyExcel") {
    return "不支持 .xls 格式（仅支持 .xlsx），请在 Excel 中另存为 .xlsx 后重试";
  }
  if ("UnsupportedFormat" in err) {
    return err.UnsupportedFormat.requested
      ? `不支持的格式：${err.UnsupportedFormat.requested}（支持 .csv / .parquet / .json / .xlsx）`
      : "无法识别的格式";
  }
  if ("Parse" in err) return err.Parse.detail;
  if ("Io" in err) return err.Io.detail;
  return err.Other.detail;
}

export default function App() {
  const [datasets, setDatasets] = useState<DatasetDescriptor[]>([]);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        if ("Loaded" in outcome) {
          await refresh();
          setSelected(outcome.Loaded.reference_name);
        } else if ("NeedsGuidance" in outcome) {
          setGuidance({ request: outcome.NeedsGuidance, path });
        } else {
          setError(loadErrorMessage(outcome.Error));
        }
      } catch (e) {
        setError(String(e));
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
        if ("Loaded" in outcome) {
          setGuidance(null);
          await refresh();
          setSelected(outcome.Loaded.reference_name);
        } else if ("Error" in outcome) {
          setError(loadErrorMessage(outcome.Error));
        } else {
          // NeedsGuidance shouldn't recur after an explicit header pick.
          setError("仍无法规整此工作表，请调整表头选择后重试");
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [guidance, refresh],
  );

  const shown = datasets.find((d) => d.reference_name === selected) ?? null;

  return (
    <main>
      <header>
        <h1>toptopduck</h1>
        <DisclosureBanner />
      </header>

      <FileDropzone onIngest={handleIngest} loading={loading} />
      {error && <p className="error">加载失败：{error}</p>}

      <div className="layout">
        <section className="panel">
          <h2>工作集</h2>
          <WorkingSetList
            datasets={datasets}
            activeName={activeName}
            onSelect={setSelected}
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
