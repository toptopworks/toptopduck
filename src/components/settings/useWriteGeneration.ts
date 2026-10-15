import { useRef } from "react";

import type { AppConfig } from "../../types/app-config";

// The write-generation guard (issue #683), shared by the CLI tools and
// skills panes (issue #1123): advances with every APPLIED user write, so a
// rescan response that arrives after a user write landed reads a stale
// config snapshot (the backend read it before the write) and skips its
// config sync instead of silently rolling the user's change back. The guard
// is a monotonic counter, not a request queue -- the backend's RMW write
// lock already serializes the registry; this only fixes the frontend's
// response-application order.
export function useWriteGeneration(onSync: (next: AppConfig) => void) {
  const genRef = useRef(0);

  /** Apply a user write's returned config: the sync advances the write
   *  generation, so any rescan response still in flight (issued before
   *  this write) skips its config sync instead of rolling it back. */
  function applyUserWrite(next: AppConfig) {
    genRef.current += 1;
    onSync(next);
  }

  /** The generation to capture alongside an in-flight read (a mount or
   *  manual rescan) so the response can be judged on arrival. */
  function current(): number {
    return genRef.current;
  }

  /** Apply a late read's config only if no user write landed while it was
   *  in flight; the read's own snapshot side-effects (scan entries,
   *  failure lanes) apply regardless. */
  function syncIfCurrent(gen: number, next: AppConfig) {
    if (genRef.current === gen) onSync(next);
  }

  return { applyUserWrite, current, syncIfCurrent };
}
