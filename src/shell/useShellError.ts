// Shell-level error state (issue #194). Owns the single AppError surfaced at
// the shell layer -- a createSession / openDuck / save / delete / rename
// persisted / profile-switch reject, set by the shell's async handlers via
// describeReject(e, intl, "shell"). Extracted from <App> so the shell's error
// model is one hook call rather than inline useState; the hook shape depends on
// the merged AppError (issue #194), so the extraction rides the same slice as
// the shellError/AppError merge.
//
// ADR-0058 L1: the shell error stays on the handler-async path. It is set by
// reject handlers and cleared by the next setShellError, never lifted to an L2
// ErrorBoundary (React ErrorBoundaries do not catch async throws, and lifting
// would lose the locale message + typed-detail fold). The close-wait timeout /
// resume / save reject detail still rides the TechnicalDetailsFold under the
// banner (AC: shell error display behavior unchanged).
import { useState } from "react";
import type { AppError } from "../types";

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
