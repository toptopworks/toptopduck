import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { log } from "../../lib/log";
import { probeAdapter } from "../../api";
import { adapterKeys } from "../../session/queryKeys";
import type {
  AdapterCatalogEntry,
  AdapterCatalogs,
  ProbeError,
  ProbeOk,
} from "../../types/runtime";
import { toProbeError } from "./probe-error";

// The adapter probe lifecycle (ADR-0096, #1346), shared by the built-in
// rows, the registry rows, and the editor form's Test. Hook-only module:
// the rendering face lives in ./probe-face.tsx. The busy mirror is a count
// over the shared "probe" channel, so the hook is instantiated ONCE per
// settings tab -- a second owner would let the first probe to settle clear
// the channel while another is still in flight (the close guard would open
// early, ADR-0075 "any in-flight IPC blocks close").

// One adapter's probe lifecycle: idle -> probing -> ok | failed. Local state
// by design (the result is an ephemeral diagnostic snapshot, not persisted
// config -- ADR-0096 D5 keeps the cache a separate slice).
export type ProbeState =
  | { status: "idle" }
  | { status: "probing" }
  | { status: "ok"; result: ProbeOk }
  | { status: "failed"; error: ProbeError };

/** The row-probe surface a registry row consumes, cut from the hook's full
 *  return (the form's `probeOnce` stays tab-owned). */
export interface ProbeRowHost {
  probeStates: Record<string, ProbeState>;
  expandedRows: Set<string>;
  probe: (id: string) => Promise<void>;
  toggleFold: (id: string) => void;
}

/** The cache mirror for a fresh probe result (issue #536): the entry the
 *  backend just wrote to the sidecar, rebuilt client-side so the
 *  timestamped display is immediately consistent. The degraded per-model
 *  outcome was not cached server-side -- `null` mirrors that (the entry
 *  stays whatever it was, absent included). The kind dispatch is
 *  exhaustive with a `never` guard, mirroring the probe-face render
 *  switches: a fourth kind must fail at compile time instead of silently
 *  mirroring its models under the wrong tag. */
function mirrorEntryFromProbe(result: ProbeOk): AdapterCatalogEntry | null {
  if (result.kind === "acp") {
    return {
      probe_kind: "acp",
      outcome: { acp: { discovered: result.data.discovered } },
      probed_at_millis: Date.now(),
    };
  }
  if (result.data.outcome.status !== "available") {
    return null;
  }
  const { models } = result.data.outcome;
  switch (result.kind) {
    case "codex_event_stream":
      return {
        probe_kind: "codex_event_stream",
        outcome: { codex_event_stream: { models } },
        probed_at_millis: Date.now(),
      };
    case "claude_stream_json":
      return {
        probe_kind: "claude_stream_json",
        outcome: { claude_stream_json: { models } },
        probed_at_millis: Date.now(),
      };
    default: {
      const _exhaustive: never = result;
      throw new Error(`Unknown probe ok kind: ${String(_exhaustive)}`);
    }
  }
}

/** The probe lifecycle every probe-row surface shares: per-row probe state,
 *  the fold-open set, and the busy-counted probe core. Instantiated ONCE
 *  per settings tab (see the module comment). `probe` drives a row button
 *  (state transitions + the auto-expand); `probeOnce` is the bare core the
 *  editor form's Test rides (its own inline display, the tab's busy
 *  counter, and the mirror -- so a form test and a row probe can never
 *  early-clear each other). */
export function useAdapterProbes(
  onIpcBusy: (channel: "probe" | "userAdapter", busy: boolean) => void,
): ProbeRowHost & { probeOnce: (id: string) => Promise<ProbeOk> } {
  const queryClient = useQueryClient();
  // Per-adapter probe state; one entry per probed row, keyed by adapter id.
  const [probeStates, setProbeStates] = useState<Record<string, ProbeState>>({});
  // Expanded adapter ids (issue #552): component-local, never persisted -- the
  // fold resets on unmount, mirroring the MCP panel's expandedRows.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  // In-flight probe count (probe is the only multi-instance IPC channel --
  // multiple rows can probe concurrently). The busy report mirrors the
  // count, not any single row's status: the first probe to settle must not
  // clear the channel while another is still in flight (ADR-0075).
  const activeProbesRef = useRef(0);

  async function probeOnce(id: string): Promise<ProbeOk> {
    activeProbesRef.current += 1;
    onIpcBusy("probe", true);
    try {
      const result = await probeAdapter(id);
      // The backend wrote this probe's entry to the sidecar cache; mirror
      // it into the query cache so the timestamped display is immediately
      // consistent (issue #536 AC: post-probe display matches the cache).
      const mirrored = mirrorEntryFromProbe(result);
      if (mirrored) {
        queryClient.setQueryData(adapterKeys.catalogs(), (prev: AdapterCatalogs | undefined) => ({
          ...(prev ?? {}),
          [id]: mirrored,
        }));
      }
      return result;
    } finally {
      activeProbesRef.current -= 1;
      if (activeProbesRef.current === 0) {
        onIpcBusy("probe", false);
      }
    }
  }

  async function probe(id: string) {
    if (probeStates[id]?.status === "probing") return;
    setProbeStates((prev) => ({ ...prev, [id]: { status: "probing" } }));
    try {
      const result = await probeOnce(id);
      setProbeStates((prev) => ({ ...prev, [id]: { status: "ok", result } }));
      // The probe result is what the click bought -- auto-expand the row so
      // the directory is visible without a second click (issue #552). The
      // degenerate outcomes (unavailable / empty) expand too: the honest
      // line IS the result. Failure paths never touch the fold.
      setExpandedRows((prev) => new Set(prev).add(id));
    } catch (e) {
      log.warn("ProbeFace", "adapter probe failed", e);
      // The IPC rejects with the structured ProbeError; a non-shaped reject
      // or an unknown kind (harness / transport fault / skew) keeps its own
      // kind -- it never reached the CLI, so it must not display as a
      // handshake failure.
      setProbeStates((prev) => ({
        ...prev,
        [id]: { status: "failed", error: toProbeError(e) },
      }));
    }
  }

  function toggleFold(id: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return { probeStates, expandedRows, probe, toggleFold, probeOnce };
}
