import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { AppConfig } from "./types/app-config";
import type {
  DatasetDescriptor,
  DatasetPrivacy,
  LoadOutcome,
  RowPage,
  SheetGuidance,
} from "./types/dataset";
import type { McpServerConfig } from "./types/mcp";
import type {
  ResumeProgress,
  SaveError,
  SessionMetadata,
  TurnProgress,
} from "./types/session";
import type {
  ProfileKeyStatus,
  ProfileTestOutcome,
  ProviderConfig,
  ProviderConfigView,
  Protocol,
} from "./types/provider";
import type { ThreadEntry, TurnOutcome } from "./types/thread";
import type {
  ApprovalRequestPayload,
  ApprovalResolvedPayload,
  ApprovalResponse,
  AuthMode,
  ToolKey,
} from "./types/approval";

// Multi-session addressing (ADR-0056): every session-scoped function takes
// `sessionId` as its first parameter -- the backend looks up the target
// session by id. Session-AGNOSTIC functions (api key / provider config / app
// config / record_recent_file) take no sessionId. The frontend tracks the ids
// itself (createSession mints one); this single-session shell holds one until
// the multi-tab UI lands in a later PRD.

// Create a new session (ADR-0056): the backend builds an independent in-memory
// DuckDB instance + per-session cancel token, binds them to a backend-generated
// id (UUID), and returns it. This is the `+ tab` action.
export async function createSession(): Promise<string> {
  return invoke<string>("create_session");
}

// Close a session (ADR-0055): fire cancel + mark closing + remove from the
// store. Returns immediately; an in-flight ask's post-check discards its turn.
// After this, calls targeting the id reject as unknown session.
export async function closeSession(sessionId: string): Promise<void> {
  await invoke<void>("close_session", { sessionId });
}

// Close a session AND wait for the canonical single-writer key to be released
// (ADR-0063). The delete path's variant: blocks (<=120s, aligned to ADR-0021
// REQUEST_TIMEOUT) until the in-flight ask's Arc clone drops and Session::Drop
// runs, so delete_session's try_acquire gate sees the key free. Resolves at
// once when no ask is in flight. The plain closeSession (above) stays
// fire-and-forget -- this is the delete-only wait variant.
export async function closeSessionAndWaitRelease(
  sessionId: string,
): Promise<void> {
  await invoke<void>("close_session_and_wait_release", { sessionId });
}

export async function ingestFile(sessionId: string, path: string): Promise<LoadOutcome> {
  return invoke<LoadOutcome>("ingest_file", { sessionId, path });
}

// Re-ingest an Excel workbook with the user's guided rectify choices
// (ADR-0015/0042), after a NeedsGuidance outcome.
export async function ingestFileGuided(
  sessionId: string,
  path: string,
  guidance: SheetGuidance[],
): Promise<LoadOutcome> {
  return invoke<LoadOutcome>("ingest_file_guided", { sessionId, path, guidance });
}

export async function listWorkingSet(sessionId: string): Promise<DatasetDescriptor[]> {
  return invoke<DatasetDescriptor[]>("list_working_set", { sessionId });
}

export async function activeDataset(sessionId: string): Promise<DatasetDescriptor | null> {
  return invoke<DatasetDescriptor | null>("active_dataset", { sessionId });
}

// Rename a dataset's display label (ADR-0037, issue #8): display-only -- the
// reference name is untouched, so SQL / recipe / active references stay valid.
// Rejects an unknown reference or a label already shown by another dataset; the
// backend rejects with the typed `SessionError::RenameDataset` (issue #121).
export async function renameDataset(
  sessionId: string,
  referenceName: string,
  newDisplay: string,
): Promise<DatasetDescriptor> {
  return invoke<DatasetDescriptor>("rename_dataset", { sessionId, referenceName, newDisplay });
}

// Re-upload onto an existing dataset's reference name (ADR-0042, issue #11): a
// fresh snapshot takes over the name; the old one is discarded. Distinct from
// ingestFile (add) -- the reference name to take over is explicit.
export async function replaceSource(
  sessionId: string,
  referenceName: string,
  path: string,
): Promise<LoadOutcome> {
  return invoke<LoadOutcome>("replace_source", { sessionId, referenceName, path });
}

// Remove a source dataset from the working set (issue #38/#39, ADR-0040).
export async function removeSource(sessionId: string, referenceName: string): Promise<void> {
  await invoke<void>("remove_source", { sessionId, referenceName });
}

// Delete the ACTIVE source and repoint focus at an explicit continuation
// source (issue #39, ADR-0035 -- no silent focus jump).
export async function removeActiveSource(
  sessionId: string,
  referenceName: string,
  continueWith: string,
): Promise<void> {
  await invoke<void>("remove_active_source", { sessionId, referenceName, continueWith });
}

// Set a dataset's privacy controls (ADR-0011, issue #9 slice 5).
export async function setDatasetPrivacy(
  sessionId: string,
  referenceName: string,
  privacy: DatasetPrivacy,
): Promise<DatasetDescriptor> {
  return invoke<DatasetDescriptor>("set_dataset_privacy", { sessionId, referenceName, privacy });
}

// Ask one question (PRD #1) against the named session: run one turn and return
// its ADR-0028 outcome (result / textual / failed / cancelled).
export async function askQuestion(sessionId: string, question: string): Promise<TurnOutcome> {
  return invoke<TurnOutcome>("ask", { sessionId, question });
}

// Cancel the named session's in-flight turn (ADR-0021, issue #28). Fires THAT
// session's cancel token (per-session, ADR-0056).
export async function cancelQuery(sessionId: string): Promise<void> {
  await invoke<void>("cancel", { sessionId });
}

// Read the named session's conversation thread (ADR-0028/0039/0040).
export async function conversation(sessionId: string): Promise<ThreadEntry[]> {
  return invoke<ThreadEntry[]>("conversation", { sessionId });
}

// Read one page of a dataset's rows from the named session (ADR-0024).
export async function readRows(
  sessionId: string,
  referenceName: string,
  offset: number,
  limit: number,
): Promise<RowPage> {
  return invoke<RowPage>("read_rows", { sessionId, referenceName, offset, limit });
}

// --- LLM provider key + config (issue #29, ADR-0007/0019/0029) -------------
//
// Session-AGNOSTIC (ADR-0056): no sessionId. The API key crosses IPC exactly
// once (here, into Rust), is stored in the OS keychain, and thereafter the
// frontend learns only a boolean. The webview holds no key and makes no HTTP
// egress -- all LLM calls are placed by the Rust core (ADR-0029).

export async function setApiKey(key: string): Promise<void> {
  await invoke<void>("set_api_key", { key });
}

export async function clearApiKey(): Promise<void> {
  await invoke<void>("clear_api_key");
}

export async function getProviderConfig(): Promise<ProviderConfigView> {
  return invoke<ProviderConfigView>("get_provider_config");
}

export async function setProviderConfig(config: ProviderConfig): Promise<ProviderConfigView> {
  return invoke<ProviderConfigView>("set_provider_config", { config });
}

// Per-profile key management (issue #153, ADR-0064/0029). The Profiles UI edits
// keys for ANY profile, not just the active one. Each profile's key lives in its
// own keychain slot `key-<profile_id>`; the frontend learns only booleans,
// never the key (ADR-0029 invariant 3). The active-profile STATUS rides
// getProviderConfig (above) -- its keychain_fault drives the header indicator.

// One entry per profile currently in app-config: the profile id plus whether its
// keychain slot holds a key. Profile RECORDS stay single-sourced from
// app-config; this overlays only the key status. Read-only -- cannot refuse.
export async function listProviderProfiles(): Promise<ProfileKeyStatus[]> {
  return invoke<ProfileKeyStatus[]>("list_provider_profiles");
}

// Store the key for the named profile (ADR-0029 one-shot transfer; the key
// never returns across IPC). Returns the NEW has_key so the UI updates its
// overlay without a re-fetch. `profileId` is the opaque profile id; it need not
// match a saved profile yet (a freshly-minted id before Save is a valid target).
export async function setProfileKey(profileId: string, key: string): Promise<boolean> {
  return invoke<boolean>("set_profile_key", { profileId, key });
}

// Remove the key for the named profile (idempotent). Returns the NEW has_key
// (false on success). A keychain error rejects with StoreCommandError so the UI
// can tell the user the key did not come out (ADR-0029 trust root).
export async function clearProfileKey(profileId: string): Promise<boolean> {
  return invoke<boolean>("clear_profile_key", { profileId });
}

// Run a connection preflight against the named profile (issue #236, ADR-0070).
// The backend reads the profile's stored key from the OS keychain by profileId
// (ADR-0029 -- the key never crosses IPC) and probes the caller-supplied
// endpoint (the edit form's CURRENT protocol/base_url/model values, so a user
// who edits base_url and re-tests does not have to save first -- ADR-0070 Why
// 3). Returns the six-state ProfileTestOutcome classification; the listed
// models feed the model dropdown (NOT persisted -- ADR-0038).
export async function testProfile(
  profileId: string,
  protocol: Protocol,
  baseUrl: string,
  model: string,
): Promise<ProfileTestOutcome> {
  return invoke<ProfileTestOutcome>("test_profile", { profileId, protocol, baseUrl, model });
}

// --- Cross-session persistence (issue #48, ADR-0034/0036) -----------------

// Bind the named session to a .duck path and write one recipe immediately.
export async function saveAsDuck(
  sessionId: string,
  path: string,
  sessionName: string,
): Promise<void> {
  await invoke<void>("save_as_duck", { sessionId, path, sessionName });
}

// Open a .duck and resume the named session WITHIN THE SAME session_id
// (ADR-0056: open reuses the id; it does NOT create a new session). Runs off
// the UI thread; a `resume-progress` event fires per source / replayed turn.
export async function openDuck(sessionId: string, path: string): Promise<void> {
  await invoke<void>("open_duck", { sessionId, path });
}

// Subscribe to resume-progress events (ADR-0034/0059 visible progress, issue
// #76). Each event carries the addressing sessionId so a multi-session frontend
// filters the global broadcast; a single-session shell reads `.event` directly.
export async function onResumeProgress(
  cb: (ev: ResumeProgress) => void,
): Promise<UnlistenFn> {
  return listen<ResumeProgress>("resume-progress", (e) => cb(e.payload));
}

// Subscribe to turn-progress events (ADR-0059 discrete feedback, calibrated
// to the tool-call event stream by ADR-0078, issue #297). Each event carries
// the addressing sessionId + a TurnPhase event: Thinking (with the 1-based
// step) or the ToolCallStarted / ToolCallCompleted pair around each dispatch.
// The events never enter the TurnOutcome contract; they are observer
// feedback only.
export async function onTurnProgress(
  cb: (ev: TurnProgress) => void,
): Promise<UnlistenFn> {
  return listen<TurnProgress>("turn-progress", (e) => cb(e.payload));
}

// List every persisted .duck session's metadata for the cold-start sidebar
// (ADR-0060/0061, issue #76). The backend reads recent_files and derives each
// entry from its recipe + mtime (zero new persistence); unreadable paths are
// skipped. session_id is the .duck path -- pass it back to openDuck to resume.
export async function listSessions(): Promise<SessionMetadata[]> {
  return invoke<SessionMetadata[]>("list_sessions");
}

// Delete a persisted .duck file (ADR-0060, issue #81). The frontend closes the
// session first when it is open, then calls this. The backend removes the file
// + drops the path from recent_files; a missing file is idempotent success.
// `path` is the .duck file path (the SessionMetadata.session_id from listSessions).
export async function deleteSession(path: string): Promise<void> {
  await invoke<void>("delete_session", { path });
}

// Rename the OPEN session bound to `sessionId` (ADR-0060, issue #81). Sets the
// recipe header name and rewrites the bound .duck; the bound path is untouched.
// For a never-saved session the name is held in memory until save-as.
export async function renameSession(
  sessionId: string,
  newName: string,
): Promise<string> {
  return invoke<string>("rename_session", { sessionId, newName });
}

// Rename a CLOSED .duck recipe's session_name in place (ADR-0060, issue #81).
// `path` is the .duck file path (SessionMetadata.session_id). The backend reads
// the recipe, rewrites the header, atomic-saves -- no DuckDB instance is built.
// Refuses a path currently held open (rename those via renameSession by id).
export async function renamePersistedSession(
  path: string,
  newName: string,
): Promise<void> {
  await invoke<void>("rename_persisted_session", { path, newName });
}

// Read + clear the named session's most recent per-turn persistence failure
// (ADR-0034/0035 honest signal). Returns the typed SaveError (issue #120) so
// the banner renders the failure kind via the locale catalog instead of
// matching a backend Display string; null after a clean save.
export async function takePersistError(sessionId: string): Promise<SaveError | null> {
  return invoke<SaveError | null>("take_persist_error", { sessionId });
}

// --- App-level config (issue #53, ADR-0038) --------------------------------
//
// Session-AGNOSTIC (ADR-0056): no sessionId.

export async function getAppConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("get_app_config");
}

export async function setAppConfig(config: AppConfig): Promise<AppConfig> {
  return invoke<AppConfig>("set_app_config", { config });
}

export async function recordRecentFile(path: string): Promise<void> {
  await invoke<void>("record_recent_file", { path });
}

// --- User-configured external MCP servers (ADR-0076, issue #301) ---------
//
// CRUD over a user's external MCP servers (app-config) + per-secret keychain
// storage. The server config + its NON-SECRET env values live in app-config
// (getAppConfig carries the registry as `mcp_servers`); a SECRET env value
// lives in the OS keychain under mcp-<id>-<env_key> and crosses IPC exactly
// once here (into Rust), never back out (ADR-0029 invariant 3). The settings UI
// that drives these lands in #302.

// Upsert one MCP server. Send an empty `id` for a new server (Rust mints a uuid
// v4); send the existing id to edit. Rust fills `display_name` from the id when
// empty. Returns the finalized config (with the stable id) so the UI can address
// the server in subsequent secret / remove calls.
export async function upsertMcpServer(server: McpServerConfig): Promise<McpServerConfig> {
  return invoke<McpServerConfig>("upsert_mcp_server", { server });
}

// Remove the MCP server with the given id (idempotent). Does NOT clear the
// server's keychain secrets -- the UI orchestrates clear-then-remove.
export async function removeMcpServer(id: string): Promise<void> {
  await invoke<void>("remove_mcp_server", { id });
}

// Store one MCP server secret in the OS keychain under mcp-<id>-<env_key>
// (ADR-0029 one-shot transfer; the value never returns across IPC).
export async function setMcpServerSecret(
  id: string,
  envKey: string,
  value: string,
): Promise<void> {
  await invoke<void>("set_mcp_server_secret", { id, envKey, value });
}

// Remove one MCP server secret (idempotent). A keychain error rejects so the UI
// can tell the user the secret did not come out (ADR-0029 trust root).
export async function clearMcpServerSecret(id: string, envKey: string): Promise<void> {
  await invoke<void>("clear_mcp_server_secret", { id, envKey });
}

// --- Tiered tool approval (ADR-0080, issue #294) -------------------------
//
// The IPC contract for the in-flow approval card (ADR-0083) + the
// session-level authorization-mode / trust controls. The frontend rendering
// (pending/resolved trace entries, three-button card, unanswered badge) lands
// in #297 / #298; the auth-mode selector UI lands in #302. These functions
// own the wire surface only.

// Answer the session's in-flight approval request (ADR-0083 three-button
// card). `requestId` is the one carried by the `approval-request` event; the
// response escalates to session trust on `always_allow` (resume resets it).
// A respond that lands after the turn was cancelled, or a duplicate answer,
// rejects -- the frontend reconciles via `onApprovalResolved` rather than
// branching on the error.
export async function respondToolApproval(
  sessionId: string,
  requestId: string,
  response: ApprovalResponse,
): Promise<void> {
  await invoke<void>("respond_tool_approval", { sessionId, requestId, response });
}

// Read the session's authorization posture (ADR-0080 Decision 4): `per_call`
// (default) or `no_confirmation`. Session-level; resumes as `per_call`.
export async function getAuthorizationMode(sessionId: string): Promise<AuthMode> {
  return invoke<AuthMode>("get_authorization_mode", { sessionId });
}

// Switch the session's authorization posture (ADR-0080 Decision 4). Only
// `per_call` <-> `no_confirmation` is accepted; both resume to `per_call`.
export async function setAuthorizationMode(
  sessionId: string,
  mode: AuthMode,
): Promise<void> {
  await invoke<void>("set_authorization_mode", { sessionId, mode });
}

// Snapshot the session's "always allow" trust set (ADR-0080 Decision 3),
// keyed by `server::tool`. Resumes empty.
export async function listSessionTrust(sessionId: string): Promise<ToolKey[]> {
  return invoke<ToolKey[]>("list_session_trust", { sessionId });
}

// Revoke one tool's session-level trust (ADR-0080 Decision 3). The next call
// to that tool re-enters per-call confirmation.
export async function revokeSessionTrust(
  sessionId: string,
  server: string,
  tool: string,
): Promise<void> {
  await invoke<void>("revoke_session_trust", { sessionId, server, tool });
}

// Subscribe to approval-request events (ADR-0083). Each event carries the
// addressing sessionId so a multi-session frontend filters the global
// broadcast to the one pane that owns the suspended turn (ADR-0056).
export async function onApprovalRequest(
  cb: (ev: ApprovalRequestPayload) => void,
): Promise<UnlistenFn> {
  return listen<ApprovalRequestPayload>("approval-request", (e) => cb(e.payload));
}

// Subscribe to approval-resolved events (ADR-0083). The frontend flips the
// pending card to its resolved state in place; a cancel/close resolves to
// `deny` so no stale pending entry lingers.
export async function onApprovalResolved(
  cb: (ev: ApprovalResolvedPayload) => void,
): Promise<UnlistenFn> {
  return listen<ApprovalResolvedPayload>("approval-resolved", (e) => cb(e.payload));
}
