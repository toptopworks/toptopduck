// Tiered tool-approval wire contract (ADR-0080, issue #294). Mirrors the Rust
// `approval` module types that cross IPC as command arguments + event
// payloads. The frontend rendering (pending/resolved trace entries, the
// three-button approval card, the unanswered badge, the auth-mode selector)
// lands in #297 / #298 / #302; this file owns the typed shape only.
//
// Snake_case field names match the Rust struct field names verbatim (serde
// defaults to the Rust field name), the same convention `TurnProgress` /
// `ResumeProgress` use. Unit-variant enums serialize as bare lowercase
// strings via serde `rename_all = "snake_case"`.

// The trust granularity (ADR-0080): `server::tool`. Built-in tools live under
// the reserved `builtin` server; external MCP tools carry the user-configured
// server name (ADR-0076).
export interface ToolKey {
  server: string;
  tool: string;
}

// Session-level authorization posture (ADR-0080). Default is `per_call`;
// `no_confirmation` is an explicit, session-scoped, resume-resetting posture
// that auto-passes every external tool call.
export type AuthMode = "per_call" | "no_confirmation";

// The backend's default authorization posture (ADR-0080). Mirrors the Rust
// `AuthMode::default()` (`#[default] PerCall`, src-tauri/src/approval.rs) -- the
// single TS expression of this invariant so consumers (e.g. the composer chip)
// do not each hardcode the literal.
export const AUTH_MODE_DEFAULT: AuthMode = "per_call";

// Operation category for the approval-card badge (ADR-0083 read / write /
// execute / network). Presentation-only -- the gateway does not branch on it.
export type OperationKind = "read" | "write" | "execute" | "network";

// The user's answer to an approval request (ADR-0083 three-button card).
// `always_allow` escalates the `server::tool` to session-level trust (resume
// resets it); `deny` surfaces a tool-level denial the agent self-corrects
// from (ADR-0077).
export type ApprovalResponse = "allow_once" | "always_allow" | "deny";

// One file-delivery value's content for the approval card (issue #672,
// ADR-0109 Decision 8): the approver can expand the parameter's value on
// the card. Captured at approval time -- the temp file is deleted when the
// call ends, so this snapshot is the only durable view.
export interface FileAttachment {
  param: string;
  content: string;
}

// An `approval-request` event (ADR-0083). The gateway emits this when an
// external tool call under `per_call` mode hits the gate; the frontend
// surfaces the in-flow card filtered by `session_id` (ADR-0056).
export interface ApprovalRequestPayload {
  session_id: string;
  request_id: string;
  server: string;
  tool: string;
  operation_kind: OperationKind;
  // Short agent-readable parameter summary for the card body -- NOT the full
  // call arguments (those may be large or sensitive). The bridge summarizes.
  summary: string;
  // File-delivery values for the card's expand-on-demand view (issue #672).
  // Optional: the backend omits the field for calls without file-delivered
  // parameters (serde skip_serializing_if empty).
  file_attachments?: FileAttachment[];
}

// An `approval-resolved` event -- the frontend flips the pending card to its
// resolved state in place (ADR-0083). Emitted both on a user answer and on a
// cancel/close (which resolves to `deny` so no stale pending entry lingers).
export interface ApprovalResolvedPayload {
  session_id: string;
  request_id: string;
  response: ApprovalResponse;
}
