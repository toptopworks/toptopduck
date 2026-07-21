// The merged frontend error model (issue #194). Previously the shell carried a
// bespoke { message, detail } shellError shape while the session layer carried
// AppError { message, kind, detail } -- two shapes for the same "IPC reject
// rendered through an ErrorBanner" concern. The shell now reuses AppError with
// kind "shell", so the shell, the session pane, and the result view all render
// through one ErrorBanner contract with one prop shape.
//
// ADR-0058 L1: both shell and session rejects stay on the handler-async path
// (setError in a reject handler). They are never lifted to an L2 ErrorBoundary
// -- React ErrorBoundaries do not catch async/handler throws, and lifting would
// lose the locale prefix + typed-detail semantics.

/** The session-flow operation kinds that carry a locale verb prefix (issue
 *  #139). A rename rejection renders "{verb} failed: ..."; a load rejection
 *  renders "{verb} failed: ..."; etc. Shell-level rejects are tagged
 *  separately (see AppErrorKind) -- they surface via describeReject as a bare
 *  fmtError message with NO verb prefix (a shell operation is heterogeneous:
 *  create / open / save / delete / rename / profile-switch, so one verb would
 *  mislabel), so "shell" is intentionally excluded from this verb-bearing set.
 *  Keeping the verb logic typed over SessionFlowKind (not the full AppErrorKind)
 *  makes "shell has no verb" a compile-time invariant rather than a runtime
 *  default-arm hope (tsconfig has no noImplicitReturns). */
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
 *  profile switch) rendered via describeReject without a verb prefix. */
export type AppErrorKind = SessionFlowKind | "shell";

/** An error tagged by the operation that produced it, so the displayed prefix
 *  matches the action (a rename rejection is never mislabelled a load failure).
 *  Shared by the shell (kind "shell"), the session pane (SessionFlowKind), and
 *  the result view (SessionFlowKind -- a readRows reject tagged "ask" as the
 *  read phase of a turn; describeReject applies no verb prefix there either,
 *  so the tag only satisfies this shape and is not rendered by ErrorBanner). */
export interface AppError {
  message: string;
  kind: AppErrorKind;
  /** Technical detail from a typed error reject (SessionError / ResumeError /
   *  SaveError, issues #119/#120), rendered collapsed under the error banner.
   *  null when the rendered message is already self-contained, so the fold is
   *  omitted. ADR-0029: the Rust side is audited to keep secrets out of these
   *  payloads (the resume / save paths are keychain-free). */
  detail?: string | null;
}
