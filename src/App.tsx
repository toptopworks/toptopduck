import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { LogicalPosition, LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { ActiveSourceDeleteDialog } from "./components/ActiveSourceDeleteDialog";
import { FileDropzone } from "./components/FileDropzone";
import { WorkingSetList } from "./components/WorkingSetList";
import { DatasetDetail } from "./components/DatasetDetail";
import { DisclosureBanner } from "./components/DisclosureBanner";
import { GuidedLoadDialog } from "./components/GuidedLoadDialog";
import { QuestionBar } from "./components/QuestionBar";
import { ResultView } from "./components/ResultView";
import { SettingsDialog } from "./components/SettingsDialog";
import { Thread } from "./components/Thread";
import {
  activeDataset,
  askQuestion,
  cancelQuery,
  conversation,
  fmtError,
  getAppConfig,
  getProviderConfig,
  ingestFile,
  ingestFileGuided,
  listWorkingSet,
  openDuck,
  onResumeProgress,
  recordRecentFile,
  renameDataset,
  removeSource,
  removeActiveSource,
  replaceSource,
  saveAsDuck,
  setAppConfig,
  setDatasetPrivacy,
  takePersistError,
} from "./api";
import { loadErrorMessage } from "./loadErrorMessage";
import type {
  AppConfig,
  DatasetDescriptor,
  GuidanceRequest,
  ResumeEvent,
  SheetGuidance,
  StaleAnchor,
  Theme,
  ThreadEntry,
  VizSpec,
} from "./types";

/** A surfaced error tagged by the operation that produced it, so the displayed
 * prefix matches the action (a rename rejection is never mislabelled a load
 * failure). The backend error crosses IPC as a plain string, so the kind is
 * reconstructed at the call site that knows the operation. */
type AppError = {
  message: string;
  kind: "load" | "rename" | "replace" | "delete" | "privacy" | "ask";
};

/** Error prefix per operation kind -- exhaustive over AppError["kind"], so
 * TypeScript catches a missing entry when a new kind is added. */
const ERROR_PREFIX: Record<AppError["kind"], string> = {
  load: "加载失败：",
  rename: "重命名失败：",
  replace: "换源失败：",
  delete: "删源失败：",
  privacy: "隐私设置失败：",
  ask: "提问失败：",
};

/** The most recent materialized turn result, shown in the result pane. */
interface LatestResult {
  referenceName: string;
  assumption: string | null;
  /** The turn's viz spec (ADR-0016/0033): null = plain table; a spec the
   * ResultView renders or degrades to the table with a disclosure. Carried so a
   * re-selected past result re-renders its chart too. */
  viz: VizSpec | null;
}

/** Acquire the main window, or `null` when the Tauri bridge is absent (jsdom
 * tests). Every window-geometry call site is a no-op without it -- geometry
 * persistence is a convenience, never a correctness surface, so a missing
 * bridge must never crash the render. */
function safeMainWindow(): ReturnType<typeof getCurrentWindow> | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export default function App() {
  const [datasets, setDatasets] = useState<DatasetDescriptor[]>([]);
  // Issue #40 stale-cascade: result_N whose upstream source was removed stay
  // in the working set (visible, ADR-0013) but carry a stale anchor. Keyed by
  // reference name so the Thread can badge stale results without each
  // TurnRecord snapshot re-fetching current state. Rebuilt per render -- the
  // working set is small and this dodges a useMemo for a trivial derivation.
  const staleByReference = new Map<string, StaleAnchor>();
  for (const d of datasets) if (d.stale) staleByReference.set(d.reference_name, d.stale);
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
  // The always-visible conversation thread (ADR-0028/0039/0040): the unified
  // timeline of turns AND source lifecycle events, in order. The session is the
  // source of truth; this is refetched after each turn / source mutation so all
  // entry kinds render.
  const [thread, setThread] = useState<ThreadEntry[]>([]);
  // LLM provider key status (issue #29, ADR-0029): whether an API key is
  // stored. A boolean only -- the key itself never crosses to the frontend.
  // When false, ask turns fail as not-wired until the user configures a key in
  // the settings dialog; this indicator guides them there.
  const [hasKey, setHasKey] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Pending active-source delete (issue #39, ADR-0035): when the user removes
  // the current focus source while other sources remain, this holds the target
  // while the confirm dialog collects an explicit continuation. null = no
  // dialog open. Nothing crosses IPC while this is set -- cancel is a true
  // no-op (AC3).
  const [pendingActiveDelete, setPendingActiveDelete] =
    useState<DatasetDescriptor | null>(null);
  // Resume progress (issue #48, ADR-0034 visible progress): the textual status
  // line shown while Session::open_duck re-reads sources + re-executes the
  // productive chain. null when no resume is running. Updates come from the
  // backend `resume-progress` Tauri event.
  const [resumeStatus, setResumeStatus] = useState<string | null>(null);
  // persistenceBusy (review H6): blocks both save/open buttons for the ENTIRE
  // handler -- including the native dialog window -- not just the post-dialog
  // invoke. Without it the buttons stay enabled while the OS dialog is open
  // and a user can trigger both handlers concurrently; two invokes then race
  // the session mutex and the resume-progress listener.
  const [persistenceBusy, setPersistenceBusy] = useState(false);
  // persistError (review H4): the most recent per-turn save failure, shown as
  // a non-blocking banner. The in-memory turn always advances, so without this
  // signal the user has no way to learn the disk fell behind -- closing the
  // app in that window loses the unsaved turns. Cleared by the next clean poll.
  const [persistError, setPersistError] = useState<string | null>(null);
  // App-level config (issue #53, ADR-0038): preferences, window geometry, recent
  // files, and the no-key endpoint config. null until the first getAppConfig
  // resolves. The theme + window geometry apply on load; the recent-files list
  // renders in the header. A read failure honest-degrades server-side, so this
  // always resolves to a usable AppConfig.
  const [appConfig, setAppConfigState] = useState<AppConfig | null>(null);
  // Latest AppConfig behind a ref so the debounced window-geometry persist
  // writes the freshest values without depending on stale state in its closure.
  const appConfigRef = useRef<AppConfig | null>(null);
  // Avoid restoring window geometry more than once: the first time appConfig
  // lands, apply the stored size/position; later loads (after a save) must NOT
  // re-apply (would snap the user's just-resized window back).
  const geometryRestoredRef = useRef(false);

  /** Poll the backend for the most recent per-turn persistence failure
   * (review H4). Called at the end of every mutating handler so a dropped
   * save surfaces here instead of relying on the next successful write to
   * silently self-heal. Best-effort: an IPC failure here is swallowed rather
   * than shown as a separate error (it must not mask the real operation). */
  const pollPersistError = useCallback(async () => {
    try {
      setPersistError(await takePersistError());
    } catch {
      // swallow -- persist-status polling must not surface its own failure
    }
  }, []);

  const refresh = useCallback(async () => {
    setDatasets(await listWorkingSet());
    const act = await activeDataset();
    setActiveName(act?.reference_name ?? null);
    setSelected((cur) => cur ?? act?.reference_name ?? null);
    setThread(await conversation());
  }, []);

  // Refresh the LLM key-configured indicator (issue #29). Called on mount and
  // after the settings dialog closes (a save/clear changes the stored key). A
  // failure is non-fatal -- the indicator just stays stale and an ask surfaces
  // the real error, so it is swallowed rather than surfacing as a top-level
  // app error.
  const refreshKeyStatus = useCallback(async () => {
    try {
      setHasKey((await getProviderConfig()).has_key);
    } catch {
      // Keep the previous indicator; the ask path surfaces real failures.
    }
  }, []);

  useEffect(() => {
    // Mount-time sync from the Tauri backend (external system -> state): a
    // legitimate one-shot fetch, not the avoidable cascade this rule targets.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    // refreshKeyStatus swallows its own errors, so no disable is needed here.
    void refreshKeyStatus();
    // Load app-config (ADR-0038): theme + window geometry + recent files. Errors
    // are swallowed server-side (honest-degrade), so a reject here is an IPC
    // fault -- non-fatal, the app keeps defaults-equivalent null state.
    void getAppConfig()
      .then((cfg) => {
        appConfigRef.current = cfg;

        setAppConfigState(cfg);
      })
      .catch(() => {
        // Keep null; theme defaults to "system" (no attribute), no recent files.
      });
  }, [refresh, refreshKeyStatus]);

  /** Push `cfg` into state + ref and persist it atomically. Centralizes the
   * "mutate AppConfig" flow so every caller keeps state, ref, and disk aligned.
   * A persist failure surfaces as a top-level error tagged "load" (the closest
   * existing kind -- there is no dedicated "settings" kind yet). */
  const commitAppConfig = useCallback(async (cfg: AppConfig): Promise<void> => {
    appConfigRef.current = cfg;
    setAppConfigState(cfg);
    await setAppConfig(cfg);
  }, []);

  /** Apply the theme to the document root (ADR-0050). "system" clears the
   * attribute so the OS preference + CSS media query decide; light/dark set the
   * data-theme attribute the stylesheet keys off. The actual color CSS is wired
   * per ADR-0050; this slice persists + restores the choice. */
  useEffect(() => {
    const theme: Theme = appConfig?.theme ?? "system";
    const root = document.documentElement;
    if (theme === "system") {
      delete root.dataset.theme;
    } else {
      root.dataset.theme = theme;
    }
  }, [appConfig?.theme]);

  /** Restore the persisted window geometry ONCE on the first app-config load
   * (ADR-0038). Guarded: the Tauri window API is absent in jsdom, so every call
   * is wrapped to no-op on failure rather than crash the render. Later loads
   * (after a save) skip restore -- re-applying would snap a just-resized window
   * back to the stored value. */
  useEffect(() => {
    if (!appConfig || geometryRestoredRef.current) return;
    const win = safeMainWindow();
    if (!win) return;
    geometryRestoredRef.current = true;
    const { width, height, x, y, maximized } = appConfig.window;
    if (maximized) {
      void win.maximize().catch(() => {});
    } else {
      void win
        .setSize(new LogicalSize(width, height))
        .then(async () => {
          if (x !== null && y !== null) {
            await win.setPosition(new LogicalPosition(x, y)).catch(() => {});
          }
        })
        .catch(() => {});
    }
  }, [appConfig]);

  /** Persist window geometry on resize/move, debounced (ADR-0038). Each event
   * reads the live size/position from the Tauri window and patches the latest
   * AppConfig via read-modify-write. Guarded so a missing window API (jsdom) or
   * an IPC fault never surfaces -- geometry persistence is a convenience, never
   * a correctness surface. */
  useEffect(() => {
    const win = safeMainWindow();
    if (!win) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      Promise.all([win.innerSize(), win.outerPosition(), win.isMaximized()])
        .then(([size, pos, maximized]) => {
          const base = appConfigRef.current;
          if (!base) return;
          const next: AppConfig = {
            ...base,
            window: {
              width: size.width,
              height: size.height,
              x: pos.x,
              y: pos.y,
              maximized,
            },
          };
          // Fire-and-forget: a failure here must not loop or surface.
          void commitAppConfig(next).catch(() => {});
        })
        .catch(() => {});
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 500);
    };
    const unresizedP = win.onResized(schedule).catch(() => () => {});
    const unmovedP = win.onMoved(schedule).catch(() => () => {});
    return () => {
      if (timer) clearTimeout(timer);
      void unresizedP.then((un) => un()).catch(() => {});
      void unmovedP.then((un) => un()).catch(() => {});
    };
  }, [commitAppConfig]);

  /** Refresh the recent-files list from the backend after a save/open records a
   * new path. Swallows errors -- the list is advisory. */
  const refreshRecentFiles = useCallback(async () => {
    try {
      const cfg = await getAppConfig();
      appConfigRef.current = cfg;
      setAppConfigState(cfg);
    } catch {
      // advisory; leave the stale list.
    }
  }, []);

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
          setError({ message: fmtError(e), kind });
          setLoading(false);
          void pollPersistError();
          return;
        }
        try {
          await refresh();
        } catch (refreshErr) {
          setError({
            message: `${ERROR_PREFIX[kind].replace("失败：", "")}已保存，但刷新工作集失败：${fmtError(refreshErr)}`,
            kind,
          });
        }
        setLoading(false);
        void pollPersistError();
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
        setError({ message: fmtError(e), kind: "load" });
      } finally {
        setLoading(false);
        void pollPersistError();
      }
    },
    [refresh, pollPersistError],
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
        setError({ message: fmtError(e), kind: "load" });
      } finally {
        setLoading(false);
        void pollPersistError();
      }
    },
    [guidance, refresh, pollPersistError],
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
        setError({ message: fmtError(e), kind: "replace" });
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

  // Plain remove path (issue #38/#39, ADR-0040): the backend detaches the
  // snapshot, deletes its file, drops the reference name, and appends a Deleted
  // source lifecycle event. Used for non-active sources and for the LAST active
  // source (AC4 -> empty working set). Tagged "delete" so the error prefix
  // matches the action (an IsActive refusal is never mislabelled
  // a load failure). The shared `loading` flag disables source management while
  // the (synchronous, lock-held) removal runs and -- via the same flag set by
  // handleAsk -- while a turn is in flight (ADR-0040 execution window).
  const handleRemoveSource = useSimpleMutation("delete", removeSource);

  // Issue #39 / ADR-0035: deleting the ACTIVE source while others remain would
  // silently move the user's focus. Route those deletes through the confirm
  // dialog (the user picks an explicit continuation in `pendingActiveDelete`);
  // any non-active source, or the last active source, goes straight through the
  // plain remove path. The frontend already knows active + remaining from
  // list/active, so it branches without waiting for the backend's IsActive
  // refusal -- but `removeSource` still refuses on the IPC boundary, so a
  // direct call or a stale view cannot silently slip past.
  const handleDelete = useCallback(
    (referenceName: string) => {
      if (referenceName === activeName && datasets.length > 1) {
        const target = datasets.find((d) => d.reference_name === referenceName);
        if (target) {
          setPendingActiveDelete(target);
          return;
        }
      }
      void handleRemoveSource(referenceName);
    },
    [activeName, datasets, handleRemoveSource],
  );

  // AC2 (issue #39): the user picked a continuation -- delete the active source
  // and repoint focus at it in one atomic IPC. Success closes the dialog; a
  // refusal (stale view / IsActive) keeps it open so the error stays
  // attached to the same action. Mirrors useSimpleMutation's two-error split
  // (commit ok vs refresh failed) but is hand-written so it can clear the
  // pending dialog state on a committed success.
  const handleConfirmActiveDelete = useCallback(
    async (continueWith: string) => {
      const target = pendingActiveDelete;
      if (!target) return;
      setLoading(true);
      setError(null);
      try {
        await removeActiveSource(target.reference_name, continueWith);
      } catch (e) {
        setError({ message: fmtError(e), kind: "delete" });
        setLoading(false);
        return;
      }
      setPendingActiveDelete(null);
      try {
        await refresh();
      } catch (refreshErr) {
        setError({
          message: `删源已保存，但刷新工作集失败：${fmtError(refreshErr)}`,
          kind: "delete",
        });
      }
      setLoading(false);
    },
    [pendingActiveDelete, refresh],
  );

  // AC3 (issue #39): cancel leaves the working set untouched -- nothing crossed
  // IPC while the dialog was open, so just drop the pending state.
  const handleCancelActiveDelete = useCallback(() => {
    setPendingActiveDelete(null);
  }, []);

  // Ask one question (PRD #1, issue #23): run one turn -> one ADR-0028 outcome.
  // The retry loop is invisible (one question = one thread entry = one outcome).
  // A result enters the working set + result pane; textual / failed / cancelled
  // turns still appear in the thread (always visible) but touch no working set.
  // Tagged "ask" so a failure prefix matches the action (never mislabelled a
  // load failure).
  const handleAsk = useCallback(
    async (question: string) => {
      setLoading(true);
      setError(null);
      try {
        const outcome = await askQuestion(question);
        if (outcome.kind === "Materialized") {
          const referenceName = outcome.data.dataset.reference_name;
          // Select before refresh -- the user sees the result even when the
          // working-set sync fails. A refresh failure is reported distinctly
          // (never mislabel a successful turn as a failed ask).
          setLatestResult({
            referenceName,
            assumption: outcome.data.assumption,
            viz: outcome.data.viz,
          });
          setSelected(referenceName);
          try {
            await refresh(); // working set + thread
          } catch (e) {
            setError({ message: `结果已生成，但工作集刷新失败：${fmtError(e)}`, kind: "ask" });
          }
        } else {
          // Textual / failed / cancelled: no working-set change, only the thread.
          try {
            setThread(await conversation());
          } catch (e) {
            setError({ message: `对话刷新失败：${fmtError(e)}`, kind: "ask" });
          }
        }
      } catch (e) {
        setError({ message: fmtError(e), kind: "ask" });
      } finally {
        setLoading(false);
        // Surface a per-turn save failure (review H4): the ask just wrote (or
        // tried to write) the recipe, so this is the right poll point.
        void pollPersistError();
      }
    },
    [refresh, pollPersistError],
  );

  // Re-show a past result turn's rows in the result pane (ADR-0028 always-
  // visible history: any result in the thread is re-openable). Preserves the
  // turn's assumption side note and viz spec across re-selections.
  const handleSelectResult = useCallback(
    (referenceName: string, assumption: string | null, viz: VizSpec | null) => {
      setLatestResult({ referenceName, assumption, viz });
      setSelected(referenceName);
    },
    [],
  );

  // Cancel the in-flight turn (ADR-0021, issue #28). Fires the backend cancel
  // token, which interrupts the running DuckDB query; the in-flight ask then
  // resolves as a Cancelled outcome and handleAsk's finally clears loading.
  // Best-effort: a cancel that fails to dispatch is surfaced but does not wedge
  // the input -- the ask itself still resolves (Cancelled or otherwise) and
  // clears loading on its own.
  const handleCancel = useCallback(async () => {
    try {
      await cancelQuery();
    } catch (e) {
      setError({ message: fmtError(e), kind: "ask" });
    }
  }, []);

  // Save the live session to a .duck path (issue #48, ADR-0034). After this
  // every terminal turn / source event atomically rewrites the recipe; the
  // session name defaults to the file stem. A cancel (empty path) is a no-op.
  const handleSaveAs = useCallback(async () => {
    setPersistenceBusy(true);
    try {
      const path = await saveDialog({
        filters: [{ name: "toptopduck", extensions: ["duck"] }],
      });
      if (!path) return;
      const stem =
        path.split(/[\\/]/).pop()?.replace(/\.duck$/i, "") ?? "session";
      setLoading(true);
      setError(null);
      try {
        await saveAsDuck(path, stem);
        // Record into the app-config recent-files list (issue #53). Fire-and-
        // forget + refresh so the list renders the new entry; a failure is
        // swallowed inside the backend (advisory).
        void recordRecentFile(path).then(() => void refreshRecentFiles());
        await refresh();
      } catch (e) {
        setError({ message: fmtError(e), kind: "load" });
      } finally {
        setLoading(false);
        void pollPersistError();
      }
    } finally {
      setPersistenceBusy(false);
    }
  }, [refresh, pollPersistError, refreshRecentFiles]);

  // Open a .duck and resume the session across the restart boundary
  // (issue #48, ADR-0034). Resume runs off the UI thread; the resume-progress
  // event drives the status line, and on completion the working set / thread
  // / active are refreshed from the resumed backend session. A cancel (no file
  // picked) is a no-op. The recent-files list (issue #53) reuses
  // openDuckByPath for click-to-open without the OS dialog.
  const openDuckByPath = useCallback(
    async (path: string) => {
      setLoading(true);
      setError(null);
      // Subscribe BEFORE openDuck so the first Source event is never missed
      // (review H5). open_duck spawns a blocking task that emits progress
      // immediately on entry -- if we awaited openDuck first, the first event
      // would land with no listener attached (listen() is an async IPC round
      // trip). Resume status stays null until the listener is confirmed.
      const unlisten = await onResumeProgress((ev: ResumeEvent) => {
        if ("Source" in ev) {
          setResumeStatus(
            `校验源 ${ev.Source.index}/${ev.Source.total}：${ev.Source.reference_name}`,
          );
        } else if ("Replay" in ev) {
          setResumeStatus(
            `重放 ${ev.Replay.index}/${ev.Replay.total}：${ev.Replay.reference_name}`,
          );
        }
      });
      setResumeStatus("正在打开…");
      try {
        await openDuck(path);
        // Record into the recent-files list (issue #53). Fire-and-forget +
        // refresh; a failure is swallowed inside the backend (advisory).
        void recordRecentFile(path).then(() => void refreshRecentFiles());
        setResumeStatus(null);
        setLatestResult(null);
        await refresh();
      } catch (e) {
        setError({ message: fmtError(e), kind: "load" });
        setResumeStatus(null);
      } finally {
        void unlisten();
        setLoading(false);
        void pollPersistError();
      }
    },
    [refresh, pollPersistError, refreshRecentFiles],
  );

  const handleOpenDuck = useCallback(async () => {
    setPersistenceBusy(true);
    try {
      const selected = await openDialog({
        filters: [{ name: "toptopduck", extensions: ["duck"] }],
        multiple: false,
      });
      const path = typeof selected === "string" ? selected : null;
      if (!path) return;
      await openDuckByPath(path);
    } finally {
      setPersistenceBusy(false);
    }
  }, [openDuckByPath]);

  /** Open a recent file by its stored path (issue #53). Same resume flow as the
   * OS-dialog open, minus the dialog. A path that fails to resume (moved /
   * deleted) surfaces the normal open error; the entry stays in the list so the
   * user can retry or ignore it. */
  const handleOpenRecent = useCallback(
    (path: string) => {
      void openDuckByPath(path);
    },
    [openDuckByPath],
  );

  const shown = datasets.find((d) => d.reference_name === selected) ?? null;

  return (
    <main>
      <header>
        <h1>toptopduck</h1>
        <DisclosureBanner />
        <div className="header-actions">
          <button
            onClick={() => void handleOpenDuck()}
            disabled={loading || persistenceBusy || resumeStatus !== null}
            title="打开 .duck 恢复此前的分析"
          >
            打开 .duck
          </button>
          <button
            onClick={() => void handleSaveAs()}
            disabled={loading || persistenceBusy || resumeStatus !== null}
            title="把当前会话另存为 .duck（之后每轮自动保存）"
          >
            另存为 .duck
          </button>
          <span className={hasKey ? "key-ok" : "key-missing"}>
            {hasKey ? "LLM key 已配置" : "未配置 LLM key——提问将失败"}
          </span>
          <button onClick={() => setSettingsOpen(true)}>设置</button>
        </div>
        {resumeStatus && (
          <p className="resume-progress" role="status" aria-live="polite">
            {resumeStatus}
          </p>
        )}
        {persistError && (
          <p className="persist-warning" role="status">
            自动保存失败：{persistError}（内存中的最新更改未写入磁盘，关闭 app 前请重试保存）
          </p>
        )}
        {appConfig && appConfig.recent_files.length > 0 && (
          <nav className="recent-files" aria-label="最近文件">
            <span className="muted">最近：</span>
            {appConfig.recent_files.map((p) => {
              const base = p.split(/[\\/]/).pop()?.replace(/\.duck$/i, "") ?? p;
              return (
                <button
                  key={p}
                  className="recent-file"
                  title={p}
                  disabled={loading || persistenceBusy || resumeStatus !== null}
                  onClick={() => handleOpenRecent(p)}
                >
                  {base}
                </button>
              );
            })}
          </nav>
        )}
      </header>

      <FileDropzone onIngest={handleIngest} loading={loading} />
      {error && (
        <p className="error">
          {ERROR_PREFIX[error.kind]}{error.message}
        </p>
      )}

      <QuestionBar onSubmit={handleAsk} onCancel={handleCancel} loading={loading} />
      <Thread
        entries={thread}
        selectedResult={latestResult?.referenceName ?? null}
        onSelectResult={handleSelectResult}
        staleByReference={staleByReference}
      />
      {latestResult && (
        <section className="panel">
          <ResultView
            key={latestResult.referenceName}
            referenceName={latestResult.referenceName}
            assumption={latestResult.assumption}
            viz={latestResult.viz}
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
            onDelete={handleDelete}
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

      {pendingActiveDelete && (
        <ActiveSourceDeleteDialog
          target={pendingActiveDelete}
          // AC5: every remaining dataset but the removed one. On the live path
          // this dialog only opens in the no-result case (activeName resolves to
          // a source), so these ARE the remaining sources. A stale view that
          // opens it while a result exists is refused by the backend's
          // The DatasetDescriptor carries no source/result flag, so the
          // frontend cannot pre-filter result_N out of the candidate list
          // without a round-trip -- the backend's set_active rejects a result
          // name as InvalidContinueWith if the user picks one.
          candidates={datasets.filter(
            (d) => d.reference_name !== pendingActiveDelete.reference_name,
          )}
          onConfirm={(cw) => void handleConfirmActiveDelete(cw)}
          onCancel={handleCancelActiveDelete}
        />
      )}

      {settingsOpen && appConfig && (
        <SettingsDialog
          appConfig={appConfig}
          onCommitAppConfig={(cfg) => void commitAppConfig(cfg)}
          // Closing the dialog also refreshes the key indicator, so a save or
          // clear is reflected in the header status immediately.
          onClose={() => {
            setSettingsOpen(false);
            void refreshKeyStatus();
          }}
        />
      )}
    </main>
  );
}
