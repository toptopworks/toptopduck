// The shared probe reject-narrowing for the settings panes (the
// non-component-export pattern from user-runtime-form.ts): one definition,
// so the runtime pane's copy cannot drift from the Local CLI tab's.
import type { ProbeError } from "../../types/runtime";

/** The kinds the backend can reject with -- the runtime kind allowlist for
 *  the reject-shape check (a `kind` field alone proves nothing: an unknown
 *  value would otherwise flow into a per-kind renderer and surface as a
 *  render-time contract-break throw instead of a degraded error row). */
export const PROBE_ERROR_KINDS: ReadonlySet<string> = new Set([
  "NotDetected",
  "SpawnFailure",
  "HandshakeFailure",
  "Timeout",
]);

/** Narrow an IPC reject to a `ProbeError`: a reject shaped like one (a known
 *  kind) passes through; anything else -- a non-shaped reject or an unknown
 *  kind (frontend/backend skew) -- degrades to the frontend-only
 *  `ProbeUnreachable`, never a false handshake failure or a render throw. */
export function toProbeError(e: unknown): ProbeError {
  if (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    PROBE_ERROR_KINDS.has(e.kind as string)
  ) {
    return e as ProbeError;
  }
  return { kind: "ProbeUnreachable", data: String(e) };
}
