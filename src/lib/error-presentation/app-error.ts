// The upper-layer AppError assembler (ADR-0069). toAppError is the single
// kind-driven entry point: it computes the bare locale message + detail (via
// the format core) and applies the prefix strategy chosen by `kind`. The verb
// prefix logic (errorVerb / flowFailedMessage / refreshFailedMessage) moved
// here from useSessionState.ts (issue #225 slice 1); it stays module-internal.
// describeReject (api.ts) and appErrorFrom (useSessionState.ts) become thin
// compatibility shims that delegate to toAppError -- call sites are unchanged
// in this slice; slice 2 migrates them and deletes the shims.

import type { IntlShape } from "react-intl";
import type { AppError, AppErrorKind, SessionFlowKind } from "../../types/error";
import { errorDetail, fmtError } from "./format";

// The Engine locale message, used as the never-blank fallback when fmtError
// yields an empty string (a bare throw with no message, or a minified error).
// Applied ONLY on the shell/read branches of toAppError, matching the prior
// describeReject (api.ts) which computed fmtError(e) || <Engine message>; the
// SessionFlowKind branches carry no fallback, matching the prior appErrorFrom
// (useSessionState.ts). Slice 1 is a behavior-equivalent refactor -- widening
// the fallback to SessionFlowKind is a behavior change deferred to slice 2.
function engineFallback(intl: IntlShape): string {
  return intl.formatMessage({
    id: "error.session.engine",
    defaultMessage: "Internal error",
  });
}

// The locale verb for an error kind (ADR-0052, issue #139). Catalog-backed so
// the verb tracks the active locale -- the prior ERROR_VERB map hard-coded
// Chinese verbs and wrapped an English catalog message in a Chinese prefix,
// breaking locale consistency under en-US. Each arm carries a literal id +
// defaultMessage so @formatjs/cli extract recovers it for the catalog guard.
function errorVerb(intl: IntlShape, kind: SessionFlowKind): string {
  switch (kind) {
    case "load":
      return intl.formatMessage({ id: "error.verb.load", defaultMessage: "Load" });
    case "rename":
      return intl.formatMessage({ id: "error.verb.rename", defaultMessage: "Rename" });
    case "replace":
      return intl.formatMessage({
        id: "error.verb.replace",
        defaultMessage: "Replace source",
      });
    case "delete":
      return intl.formatMessage({
        id: "error.verb.delete",
        defaultMessage: "Delete source",
      });
    case "privacy":
      return intl.formatMessage({
        id: "error.verb.privacy",
        defaultMessage: "Privacy update",
      });
    case "ask":
      return intl.formatMessage({ id: "error.verb.ask", defaultMessage: "Ask" });
    default: {
      // Exhaustiveness guard (issue #139): a new SessionFlowKind member without
      // a case would fall through and return undefined, rendering a malformed
      // " failed: ..." banner (verb lost). The `default: never` throw enforces
      // this regardless of tsconfig flags -- mirror the guard used by
      // loadErrorDisplay + the format core.
      const unhandled: never = kind;
      throw new Error(`unhandled SessionFlowKind: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Compose the "{verb} failed: {message}" banner for an operation reject
// (issue #139). Both the verb and the failure template render through the
// active locale, so the catalog message underneath is no longer wrapped in a
// hard-coded Chinese prefix.
function flowFailedMessage(intl: IntlShape, kind: SessionFlowKind, message: string): string {
  return intl.formatMessage(
    {
      id: "error.flow.failed",
      defaultMessage: "{verb} failed: {message}",
    },
    { verb: errorVerb(intl, kind), message },
  );
}

// Compose the "{verb} saved, but refreshing the working set failed: {message}"
// banner for a post-mutation refresh reject (issue #139). The operation itself
// succeeded (its change is persisted server-side); only the cache refresh
// failed, so the banner is tagged with the operation kind but worded as a
// refresh failure rather than a fresh "{verb} failed".
//
// Exported (not module-private) for issue #225 slice 1 only: useSessionState's
// two inline refresh-reject sites (refreshServerState + handleAsk) still call it
// directly and are not migrated until slice 2. Slice 2 migrates those sites to
// toAppError(e, intl, kind, { refreshFailed: true }) and privatizes this helper
// (it is intentionally NOT re-exported through the index.ts facade, which holds
// the stable 5-function public surface).
export function refreshFailedMessage(
  intl: IntlShape,
  kind: SessionFlowKind,
  message: string,
): string {
  return intl.formatMessage(
    {
      id: "error.flow.savedRefreshFailed",
      defaultMessage: "{verb} saved, but refreshing the working set failed: {message}",
    },
    { verb: errorVerb(intl, kind), message },
  );
}

// Build an AppError from an IPC reject with a kind-driven prefix strategy
// (ADR-0069 Decision 3). The bare locale message comes from fmtError; the
// Engine message is a never-blank fallback ONLY on shell/read (matching the
// prior describeReject). The prefix is then chosen by kind:
//   - SessionFlowKind (load/rename/replace/delete/privacy/ask): "{verb} failed:
//     {message}", or "{verb} saved, but refreshing the working set failed:
//     {message}" when opts.refreshFailed is set (a post-mutation refresh reject
//     where the mutation itself succeeded). No Engine fallback here -- matches
//     the prior appErrorFrom, which composed flowFailedMessage(intl, kind,
//     fmtError(e)) directly (an empty fmtError rendered "{verb} failed: ").
//   - shell / read: the bare message (no verb prefix), with the Engine fallback
//     so a bare throw / minified error never renders a blank banner.
//
// Slice 1 is a behavior-equivalent refactor: the fallback's scope is preserved
// per-kind rather than widened. Widening it to SessionFlowKind is a behavior
// change deferred to slice 2 (issue #224).
//
// The exhaustiveness `default: never` guard makes "verb applies only to
// SessionFlowKind" a compile-time invariant (SessionFlowKind ⊂ AppErrorKind is
// already established in types/error.ts): adding a new AppErrorKind member
// without a case trips the compiler here instead of silently rendering bare.
export function toAppError(
  e: unknown,
  intl: IntlShape,
  kind: AppErrorKind,
  opts?: { refreshFailed?: boolean },
): AppError {
  const detail = errorDetail(e);
  switch (kind) {
    case "load":
    case "rename":
    case "replace":
    case "delete":
    case "privacy":
    case "ask": {
      const bare = fmtError(e, intl);
      const message = opts?.refreshFailed
        ? refreshFailedMessage(intl, kind, bare)
        : flowFailedMessage(intl, kind, bare);
      return { message, kind, detail };
    }
    case "shell":
    case "read": {
      const bare = fmtError(e, intl) || engineFallback(intl);
      return { message: bare, kind, detail };
    }
    default: {
      const unhandled: never = kind;
      throw new Error(`unhandled AppErrorKind: ${JSON.stringify(unhandled)}`);
    }
  }
}
