// Shell-level error state (issue #194). Owns the single AppError surfaced at
// the shell layer -- a createSession / openDuck / save / delete / rename
// persisted / profile-switch reject, set by the shell's async handlers via
// describeReject(e, intl, "shell").
//
// ADR-0058 L1: the shell error stays on the handler-async path. It is set by
// reject handlers and cleared by the next setShellError, never lifted to an L2
// ErrorBoundary (React ErrorBoundaries do not catch async throws, and lifting
// would lose the locale message + typed-detail fold). The close-wait timeout /
// resume / save reject detail rides the TechnicalDetailsFold under the banner.
import { useState } from "react";
import type { AppError } from "../types/error";

/** The shell error state + setter. setShellError(null) clears the banner; the
 *  setter is the raw useState dispatcher (stable identity, no wrapper needed).
 *  Callers pass describeReject(e, intl, "shell") to surface a reject. */
export function useShellError(): {
  shellError: AppError | null;
  setShellError: (error: AppError | null) => void;
} {
  const [shellError, setShellError] = useState<AppError | null>(null);
  return { shellError, setShellError };
}
