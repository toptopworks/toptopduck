// The workspace datasets seam (#1519, ADR-0123's mirror on the shared face):
// ONE owner for the mutation family + the batch feedback machine that four
// hand-written copies previously dispersed (the dialog's pickAndAdd loop and
// onReplace, SessionPane.trackReplace, useIngestFlow.runBatchSegment). The
// drift bugs that motivated it (#1488/#1490/#1491/#1492) all landed on the
// shared face; the private face stopped its bug flow once useWorkingSet took
// ownership (ADR-0123), and this module applies the same shape here: the
// mutations, the batch clock, the flight identity gate, the settle machine,
// the failure routing, the upload badge map, and the row pending counts all
// live inside this module; the panel (WorkspaceDatasetsDialog) is a consumer
// shell -- actions, a read snapshot, rendering. One deliberate deviation from
// ADR-0123 Decision 2: the detail pick lives here too, not in the consumer --
// that ruling kept a TAB-level seam pick with its tab (the pick survives the
// tab remounts there); the panel is a per-open modal whose pick has no reader
// outside it, so the consumer-shell posture wins here.
//
// The invariants the copies previously synced by long comments are now
// structural:
// - ONE batch clock per wait window: the add batch stamps `startedAt` once at
//   its entry; every per-file badge reuses it (a per-file clock would visibly
//   reset per file, issue #1485), and the done badge freezes the total
//   duration read at settle time (outside the state updater, so the elapsed
//   measures the batch, not React's commit).
// - The minted identity freezes at fire time: every action binds the IPC
//   target, the invalidation target, and the toast attribution to the
//   workspace the click fired in (render const), never the live panel
//   (#1491) -- TanStack's hot-swapped options closures made that work by
//   accident of placement; here the flight closure simply owns it.
// - A failed file never reads as added: the add batch's done face names the
//   LAST LANDED file, a whole-failed batch parks no badge, and the failure
//   routes by where the panel stands at SETTLE time (#1490) -- on-site the
//   banner owns the face, offsite (closed or rebound) a destructive toast
//   carries it attributed to the origin workspace, so the reopen edge has
//   nothing to destroy unread.
// - The pending counts are module-internal facts, not cache archaeology
//   (#1492): each flight bumps a per-workspace counter at fire time and
//   decrements in its own finally, so a superseding fire on a rebind can
//   never unlock another workspace's rows -- there is no shared slot to
//   supersede, and the `variables`-cast + mutationCache scan this retires
//   had no type enforcement (a sixth mutation forgetting `workspace` would
//   silently count 0).
//
// The unified progress content model (BatchProgress, #1519) is exported
// here: the three per-face types that previously drifted -- the rail's
// IngestProgress, the panel's UploadStatus badge, the working-set rail's
// ReplaceProgress -- are projections of this one union, each face's machine
// unchanged, only its type reference swapped.
//
// Deliberately NOT here (the ticket's exclusion list): the private face's
// ingest orchestration (useIngestFlow keeps its park/resume/halt machine,
// ADR-0123 Decision 3), the Thread rail's progress rendering blocks, the
// backend Rust command face, toast dedup keys (a behavior change, ruled
// separately).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { open as openPicker } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";

import {
  addWorkspaceDataset,
  listWorkspaceDatasets,
  removeWorkspaceDataset,
  renameWorkspaceDataset,
  replaceWorkspaceDataset,
  setWorkspaceDatasetPrivacy,
} from "../api";
import { fileBasename } from "../lib/basename";
import { describeError } from "../lib/error-presentation";
import { toast } from "../components/ui/use-toast";
import { workspaceDatasetKeys } from "./queryKeys";
import type { DatasetPrivacy } from "../types/dataset";
import type { ListedWorkspaceDataset } from "../types/workspace-datasets";

/** The panel's target workspace: the listing projection's canonical path +
 *  label (the dialog is mounted per open, never re-targeted while open). */
export interface WorkspaceTarget {
  path: string;
  label: string;
}

/** The ONE in-flight batch progress content model (#1519): every batch face
 *  renders from a member of this union. The members keep each face's exact
 *  field set, so the private-face machines (useIngestFlow's segment loop,
 *  SessionPane's trackReplace) swap type references without touching their
 *  construction sites. The badge members carry the panel's own identity
 *  fields (`phase`/`mode`); the two private-face members are recognized by
 *  their face-unique fields (`currentPath` / `referenceName`). Client UI
 *  state only -- never enters any cache. */
export type BatchProgress =
  // The rail's ingest block (useIngestFlow): the file currently
  // materializing, its 1-based position in the batch, the batch size, and
  // the batch's ONE start stamp.
  | { currentPath: string; index: number; total: number; startedAt: number }
  // The panel's running add badge (issues #1485 and #1488): the file's
  // basename plus its 1-based position and the batch size.
  | {
    phase: "running";
    mode: "add";
    name: string;
    index: number;
    total: number;
    startedAt: number;
  }
  // The panel's running replace badge: a single-file wait, no position.
  | { phase: "running"; mode: "replace"; name: string; startedAt: number }
  // The settled face: the operation's label, the last landed file's
  // basename, and the FROZEN total duration -- parks until dismissed, a new
  // upload begins, or the reopen edge clears it. A failed upload never
  // reaches `done` -- the error face owns that route.
  | { phase: "done"; mode: "add" | "replace"; name: string; seconds: number }
  // The working-set rail's replace line (useWorkingSet / SessionPane): the
  // flight's swap target (#1512).
  | { referenceName: string; path: string; startedAt: number };

/** The badge members of the unified model -- what `uploadStatuses` stores
 *  and the panel's badge slot renders. */
export type UploadStatus = Extract<BatchProgress, { phase: "running" | "done" }>;

export interface UseWorkspaceDatasets {
  // Read snapshot.
  /** The close-animation anchor: the last non-null workspace, so the key,
   *  the title and the listing hold their rendered values while the exit
   *  animation plays (the prop nulls the moment close is requested). */
  panel: WorkspaceTarget | null;
  rows: ListedWorkspaceDataset[];
  listingPending: boolean;
  listingError: unknown;
  /** The resolved detail target: the pick, else the first list item; null
   *  only while the set is empty (the deleted-pick fallback). */
  resolvedName: string | null;
  shown: ListedWorkspaceDataset | null;
  /** The rows whose store file is gone (ADR-0141 D8: flagged, not hidden). */
  missingNames: ReadonlySet<string>;
  // Panel-local state.
  /** The on-site error banner's message; the module routes failures into
   *  it only while the origin panel stands. */
  error: string | null;
  setError: (message: string | null) => void;
  /** The detail pick; re-resolves via `resolvedName` when the row leaves. */
  selectedName: string | null;
  select: (name: string) => void;
  /** This workspace's badge face, or null. Keyed by the minting workspace:
   *  a foreign panel's flight neither narrates nor locks here (#1491). */
  badge: UploadStatus | null;
  dismissBadge: () => void;
  /** The row-action lock: any of this workspace's row flights in the air,
   *  or the upload badge RUNNING (a second submission would overwrite the
   *  live badge). Done does not lock. */
  busy: boolean;
  /** The detail pane's privacy spinner gate: this workspace's privacy
   *  flights alone, not any row mutation. */
  privacyBusy: boolean;
  // Actions.
  pickAndAdd: () => Promise<void>;
  rename: (name: string, newDisplay: string) => void;
  replace: (name: string, file: string) => void;
  remove: (name: string) => void;
  setPrivacy: (name: string, next: DatasetPrivacy) => void;
}

/** The picker extensions the shared face accepts (ADR-0141 D11: xlsx is
 *  refused -- the picker never offers it; the store-side refusal stays as
 *  the honest boundary for any channel that slips one through). */
const PICKER_EXTENSIONS = ["csv", "parquet", "json", "jsonl", "ndjson"];

/** Drop one key from a record without mutating (the badge map's clear
 *  paths). */
function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

export function useWorkspaceDatasets(workspace: WorkspaceTarget | null): UseWorkspaceDatasets {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const open = workspace !== null;
  const [error, setError] = useState<string | null>(null);
  // The in-flight upload's badge faces (issues #1485/#1488/#1491), keyed by
  // the minting workspace: a second flight never overwrites the first's
  // RUNNING face, the home panel keeps its face across close/reopen, and a
  // panel on another workspace renders none of it.
  const [uploadStatuses, setUploadStatuses] = useState<Record<string, UploadStatus>>({});
  // The detail pick (which row's detail the right pane shows), resolved to
  // the first entry when unset or deleted -- the band rides the resolved
  // pick so it never names a row that is no longer in the list.
  const [selectedName, setSelectedName] = useState<string | null>(null);
  // The close-animation anchor: clearing the workspace prop unmounts the
  // listing's query key mid-animation, and the panel would flash its empty
  // face while it plays. React's render-time state adjustment pattern: the
  // branch fires only when the prop moved, and converges on the next render.
  const [panel, setPanel] = useState(workspace);
  const [lastSeen, setLastSeen] = useState(workspace);
  if (workspace !== lastSeen) {
    setLastSeen(workspace);
    setPanel(workspace ?? panel);
    if (workspace !== null) {
      // The open edge clears the transient state (the error banner and the
      // detail pick never survive into a fresh panel); the close edge
      // deliberately keeps everything, so the animation plays over the
      // exact face the user is leaving. The DONE badge joins the open-edge
      // cleanup: a reopen is a fresh working session, not a continuation of
      // the last one. A RUNNING badge survives the edge: its IPC is still
      // in flight, and clearing it would resurrect the vanished-state bug
      // (the upload keeps running with no face). The sweep is key-wide:
      // every workspace's DONE face clears, every RUNNING face stays.
      setError(null);
      setSelectedName(null);
      setUploadStatuses((prev) =>
        Object.fromEntries(
          Object.entries(prev).filter(([, status]) => status.phase === "running"),
        ),
      );
    }
  }
  const path = panel?.path ?? "";

  // The panel's standing at SETTLE time, for the failure routing and the
  // detail-pick gate: the raw prop would freeze in the flight closures (a
  // bare async function captures its render), while TanStack's hot-swapped
  // options used to read the latest render for free. The effect is the
  // deliberate mirror of that semantics (#1490's routing reads where the
  // panel stands when the failure lands, not where it stood at the click).
  const workspaceRef = useRef(workspace);
  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  const listing = useQuery({
    queryKey: workspaceDatasetKeys.listing(path),
    queryFn: () => listWorkspaceDatasets(path),
    enabled: open,
  });

  // The listing invalidation for a NAMED workspace: the app default is
  // staleTime Infinity, so the mutations' invalidation is the only refetch
  // trigger, and it must bind to the minted workspace -- a mid-flight rebind
  // would otherwise leave the origin's listing stale (#1491/#1492).
  const invalidateFor = (ws: string) => {
    void queryClient.invalidateQueries({ queryKey: workspaceDatasetKeys.listing(ws) });
  };

  // The two batch faces' shared failure router (the add loop and replace,
  // #1490/#1519): the failure routes by where the panel stands at SETTLE
  // time -- on the origin workspace the banner stays the face; off it
  // (closed = null, or rebound to another workspace) the banner cannot
  // carry the failure -- closed, it renders nowhere and the reopen edge
  // destroys it unread; rebound, it would narrate the origin's failure on
  // another workspace's panel. The destructive toast carries the message,
  // attributed to the origin workspace by the label frozen at fire time.
  // One failure, one face: the toast branch never touches the error state.
  // The title arrives as a RENDER CLOSURE, not a descriptor: the i18n
  // catalog guard recovers ids from `formatMessage` LITERAL calls, so each
  // call site keeps its literal (describeError's precedent) and only the
  // routing decision is shared.
  const routeOffsiteFailure = (e: unknown, origin: string, toastTitle: () => string) => {
    const live = workspaceRef.current;
    if (live === null || live.path !== origin) {
      toast({
        variant: "destructive",
        title: toastTitle(),
        description: describeError(e, intl),
      });
    } else {
      setError(describeError(e, intl));
    }
  };

  // The per-workspace flight counters: bumped at fire time, decremented in
  // the flight's own finally. Keyed by the workspace the flight was minted
  // for, so the lock reads only the flights fired on THIS panel's workspace
  // -- a foreign fire neither locks nor narrates (#1492's identity gate,
  // now as module-internal facts instead of a cache scan).
  const [rowFlights, setRowFlights] = useState<Record<string, number>>({});
  const [privacyFlights, setPrivacyFlights] = useState<Record<string, number>>({});
  const bumpRow = (ws: string, delta: number) =>
    setRowFlights((prev) => ({ ...prev, [ws]: Math.max(0, (prev[ws] ?? 0) + delta) }));
  const bumpPrivacy = (ws: string, delta: number) =>
    setPrivacyFlights((prev) => ({ ...prev, [ws]: Math.max(0, (prev[ws] ?? 0) + delta) }));

  const rowFlightCount = rowFlights[path] ?? 0;
  const privacyFlightCount = privacyFlights[path] ?? 0;
  const badge = uploadStatuses[path] ?? null;
  const uploadRunning = badge?.phase === "running";
  const busy = rowFlightCount > 0 || uploadRunning;
  const privacyBusy = privacyFlightCount > 0;

  // The picker: the panel's only add / replace channel (the same
  // plugin-dialog face the working set uses). xlsx never appears -- the
  // filter is the first refusal edge (ADR-0141 D11).
  const pickerFilters = [
    {
      name: intl.formatMessage({
        id: "workspace.datasets.fileFilter",
        defaultMessage: "Data files",
      }),
      extensions: PICKER_EXTENSIONS,
    },
  ];

  const pickAndAdd = async () => {
    const selected = await openPicker({
      multiple: true,
      filters: pickerFilters,
    }).catch((e: unknown) => {
      setError(describeError(e, intl));
      return null;
    });
    const files = typeof selected === "string" ? [selected] : (selected ?? []);
    if (files.length === 0) return;
    // Clear-on-fire, the row actions' posture: a stale banner must not sit
    // beside (or contradict) this batch's visible outcome. The cancel path
    // above keeps an old banner -- no batch fired, nothing to clear.
    setError(null);
    // Sequential awaits (issue #1485): the backend's manifest lock
    // serializes anyway, so the total time is unchanged -- but each file's
    // invalidation lands per file, so rows appear one by one. A rejected
    // file is routed and swallowed so the batch continues. ONE batch clock
    // minted here: every per-file badge reuses it, so the elapsed suffix
    // counts the whole batch instead of resetting per file. The done badge
    // names the LAST file that actually landed -- a failed file must never
    // read as added. The batch's target and attribution (`path`, the
    // panel's label) freeze in this closure at fire time (#1491).
    const startedAt = Date.now();
    let lastLanded: string | null = null;
    for (const [i, file] of files.entries()) {
      setUploadStatuses((prev) => ({
        ...prev,
        [path]: {
          phase: "running",
          mode: "add",
          name: fileBasename(file),
          index: i + 1,
          total: files.length,
          startedAt,
        },
      }));
      bumpRow(path, 1);
      await addWorkspaceDataset(path, file)
        .then((entry) => {
          // The freshly added dataset becomes the detail pick: the user's
          // last upload is what they want to look at (a multi-file pick
          // lands on the last one). The write lands only while the panel
          // still shows the batch's workspace (#1492) -- read at settle
          // time, where TanStack's hot-swapped options used to read it.
          const live = workspaceRef.current;
          if (live !== null && live.path === path) {
            setSelectedName(entry.reference_name);
          }
          invalidateFor(path);
          lastLanded = fileBasename(file);
        })
        .catch((e: unknown) => {
          routeOffsiteFailure(e, path, () =>
            intl.formatMessage(
              {
                id: "workspace.datasets.uploadFailedToast",
                defaultMessage: "Upload to {workspace} failed",
              },
              { workspace: panel?.label ?? "" },
            ),
          );
        })
        .finally(() => bumpRow(path, -1));
    }
    const landed = lastLanded;
    if (landed !== null) {
      // The clock reads at settle time, outside the updater: the batch's
      // elapsed measures the batch, not React's commit of the badge.
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      setUploadStatuses((prev) => ({
        ...prev,
        [path]: {
          phase: "done",
          mode: "add",
          name: landed,
          seconds,
        },
      }));
    } else {
      // A whole-failed batch parks nothing: the running badge must not
      // outlive its batch, and the error face owns the failure face.
      setUploadStatuses((prev) => omitKey(prev, path));
    }
  };

  const rename = (name: string, newDisplay: string) => {
    setError(null);
    bumpRow(path, 1);
    void renameWorkspaceDataset(path, name, newDisplay)
      .then(() => invalidateFor(path))
      .catch((e: unknown) => setError(describeError(e, intl)))
      .finally(() => bumpRow(path, -1));
  };

  const replace = (name: string, file: string) => {
    setError(null);
    // The same badge as the add batch (issue #1485): a replace is one long
    // IPC, the running badge names the row until it settles; success flips
    // to the done badge (the frozen duration), a failure clears it -- the
    // error face owns the failure face. The row flight rides the same
    // counter as the rest of the family (the lock is symmetric).
    const ws = path;
    const startedAt = Date.now();
    setUploadStatuses((prev) => ({
      ...prev,
      [ws]: { phase: "running", mode: "replace", name, startedAt },
    }));
    bumpRow(ws, 1);
    void replaceWorkspaceDataset(ws, name, file)
      .then(() => {
        invalidateFor(ws);
        const seconds = Math.floor((Date.now() - startedAt) / 1000);
        setUploadStatuses((prev) => ({
          ...prev,
          [ws]: { phase: "done", mode: "replace", name, seconds },
        }));
      })
      .catch((e: unknown) => {
        setUploadStatuses((prev) => omitKey(prev, ws));
        // The shared router (the add batch's #1490 posture), closing the
        // live hole #1519 names: a replace is a minute-scale copy-in, and a
        // failure landing after the panel closed had no face -- the banner
        // renders nowhere while closed, and the reopen edge destroyed the
        // error state unread.
        routeOffsiteFailure(e, ws, () =>
          intl.formatMessage(
            {
              id: "workspace.datasets.replaceFailedToast",
              defaultMessage: "Dataset replace in {workspace} failed",
            },
            { workspace: panel?.label ?? "" },
          ),
        );
      })
      .finally(() => bumpRow(ws, -1));
  };

  const remove = (name: string) => {
    setError(null);
    bumpRow(path, 1);
    void removeWorkspaceDataset(path, name)
      .then(() => invalidateFor(path))
      .catch((e: unknown) => setError(describeError(e, intl)))
      .finally(() => bumpRow(path, -1));
  };

  const setPrivacy = (name: string, next: DatasetPrivacy) => {
    setError(null);
    // Double-counted: the privacy flight rides the row counter too (the
    // cache-scan predicate it replaces matched every workspace-tagged
    // mutation), so the row lock holds while the toggle spins.
    bumpRow(path, 1);
    bumpPrivacy(path, 1);
    void setWorkspaceDatasetPrivacy(path, name, next)
      .then(() => invalidateFor(path))
      .catch((e: unknown) => setError(describeError(e, intl)))
      .finally(() => {
        bumpRow(path, -1);
        bumpPrivacy(path, -1);
      });
  };

  const dismissBadge = useCallback(() => {
    setUploadStatuses((prev) => omitKey(prev, path));
  }, [path]);

  const select = useCallback((name: string) => setSelectedName(name), []);

  const rows = listing.data ?? [];
  const missingNames = new Set(rows.filter((d) => d.file_missing).map((d) => d.reference_name));
  const resolvedName =
    selectedName !== null && rows.some((d) => d.reference_name === selectedName)
      ? selectedName
      : (rows[0]?.reference_name ?? null);
  const shown = rows.find((d) => d.reference_name === resolvedName) ?? null;

  return {
    panel,
    rows,
    listingPending: listing.isPending,
    listingError: listing.error,
    resolvedName,
    shown,
    missingNames,
    error,
    setError,
    selectedName,
    select,
    badge,
    dismissBadge,
    busy,
    privacyBusy,
    pickAndAdd,
    rename,
    replace,
    remove,
    setPrivacy,
  };
}
