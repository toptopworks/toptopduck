import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { AppConfig, DefaultRuntime, ModelPosture } from "./types/app-config";
import type {
  DatasetDescriptor,
  DatasetPrivacy,
  LoadOutcome,
  RowPage,
  SheetGuidance,
} from "./types/dataset";
import type {
  DiscoveryResult,
  ImportSource,
  McpProbeResult,
  McpServerConfig,
  McpServerStatusEntry,
} from "./types/mcp";
import type {
  ImportItem,
  ImportMode,
  ImportOutcome,
  SkillEntry,
  SkillListing,
  SkillSource,
  SkillUpdate,
} from "./types/skills";
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
import type {
  AdapterCatalogs,
  AdapterEntry,
  ProbeOk,
  SessionModelConfig,
  SessionRuntimeChoice,
} from "./types/runtime";

// Multi-session addressing (ADR-0056): every session-scoped function takes
// `sessionId` as its first parameter -- the backend looks up the target
// session by id. Session-AGNOSTIC functions (api key / provider config / app
// config / sessions dir) take no sessionId. The frontend tracks the ids
// itself (createSession mints one); this single-session shell holds one until
// the multi-tab UI lands in a later PRD.

/** The wire reply from `create_session` (ADR-0089): the runtime session id +
 *  the bound `session.duck` path. Every session is persisted from creation. */
export interface CreateSessionReply {
  session_id: string;
  duck_path: string;
}

// Create a new session (ADR-0056/0089): the backend builds an independent
// in-memory DuckDB instance + per-session cancel token, binds them to a
// backend-generated id (UUID), AND immediately persists by creating a
// per-session directory + initial session.duck. This is the `+ tab` action.
export async function createSession(): Promise<CreateSessionReply> {
  return invoke<CreateSessionReply>("create_session");
}

// Close a session (ADR-0055): fire cancel + mark closing + remove from the
// store. Returns immediately; an in-flight ask's post-check discards its turn.
// After this, calls targeting the id reject as unknown session.
// Returns true when ADR-0089 Decision 6 cleaned up the per-session directory
// (empty timeline); false for a normal close where the session stays on disk.
export async function closeSession(sessionId: string): Promise<boolean> {
  return invoke<boolean>("close_session", { sessionId });
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

// Export a copy of the per-session directory (session.duck + assets/) to a
// user-chosen destination (ADR-0089 Decision 5, issue #449). Does NOT rebind
// the session or touch the registry — pure file I/O.
export async function exportSession(
  duckPath: string,
  destDir: string,
): Promise<void> {
  await invoke<void>("export_session", { duckPath, destDir });
}

// Import an external .duck into the managed sessions tree (ADR-0089 Decision 5,
// issue #450). Copies the external file (and companion assets/) into a fresh
// per-session directory, returns the session id + local duck path. The frontend
// then calls openDuck on the returned path to resume. The store entry is NOT
// bound by this call — binding happens inside open_duck, avoiding a canonical-
// writer registry conflict.
export async function prepareImportSession(
  externalPath: string,
): Promise<CreateSessionReply> {
  return invoke<CreateSessionReply>("prepare_import_session", {
    externalPath,
  });
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
// (ADR-0060/0061, issue #76). The backend scans the managed sessions directory
// (ADR-0089) and derives each entry from its recipe + mtime; unreadable paths
// are skipped. duck_path is the .duck path -- pass it back to openDuck to
// resume.
export async function listSessions(): Promise<SessionMetadata[]> {
  return invoke<SessionMetadata[]>("list_sessions");
}

// Delete a persisted .duck file (ADR-0060, issue #81). The frontend closes the
// session first when it is open, then calls this. The backend removes the
// per-session directory; a missing file is idempotent success.
// `path` is the .duck file path (the SessionMetadata.duck_path from listSessions).
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

// Read the OPEN session's current display name (ADR-0089 Decision 4). After the
// first terminal turn auto-names the session, the frontend calls this to sync
// the sidebar entry + session header with the backend's auto-generated name.
export async function getSessionName(sessionId: string): Promise<string> {
  return invoke<string>("get_session_name", { sessionId });
}

// Rename a CLOSED .duck recipe's session_name in place (ADR-0060, issue #81).
// `path` is the .duck file path (SessionMetadata.duck_path). The backend reads
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

// --- Managed sessions directory (issue #452, ADR-0089 Decision 2) ----------
//
// Session-AGNOSTIC (ADR-0056): no sessionId. The dedicated IPC validates the
// path (exists + writable) + persists to app-config + updates the in-memory
// SessionsRoot live, returning the updated AppConfig. Unlike set_app_config,
// this carries the SessionsRoot side-effect (no restart needed).

// Set the managed sessions directory. Validates + persists + updates the live
// root. Returns the updated AppConfig so the frontend syncs state without a
// re-fetch. The sidebar (list_sessions) re-scans the new directory on the
// caller's next refresh.
export async function setSessionsDir(path: string | null): Promise<AppConfig> {
  return invoke<AppConfig>("set_sessions_dir", { path });
}

// Set the default runtime new sessions start on (ADR-0098 Decision 2, issue
// #569; a resume continues the session's own last runtime since ADR-0102 --
// the default stays the fallback for a pre-#589 recipe without the field).
// Returns the updated AppConfig so the caller syncs state without a re-fetch.
// An external id must name a `listAdapters` adapter (unknown ids reject --
// UnknownAdapter); the adapter does NOT need to be detected: the preference
// persists and startup resolution degrades per-start (ADR-0098 Decision 3).
export async function setDefaultRuntime(runtime: DefaultRuntime): Promise<AppConfig> {
  return invoke<AppConfig>("set_default_runtime", { runtime });
}

// --- Startup model posture backfill (ADR-0100, issue #581) ------------------
//
// Session-AGNOSTIC (ADR-0056): keyed by adapter id, not sessionId. The
// composer bar reads the backfill entry via getLastModelPosture and clears
// it via clearLastModelPosture.

// Read one adapter's backfill posture: the model + thought-level a NEW session
// on that adapter starts with (selected + injected). Never refuses -- no entry
// (never chosen) and a cleared entry both read as the empty posture
// (null/null), i.e. an unselected "default (recommended)" start.
export async function getLastModelPosture(adapterId: string): Promise<ModelPosture> {
  return invoke<ModelPosture>("get_last_model_posture", { adapterId });
}

// Clear one adapter's backfill posture (ADR-0100 Decision 3): the posture
// cascade's "default (recommended)" row -- the next new session on that
// adapter starts unselected again, so the backfill never makes an explicit
// clear pointless. The id must name a `listAdapters` adapter (the same
// table-membership contract as setDefaultRuntime; detection not required).
// Returns the updated AppConfig so the caller syncs state without a re-fetch.
export async function clearLastModelPosture(adapterId: string): Promise<AppConfig> {
  return invoke<AppConfig>("clear_last_model_posture", { adapterId });
}

// Read the current sessions directory's resolved path string. Used for the
// settings display + revealItemInDir target + the directory-picker defaultPath.
export async function getSessionsDir(): Promise<string> {
  return invoke<string>("get_sessions_dir");
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

// List every configured MCP server with THIS session's enablement + last
// connect outcome (issue #301 slice D, AC#3; consumed by the composer "+"
// panel badge, ADR-0083 issue #351). Session-scoped (ADR-0056): enablement is
// per session. Lock-light server-side -- safe to call while a turn is in
// flight. A reject (e.g. the session closed mid-flight) propagates to the
// caller; the panel coalesces an undefined read to an empty count, so a
// mid-flight session-close never surfaces a user-facing error.
export async function listMcpServerStatus(sessionId: string): Promise<McpServerStatusEntry[]> {
  return invoke<McpServerStatusEntry[]>("list_mcp_server_status", { sessionId });
}

// Toggle one MCP server's enabled state for this session (issue #301 slice D
// AC#3, used by the composer "+" panel MCP section, issue #369). Session-
// scoped: enabling includes all the server's tools in the next turn's
// connect_all; disabling removes them. The change lands next turn (per-turn
// spawn, ADR-0076 Q2).
export async function toggleMcpServer(
  sessionId: string,
  serverId: string,
  enabled: boolean,
): Promise<void> {
  await invoke<void>("toggle_mcp_server", { sessionId, serverId, enabled });
}

// Probe one MCP server's connectivity (issue #387). Global (not session-
// scoped): the settings page calls this to test a server independently of any
// agent turn. The backend spawns the server, initializes, lists tools, then
// tears down. v1 supports stdio only; other transports return connected:false
// with an unsupported-transport error.
export async function probeMcpServer(server: McpServerConfig): Promise<McpProbeResult> {
  return invoke<McpProbeResult>("probe_mcp_server", { server });
}

// Discover MCP servers from an external tool's config (issue #390). The backend
// reads the source's local config file (Claude Desktop / Codex), parses server
// definitions, and returns a DiscoveryResult (servers + config file path) for
// the import checklist. Returns empty servers when the config file is not found
// (NOT an error).
export async function discoverMcpServers(
  source: ImportSource,
): Promise<DiscoveryResult> {
  return invoke<DiscoveryResult>("discover_mcp_servers", { source });
}

// --- Skills registry (issue #362, ADR-0086) --------------------------------
//
// CRUD over the Agent Skills registry under <app_data_dir>/skills.
// Session-AGNOSTIC: the registry is process-global (one root shared by every
// session). The directory scan IS the registry (no sidecar, no app-config
// entry). Rejects are the typed SkillError (adjacently tagged like every other
// typed IPC error) so the settings page renders each refusal through the locale
// catalog (ADR-0052). The composer "+" panel reads the registry through the
// same IPC (issue #365); the per-session mount model lives in the block below
// (issue #363).

// List every spec-valid skill in the registry PLUS the directories the scan
// skipped (acquired derived by the loader). Directories that fail the spec
// are surfaced in `ignored` with the English technical reason so the settings
// UI can show WHY a directory disappeared; the spec-valid `skills` list keeps
// its sorted semantics. A never-created registry lists empty (both fields
// `[]`). Read-only -- never refuses.
export async function listSkills(): Promise<SkillListing> {
  return invoke<SkillListing>("list_skills");
}

// Mint a new local skill: <root>/<name>/SKILL.md with the given description +
// the skeleton body. The name must be kebab-case (<= 64) and free. Returns the
// entry read back from disk.
export async function createSkill(name: string, description: string): Promise<SkillEntry> {
  return invoke<SkillEntry>("create_skill", { name, description });
}

// Rewrite one local skill's SKILL.md (frontmatter + body) atomically. `name`
// addresses the current directory; `update.name` is the identity to write -- a
// different value renames the directory. Refuses a linked skill (read-only),
// an unknown skill, and a taken rename target.
export async function updateSkill(name: string, update: SkillUpdate): Promise<SkillEntry> {
  return invoke<SkillEntry>("update_skill", { name, update });
}

// Delete a skill. A local skill's directory is removed with all its contents;
// a linked skill's LINK is removed without touching the external source.
export async function deleteSkill(name: string): Promise<void> {
  await invoke<void>("delete_skill", { name });
}

// --- Skill import (issue #367, ADR-0086) -------------------------------------
//
// The import dialog discovers external agent skill libraries (Claude Code
// ~/.claude/skills, Codex CLI ~/.codex/skills + user-added custom paths) and
// imports each selected skill as a link (acquired: linked) or a copy
// (acquired: local). Session-AGNOSTIC + read-only discovery; the import
// command re-validates + re-checks the registry at commit time.

// Discover external skill sources for the import dialog (issue #367). The
// backend resolves the standard agent libraries off the home dir + appends
// each `customPaths` entry (absolute OS paths the dialog collected via the
// directory picker). A source that does not exist is dropped silently (the
// "show only if it exists" rule). Each surviving source's skills are
// classified importable / already_exists / invalid against the CURRENT
// registry name set. Read-only -- never refuses.
export async function listSkillSources(customPaths: string[]): Promise<SkillSource[]> {
  return invoke<SkillSource[]>("list_skill_sources", { customPaths });
}

// Import a batch of skills into the registry (issue #367). Each item is an
// absolute source directory; `mode` is shared across the batch (the dialog's
// bottom dropdown). The result parallels the input so a per-item failure never
// aborts the rest -- the caller folds each `failed` through fmtError. Each
// item is re-validated + name-re-checked at commit time.
export async function importSkills(
  items: ImportItem[],
  mode: ImportMode,
): Promise<ImportOutcome[]> {
  return invoke<ImportOutcome[]>("import_skills", { items, mode });
}

// --- Skill mount model (issue #363, #365; ADR-0086) -----------------------
//
// Per-session mount / unmount over the live timeline. The mount SET is folded
// from the SkillLifecycleEvent sequence (Mount in / Unmount out); these
// commands append the event + atomically persist the recipe. Session-scoped
// (ADR-0056): every command takes sessionId first. The loading gate lives on
// the backend -- both write commands refuse during resume / an in-flight turn
// (reject_if_resuming + reject_if_in_flight), so the toggle the frontend
// renders is also disabled under the same `loading` gate the composer already
// honors (issue #365 AC #5). Rejects ride SessionError.SkillMount (typed
// AlreadyMounted / NotMounted).

// The session's currently-mounted skill names, in first-mount insertion order
// (issue #363). Read-only; the composer "+" panel + the badge both derive the
// active set from this. Lock-light server-side -- safe to call while a turn is
// in flight. A reject (e.g. session closed mid-flight) propagates to the
// caller; the skills section renders the cached / undefined read as an empty
// set for numeric coherence (badge count + checkbox state) and surfaces the
// reject through its alert slot.
export async function listMountedSkills(sessionId: string): Promise<string[]> {
  return invoke<string[]>("list_mounted_skills", { sessionId });
}

// Mount a skill into the session's active set (issue #365). Appends a Mount
// lifecycle event + persists the recipe; refuses a redundant mount
// (AlreadyMounted) and rejects during resume / an in-flight turn.
export async function mountSkill(sessionId: string, name: string): Promise<void> {
  await invoke<void>("mount_skill", { sessionId, name });
}

// Unmount a skill from the session's active set (issue #365). Appends an
// Unmount lifecycle event + persists the recipe; refuses a name not in the set
// (NotMounted) and rejects during resume / an in-flight turn.
export async function unmountSkill(sessionId: string, name: string): Promise<void> {
  await invoke<void>("unmount_skill", { sessionId, name });
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

// --- Runtime selector (issue #353, ADR-0076/0081/0083) ---------------------
//
// Session-AGNOSTIC adapter table (list / rescan) + per-session runtime choice
// (get / set). The composer runtime picker reads the table + the choice and
// writes a switch back; the next turn dispatches on the selection at the turn
// boundary (built-in BYOK loop vs external ACP engine).

// List every v1 adapter with its live PATH-scan detection state. The picker
// renders this verbatim -- adding a CLI upstream grows the list with zero
// frontend change. Read-only; never refuses.
export async function listAdapters(): Promise<AdapterEntry[]> {
  return invoke<AdapterEntry[]>("list_adapters");
}

// Re-run the adapter PATH scan on demand (the picker's ↻ entry). Same
// projection as listAdapters -- detection is uncached -- but its own command
// so a user-driven re-detect is an explicit wire action.
export async function rescanAdapters(): Promise<AdapterEntry[]> {
  return invoke<AdapterEntry[]>("rescan_adapters");
}

// Run the adapter diagnostic probe (ADR-0096, issues #534/#535): one-shot
// spawn of the detected CLI in protocol mode + per-format catalog query (ACP
// initialize/session/new handshake, or codex app-server `model/list`) +
// process terminated. Display-only in this slice (no cache); the rejection
// is the structured ProbeError (kind-dispatched by the UI). Long-running
// (CLI cold start can take tens of seconds; backend wall clock 45s) --
// callers own the in-flight UI state.
export async function probeAdapter(adapterId: string): Promise<ProbeOk> {
  return invoke<ProbeOk>("probe_adapter", { adapterId });
}

// Read the adapter catalog cache (ADR-0096 D5/D6, issue #536): every
// adapter's last explicitly-tested catalog + timestamp, from the app-data
// sidecar. Lock-light server-side (a plain file read, no session lock), so
// it is safe during an in-flight turn. Honest-degrade server-side too -- a
// missing or corrupt file reads as an empty map; the command never rejects.
export async function getAdapterCatalogs(): Promise<AdapterCatalogs> {
  return invoke<AdapterCatalogs>("get_adapter_catalogs");
}

// Read the session's runtime choice. Returns `built_in` for a fresh session
// (the honest default, ADR-0081); a resumed session returns the restored
// last runtime (ADR-0102 segment continuation) -- degraded to the built-in
// start when the recorded adapter is not detected, or the resolved default
// when the recipe predates the field. Lock-light server-side -- safe to
// call while a turn is in flight.
export async function getSessionRuntime(
  sessionId: string,
): Promise<SessionRuntimeChoice> {
  return invoke<SessionRuntimeChoice>("get_session_runtime", { sessionId });
}

// Set the session's runtime choice. Takes effect at the next turn boundary
// (the in-flight turn, if any, finishes on the runtime it started on). An
// unknown adapter id rejects -- the picker only offers `listAdapters` ids, so
// a reject is a stale / buggy client; the chip resyncs off the reject.
export async function setSessionRuntime(
  sessionId: string,
  runtime: SessionRuntimeChoice,
): Promise<void> {
  await invoke<void>("set_session_runtime", { sessionId, runtime });
}

// Read the session's external-runtime model config (ADR-0095, issue #527): the
// model + thought-level selections and the cached discovery catalog. Lock-light
// server-side -- safe to call while a turn is in flight.
export async function getSessionModelConfig(
  sessionId: string,
): Promise<SessionModelConfig> {
  return invoke<SessionModelConfig>("get_session_model_config", { sessionId });
}

// The persist-now verdict a successful set command carries back (issue
// #529): read in-process in the same critical section as the set, so the
// selection's own persist outcome cannot be mis-attributed or swallowed by
// the shared banner channel. `persist_error` = the typed SaveError of a
// failed write; `persist_suspended` = true when the write was withheld on a
// pending ADR-0035 conflict (externally modified .duck). Both null/false =
// the write landed (or the session is unbound, nothing to persist).
export interface SetModelPersistOutcome {
  persist_error: SaveError | null;
  persist_suspended: boolean;
}

// Set the session's model selection for the next external-runtime turn
// (ADR-0095). `null` clears (the CLI's own default). Takes effect at the next
// turn boundary; rejected while resuming or while a turn is in flight.
export async function setSessionModel(
  sessionId: string,
  model: string | null,
): Promise<SetModelPersistOutcome> {
  return invoke<SetModelPersistOutcome>("set_session_model", {
    sessionId,
    model,
  });
}

// Set the session's thought-level selection for the next external-runtime turn
// (ADR-0095). Same semantics as setSessionModel; a no-op posture on the
// built-in runtime.
export async function setSessionThoughtLevel(
  sessionId: string,
  thoughtLevel: string | null,
): Promise<SetModelPersistOutcome> {
  return invoke<SetModelPersistOutcome>("set_session_thought_level", {
    sessionId,
    thoughtLevel,
  });
}
