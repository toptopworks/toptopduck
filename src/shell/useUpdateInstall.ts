import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  installUpdate,
  listLiveSessions,
  onUpdateDownloadProgress,
} from "../api";
import { updateKeys } from "../session/queryKeys";
import { fmtError } from "../lib/error-presentation";

/** The shared install-in-flight slice's payload (see updateKeys.install):
 *  `null` = no install running; `{ percent: null }` = downloading with an
 *  unknown total; `{ percent: 0..100 }` = downloading with a known total. */
export interface UpdateInstallState {
  percent: number | null;
}

/** Subscription to the shared install slice (enabled:false -- the install
 *  chain is the only writer). An install is process-wide, so every face --
 *  the sidebar indicator, the About button, the install overlay -- reads
 *  this one truth, and the in-flight gate blocks a second start no matter
 *  which face initiated the first. */
export function useUpdateInstallState(): UpdateInstallState | null {
  const { data } = useQuery({
    queryKey: updateKeys.install(),
    queryFn: () => null as UpdateInstallState | null,
    enabled: false,
    staleTime: Infinity,
  });
  return data ?? null;
}

/** The shared install chain (ADR-0143, issue #1509): the active-turn gate
 *  (confirm before interrupting, never hard-block -- the backend's live table
 *  is the truth), then the Rust side's one-shot atomic chain (fresh check ->
 *  download -> cleanup -> install -> relaunch). A successful install NEVER
 *  resolves -- the process is replaced -- so only the error path calls back.
 *  The error face is the caller's choice (About shows it inline; the sidebar
 *  indicator toasts it), which is why it arrives as a callback, not state.
 *  The in-flight progress is written to the shared `update-install` slice,
 *  not local state, so all faces mirror it. */
export function useUpdateInstall(onInstallError: (message: string) => void) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const installState = useUpdateInstallState();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const onErrorRef = useRef(onInstallError);
  onErrorRef.current = onInstallError;

  // The single in-flight gate: reads the cache synchronously (not a render
  // ref), so the check -> write pair inside startInstall's synchronous head
  // is atomic against a second face starting in the same tick -- JS runs the
  // two heads serially and the first write is already visible to the second.
  // NOTE: getQueryData returns undefined for a missing key -- `!= null`
  // (loose) treats that as "no install", a strict `!==` would gate forever.
  const installRunning = () =>
    queryClient.getQueryData(updateKeys.install()) != null;

  // Drop the progress listener if the consuming face unmounts mid-download
  // (the download itself keeps running in Rust; only the UI goes away).
  const unlistenRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  async function requestInstall() {
    if (installRunning()) return;
    // Active-turn gate (ADR-0143 Decision 5): confirm before interrupting.
    // Best-effort -- an unreadable live table must not bury the update.
    let inFlight = false;
    try {
      inFlight = (await listLiveSessions()).some((row) => row.in_flight);
    } catch {
      // proceed without the dialog
    }
    if (inFlight) {
      setConfirmOpen(true);
      return;
    }
    void startInstall();
  }

  async function startInstall() {
    if (installRunning()) return;
    setConfirmOpen(false);
    queryClient.setQueryData(updateKeys.install(), { percent: null });
    void onUpdateDownloadProgress((p) => {
      const percent =
        p.contentLength && p.contentLength > 0
          ? Math.min(100, Math.floor((p.downloaded / p.contentLength) * 100))
          : null;
      queryClient.setQueryData(updateKeys.install(), { percent });
    }).then((unlisten) => {
      unlistenRef.current = unlisten;
    });
    try {
      // Success never resolves (the process is replaced by the installer /
      // relaunch); only the error path lands here.
      await installUpdate();
    } catch (e) {
      onErrorRef.current(fmtError(e, intl));
      queryClient.setQueryData(updateKeys.install(), null);
      unlistenRef.current?.();
      unlistenRef.current = null;
    }
  }

  return {
    installing: installState !== null,
    percent: installState?.percent ?? null,
    confirmOpen,
    setConfirmOpen,
    requestInstall,
    startInstall,
  };
}
