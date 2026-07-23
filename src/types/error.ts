// The merged frontend error model (issue #194): the shell, the session pane,
// and the result view all render IPC rejects through one AppError shape.
// ADR-0058 L1 (rejects stay on the handler-async path, never lifted to an L2
// ErrorBoundary) is documented at src/shell/useShellError.ts.

/** The session-flow operation kinds that carry a locale verb prefix (issue
 *  #139). A rename rejection renders "{verb} failed: ..."; a load rejection
 *  renders "{verb} failed: ..."; etc. The non-verb kinds ("shell" and "read" --
 *  see AppErrorKind) surface via toAppError as a bare fmtError message, so
 *  they are intentionally excluded from this verb-bearing set. Typing the verb
 *  logic over SessionFlowKind (not the full AppErrorKind) makes the exclusion a
 *  compile-time invariant, not a runtime default-arm hope. */
export type SessionFlowKind =
  | "load"
  | "rename"
  | "replace"
  | "delete"
  | "privacy"
  | "ask";

/** The full error-tag domain. SessionFlowKind members tag a session-layer
 *  mutation/query reject (verb-prefixed banner); "shell" tags a shell-layer IPC
 *  reject (createSession / openDuck / save / delete / rename persisted /
 *  profile switch); "read" tags a ResultView readRows reject. "shell" and
 *  "read" both render via toAppError without a verb prefix. */
export type AppErrorKind = SessionFlowKind | "shell" | "read";

/** An error tagged by the operation that produced it, so the displayed prefix
 *  matches the action (a rename rejection is never mislabelled a load
 *  failure). Shared by the shell (kind "shell"), the session pane
 *  (SessionFlowKind), and the result view (kind "read" -- a readRows reject).
 *  Only `message` and `detail` are rendered by ErrorBanner; `kind` tags the
 *  operation for upstream prefix logic. */
export interface AppError {
  message: string;
  kind: AppErrorKind;
  /** Technical detail from a typed error reject (SessionError / ResumeError /
   *  SaveError, issues #119/#120), rendered collapsed under the error banner.
   *  null when the rendered message is already self-contained, so the fold is
   *  omitted. ADR-0029: the Rust side is audited to keep secrets out of these
   *  payloads (the resume / save paths are keychain-free). */
  detail: string | null;
}
