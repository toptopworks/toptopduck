//! Per-session state: an in-memory DuckDB parent (working-set metadata + future
//! result_N) plus READ_ONLY-attached source snapshots (ADR-0004/0005/0012). The
//! per-session temp dir holds the snapshot files and is cleared on drop (ADR-0012).

pub mod agent_loop;
pub mod derived_source;
pub mod inline_materialize;
pub mod materializer;
pub mod recipe_persister;
pub mod resume;
pub mod sandbox;
pub mod skills;
pub mod snapshot;
pub mod source_lifecycle;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use calamine::Data;
use duckdb::Connection;
use tempfile::TempDir;

use crate::approval::{ApprovalRequestBody, ApprovalResponse, ApprovalSink, ApprovalState};
use crate::cancel::CancelToken;
use crate::guardrail::{apply_resource_caps, DEFAULT_MAX_RESULT_ROWS};
use crate::ingest;
use crate::ingest::schema::quote_ident;
use crate::ingest::tidy::{auto_tidy, forward_fill_merges, TidyOutcome};
use crate::mcp::config::McpServerConfig;
use crate::model::{
    DatasetDescriptor, DatasetPrivacy, GuidanceRequest, GuidanceSheet, LoadError, LoadOutcome,
    RectifyProvenance, RenameError, RowPage, SheetGuidance, SheetRectify, SkillLifecycleEvent,
    SkillProvenance, SourceLifecycleEvent, SourceLifecycleKind, TextKind, ThreadEntry,
    TraceEntryView, TurnError, TurnFailure, TurnOutcome, TurnPhase, TurnProvenance, TurnRecord,
};
use crate::persistence::recipe::{
    Recipe, RecipeTraceEntry, RecipeTurn, RuntimeKind, SourceRef,
    TurnProvenance as PersistedTurnProvenance,
};
use crate::persistence::registry::canonicalize_duck;
use crate::persistence::{read_duck, SaveError};
use crate::provider::keychain::KeychainStore;
use crate::provider::prompt::ResponseLocale;
use crate::provider::{Provider, UnwiredProvider};
use crate::runtime::acp::adapter::{detect_adapter, AdapterSpec};
use crate::runtime::acp::engine::{AcpEngine, AcpTurnInput};
use crate::runtime::acp::wire::McpServer;
use crate::runtime::gateway::server::{bind_gateway, serve_connection, GatewayCtx, GatewayOutcome};
use crate::session::agent_loop::{AgentLoop, LoopOutcome, Termination, TraceEntry};
use crate::session::materializer::{CachedDerivedRef, Materializer, RealMaterializer, TurnDeps};
use crate::session_store::ClosingFlag;
use crate::skills::SkillPromptFragment;
use crate::tools::definitions::builtin_metadata;
use crate::window;
use crate::workingset::{WorkingSet, DEFAULT_RESULT_COUNT_CAP};

// Re-export the resume global-state probe (ADR-0053 Decision 3) after its
// move into `session::resume`. Since ADR-0056 the LIVE command-layer resume
// gate is per-session (`SessionHandle::is_resuming`, read by
// `commands::reject_if_resuming`); this process-global `is_resuming` /
// `resuming_count` pair is retained ONLY as the integration-test RAII probe
// (persistence_blackbox.rs asserts it rises and clears around a resume). It
// is further re-exported from `lib.rs` so those tests can reach it.
pub use resume::{is_resuming, resuming_count};

/// Raw rows surfaced per sheet in the guided-load preview -- enough to spot the
/// header row and any separator/sub-header/footer rows to skip (ADR-0015).
const GUIDANCE_PREVIEW_ROWS: usize = 12;

/// Upper bound on a single read_rows page (ADR-0005/0024 display cap). A larger
/// requested limit is clamped so a malformed/hostile caller can't pull the whole
/// table into memory; the physical table still holds the full result.
const MAX_READ_ROWS: u64 = 10_000;

/// The subdirectory name under the session temp dir where external MCP tools
/// write their output files (ADR-0087 Decision 3). Created eagerly at session
/// construction; lifecycle follows the TempDir RAII. The path is passed to each
/// stdio MCP server via `TOPTOPDUCK_TOOL_OUTPUT_DIR` (see `mcp::client`).
pub(crate) const TOOL_OUTPUT_DIR_NAME: &str = "tool_output";

/// Maximum length of an auto-generated session name, in chars (ADR-0089
/// Decision 4). The name is the first question's verbatim text, bounded by
/// this cap. Same truncation rule as ADR-0039 (verbatim question cut at a
/// char boundary with an ellipsis, never an LLM summary) -- the specific
/// bound is an impl parameter, shorter than the far-window excerpt because a
/// sidebar title has less horizontal room.
const SESSION_NAME_MAX_CHARS: usize = 50;

/// Truncate a question into a session name (ADR-0089 Decision 4 + ADR-0039
/// bounded-truncation rule). The result is the verbatim question (trimmed)
/// cut at [`SESSION_NAME_MAX_CHARS`] chars with an ellipsis when truncated --
/// never an LLM summary. An empty / whitespace-only question yields an empty
/// string, which the display layer falls back from (listing::display_name).
fn truncate_session_name(question: &str) -> String {
    let trimmed = question.trim();
    if trimmed.chars().count() <= SESSION_NAME_MAX_CHARS {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(SESSION_NAME_MAX_CHARS).collect();
    format!("{head}…")
}

/// Why a resume failed (ADR-0035 honest degrade). The interactive re-link /
/// drift / active-abandoned decisions land via [`SourceIssue`] /
/// [`ActiveAbandoned`] callbacks; this enum covers the non-interactive
/// failures (corrupt recipe, path-traversal refusal, user cancel / abort).
///
/// Crosses IPC serde-structured (issue #120): `#[serde(tag = "kind", content =
/// "data")]`, the adjacently-tagged shape the rest of the wire contract uses
/// (the same as [`crate::session_store::SessionError`]). The `open_duck`
/// command wraps this in [`SessionError::Resume`], so the frontend recurses
/// `Resume.data.kind`
/// and renders a locale message; the `Load` variant recurses into the nested
/// [`LoadError`](crate::persistence::io::LoadError) for the version-mismatch /
/// io / parse / migration detail. Command-boundary internal failures (mutex
/// poison, join panic) stay on `SessionError::Engine` -- they are NOT resume-
/// domain, so they do not ride this enum. The hand-written `Display` below
/// stays Rust-log-only; it is NOT the IPC contract.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum ResumeError {
    /// Reading or parsing the .duck failed (ADR-0036 version / parse / IO).
    Load(crate::persistence::io::LoadError),
    /// A source path was refused at the resume boundary for a non-recoverable
    /// reason -- today, a relative_path that escapes the `.duck`'s directory
    /// subtree (path-traversal refusal, ADR-0036 trust boundary). Distinct
    /// from the interactive [`SourceIssue::Missing`]: a traversal is a hard
    /// engine refusal (re-linking to the same traversed path would not help),
    /// while a plain missing file is a user-resolvable re-link.
    SourceMissing {
        reference_name: String,
        path: String,
        detail: String,
    },
    /// A working-set invariant violation surfaced while rebuilding the
    /// conversation timeline: a Materialized turn that should have been
    /// re-materialized by [`Session::resume_replay`] is not registered. A
    /// replay SQL failure itself is NOT reported here -- it lands as a partial
    /// session with that turn rendered as `Failed` (ADR-0035 honest partial
    /// state). This variant signals a logic bug or a hand-edited recipe whose
    /// history references a result the chain never produced.
    Replay {
        reference_name: String,
        detail: String,
    },
    /// The recipe's active pointer does not resolve to a usable registered
    /// source. Two paths land here, both honest stops (the engine never
    /// silently picks a different active source): (1) a corrupt recipe whose
    /// `active` was never in `recipe.sources` -- the write path never
    /// persists such a name, so this signals external editing; (2) the
    /// caller's [`ActiveResolution::ContinueWith`] named a source not in the
    /// `remaining` menu -- a stale view or a direct IPC race. Distinct from
    /// an active source that WAS in the recipe but got rebuilt: that case is
    /// resolvable via [`ActiveAbandoned`] and never reaches this variant.
    ActiveMissing(String),
    /// The user cancelled resume (ADR-0021): the cancel token fired during
    /// source verification or replay. Distinct from [`Self::Aborted`] so the
    /// UI can show "已取消" instead of "已中止" -- a cancel is an engine
    /// interrupt, not a user dialog choice.
    Cancelled,
    /// The user chose Abort in a re-link or active-abandoned dialog
    /// (ADR-0035): resume stops at the decision point and the on-disk recipe
    /// is left untouched (no partial state is persisted). Distinct from
    /// [`Self::Cancelled`] (engine interrupt) and from Rebuild (which abandons
    /// ONE source and continues -- Abort abandons the whole resume).
    Aborted,
    /// ADR-0035 Decision 3 / issue #50: the canonical `.duck` path is already held
    /// open by another Session in this process (single-writer). Resume is
    /// refused BEFORE any source read or replay so the existing in-memory
    /// session's state is never diverged from disk by a second opener. The
    /// caller surfaces this as "already open" -- the user closes one window
    /// or uses the existing session rather than silently racing two writers.
    AlreadyOpen(PathBuf),
}

impl std::fmt::Display for ResumeError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::Load(e) => write!(f, "{e}"),
            Self::SourceMissing {
                reference_name,
                path,
                detail,
            } => write!(f, "源「{reference_name}」找不到：{path}（{detail}）"),
            Self::Replay {
                reference_name,
                detail,
            } => write!(f, "重放「{reference_name}」失败：{detail}"),
            Self::ActiveMissing(name) => write!(f, "会话焦点指向未注册的源「{name}」"),
            Self::Cancelled => write!(f, "已取消恢复"),
            Self::Aborted => write!(f, "已中止恢复"),
            Self::AlreadyOpen(p) => {
                write!(f, "该 .duck 已在本进程打开，不能重复打开：{}", p.display())
            }
        }
    }
}
impl std::error::Error for ResumeError {}

/// Why a session rename was rejected (ADR-0060, issue #81). The single refusal
/// is a blank name; a persist write failure does NOT surface here -- it rides
/// [`Session::take_persist_error`] (best-effort persist, self-heals on the next
/// write). Crosses IPC as this serde struct, wrapped in
/// [`SessionError::RenameSession`](crate::session_store::SessionError) (issue
/// #121); the frontend narrows on `kind` and renders a locale message. The
/// `Display` is Rust-log-only -- NOT the IPC contract.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum RenameSessionError {
    /// The trimmed name was empty / whitespace-only. A session name must be
    /// visible, so blanks are rejected; the user must supply a non-blank name.
    EmptyName,
}

impl std::fmt::Display for RenameSessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::EmptyName => write!(f, "session name must not be empty"),
        }
    }
}
impl std::error::Error for RenameSessionError {}

/// Per-source integrity issue surfaced during resume (ADR-0035 honest degrade,
/// issue #49). Passed to the caller's [`Session::open_duck`] `on_source_issue`
/// callback so the UI (or test) can drive the re-link / abort / rebuild
/// decision -- the engine NEVER silently picks. Each variant names the source
/// + the path/fingerprint context the decision needs.
///
/// C1 (issue #121): `SourceIssue` does NOT yet cross IPC as a typed value --
/// `open_duck`'s `on_source_issue` callback always aborts today (no re-link
/// UI), so it produces no user-facing wording. When #49 lands the re-link /
/// rebuild dialogs this enum will follow the same typed-IPC pattern as the
/// source-management errors (`#[serde(tag = "kind", content = "data")]` + a
/// `types.ts` mirror + locale messages), and the `Unreadable.reason` field --
/// today a Rust-log-only ingest `LoadError` display string -- will be replaced
/// by the typed `LoadError`.
#[derive(Debug, Clone)]
pub enum SourceIssue {
    /// The recorded path no longer exists (deleted / moved / renamed). The
    /// user may re-link to the moved file, abort, or rebuild (re-upload later).
    /// Distinct from [`Self::Unreadable`]: a Missing file is a re-link
    /// candidate (the user likely knows where it moved); an Unreadable file
    /// is a format/parse problem the user must diagnose before re-linking
    /// would help. Confusing the two would mislead the UI into offering a
    /// re-link dialog for a file that is right where the recipe recorded it
    /// (ADR-0035 honest signal -- the issue's kind drives the user action).
    Missing {
        reference_name: String,
        /// The path the recipe recorded (absolute fallback form).
        recorded_path: String,
    },
    /// The file IS present at its resolved path but could not be read into a
    /// usable snapshot: parse error, unsupported format, refused Excel
    /// workbook (multi-sheet guided rectify needs its own resume path), or a
    /// DuckDB ATTACH failure. The user sees the underlying reason so they can
    /// tell a corrupt/unsupported file from a moved one. The same re-link /
    /// abort / rebuild resolutions apply -- re-linking to a different file of
    /// a supported format is the typical fix.
    Unreadable {
        reference_name: String,
        /// The path actually read (post resolve, after any prior re-link).
        path: String,
        /// The underlying read failure detail (LoadError display string).
        reason: String,
    },
    /// The source is present at its path but the post-rectify fingerprint
    /// differs from the recipe's record (ADR-0035 "drift") -- the data
    /// changed since the recipe was written. The engine must NEVER silently
    /// replay with the new data; the user decides to rebuild (the data is
    /// genuinely different) or abort. A re-link to a backup whose fingerprint
    /// matches the recipe is also accepted (the verify loop re-checks).
    Drift {
        reference_name: String,
        /// The path actually read (post resolve, after any prior re-link).
        path: String,
        /// The fingerprint the recipe recorded (the canonical-content hash).
        expected: String,
        /// The fingerprint computed from the file currently at `path`.
        found: String,
    },
}

/// The caller's resolution to a [`SourceIssue`] (ADR-0035). Returned from the
/// `on_source_issue` callback; the engine acts on it without second-guessing.
#[derive(Debug, Clone)]
pub enum SourceResolution {
    /// Re-link: the user pointed at a new path for this source. Resume
    /// re-ingests + fingerprint-verifies; on a match the recipe is updated to
    /// the new path (canonical params + fingerprint UNCHANGED -- same content,
    /// ADR-0035). On a mismatch the issue re-surfaces (loop), giving the user
    /// another chance to pick the right file or abort.
    Relink(PathBuf),
    /// Abort: stop resume entirely. The session is NOT entered; the on-disk
    /// recipe is untouched (AC2 -- "原状保留").
    Abort,
    /// Rebuild: abandon THIS source (it is dropped from the working set + the
    /// persisted recipe), and resume continues with the remaining sources
    /// (AC4 -- per-source independent handling). The user will re-upload the
    /// data in a later turn. If the rebuilt source was the active source AND
    /// at least one other source remains, [`ActiveAbandoned`] fires next
    /// (AC5). When it was the last source, no callback fires -- the empty
    /// working set IS the honest end (AC5 supplement: there is nothing left
    /// to silently fall back to).
    Rebuild,
}

/// Notice that the active-SOURCE pointer was abandoned (AC5, ADR-0035
/// no-silent-fallback). Passed to the `on_active_abandoned` callback ONLY when
/// the active source was rebuilt (or otherwise unresolvable) AND at least one
/// other source remains. When the last source is rebuilt the working set goes
/// empty + `active` becomes `None` without a callback (the empty state IS the
/// honest end -- there is nothing left to silently fall back to).
#[derive(Debug, Clone)]
pub struct ActiveAbandoned {
    /// The reference name of the abandoned active source.
    pub abandoned: String,
    /// The remaining registered source reference names, in working-set order.
    /// Always non-empty when this is fired (empty -> no callback).
    pub remaining: Vec<String>,
}

/// The caller's resolution to an [`ActiveAbandoned`] notice (ADR-0035).
#[derive(Debug, Clone)]
pub enum ActiveResolution {
    /// Continue with an explicit source from `remaining`. ADR-0035 forbids
    /// auto-fallback, so the user must name the continuation source; the
    /// engine never picks "the first remaining" on its own.
    ContinueWith(String),
    /// Abort resume entirely (the user declined to pick a continuation).
    Abort,
}

/// Re-export from [`recipe_persister`] (issue #415): the type moved to the
/// persister module but `commands.rs` / `lib.rs` reach it through `session::`.
pub use self::recipe_persister::PendingConflict;

/// One progress event during resume (ADR-0034 visible progress). Fired per
/// source verification and per replayed turn so the UI can render a
/// deterministic progress bar.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ResumeEvent {
    /// Verifying source `index` of `total` (post-rectify fingerprint check).
    Source {
        index: usize,
        total: usize,
        reference_name: String,
    },
    /// Replaying productive turn `index` of `total` (re-materializing
    /// `result_N`).
    Replay {
        index: usize,
        total: usize,
        reference_name: String,
    },
}

/// One `resume-progress` side-channel event (ADR-0034/0059, issue #76). Wraps a
/// [`ResumeEvent`] with the addressing `session_id` so a multi-session frontend
/// filters the global Tauri event broadcast down to the one SessionPane that
/// owns the resume (ADR-0056/0059 -- v1 emitted a bare ResumeEvent, a
/// single-session legacy; multi-session lands the sessionId here). `session_id`
/// is the runtime id the `open_duck` command received (a UUID string). The field
/// is required -- resume progress without a session it belongs to is not
/// addressable.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ResumeProgress {
    pub session_id: String,
    pub event: ResumeEvent,
}

pub struct Session {
    conn: Connection,
    working_set: WorkingSet,
    _temp_dir: TempDir, // held to keep its dir alive; cleared on drop (ADR-0012)
    temp_path: PathBuf,
    /// The LLM provider (ADR-0007/0064), held behind `Box<dyn>` (dyn, not
    /// generic) so this struct does not parameterize `commands.rs` / `lib.rs`.
    /// [`Self::ask_with_phase`] borrows it per turn to drive the agent loop
    /// (ADR-0081) and reads the live response locale off it for the system
    /// prompt. Built in [`Self::with_provider_and_cancel`].
    provider: Box<dyn Provider>,
    /// The shared materializer (ADR-0053): the SAME trait object the live-turn
    /// agent loop drives (`materialize` tool calls) and the resume path borrows
    /// (recipe replay) -- one promotion mechanism across both paths, so a fake
    /// materializer injected for a `Resumer` unit test exercises the replay
    /// branch without DuckDB / a filesystem. Stateless (`RealMaterializer`);
    /// the admin connection / source_files / working_set it borrows live on
    /// this Session and are passed per turn via [`TurnDeps`]. Held on the
    /// Session itself (not inside the loop, which is built per turn) so the
    /// resume borrow and the live-turn borrow share one object.
    materializer: Box<dyn Materializer>,
    /// The conversation thread (ADR-0028/0039/0040): a unified timeline of turns
    /// AND source/skill lifecycle events, in order. The source of truth the
    /// frontend renders (via [`Self::conversation`]); the window assembler reads
    /// only the turns (via [`Self::turns`]), so non-turn events occupy a
    /// timeline slot and stay always-visible yet never enter the LLM turn window
    /// or advance result_N (ADR-0040). Each turn entry carries its persisted
    /// audit (trace + provenance, ADR-0078) inline, so alignment is structural
    /// rather than maintained by paired pushes (issue #325).
    timeline: Vec<TimelineEntry>,
    /// Ceiling on a materialized result's row count (ADR-0005 L3). A query whose
    /// result would exceed it is aborted with a resource error rather than
    /// allowed to balloon memory. Defaults to [`DEFAULT_MAX_RESULT_ROWS`];
    /// tunable via [`Self::set_result_row_cap`] (e.g. tests lower it for a fast,
    /// deterministic cap-hit).
    result_row_cap: u64,
    /// Ceiling on the number of registered `result_N` (ADR-0013 M=100). When a
    /// freshly materialized result pushes the count over the cap, the oldest
    /// stale results are auto-reclaimed; active results are never auto-deleted.
    /// Defaults to [`DEFAULT_RESULT_COUNT_CAP`]; tunable via
    /// [`Self::set_result_count_cap`] (tests lower it for a fast, deterministic
    /// GC trigger -- the count-cap twin of [`Self::result_row_cap`]).
    result_count_cap: usize,
    /// Each loaded source's reference name -> the `.duckdb` snapshot file admin
    /// currently holds attached, so the sandbox can re-attach it READ_ONLY
    /// (ADR-0005 read_* closure). Tracked here rather than reconstructed from
    /// `temp_path/<ref>.duckdb` because a replace may leave the file at a swap
    /// path. Insert-only; stale entries are harmless (the working set is the
    /// source of truth for which sources exist).
    source_files: HashMap<String, PathBuf>,
    /// Session-level ephemeral cache: tool_output file path → cached
    /// derived-source registration (issue #440). Prevents re-staging +
    /// re-copy_in + re-ATTACH when the same tool_output file is referenced
    /// across multiple materialize calls. Each entry stores the catalog ref
    /// name plus a file fingerprint (mtime + size) for staleness detection.
    /// Ephemeral — not persisted to recipe; cleared on Session drop. Resume
    /// does not need this: recipe SQL already has catalog refs, so process()'s
    /// extract_read_paths finds no read_* calls.
    tool_output_refs: HashMap<String, CachedDerivedRef>,
    /// Cancellation + single-in-flight signal for the query loop (ADR-0021,
    /// issue #28). `Arc`-shared with the cancel command (and the timeout
    /// watchdog) so a cancel fires WITHOUT the session lock -- `ask` holds it
    /// for the whole turn. Clone it out via [`Self::cancel_token`] before the
    /// lock is taken (e.g. the command layer registers it as managed state).
    cancel: Arc<CancelToken>,
    /// ADR-0055 close-tab lifecycle: the shared closing flag, set by
    /// `close_session` (via the [`SessionStore`](crate::session_store::SessionStore)
    /// handle) and read by [`Self::ask`]'s post-turn check. When set, an
    /// in-flight turn that finishes (Cancelled or otherwise) is DISCARDED -- not
    /// appended to the thread, not persisted to the recipe -- so a closed
    /// session's cancelled turn never enters the productive chain (ADR-0021,
    /// ADR-0034). Defaults to a private false flag for sessions built
    /// outside a store (tests, `new`); the store attaches its own so
    /// `close_session` and `ask` share one. Read via [`Self::is_closing`]. The
    /// [`ClosingFlag`] newtype exposes set / get but NO unset, so the
    /// once-closing-always-closing invariant (ADR-0055) is type-enforced
    /// (review H2, issue #73) -- the prior `Arc<AtomicBool>` let any holder
    /// `store(false)` and revoke a close.
    closing: ClosingFlag,
    /// The persistence concern (issue #415): `.duck` binding, projection,
    /// write loop, conflict detection, and the single-writer registry key.
    /// Extracted from the former inline fields so the projection + write
    /// state machine are testable without a DuckDB connection.
    persister: recipe_persister::RecipePersister,
    /// ADR-0063: the sender half of the close-and-wait-release drop signal. The
    /// matching receiver lives on the [`SessionHandle`](crate::session_store::SessionHandle);
    /// the delete path awaits it after detaching the handle from the store map so
    /// [`Self::Drop`] (the canonical key release point, ADR-0035 Decision 3) is
    /// guaranteed to have run before `delete_session`'s single-writer gate fires.
    /// Fired here in Drop -- AFTER the key release -- then the sender drops. `None`
    /// for sessions built outside a store (tests, `new`); a store-attached session
    /// has it set via [`Self::set_drop_signal`]. Single-waiter assumption (delete
    /// path is the sole awaiter); a closed receiver (waiter timed out / gone) makes
    /// `send` return Err, which Drop swallows (Drop must not panic).
    drop_signal: Option<std::sync::mpsc::Sender<()>>,
    /// The per-session external-runtime selector (issue #299 slice 9c). `None`
    /// drives the built-in agent loop; `Some(spec)` drives the external ACP
    /// engine for one CLI on the next turn. Issue #353 wired this to the
    /// composer runtime picker: the command layer mirrors the session's
    /// handle-held runtime choice into this field at each turn top (see the
    /// `ask` command), so the dispatch below reads exactly the runtime the
    /// user picked, and a switch lands at the turn boundary. Integration
    /// tests still toggle it directly via [`Self::set_external_runtime`].
    external_runtime: Option<AdapterSpec>,
    /// The last turn's per-server MCP connect outcomes (issue #301 slice D).
    /// Updated at the top of each turn (the aggregator's `connect_all` result)
    /// so the command layer can snapshot it into the SessionHandle for
    /// `list_mcp_server_status` without taking the session lock a turn holds.
    /// Empty until the first turn runs and after a resume (a fresh Session is
    /// constructed by `open_duck`; the enablement set on the handle + this
    /// cache reset together -- the ADR-0080 reset lineage, server-granularity cousin).
    last_mcp_connect: Vec<crate::mcp::aggregator::ConnectResult>,
    /// The session's currently-mounted skills (ADR-0086, issue #363). A live
    /// memoization of the timeline's Mount/Unmount fold -- [`Self::build_recipe`]
    /// is the single source of truth (the recipe never stores a snapshot, only
    /// the event sequence), and this cache stays in sync because every mount /
    /// unmount mutates both together. Seeded by `open_duck` from the recipe
    /// fold on resume. Looked up by the assembly path's skill set builder
    /// (wired in #364) and by the `list_mounted_skills` IPC command. Names are
    /// unique, in first-mount insertion order (mirrors
    /// [`crate::persistence::recipe::Recipe::mounted_skills`]).
    mounted_skills: Vec<String>,
}

/// One entry in the session's unified timeline (issue #325). Replaces the
/// former pair of index-aligned `Vec<ThreadEntry>` + `Vec<TurnAudit>` so
/// alignment is structural (compile-time): a turn entry CANNOT exist without
/// its audit, and a non-turn entry (Source/Skill lifecycle) CANNOT carry
/// audit data. The `TurnAudit::default()` sentinel is eliminated.
#[derive(Debug)]
pub(super) enum TimelineEntry {
    /// A conversation turn: the IPC-visible [`TurnRecord`] paired with the
    /// turn's persisted audit (trace + provenance, ADR-0078).
    Turn {
        record: TurnRecord,
        audit: TurnAudit,
    },
    /// A source lifecycle event (ADR-0040): first-class timeline slot, not a turn.
    Source(SourceLifecycleEvent),
    /// A skill lifecycle event (ADR-0086): first-class timeline slot, not a turn.
    Skill(SkillLifecycleEvent),
}

impl TimelineEntry {
    /// Project to the IPC-visible [`ThreadEntry`] form (drops the persisted
    /// audit). The unified timeline is the session's internal representation;
    /// this projection feeds the `conversation()` IPC boundary so the wire
    /// shape stays unchanged (ADR-0078).
    fn to_thread_entry(&self) -> ThreadEntry {
        match self {
            TimelineEntry::Turn { record, .. } => ThreadEntry::Turn(record.clone()),
            TimelineEntry::Source(ev) => ThreadEntry::Source(ev.clone()),
            TimelineEntry::Skill(ev) => ThreadEntry::Skill(ev.clone()),
        }
    }
}

/// The persisted audit for one turn (ADR-0078, issue #319): the trace's
/// PERSISTENCE form, carried alongside the [`TurnRecord`] in
/// [`TimelineEntry::Turn`]. The [`TurnRecord`] additionally carries the
/// display view ([`crate::model::TraceEntryView`], issue #297) for the
/// rail's expanded trace -- same bounded shape, so the full in-memory
/// payloads cross neither, and the far window still reads only the trace's
/// summary (ADR-0078). [`Session::build_recipe`]'s whole-file rebuild reads
/// the audit inline from each timeline turn entry; resume seeds it from the
/// recipe so persisted values round-trip verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct TurnAudit {
    /// The turn's persisted execution trace (ADR-0078); empty for no-tool turns.
    trace: Vec<RecipeTraceEntry>,
    /// The turn's runtime + skill provenance (ADR-0078/0081). The PERSISTED
    /// shape (recipe::TurnProvenance, aliased here) -- wider than the IPC
    /// [`TurnProvenance`]: also carries the runtime kind for the .duck audit
    /// anchor. The IPC TurnRecord narrows to skills only (issue #381).
    provenance: PersistedTurnProvenance,
}

impl TurnAudit {
    /// The audit for a turn the built-in agent loop just recorded (ADR-0078/
    /// 0081, issue #319; ADR-0086, issue #364): the loop's real multi-call trace
    /// mapped to its persisted form + the BuiltIn runtime + the mounted skills'
    /// provenance (each skill's `name` + `content_hash` snapshotted at the
    /// turn's assembly time). `skills` is empty when no skills were mounted
    /// (the field is default-omitted from the .duck while empty).
    fn builtin(trace: Vec<TraceEntry>, skills: Vec<SkillProvenance>) -> Self {
        Self {
            trace: trace
                .iter()
                .map(RecipeTraceEntry::from_live_trace)
                .collect(),
            provenance: PersistedTurnProvenance {
                runtime: Some(RuntimeKind::BuiltIn),
                skills,
            },
        }
    }

    /// The audit harvested from one persisted recipe turn (resume, ADR-0078):
    /// a turn's trace + provenance round-trip verbatim from the .duck. Called
    /// only for `RecipeEntry::Turn` -- source and skill lifecycle entries are
    /// not turns and never produce a [`TurnAudit`].
    fn from_recipe_turn(turn: &RecipeTurn) -> Self {
        Self {
            trace: turn.trace.clone(),
            provenance: turn.provenance.clone(),
        }
    }

    /// Read-only access to the persisted trace (for RecipePersister's
    /// projection, issue #415).
    pub(super) fn trace(&self) -> &[RecipeTraceEntry] {
        &self.trace
    }

    /// Read-only access to the persisted provenance (for RecipePersister's
    /// projection, issue #415).
    pub(super) fn provenance(&self) -> &PersistedTurnProvenance {
        &self.provenance
    }

    /// Test-only constructor with explicit trace + provenance (issue #415).
    #[cfg(test)]
    pub(super) fn test_new(
        trace: Vec<RecipeTraceEntry>,
        provenance: PersistedTurnProvenance,
    ) -> Self {
        Self { trace, provenance }
    }
}

/// The per-turn borrowed data inputs for [`Session::ask_with_phase`] (issue
/// #378): the effective MCP servers, the keychain for secret env resolution,
/// and the mounted skill prompt fragments. These three are "data passed in"
/// rather than orchestration concerns -- the approval state / sink / phase
/// callback are wiring, not data -- so they collapse into one struct. This
/// keeps `run_external_turn` (currently 8 params, `#[allow]` retained) from
/// growing further, and prevents `ask_with_phase` from exceeding the
/// threshold as more data inputs are added.
pub struct TurnInputs<'a> {
    /// The effective MCP server configs for this turn (enabled ∪
    /// skill-declared, computed at the command boundary). The gateway
    /// connects each one per turn (ADR-0076).
    pub mcp_servers: &'a [McpServerConfig],
    /// Borrow of the OS keychain (ADR-0029). The gateway reads each server's
    /// secret env values at spawn; the values never cross IPC back out.
    pub keychain: &'a KeychainStore,
    /// The mounted-skill prompt fragments (ADR-0086, issue #364). Each
    /// fragment's body rides the system prompt; its `content_hash` snapshots
    /// into the turn's provenance for resume-time drift detection.
    pub skills: &'a [SkillPromptFragment],
}

impl<'a> TurnInputs<'a> {
    /// Build a no-MCP / no-skill input set -- the common case in tests and the
    /// non-command path ([`Session::ask`]). Borrows the caller-owned keychain;
    /// `Default` is impossible because the keychain field is a borrowed (not
    /// owned) type.
    pub fn empty(keychain: &'a KeychainStore) -> Self {
        Self {
            mcp_servers: &[],
            keychain,
            skills: &[],
        }
    }
}

impl Session {
    pub fn new() -> anyhow::Result<Self> {
        Self::with_provider_and_cancel(Box::new(UnwiredProvider), Arc::new(CancelToken::new()))
    }

    /// Tune the materialized-result row ceiling (ADR-0005 L3, "可调"). A query
    /// whose result would exceed `cap` rows aborts with a resource error. The
    /// default is [`DEFAULT_MAX_RESULT_ROWS`]; tests lower it for a fast,
    /// deterministic cap-hit, and a future preferences surface may expose it.
    pub fn set_result_row_cap(&mut self, cap: u64) {
        self.result_row_cap = cap;
    }

    /// Tune the result-count ceiling (ADR-0013 M=100, "可调"). When the
    /// registered `result_N` count exceeds `cap`, the oldest stale results are
    /// auto-reclaimed on the next materialization; active results are never
    /// auto-deleted. Tests lower it for a fast, deterministic GC trigger
    /// (mirroring [`Self::set_result_row_cap`]).
    pub fn set_result_count_cap(&mut self, cap: usize) {
        self.result_count_cap = cap;
    }

    /// Set the per-session external-runtime selector (issue #299 slice 9c).
    /// Pass `Some(spec)` to drive the external ACP engine for the next turn,
    /// or `None` to revert to the built-in loop. The production path is the
    /// `ask` command mirroring the handle-held runtime choice here at turn
    /// top (issue #353); this direct setter stays `pub` so integration tests
    /// in `tests/` (a separate crate) can toggle the selector without IPC.
    pub fn set_external_runtime(&mut self, spec: Option<AdapterSpec>) {
        self.external_runtime = spec;
    }

    /// Build a session with an explicit provider (tests inject a scripted fake;
    /// the real LLM client wires in #29). The default [`Self::new`] uses
    /// [`UnwiredProvider`] -- every turn is refused until a provider is set.
    pub fn with_provider(provider: Box<dyn Provider>) -> anyhow::Result<Self> {
        Self::with_provider_and_cancel(provider, Arc::new(CancelToken::new()))
    }

    /// Build a session with an explicit provider AND a shared cancel token
    /// (ADR-0021, issue #28). The token is `Arc`-cloned to the cancel command
    /// and the timeout watchdog so a cancel fires without the session lock;
    /// `with_provider` / `new` allocate a private token for callers that don't
    /// need cross-thread cancel. Tests that drive cancel/timeout inject a token
    /// they also hold, so they can observe `is_in_flight` / fire `request`.
    pub fn with_provider_and_cancel(
        provider: Box<dyn Provider>,
        cancel: Arc<CancelToken>,
    ) -> anyhow::Result<Self> {
        let temp_dir = tempfile::Builder::new()
            .prefix("toptopduck-session-")
            .tempdir()?;
        let temp_path = temp_dir.path().to_path_buf();
        // Eagerly create the tool-output subdirectory (ADR-0087 Decision 3).
        // External MCP stdio servers receive this path via
        // `TOPTOPDUCK_TOOL_OUTPUT_DIR` and write their output files here; the
        // agent references them via `read_csv_auto` / `read_json` /
        // `read_parquet`. The directory's lifecycle follows the TempDir RAII
        // (cleaned on session drop). `create_dir_all` is idempotent; failure
        // is a disk / OS issue surfaced honestly rather than silently skipped.
        fs::create_dir_all(temp_path.join(TOOL_OUTPUT_DIR_NAME))
            .map_err(|e| anyhow::anyhow!("failed to create tool_output dir: {e}"))?;
        let conn = Connection::open_in_memory()?;
        // Engine-level resource caps (ADR-0005 L3): bind memory + threads before
        // any query runs so a runaway LLM SQL cannot OOM or monopolize the
        // machine. Best-effort; apply_resource_caps logs+swallows a rejection.
        apply_resource_caps(&conn);
        // The provider + materializer live on the Session behind `Box<dyn>`
        // (dyn, not generic) so this struct does not parameterize the IPC
        // layer (ADR-0053). The agent loop borrows both per turn; the resume
        // path borrows the same materializer for the recipe replay. The
        // materializer is stateless (RealMaterializer); the admin connection /
        // source_files / working_set it borrows live on this Session and are
        // passed per turn via TurnDeps.
        Ok(Self {
            conn,
            working_set: WorkingSet::default(),
            _temp_dir: temp_dir,
            temp_path,
            provider,
            materializer: Box::new(RealMaterializer),
            timeline: Vec::new(),
            result_row_cap: DEFAULT_MAX_RESULT_ROWS,
            result_count_cap: DEFAULT_RESULT_COUNT_CAP,
            source_files: HashMap::new(),
            tool_output_refs: HashMap::new(),
            cancel,
            closing: ClosingFlag::new(),
            persister: recipe_persister::RecipePersister::new(),
            drop_signal: None,
            external_runtime: None,
            last_mcp_connect: Vec::new(),
            mounted_skills: Vec::new(),
        })
    }

    /// The session's tool-output directory as a string for env injection
    /// (ADR-0087 Decision 3). Both production MCP paths (built-in agent loop +
    /// external gateway) use this to avoid duplicating the path construction.
    fn tool_output_path(&self) -> String {
        self.temp_path
            .join(TOOL_OUTPUT_DIR_NAME)
            .to_string_lossy()
            .into_owned()
    }

    /// A clone of the shared cancel token (ADR-0021, issue #28). The command
    /// layer takes this BEFORE the session lock so the cancel command can fire
    /// without contending for the lock `ask` holds for the whole turn; tests
    /// clone it to observe `is_in_flight` / drive `request` from another thread.
    pub fn cancel_token(&self) -> Arc<CancelToken> {
        Arc::clone(&self.cancel)
    }

    /// A snapshot of the last turn's per-server MCP connect outcomes (issue
    /// #301 slice D). The command layer reads this after a turn to mirror into
    /// the SessionHandle so `list_mcp_server_status` is lock-light (the status
    /// IPC never takes the session lock an in-flight turn holds). Empty until
    /// the first turn runs and after a resume (the Session is fresh).
    pub fn last_mcp_connect(&self) -> &[crate::mcp::aggregator::ConnectResult] {
        &self.last_mcp_connect
    }

    /// Attach the store-shared closing flag (ADR-0055). [`SessionStore::create`]
    /// calls this so the flag it holds (and `close_session` sets) is the SAME
    /// [`ClosingFlag`] [`Self::ask`] reads in its post-turn check. A session
    /// built outside a store keeps its default private flag (always false) --
    /// `is_closing` then never trips, which is correct for tests that never
    /// close. Idempotent-ish: the prior flag is dropped (its only other holder
    /// is the store, which keeps its own clone). The flag is monotonic (no
    /// unset), so attaching it cannot weaken the once-closing invariant.
    pub fn set_closing_flag(&mut self, closing: ClosingFlag) {
        self.closing = closing;
    }

    /// Attach the close-and-wait-release drop signal (ADR-0063). The store
    /// creates the `(sender, receiver)` pair, hands the sender here, and keeps
    /// the receiver on the handle. On resume (`open_duck`), a FRESH pair is
    /// installed on both ends so the resumed session's Drop reaches the handle's
    /// current receiver (the old pair is orphaned -- the pre-replace session's
    /// Drop fires the old sender into a closed receiver, a harmless no-op).
    pub fn set_drop_signal(&mut self, tx: std::sync::mpsc::Sender<()>) {
        self.drop_signal = Some(tx);
    }

    /// Whether `close_session` has marked this session closing (ADR-0055). Read
    /// by [`Self::ask`]'s post-turn check to discard an in-flight turn that
    /// finished after close fired cancel.
    pub fn is_closing(&self) -> bool {
        self.closing.get()
    }

    /// Request cancellation of the in-flight turn (ADR-0021). Sets the
    /// cooperative flag and interrupts the running DuckDB query (if any); the
    /// orchestrator lands the turn as [`TurnOutcome::Cancelled`] at its next
    /// check. Safe to call when no turn is in flight (no-op besides the flag,
    /// which the next `ask` resets before it starts).
    pub fn cancel(&self) {
        self.cancel.request();
    }

    /// Whether a turn is currently executing (the single-in-flight invariant,
    /// ADR-0021). Observable without the session lock via the shared token, so a
    /// test can assert exactly one query runs at a time.
    pub fn is_query_in_flight(&self) -> bool {
        self.cancel.is_in_flight()
    }

    /// Bind this session to a `.duck` path (ADR-0034) and immediately persist
    /// one full recipe. After this, every terminal turn and source lifecycle
    /// event atomically rewrites the recipe (temp + rename). The session name
    /// rides the recipe header and is shown on resume. Returns the save error
    /// (if any) so the caller can surface it -- the binding still takes effect
    /// so in-memory state is correct even if the first write fails.
    ///
    /// ADR-0035 Decision 3 / issue #50 single-writer: the canonical path is acquired
    /// in the process-global registry BEFORE the write. A second `bind_duck`
    /// of a path another Session already holds returns
    /// [`SaveError::AlreadyOpen`] without touching the file. Re-binding the
    /// SAME canonical path on the SAME session (e.g. a Save over the open
    /// file) is allowed -- it is an update, not a second opener. Moving from
    /// one `.duck` to another releases the old canonical key so a different
    /// session can open it.
    pub fn bind_duck(&mut self, path: PathBuf, session_name: String) -> Result<(), SaveError> {
        // Migrate derived source files from temp staging to .duck-adjacent
        // (issue #433, ADR-0087 D2). Before the recipe is persisted, each
        // derived source's source_path is updated so SourceRef carries the
        // portable (relative-to-.duck) location.
        self.migrate_derived_sources(&path);
        self.persister
            .bind(path, session_name, &self.working_set, &self.timeline)
    }

    /// The bound `.duck` path, if any (ADR-0034/0089). Since ADR-0089 every
    /// production session is bound at `create_session`, so `None` is reachable
    /// only from test constructors (`Session::new`, `with_provider`).
    pub fn duck_path(&self) -> Option<&Path> {
        self.persister.duck_path()
    }

    /// Migrate derived source files from temp staging (`temp_path/derived/`)
    /// to the per-session directory's `assets/` subdirectory (ADR-0089, issue
    /// #433, ADR-0087 D2) so they survive session close and are portable with
    /// the `.duck` file. Updates each descriptor's `source_path` in place so
    /// the recipe's `SourceRef` carries the persistent location. Best-effort +
    /// logged: a copy failure leaves the staging path in place (the session
    /// temp dir is wiped on drop, but the recipe write still succeeds — a
    /// resume would surface the missing file as an interactive re-link).
    fn migrate_derived_sources(&mut self, duck_path: &Path) {
        let staging_dir = self.temp_path.join(derived_source::DERIVED_STAGING_DIR);
        // ADR-0089: derived sources live in the per-session directory's `assets/`
        // subdirectory (previously `{duck_stem}.assets/` adjacent to a flat .duck).
        let Some(session_dir) = duck_path.parent() else {
            log::warn!(
                target: "toptopduck::session",
                "skipped derived-source migration: duck_path has no parent: {}",
                duck_path.display()
            );
            return;
        };
        let assets_dir = session_dir.join("assets");

        // Collect (ref_name, old_path, new_path) for sources staged in
        // temp_path/derived/. Iterating the working set immutably first, then
        // applying updates mutably (borrow split).
        let staging_prefix = staging_dir.to_string_lossy().to_string();
        let to_migrate: Vec<(String, PathBuf, PathBuf)> = self
            .working_set
            .list()
            .iter()
            .filter(|d| !self.working_set.is_result(&d.reference_name))
            .filter(|d| d.source_path.starts_with(&staging_prefix))
            .filter_map(|d| {
                let old_path = PathBuf::from(&d.source_path);
                let filename = PathBuf::from(old_path.file_name()?);
                Some((
                    d.reference_name.clone(),
                    old_path,
                    assets_dir.join(filename),
                ))
            })
            .collect();

        if to_migrate.is_empty() {
            return;
        }

        if let Err(e) = fs::create_dir_all(&assets_dir) {
            log::warn!(
                target: "toptopduck::session",
                "failed to create derived assets dir {}: {e}",
                assets_dir.display()
            );
            return;
        }

        for (ref_name, old_path, new_path) in &to_migrate {
            if let Err(e) = fs::copy(old_path, new_path) {
                log::warn!(
                    target: "toptopduck::session",
                    "failed to migrate derived source {ref_name}: {e}"
                );
                continue;
            }
            self.working_set
                .update_source_path(ref_name, &new_path.to_string_lossy());
        }
    }

    /// The user-facing session name, if bound to a `.duck` (ADR-0034).
    pub fn session_name(&self) -> Option<&str> {
        self.persister.session_name()
    }

    /// Open a `.duck` and resume the session across the restart boundary
    /// (ADR-0034/0035, issue #49). Reads the recipe, re-reads + fingerprint-
    /// verifies each source (interactive re-link / rebuild on Missing / Drift),
    /// resolves the active-SOURCE pointer (interactive continuation if the
    /// active was abandoned + others remain), eagerly re-executes the
    /// productive SQL chain LLM-free (partial on a round-K failure: K-1
    /// results preserved, K rendered as Failed, post-K turns dropped), and
    /// rebuilds the conversation timeline truncated at any replay breakpoint.
    ///
    /// The three callbacks are the honest-degrade decision points
    /// (ADR-0035 -- the engine NEVER silently picks):
    /// - `on_progress`: per-source verification + per-replayed-turn progress
    ///   (ADR-0034 visible progress).
    /// - `on_source_issue`: per-source Missing / Drift resolution. Each source
    ///   is handled independently (AC4); a Rebuild drops just that source.
    /// - `on_active_abandoned`: fired ONLY when the active source was rebuilt
    ///   AND other sources remain (AC5 -- no silent fallback).
    ///
    /// Resume itself is LLM-free (AC7): it re-executes stored SQL and asks the
    /// caller (not a cloud model) for every integrity decision. The provider is
    /// wired only so the next NEW turn after resume reaches a live model.
    ///
    /// On success the `.duck` is rewritten to reflect the post-resume state
    /// (relinked paths, rebuilt sources dropped, truncated timeline with the
    /// failed turn) -- a failure here is captured in `persist_error` (non-
    /// blocking; the session is live regardless, ADR-0035 honest signal). On
    /// [`ResumeError::Aborted`] the on-disk recipe is left untouched (AC2).
    ///
    /// ADR-0035 Decision 3 / issue #50 single-writer: the canonical path is acquired
    /// BEFORE the recipe is read -- a second opener in this process gets
    /// [`ResumeError::AlreadyOpen`] and never diverges a second in-memory
    /// session from the file. The acquire is RAII; any error exit (load,
    /// cancel, abort, replay invariant) releases the key. On success the
    /// resumed Session takes ownership (the guard is forgotten) and releases
    /// the key on its own Drop.
    pub fn open_duck(
        path: &Path,
        cancel: Arc<CancelToken>,
        provider: Box<dyn Provider>,
        mut on_progress: impl FnMut(ResumeEvent),
        mut on_source_issue: impl FnMut(SourceIssue) -> SourceResolution,
        mut on_active_abandoned: impl FnMut(ActiveAbandoned) -> ActiveResolution,
    ) -> Result<Session, ResumeError> {
        // Mark resume in-flight for the WHOLE function so concurrent mutating
        // commands reject at the command layer instead of silently racing the
        // stale pre-resume session. RAII -- every exit (including `?` error
        // propagation) drops the guard and clears the flag. Acquired FIRST so
        // even a registry-refuse / load-fail resume holds the flag for its
        // full (short) duration.
        let _resume_flag = resume::ResumeFlagGuard::acquire();
        // Single-writer acquire (ADR-0035 Decision 3, issue #50). Held across all
        // resume phases; the guard's Drop releases the key on every error
        // exit, and `mem::forget` on success transfers ownership to the
        // resumed Session. Acquiring BEFORE the cancel guard / recipe read
        // means a duplicate-opener refusal never disturbs an in-flight cancel
        // state.
        let canonical = canonicalize_duck(path)
            .map_err(|e| ResumeError::Load(crate::persistence::io::LoadError::Io(e.to_string())))?;
        let registry = resume::OpenDuckGuard::acquire(canonical.clone())?;

        // Mark resume as in-flight + clear any stale cancel request, mirroring
        // `ask`'s per-turn guard (ADR-0021). The resume_sources / resume_replay
        // loops poll is_requested() between items so a user cancel lands as
        // [`ResumeError::Cancelled`] (a clean signal), not a masked partial
        // state indistinguishable from data corruption. Drop on exit clears
        // in-flight and the interrupt slot (RAII -- every exit from open_duck,
        // success or error, drops the guard). The resumed Session reuses the
        // SAME Arc<CancelToken>, so the next ask's begin_turn composes cleanly.
        let _guard = cancel.begin_turn();

        let mut recipe = read_duck(path).map_err(ResumeError::Load)?;
        // Seed the external-change baseline from the file AS READ (ADR-0035 Decision 3,
        // issue #50): any external edit during the resume phases (re-ingest /
        // replay can take seconds) surfaces at the post-resume persist via the
        // hash check, never as a silent clobber of the edited file.
        let resume_baseline = recipe_persister::hash_file(path)
            .map_err(|e| ResumeError::Load(crate::persistence::io::LoadError::Io(e.to_string())))?;
        let mut session = Session::with_provider_and_cancel(provider, cancel)
            .map_err(|e| ResumeError::Load(crate::persistence::io::LoadError::Io(e.to_string())))?;
        session.persister.adopt_resumed(
            path.to_path_buf(),
            canonical.clone(),
            recipe.session_name.clone(),
            resume_baseline,
        );

        // Phase 1: re-read + verify each source (interactive re-link / rebuild).
        // Returns the set of rebuilt (dropped) sources; recipe.sources[i] is
        // updated in place for any relinked path.
        let rebuilt =
            session.resume_sources(path, &mut recipe, &mut on_progress, &mut on_source_issue)?;

        // Phase 2/3/4 via the Resumer deep module (ADR-0053 Decision 3): the
        // Resumer borrows the shared cancel + the SAME Materializer trait
        // object the live-turn agent loop drives + the recipe. It does NOT
        // hold the Session -- each phase method borrows working_set / TurnDeps
        // and returns a structured result, which open_duck applies. Scoped so
        // the Resumer (and its disjoint-field borrows of session.cancel /
        // session.materializer) drops before phase 5's &mut session persist.
        {
            let mut resumer =
                resume::Resumer::new(&session.cancel, &mut *session.materializer, &recipe);
            // Phase 2: resolve the active-SOURCE pointer. The happy path
            // restores recipe.active; if the active was rebuilt + others
            // remain, the caller picks an explicit continuation (ADR-0035
            // no-silent-fallback, AC5).
            resumer.resolve_active(&mut session.working_set, &rebuilt, &mut on_active_abandoned)?;
            // Phase 3: replay the productive SQL chain (partial on failure --
            // K-1 results preserved, K rendered as Failed, AC6).
            let replay_break = {
                let mut deps = TurnDeps {
                    conn: &session.conn,
                    source_files: &mut session.source_files,
                    working_set: &mut session.working_set,
                    result_row_cap: session.result_row_cap,
                    result_count_cap: session.result_count_cap,
                    temp_path: &session.temp_path,
                    tool_output_refs: &mut session.tool_output_refs,
                };
                resumer.replay(&mut deps, &mut on_progress)?
            };
            // Phase 4: rebuild the conversation timeline, truncated at the
            // replay breakpoint (if any). Post-break entries are dropped
            // ("对话停在断点"). rebuild_timeline returns the unified timeline
            // (ThreadEntry + audit paired per turn, issue #325) so alignment is
            // structural and no separate audit harvest is needed.
            session.timeline =
                resumer.rebuild_timeline(&mut session.working_set, replay_break.as_ref())?;
            // ADR-0086 (issue #363): seed the live mounted-skills cache from
            // the recipe's Mount/Unmount fold. The recipe never stores a
            // snapshot -- the timeline IS the source of truth -- so the cache
            // is rebuilt deterministically on every resume. Honest degrade
            // applies at assembly time (a name missing from the registry is
            // surfaced then); here every folded name lands regardless.
            session.mounted_skills = recipe.mounted_skills();
        }

        // Phase 5: persist the post-resume state. adopt_resumed already set
        // duck_path + the baseline, so only the write remains. build_recipe
        // reads the live working set, so relinked paths, dropped (rebuilt)
        // sources, and the truncated timeline (failed turn at K) land in the
        // persisted recipe. A failure is non-blocking -- the session is live;
        // the banner surfaces the disk-vs-memory drift. The post-resume write
        // runs the external-change hash check against the resume_baseline --
        // if the file changed under us during resume, the write is suspended
        // and pending_conflict is set (never a silent clobber).
        session.persist_if_bound();

        // Success -- the resumed Session owns the registry key now. Disarm the
        // guard so its Drop does NOT release the key; the Session's own Drop
        // will. `registry` is moved into forget, so it is no longer reachable
        // for an accidental early release.
        std::mem::forget(registry);
        Ok(session)
    }

    /// Resolve a recipe source path to a filesystem path (ADR-0036 Decision 4
    /// hybrid paths). The relative form -- taken against the `.duck` file's
    /// directory -- wins when present and the candidate exists; that is the
    /// form that survives "move the folder" portability. Otherwise the
    /// absolute `source_path` is the fallback. Fingerprint verification
    /// upstream catches a wrong pick, so the choice here is safe.
    ///
    /// Trust boundary (rust/security.md Input Validation section + ADR-0036): the
    /// `.duck` is external input. A hand-edited or externally-sourced recipe
    /// whose `relative_path` escapes the `.duck`'s directory subtree
    /// (`../../etc/passwd`, `~/../.ssh/id_rsa`, ...) would otherwise let a
    /// malicious recipe pull arbitrary files into the DuckDB snapshot (and
    /// from there into LLM samples / column names). The relative candidate
    /// is canonicalized and MUST remain inside the `.duck`'s directory; an
    /// escape is rejected at this boundary as a `SourceMissing` (path
    /// traversal refused). A missing candidate falls through to the absolute
    /// fallback, which fingerprint verification then refuses if it is also
    /// missing or drifted (ADR-0035 honest degrade -- not a silent traversal).
    fn resolve_source_path(duck_path: &Path, src: &SourceRef) -> Result<PathBuf, ResumeError> {
        let absolute = PathBuf::from(&src.source_path);
        let Some(relative) = &src.relative_path else {
            return Ok(absolute);
        };
        let Some(base) = duck_path.parent() else {
            return Ok(absolute);
        };
        let candidate = base.join(relative);
        // canonicalize requires the file to exist; a missing candidate falls
        // through to the absolute fallback (fingerprint check decides there).
        if let Ok(canonical) = candidate.canonicalize() {
            if let Ok(base_canonical) = base.canonicalize() {
                if !canonical.starts_with(&base_canonical) {
                    return Err(ResumeError::SourceMissing {
                        reference_name: src.reference_name.clone(),
                        path: relative.clone(),
                        detail: "相对路径越出 .duck 目录（已拒绝路径遍历）".into(),
                    });
                }
                return Ok(canonical);
            }
        }
        Ok(absolute)
    }

    /// Resume phase 1 (ADR-0034/0035/0036/0042, issue #49): re-read and verify
    /// every source, interactively. The source path resolves hybrid-style
    /// ([`Self::resolve_source_path`]); the source is ingested under the
    /// recipe's reference name via [`Self::resume_ingest_at`] (no name derive
    /// / de-conflict / Added-event -- resume replays the recipe's own events
    /// in phase 4, not new ones); the resulting post-rectify fingerprint must
    /// match the recipe (ADR-0035/0042). On Missing (path gone / unreadable)
    /// or Drift (present but fingerprint differs) the caller's `on_source_issue`
    /// callback decides: Relink (re-ingest a new path + re-verify, looping),
    /// Abort (stop resume, on-disk recipe untouched), or Rebuild (drop this one
    /// source, continue with the rest -- AC4 per-source independence).
    ///
    /// Returns the set of rebuilt source reference names so phase 2 can decide
    /// whether the active pointer needs an interactive continuation. Mutates
    /// `recipe.sources[i]` in place for any relinked path (source_path updated,
    /// relative_path cleared) so phase 5's persist writes the new path. Fires
    /// one `Source` progress event per source (ADR-0034 visible progress).
    fn resume_sources(
        &mut self,
        duck_path: &Path,
        recipe: &mut Recipe,
        on_progress: &mut impl FnMut(ResumeEvent),
        on_source_issue: &mut impl FnMut(SourceIssue) -> SourceResolution,
    ) -> Result<HashSet<String>, ResumeError> {
        let total = recipe.sources.len();
        let mut rebuilt: HashSet<String> = HashSet::new();
        for i in 0..recipe.sources.len() {
            if self.cancel.is_requested() {
                return Err(ResumeError::Cancelled);
            }
            // Snapshot the reference name for the progress event before any
            // mutable borrow of recipe.sources below.
            let reference_name = recipe.sources[i].reference_name.clone();
            on_progress(ResumeEvent::Source {
                index: i + 1,
                total,
                reference_name: reference_name.clone(),
            });
            // Re-link / drift retry loop: each iteration resolves the path,
            // ingests under the recipe's name, and verifies the fingerprint.
            // A Relink resolution updates the path and loops; Abort returns;
            // Rebuild drops the source and breaks to the next one.
            loop {
                let src = recipe.sources[i].clone();
                let path = Self::resolve_source_path(duck_path, &src)?;
                match self.resume_ingest_at(&src.reference_name, &src.display_name, &path) {
                    Ok(descriptor) => {
                        if descriptor.fingerprint == src.fingerprint {
                            // Match -- restore the recipe's display label over
                            // the path-derived one (ADR-0037 rename survives).
                            if descriptor.display_name != src.display_name {
                                // ADR-0035 honest signal: a failure to restore
                                // the recipe's label is logged, not swallowed --
                                // the user would otherwise see a path-derived
                                // label without knowing the rename was lost.
                                if let Err(e) =
                                    self.rename_display(&src.reference_name, &src.display_name)
                                {
                                    log::warn!(
                                        target: "toptopduck::session",
                                        "restore label「{}」for re-linked source {} failed: {e}",
                                        src.display_name, src.reference_name,
                                    );
                                }
                            }
                            break; // next source
                        }
                        // Drift: present at path, fingerprint differs. NEVER
                        // silently replay with the new data (ADR-0035).
                        let resolution = on_source_issue(SourceIssue::Drift {
                            reference_name: src.reference_name.clone(),
                            path: path.to_string_lossy().to_string(),
                            expected: src.fingerprint.clone(),
                            found: descriptor.fingerprint,
                        });
                        match resolution {
                            SourceResolution::Relink(new_path) => {
                                // Drop the just-ingested drifted snapshot so
                                // the next loop's copy-in can attach under the
                                // same name without colliding.
                                self.detach_snapshot(&src.reference_name);
                                recipe.sources[i].source_path =
                                    new_path.to_string_lossy().to_string();
                                recipe.sources[i].relative_path = None;
                                continue; // re-verify with the new path
                            }
                            SourceResolution::Abort => return Err(ResumeError::Aborted),
                            SourceResolution::Rebuild => {
                                self.detach_snapshot(&src.reference_name);
                                rebuilt.insert(src.reference_name.clone());
                                break; // next source (this one abandoned)
                            }
                        }
                    }
                    Err(e) => {
                        // Distinguish Absent (path doesn't exist -> re-link is
                        // the natural fix) from Unreadable (file present but
                        // parse / format / ATTACH failed -> the user needs the
                        // reason to diagnose). ADR-0035 honest signal: the
                        // issue kind drives the user's next action, so
                        // conflating them would offer a re-link dialog for a
                        // file that is right where the recipe recorded it.
                        // `path` is the resolved candidate (relative preferred,
                        // absolute fallback) from resolve_source_path above.
                        let issue = if path.exists() {
                            SourceIssue::Unreadable {
                                reference_name: src.reference_name.clone(),
                                path: path.to_string_lossy().to_string(),
                                reason: e.to_string(),
                            }
                        } else {
                            SourceIssue::Missing {
                                reference_name: src.reference_name.clone(),
                                recorded_path: src.source_path.clone(),
                            }
                        };
                        let resolution = on_source_issue(issue);
                        match resolution {
                            SourceResolution::Relink(new_path) => {
                                recipe.sources[i].source_path =
                                    new_path.to_string_lossy().to_string();
                                recipe.sources[i].relative_path = None;
                                continue; // re-verify with the new path
                            }
                            SourceResolution::Abort => return Err(ResumeError::Aborted),
                            SourceResolution::Rebuild => {
                                rebuilt.insert(src.reference_name.clone());
                                break; // next source (never ingested)
                            }
                        }
                    }
                }
            }
        }
        Ok(rebuilt)
    }

    /// Ingest a source for resume under an explicit reference name + display
    /// label (no derive / de-conflict / Added-event append). The recipe
    /// already fixed the name + the timeline; resume just needs the snapshot
    /// attached read-only + the descriptor registered so fingerprint
    /// verification and replay can proceed. CSV/JSON/Parquet share the single
    /// copy-in path; Excel is refused (its multi-sheet + guided rectify
    /// semantics need their own resume path, out of scope for #49 -- a
    /// refused resume is more honest than silently re-tidying into shapes the
    /// recipe did not record). Returns the freshly-read descriptor.
    fn resume_ingest_at(
        &mut self,
        reference_name: &str,
        display_name: &str,
        path: &Path,
    ) -> Result<DatasetDescriptor, LoadError> {
        let dispatched = ingest::dispatch(path);
        let reader = match dispatched {
            ingest::Dispatched::Xls => return Err(LoadError::LegacyExcel),
            ingest::Dispatched::Xlsx => {
                return Err(LoadError::Other {
                    detail: "resume 不支持 Excel 工作簿（多 sheet 语义）".into(),
                });
            }
            _ => match ingest::reader_for(&dispatched) {
                Some(r) => r,
                None => {
                    let requested = match dispatched {
                        ingest::Dispatched::Unsupported(ext) => ext,
                        _ => String::new(),
                    };
                    return Err(LoadError::UnsupportedFormat { requested });
                }
            },
        };
        // copy-in + attach under the explicit reference name (no de-conflict:
        // the recipe's name is already unique, ADR-0036 parse-time check).
        let snap = ingest::loader::copy_in(path, &self.temp_path, reference_name, reader)?;
        let attach_path = snap.file_path.to_string_lossy();
        let attach_sql = format!(
            "ATTACH '{attach_path}' AS {} (READ_ONLY);",
            quote_ident(reference_name)
        );
        if let Err(e) = self.conn.execute_batch(&attach_sql) {
            let _ = fs::remove_file(&snap.file_path);
            return Err(LoadError::Other {
                detail: format!("挂载快照失败：{e}"),
            });
        }
        self.source_files
            .insert(reference_name.to_string(), snap.file_path);
        let descriptor = DatasetDescriptor {
            reference_name: reference_name.to_string(),
            display_name: display_name.to_string(),
            source_path: path.to_string_lossy().to_string(),
            columns: snap.columns,
            row_count: snap.row_count,
            sample: snap.sample,
            fingerprint: snap.fingerprint,
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: None,
        };
        self.working_set.register(descriptor.clone());
        Ok(descriptor)
    }

    /// Detach a source's read-only snapshot + drop it from the working set,
    /// WITHOUT appending a lifecycle event or cascading stale. Used during
    /// resume re-link / drift retry: the source is being re-ingested under the
    /// same name (re-link) or abandoned mid-resume (Rebuild), so the snapshot
    /// file must be released before a new copy-in can attach under the same
    /// name. Best-effort + logged I/O (mirrors `commit_removal`): a failure
    /// leaves a ghost attachment, but the working set is the source of truth
    /// and the session temp dir is wiped on drop.
    fn detach_snapshot(&mut self, reference_name: &str) {
        // Detach + drop the snapshot file + working-set entry, WITHOUT the
        // cascade-stale / Deleted-event steps of `commit_removal`. Used during
        // resume re-link / drift retry: the source is being re-ingested under
        // the same name (re-link) or abandoned mid-resume (Rebuild). The
        // shared best-effort I/O lives in `release_snapshot`.
        self.release_snapshot(reference_name);
    }

    /// Release a source's snapshot: DETACH the catalog + delete the snapshot
    /// file + drop the working-set entry. Best-effort + logged I/O shared by
    /// [`Self::detach_snapshot`] (resume re-link / drift retry) and
    /// [`Self::commit_removal`] (source removal). A failure leaves a ghost
    /// attachment or a stray temp file, but the working set (source of truth)
    /// still reflects the removal; the session temp dir is wiped on drop.
    fn release_snapshot(&mut self, reference_name: &str) {
        if let Err(e) = self
            .conn
            .execute_batch(&format!("DETACH {};", quote_ident(reference_name)))
        {
            log::warn!(
                target: "toptopduck::session",
                "DETACH failed for {reference_name}: {e}"
            );
        }
        let snapshot_path = self
            .source_files
            .remove(reference_name)
            .unwrap_or_else(|| self.temp_path.join(format!("{reference_name}.duckdb")));
        if let Err(e) = fs::remove_file(&snapshot_path) {
            log::warn!(
                target: "toptopduck::session",
                "snapshot file removal failed for {reference_name}: {e}"
            );
        }
        self.working_set.remove(reference_name);
        // Invalidate any derived-source dedup cache entry pointing at this ref
        // (issue #440): a later materialize referencing the same tool_output
        // file must re-stage + re-register, not reuse the dangling name.
        self.tool_output_refs
            .retain(|_, v| v.ref_name != reference_name);
    }

    fn ingest_structured(&mut self, path: &Path, reader: &str) -> LoadOutcome {
        let reference_name = match ingest::derive_reference_name(path) {
            Some(n) => self.working_set.deconflict(&n),
            None => {
                return LoadOutcome::Error(LoadError::Io {
                    detail: "无法从路径推导数据集名".into(),
                })
            }
        };

        // copy-in must succeed before the working set is touched.
        let snap = match ingest::loader::copy_in(path, &self.temp_path, &reference_name, reader) {
            Ok(s) => s,
            Err(e) => return LoadOutcome::Error(e),
        };

        // Attach the snapshot read-only (ADR-0005 engine-level enforcement).
        // `attach_path` is tool-controlled (temp dir + sanitized alias), not user
        // input, so interpolation is safe; the user-supplied source path is bound
        // as a parameter during copy-in (see ingest::loader).
        let attach_path = snap.file_path.to_string_lossy();
        let attach_sql = format!(
            "ATTACH '{attach_path}' AS {} (READ_ONLY);",
            quote_ident(&reference_name),
        );
        if let Err(e) = self.conn.execute_batch(&attach_sql) {
            let _ = std::fs::remove_file(&snap.file_path);
            return LoadOutcome::Error(LoadError::Other {
                detail: format!("failed to mount snapshot: {e}"),
            });
        }

        // Record the attached snapshot's file so the sandbox can re-attach it
        // READ_ONLY (ADR-0005 read_* closure). file_path is moved here; the
        // descriptor below takes snap's remaining fields.
        self.source_files
            .insert(reference_name.clone(), snap.file_path);

        // ADR-0037: the display label is the readable original filename stem (the
        // SQL-safe reference name is sanitized above), display-layer de-conflicted
        // so two sources sharing a stem never show identical labels in the UI
        // (slice 4a, issue #8).
        let raw_display = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(reference_name.as_str());
        let display_name = self.working_set.deconflict_display(raw_display);

        let descriptor = DatasetDescriptor {
            reference_name: reference_name.clone(),
            display_name,
            source_path: path.to_string_lossy().to_string(),
            columns: snap.columns,
            row_count: snap.row_count,
            sample: snap.sample,
            fingerprint: snap.fingerprint,
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: None,
        };
        self.working_set.register(descriptor.clone());
        // ADR-0040: a successful add appends a source lifecycle event -- a
        // first-class thread entry that is NOT a turn (no question, no outcome),
        // so it never enters the LLM window or advances result_N.
        self.append_source_event(
            SourceLifecycleKind::Added,
            &descriptor.reference_name,
            &descriptor.display_name,
        );
        LoadOutcome::Loaded(descriptor)
    }

    /// Read a workbook's visible sheets and drop blank ones -- the shared
    /// preamble for both Excel ingest paths (auto-tidy and guided). Returns
    /// `Err` with a single shared message when no sheet carries data, so the
    /// "工作簿不含任何含数据的 sheet" wording lives in one place.
    fn read_non_empty_sheets(path: &Path) -> Result<Vec<ingest::excel::SheetRows>, LoadError> {
        let mut sheets = ingest::excel::read_sheets(path)?;
        sheets.retain(|s| !s.rows.is_empty());
        if sheets.is_empty() {
            return Err(LoadError::Parse {
                detail: "工作簿不含任何含数据的 sheet".into(),
            });
        }
        Ok(sheets)
    }

    /// Ingest a .xlsx workbook (slice 3b, issue #10): best-effort auto-tidy each
    /// sheet (ADR-0015) -- forward-fill merged cells + single-header detection.
    /// If every sheet tidies confidently, each becomes a Dataset (`rectify =
    /// Auto`: the auto algorithm's choices aren't recorded, ADR-0042). If *any*
    /// sheet can't be confidently tidied, NO sheet is loaded -- the working set
    /// stays untouched and a [`LoadOutcome::NeedsGuidance`] carries each sheet's
    /// raw preview so the UI can gather explicit header/skip choices. Formula
    /// cells use their cached value (ADR-0015). Transactional: on any failure
    /// already-attached snapshots roll back (AC6/AC7).
    fn ingest_excel(&mut self, path: &Path) -> LoadOutcome {
        let sheets = match Self::read_non_empty_sheets(path) {
            Ok(s) => s,
            Err(e) => return LoadOutcome::Error(e),
        };

        // Auto-tidy each sheet; the first that can't be confidently tidied sends
        // the whole workbook to guided loading (no partial load -- transactional).
        let mut entries: Vec<(String, Vec<Vec<Data>>, RectifyProvenance)> =
            Vec::with_capacity(sheets.len());
        for sheet in &sheets {
            match auto_tidy(sheet) {
                TidyOutcome::Tidied(t) => {
                    entries.push((sheet.name.clone(), t.rows, RectifyProvenance::Auto))
                }
                TidyOutcome::NeedsGuidance => {
                    return LoadOutcome::NeedsGuidance(Self::build_guidance(path, &sheets));
                }
            }
        }

        match self.commit_excel(path, entries) {
            Ok(active) => LoadOutcome::Loaded(active),
            Err(e) => LoadOutcome::Error(e),
        }
    }

    /// Re-ingest an Excel workbook with the user's explicit rectify choices
    /// (ADR-0015 guided fallback / ADR-0042 user decisions). Each sheet is
    /// rectified by its [`SheetRectify`] (header row + skipped rows) and
    /// forward-filled over merged cells, then loaded with `rectify = User(...)`
    /// recorded on the descriptor. Transactional like [`Self::ingest`].
    pub fn ingest_guided(&mut self, path: &Path, guidance: &[SheetGuidance]) -> LoadOutcome {
        let sheets = match Self::read_non_empty_sheets(path) {
            Ok(s) => s,
            Err(e) => return LoadOutcome::Error(e),
        };

        // Apply each sheet's user rectify. A sheet with no guidance entry
        // defaults to a plain single-header rectify (header_row 1, no skips) --
        // the dialog sends one entry per visible sheet, this just stays safe.
        // Any out-of-range header_row aborts before copy-in so no partial load
        // escapes (transactional -- ADR-0042).
        let entries: Vec<(String, Vec<Vec<Data>>, RectifyProvenance)> = match sheets
            .iter()
            .map(|sheet| {
                let rectify = guidance
                    .iter()
                    .find(|g| g.name == sheet.name)
                    .map(|g| g.rectify.clone())
                    .unwrap_or_default();
                let rows = Self::apply_rectify(sheet, &rectify)?;
                Ok::<_, LoadError>((sheet.name.clone(), rows, RectifyProvenance::User(rectify)))
            })
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(e) => e,
            Err(e) => return LoadOutcome::Error(e),
        };

        match self.commit_excel(path, entries) {
            Ok(active) => LoadOutcome::Loaded(active),
            Err(e) => LoadOutcome::Error(e),
        }
    }

    /// Attach every `(display name, tidied rows, rectify)` entry as a read-only
    /// snapshot and register them atomically. De-conflicts both reference names
    /// and display labels up front (against the working set + each other) so
    /// duplicate sanitized names never collide at ATTACH time and no two sheets
    /// show identical labels in the UI (ADR-0037). Rolls back on any failure
    /// (AC6/AC7). Returns the active (last) descriptor.
    fn commit_excel(
        &mut self,
        path: &Path,
        entries: Vec<(String, Vec<Vec<Data>>, RectifyProvenance)>,
    ) -> Result<DatasetDescriptor, LoadError> {
        let mut reserved_ref: HashSet<String> = HashSet::new();
        let mut reserved_disp: HashSet<String> = HashSet::new();
        // De-conflict both names up front against the working set AND each other:
        // reference names (SQL-safe machine name) so two sheets that sanitize
        // alike never collide at ATTACH time, display labels so two sheets
        // sharing a name never show identical labels in the UI (ADR-0037, slice
        // 4a issue #8).
        let resolved: Vec<(String, String)> = entries
            .iter()
            .map(|(display, _, _)| {
                let reference = self
                    .working_set
                    .deconflict_with(&ingest::sanitize_sheet_name(display), &reserved_ref);
                reserved_ref.insert(reference.clone());
                let display = self
                    .working_set
                    .deconflict_display_with(display, &reserved_disp);
                reserved_disp.insert(display.clone());
                (reference, display)
            })
            .collect();

        // Copy-in + attach each entry; roll back on any failure. Panic-safety
        // invariant (carried from slice 3a): `attach_sheet` does only infallible
        // ops after ATTACH succeeds, so a just-attached snapshot never escapes
        // rollback -- keep it so when editing.
        let mut attached: Vec<String> = Vec::with_capacity(entries.len());
        let mut descriptors: Vec<DatasetDescriptor> = Vec::with_capacity(entries.len());
        for ((_, rows, rectify), (reference_name, display_name)) in
            entries.into_iter().zip(&resolved)
        {
            match self.attach_sheet(
                path,
                display_name,
                reference_name,
                &rows,
                rectify,
                &mut attached,
            ) {
                Ok(d) => descriptors.push(d),
                Err(e) => {
                    self.rollback_excel(&attached);
                    return Err(e);
                }
            }
        }

        // All attached: commit atomically. Callers guard entries non-empty
        // (read_non_empty_sheets rejects an empty workbook before reaching here),
        // but prefer a returned error over a reachable panic regardless.
        let Some(active) = descriptors.last().cloned() else {
            return Err(LoadError::Parse {
                detail: "工作簿不含任何含数据的 sheet".into(),
            });
        };
        for d in descriptors {
            // ADR-0040: each added sheet appends its own Add event, so a
            // multi-sheet workbook shows one event per sheet in the thread.
            let reference_name = d.reference_name.clone();
            let display_name = d.display_name.clone();
            self.working_set.register(d);
            self.append_source_event(SourceLifecycleKind::Added, &reference_name, &display_name);
        }
        Ok(active)
    }

    /// Copy-in one tidied sheet's rows to a read-only snapshot and attach it.
    /// On failure the snapshot file is removed; the caller records successful
    /// attaches (`attached`) for transactional rollback.
    fn attach_sheet(
        &mut self,
        path: &Path,
        display_name: &str,
        reference_name: &str,
        rows: &[Vec<Data>],
        rectify: RectifyProvenance,
        attached: &mut Vec<String>,
    ) -> Result<DatasetDescriptor, LoadError> {
        // tidied rows -> temp CSV -> read_csv_auto copy-in. DuckDB infers types
        // from the CSV, keeping the single-source-of-truth contract (ADR-0032).
        let csv_path =
            ingest::excel::write_sheet_csv(rows, display_name, &self.temp_path, reference_name)?;
        // If copy-in fails the temp CSV must still be cleaned up -- the snapshot
        // file is copy_in's own responsibility, but the CSV is ours to remove.
        let snap = match ingest::loader::copy_in(
            &csv_path,
            &self.temp_path,
            reference_name,
            "read_csv_auto",
        ) {
            Ok(s) => s,
            Err(e) => {
                let _ = fs::remove_file(&csv_path);
                return Err(e);
            }
        };
        // The temp CSV is only needed during copy-in; the snapshot holds the data.
        let _ = fs::remove_file(&csv_path);

        let attach_path = snap.file_path.to_string_lossy();
        let attach_sql = format!(
            "ATTACH '{attach_path}' AS {} (READ_ONLY);",
            quote_ident(reference_name)
        );
        if let Err(e) = self.conn.execute_batch(&attach_sql) {
            let _ = fs::remove_file(&snap.file_path);
            return Err(LoadError::Other {
                detail: format!("挂载快照失败：{e}"),
            });
        }
        attached.push(reference_name.to_string());
        // Record the attached snapshot's file for the sandbox re-attach path
        // (ADR-0005 read_* closure). file_path is moved here; the descriptor
        // below takes the remaining fields.
        self.source_files
            .insert(reference_name.to_string(), snap.file_path);

        Ok(DatasetDescriptor {
            reference_name: reference_name.to_string(),
            display_name: display_name.to_string(),
            source_path: path.to_string_lossy().to_string(),
            columns: snap.columns,
            row_count: snap.row_count,
            sample: snap.sample,
            fingerprint: snap.fingerprint,
            rectify,
            privacy: DatasetPrivacy::default(),
            stale: None,
        })
    }

    /// Build a [`GuidanceRequest`] from a workbook's sheets: each visible
    /// non-blank sheet's raw top rows rendered as strings (pre-rectify preview).
    fn build_guidance(path: &Path, sheets: &[ingest::excel::SheetRows]) -> GuidanceRequest {
        let workbook_name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("workbook")
            .to_string();
        let sheets_preview = sheets
            .iter()
            .map(|s| GuidanceSheet {
                name: s.name.clone(),
                preview: ingest::excel::render_preview(s, GUIDANCE_PREVIEW_ROWS),
            })
            .collect();
        GuidanceRequest {
            source_path: path.to_string_lossy().to_string(),
            workbook_name,
            sheets: sheets_preview,
        }
    }

    /// Apply a user's rectify choices to a sheet's raw grid: forward-fill merged
    /// cells, then take the header from `header_row` (1-based) and the data rows
    /// below it minus `skip_rows` (1-based absolute). Deterministic for the same
    /// input + params (ADR-0042).
    ///
    /// `header_row` is validated to be in `1..=rows.len()`: a guided ingest is a
    /// `#[tauri::command]`, so the value crosses the IPC boundary, and an
    /// out-of-range header_row would otherwise silently yield a header-less table
    /// (range miss) or a header-duplicated table (`0` -- the first row serves as
    /// both header and data). Rejecting it keeps the user's explicit decision
    /// producing exactly the table they asked for (ADR-0042).
    fn apply_rectify(
        sheet: &ingest::excel::SheetRows,
        rectify: &SheetRectify,
    ) -> Result<Vec<Vec<Data>>, LoadError> {
        let mut rows = sheet.rows.clone();
        forward_fill_merges(&mut rows, &sheet.merges);
        if rectify.header_row == 0 || rectify.header_row as usize > rows.len() {
            return Err(LoadError::Parse {
                detail: format!(
                    "表头行号 {} 越界（sheet \"{}\" 共 {} 行，需在 1..={} 内）",
                    rectify.header_row,
                    sheet.name,
                    rows.len(),
                    rows.len()
                ),
            });
        }
        let header_idx = rectify.header_row as usize - 1;
        let mut out = Vec::with_capacity(rows.len());
        out.push(rows[header_idx].clone());
        let skip: HashSet<u32> = rectify.skip_rows.iter().copied().collect();
        for (i, row) in rows.iter().enumerate() {
            let abs = (i + 1) as u32; // 1-based absolute row
            if abs > rectify.header_row && !skip.contains(&abs) {
                out.push(row.clone());
            }
        }
        Ok(out)
    }

    /// Detach already-attached excel snapshots and delete their files (rollback).
    /// Best-effort: a DETACH or remove_file failure is logged, not swallowed
    /// silently. A failed DETACH can leave a ghost attachment on the connection
    /// (breaking a later same-name re-ATTACH), and on Windows a held handle can
    /// make remove_file fail too -- logging keeps either failure diagnosable.
    fn rollback_excel(&mut self, attached: &[String]) {
        for reference_name in attached.iter().rev() {
            if let Err(e) = self
                .conn
                .execute_batch(&format!("DETACH {};", quote_ident(reference_name)))
            {
                log::warn!(
                    target: "toptopduck::session",
                    "DETACH failed during excel rollback for {reference_name}: {e}"
                );
            }
            if let Err(e) = fs::remove_file(self.temp_path.join(format!("{reference_name}.duckdb")))
            {
                log::warn!(
                    target: "toptopduck::session",
                    "snapshot file removal failed during excel rollback for {reference_name}: {e}"
                );
            }
        }
    }

    pub fn list(&self) -> Vec<DatasetDescriptor> {
        self.working_set.list().to_vec()
    }

    pub fn active(&self) -> Option<DatasetDescriptor> {
        // Resolved current table (ADR-0010/0022, issue #27): the most recent
        // result if any, else the most-recently-uploaded source. Mirrors what the
        // window assembler puts in the payload, so the UI's "当前表" indicator
        // matches what the next question targets by default.
        //
        // INVARIANT: every name `resolve_active` yields is present in the working
        // set today -- it derives from a registered result descriptor or the
        // active source. The remove path (#38) refuses removal of the active
        // source and of any source while results exist, so the active source
        // and any materialized result stay registered while they're resolvable.
        // When ADR-0013's result soft-invalidate/GC lands, a Materialized turn's
        // name could outlive its descriptor; the right fix then is to filter
        // stale names INSIDE `resolve_active` (it already holds the working
        // set), NOT an `or_else` fallback here -- a fallback here would split
        // the payload (`active` still names the stale result) from the UI label,
        // papering over the divergence silently.
        let turns = self.turns();
        window::resolve_active(&self.working_set, &turns)
            .and_then(|name| self.working_set.get(&name).cloned())
    }

    pub fn get(&self, reference_name: &str) -> Option<DatasetDescriptor> {
        self.working_set.get(reference_name).cloned()
    }

    /// Rename a dataset's display label (ADR-0037): display-only -- the reference
    /// name is untouched, so every existing reference (SQL FROM, the recipe
    /// chain, the active pointer) stays valid and nothing is rewritten or
    /// propagated. Delegates to the working set, returning the updated
    /// descriptor, or a [`RenameError`] when the reference is unknown or the new
    /// label collides with another dataset's display label (display-layer
    /// uniqueness).
    pub fn rename_display(
        &mut self,
        reference_name: &str,
        new_display: &str,
    ) -> Result<DatasetDescriptor, RenameError> {
        self.working_set.rename_display(reference_name, new_display)
    }

    /// Rename the session itself (ADR-0060, issue #81): set the user-facing
    /// [`Self::session_name`] carried in the recipe header, then rewrite the
    /// bound `.duck` so the new name survives resume. Display-only at the
    /// session level -- the bound path is untouched, so every external reference
    /// (sidebar addressing, open_duck) stays valid; nothing else
    /// is rewritten or propagated. Trims surrounding whitespace and rejects a
    /// blank name. The persist is best-effort (like every
    /// terminal turn): a write failure does not roll back the in-memory rename --
    /// it surfaces via [`Self::take_persist_error`] and self-heals on the next
    /// successful write. Returns the trimmed name that landed.
    pub fn rename(&mut self, new_name: &str) -> Result<String, RenameSessionError> {
        let trimmed = new_name.trim();
        if trimmed.is_empty() {
            return Err(RenameSessionError::EmptyName);
        }
        let name = trimmed.to_string();
        self.persister.set_session_name(name.clone());
        self.persister
            .save_if_bound(&self.working_set, &self.timeline);
        Ok(name)
    }

    /// Set a dataset's privacy controls (ADR-0011, issue #9 slice 5): per-
    /// dataset sample switch + per-column type-only marking. The config rides
    /// the descriptor in the working set, so it persists across UI resize /
    /// active-dataset switch / source replace, and the query-loop window
    /// assembler (PRD #1) reads it off the same descriptor to prune the LLM
    /// payload (cross-PRD contract). Returns the updated descriptor, or `None`
    /// when the reference name isn't loaded -- the command boundary maps that to
    /// an error string.
    pub fn set_privacy(
        &mut self,
        reference_name: &str,
        privacy: DatasetPrivacy,
    ) -> Option<DatasetDescriptor> {
        self.working_set.set_privacy(reference_name, privacy)
    }

    /// Run one turn (PRD #1, ADR-0077/0081 contract): assemble the windowed
    /// tool-calling request, drive the native agent loop (explore / materialize
    /// / describe / sample tool calls with model-driven self-correction), and
    /// produce exactly one ADR-0028 outcome -- result / textual / failed /
    /// cancelled. Tool-level errors route back to the model (blind retry is
    /// abolished, ADR-0077); only a non-converging trajectory exhausts the
    /// step cap and fails honestly. A cancel (user / close / wall-clock
    /// watchdog, ADR-0021) aborts the WHOLE turn -- loop + in-flight tool
    /// call -- and leaves the working set untouched. Every turn is recorded in
    /// the conversation thread (always visible, ADR-0028/0039); only a result
    /// advances result_N. Infallible -- a question always yields one outcome.
    ///
    /// Facade for callers without the command-layer approval wiring (tests):
    /// built-in tools classify Allow at the gateway without touching the sink,
    /// so a fresh [`ApprovalState`] + a no-op sink behaves identically to the
    /// store-attached pair on the built-in tool table.
    pub fn ask(&mut self, question: &str) -> TurnOutcome {
        let approval = ApprovalState::new();
        let sink = NullApprovalSink;
        // No external MCP servers in the test / non-command path: built-in
        // tools only. The keychain is an empty KeychainStore (a stateless unit
        // struct, ADR-0029) -- get_mcp_secret reads None for every env key, so
        // a server with keychain_env_keys still spawns, just secret-free.
        let keychain = KeychainStore::new();
        // No mounted skills either: tests that need skill injection call
        // ask_with_phase directly with resolved fragments (issue #364).
        let inputs = TurnInputs::empty(&keychain);
        self.ask_with_phase(question, &approval, &sink, |_| {}, &inputs)
    }

    /// Run one turn AND surface its discrete progress events (ADR-0059,
    /// calibrated by ADR-0078). Same semantics as [`Self::ask`]; the
    /// `on_phase` callback receives the [`TurnPhase`] event stream: Thinking
    /// before each provider round-trip (carrying the 1-based step so a
    /// multi-step trajectory reads honestly, "step N") and the
    /// ToolCallStarted / ToolCallCompleted pair around each tool dispatch --
    /// the trace's live form, so the rail renders the in-flight turn
    /// progressively. The command layer wraps this callback to emit the
    /// side-channel `turn-progress` Tauri event addressed by sessionId
    /// (ADR-0056/0059); the events never enter the [`TurnOutcome`] contract.
    ///
    /// `approval` + `sink` are the session's tiered-approval gateway
    /// (ADR-0080/0083): the store-attached [`ApprovalState`] the
    /// `respond_tool_approval` command wakes, and the Tauri sink that emits
    /// the approval-card events. Both live at the command boundary (the only
    /// layer holding an AppHandle, ADR-0029) and are borrowed per turn, so the
    /// Session stays unparameterized across `commands.rs`.
    pub fn ask_with_phase(
        &mut self,
        question: &str,
        approval: &ApprovalState,
        sink: &dyn ApprovalSink,
        on_phase: impl FnMut(TurnPhase) + Send,
        inputs: &TurnInputs<'_>,
    ) -> TurnOutcome {
        // Facade over the agent loop (ADR-0081, issue #318): assemble the
        // windowed tool-calling request (system prompt + tool table + windowed
        // history, via the window assembler), drive the loop with the shared
        // session state borrowed via TurnDeps + the session's own
        // materializer, map the structured LoopOutcome onto the four-way
        // TurnOutcome, then record it. `record_turn` stays on the facade (the
        // conversation timeline + persistence are session concerns, not turn
        // orchestration -- ADR-0053 Decision 2).
        let turns = self.turns();
        let locale = self.provider.response_locale();
        // ADR-0086 (issue #364): the mounted-skill fragments both ride the
        // system prompt (base prompt + skill bodies + locale + schema) and
        // snapshot into the turn's provenance (name + content_hash) for resume.
        // Computed once here so both branches see the same assembly-time
        // snapshot; an empty slice stays empty end-to-end (no skill section in
        // the prompt, no skills in the provenance -- the pre-skill path).
        let skill_provenance: Vec<SkillProvenance> = inputs
            .skills
            .iter()
            .map(|f| SkillProvenance {
                name: f.name.clone(),
                content_hash: f.content_hash.clone(),
            })
            .collect();
        // The external-runtime branch (issue #299 slice 9c, ADR-0085) replaces
        // the built-in agent loop when an adapter is set; otherwise the built-in
        // loop runs (ADR-0081). Both return a `(outcome, trace)` pair; the
        // post-turn discard + `record_turn` path stays shared (ADR-0055 +
        // ADR-0078). `on_phase` moves into exactly one arm (match arms are
        // exclusive), so the built-in closure and the external engine cannot
        // both hold it.
        let (outcome, trace) = match self.external_runtime.clone() {
            Some(adapter) => self.run_external_turn(
                question, &turns, locale, adapter, approval, sink, on_phase, inputs,
            ),
            None => {
                // Built-in agent loop (ADR-0081, issue #318): assemble the
                // windowed tool-calling request, drive the loop with the shared
                // session state, map the structured LoopOutcome onto TurnOutcome.
                let mut request = window::assemble_tool_turn(
                    question,
                    &self.working_set,
                    &turns,
                    locale,
                    inputs.skills,
                );
                // Disjoint field borrows: the loop borrows `&*self.provider`
                // while TurnDeps borrows `&self.conn` / `&self.source_files` /
                // `&mut self.working_set` / `&self.temp_path` and the loop takes
                // `&mut *self.materializer` -- distinct Session fields, so they
                // coexist without widening to `&mut self`. The block scope drops
                // the borrows before `record_turn` takes its own `&mut self`.
                let (outcome, trace) = {
                    // Connect the user's configured external MCP servers
                    // (issue #301 slice C-loop / slice D): same per-turn
                    // lifecycle as the gateway path (ADR-0076 Decision +
                    // ADR-0085 Consequences -- spawn + initialize each stdio
                    // server here, drop at scope end so the spawned children
                    // die with the aggregator). The aggregator's namespaced
                    // tools merge into the request's tool table so the model
                    // sees one surface; execute_call routes a namespaced call
                    // back through the aggregator. Slice D: connect_all returns
                    // the per-server outcomes, snapshotted into
                    // self.last_mcp_connect BEFORE deps borrows &mut
                    // self.working_set (disjoint field, but the assignment
                    // preceding the borrow keeps borrowck structural so the
                    // command layer can mirror it into the SessionHandle).
                    let mut mcp = crate::mcp::aggregator::McpAggregator::with_tool_output(
                        self.tool_output_path(),
                    );
                    self.last_mcp_connect = mcp.connect_all(inputs.mcp_servers, inputs.keychain);
                    request
                        .tools
                        .extend(crate::tools::external_tool_definitions(
                            &mcp.aggregated_tools(),
                        ));
                    let mut deps = TurnDeps {
                        conn: &self.conn,
                        source_files: &mut self.source_files,
                        working_set: &mut self.working_set,
                        result_row_cap: self.result_row_cap,
                        result_count_cap: self.result_count_cap,
                        temp_path: &self.temp_path,
                        tool_output_refs: &mut self.tool_output_refs,
                    };
                    let mut loop_outcome =
                        AgentLoop::new(&*self.provider, Arc::clone(&self.cancel)).run(
                            &request,
                            &mut deps,
                            &mut *self.materializer,
                            &mut mcp,
                            approval,
                            sink,
                            on_phase,
                        );
                    // The loop's real multi-call trace rides alongside the
                    // mapped outcome to record_turn (ADR-0078, issue #319): the
                    // mapper stays focused on the four-way classification, so
                    // the trace rides separately rather than folded into
                    // TurnOutcome -- which crosses IPC as the outcome contract
                    // alone; the trace's DISPLAY view lands on the TurnRecord
                    // at record_turn (issue #297), never on the outcome.
                    // `turn_outcome_from_loop` reads only `termination` +
                    // `promotions`, so the trace is moved out before the outcome
                    // is mapped (no clone on the per-turn record path);
                    // `mem::take` leaves an empty Vec the mapper ignores.
                    let trace = std::mem::take(&mut loop_outcome.trace);
                    (turn_outcome_from_loop(loop_outcome), trace)
                };
                (outcome, trace)
            }
        };
        // ADR-0055 post-turn discard: if `close_session` marked this session
        // closing while the turn was in flight (it also fired cancel, so the
        // outcome is typically Cancelled, but a turn that squeaked through in
        // the narrow window is discarded too), drop the outcome -- no thread
        // append, no recipe persist. The cancelled turn must not enter the
        // productive chain (ADR-0021) or the recipe (ADR-0034). NOTE: this
        // skips `record_turn` only; `run` may already have materialized a
        // `result_N` into the working set / admin connection (try_materialize
        // runs before this check), but the session is being torn down so that
        // in-memory state is dropped with it and never observed. Log the
        // discard so an operator can tell a close-induced drop apart from a
        // normal user cancel (the outcome alone reads as Cancelled either way).
        if self.is_closing() {
            log::info!(
                target: "toptopduck::session",
                "discarding in-flight turn: session closed during the turn (ADR-0055)"
            );
            return outcome;
        }
        self.record_turn(question, outcome, trace, skill_provenance)
    }

    /// Drive one external-runtime turn (issue #299 slice 9c, ADR-0085).
    ///
    /// Spawns the external CLI via [`AcpEngine`], which injects the bridge MCP
    /// descriptor at `session/new`; the CLI launches the bridge, the bridge
    /// connects back to a per-bridge gateway, and the gateway serves the
    /// built-in tool table + routes every `tools/call` through the approval
    /// gate + [`crate::tools::dispatch`] -- the same path the built-in loop
    /// takes (ADR-0076 single enforcement point). The gateway serve loop and
    /// the ACP engine run on two scoped threads (ADR-0085); this method joins
    /// both, merges their outcomes (trace de-duplicated: gateway authoritative
    /// for gateway-routed tools, ACP pump for the CLI's own built-in tools),
    /// and returns the same `(TurnOutcome, trace)` shape the built-in branch
    /// does so [`Self::ask_with_phase`]'s post-turn path is shared.
    // Cannot collapse further: question / history / locale / adapter are
    // external-runtime orchestration params with no natural grouping (unlike
    // the three data inputs now in TurnInputs); approval / sink / on_phase
    // are per-turn wiring callbacks (see TurnInputs doc), not data.
    #[allow(clippy::too_many_arguments)]
    fn run_external_turn<O: FnMut(TurnPhase) + Send>(
        &mut self,
        question: &str,
        history: &[TurnRecord],
        locale: ResponseLocale,
        adapter: AdapterSpec,
        approval: &ApprovalState,
        sink: &dyn ApprovalSink,
        on_phase: O,
        inputs: &TurnInputs<'_>,
    ) -> (TurnOutcome, Vec<TraceEntry>) {
        // 1. Resolve the CLI binary. Not-on-PATH -> a transient turn failure
        //    (the engine never spawns; nothing to clean up).
        let binary = match detect_adapter(&adapter) {
            Some(p) => p,
            None => {
                return (
                    TurnOutcome::Failed(TurnFailure::Execute {
                        detail: format!("external runtime `{}` not found on PATH", adapter.id),
                    }),
                    Vec::new(),
                );
            }
        };
        // 2. Bind the per-bridge gateway (random localhost port + 64-hex
        //    token). Bind failure is rare (OS port exhaustion) but surfaces
        //    honestly.
        let handle = match bind_gateway() {
            Ok(h) => h,
            Err(e) => {
                return (
                    TurnOutcome::Failed(TurnFailure::Execute {
                        detail: format!("gateway bind failed: {e}"),
                    }),
                    Vec::new(),
                );
            }
        };
        // 3. Build the bridge MCP descriptor. The CLI launches this binary as
        //    its MCP server; the bridge reads port + token from env and
        //    connects back to the gateway (ADR-0085 per-bridge lifecycle). A
        //    missing bin path surfaces as a transient turn failure (the gateway
        //    was bound but never served; dropping the handle releases the port).
        let bin_path = match bridge_bin_path() {
            Ok(p) => p,
            Err(detail) => {
                return (
                    TurnOutcome::Failed(TurnFailure::Execute { detail }),
                    Vec::new(),
                );
            }
        };
        let env = BTreeMap::from([
            (ENV_PORT.to_string(), handle.port.to_string()),
            (ENV_TOKEN.to_string(), handle.token.clone()),
        ]);
        let mcp_server = McpServer::stdio_bridge(GATEWAY_SERVER_NAME, bin_path, Vec::new(), env);
        // 4. Assemble the prompt blocks (leading context: locale + schema;
        //    skill block before question; M-contract via gateway tool table).
        let prompt_blocks =
            window::assemble_acp_turn(question, &self.working_set, history, locale, inputs.skills);
        let input = AcpTurnInput {
            cwd: self.temp_path.to_string_lossy().to_string(),
            mcp_servers: vec![mcp_server],
            prompt_blocks,
        };
        // 5. Drive the gateway serve + the ACP engine on two scoped threads.
        //    The gateway borrows the session's live resources (conn / working
        //    set / materializer / approval / sink / cancel) for `tools/call`
        //    dispatch; the engine drives the ACP protocol with no session
        //    borrows. Scoped threads let the non-`'static` borrows cross the
        //    thread boundary; the two `&` params (approval / sink) are `Copy`
        //    backed by `Sync` types, so both threads may hold them.
        // The ACP engine runs on a scoped thread (it drives the CLI; the CLI
        // spawns the bridge, the bridge connects back to the gateway). The
        // gateway serve runs on THIS thread because `duckdb::Connection` is
        // `!Sync` -- its statement cache + inner handle are `RefCell`-guarded,
        // so `&Connection` is `!Send` and cannot cross a thread boundary. The
        // engine holds no session borrows (owned input/binary/adapter + an
        // `Arc` cancel clone + `&approval`/`&sink`, which are `Sync`-backed) +
        // the `Send`-bounded `on_phase`, so it crosses cleanly; the serve loop
        // keeps the session's live resources on the thread that owns them
        // (ADR-0085: serve borrows in place, engine drives in parallel).
        let (acp_outcome, gateway_result) = std::thread::scope(|s| {
            let engine = AcpEngine::new(adapter, Arc::clone(&self.cancel));
            // Deterministic serve terminator (issue #357 / ADR-0085): a one-shot
            // flag the engine thread sets when its prompt pump returns. The pump
            // returning means the CLI sent its final session/prompt response,
            // so every tools/call it sent was already served synchronously --
            // serve_connection polls this at its loop top + returns the outcome
            // without waiting for the bridge to close the TCP connection. On
            // Linux the stdio-spawned bridge inherits a leaked stdin write-end
            // (Rust std limitation) and never EOFs, so without this flag serve
            // would park until the 120s wall-clock watchdog cancelled it.
            // Production Node-spawned bridges do not leak the fd, but relying on
            // the bridge to close promptly is a correctness gap the flag closes.
            // The engine thread sets the flag when its prompt pump returns. The
            // flag is an `Arc<AtomicBool>` (not a borrowed `&AtomicBool`) because
            // `thread::scope`'s `spawn` requires the closure's captures to be
            // valid for the full `'scope` lifetime, and the borrow checker will
            // not promote a borrow of a scope-body-local to `'scope` -- so the
            // shared reference must be heap-backed. `Arc` is the minimal form.
            let engine_done = Arc::new(AtomicBool::new(false));
            let done_flag = Arc::clone(&engine_done);
            let eng = s.spawn(move || {
                let outcome = engine.run(&input, &binary, approval, sink, on_phase);
                done_flag.store(true, Ordering::SeqCst);
                outcome
            });
            // Connect the user's configured external MCP servers (issue #301
            // slice C-gw / slice D). Per-turn (ADR-0076 Q2): spawn + initialize
            // each stdio server here so the gateway advertises its tools
            // alongside the built-in table and routes namespaced tools/call
            // back through the aggregator. A failed connect logs + skips that
            // server rather than failing the turn (McpAggregator::connect_all
            // / connect_one); the spawned children die with the aggregator at
            // scope end. Slice D: connect_all returns the per-server outcomes,
            // snapshotted into self.last_mcp_connect BEFORE deps borrows &mut
            // self.working_set (disjoint field, assignment-first keeps borrowck
            // structural for the command-layer mirror).
            let mut mcp =
                crate::mcp::aggregator::McpAggregator::with_tool_output(self.tool_output_path());
            self.last_mcp_connect = mcp.connect_all(inputs.mcp_servers, inputs.keychain);
            let deps = TurnDeps {
                conn: &self.conn,
                source_files: &mut self.source_files,
                working_set: &mut self.working_set,
                result_row_cap: self.result_row_cap,
                result_count_cap: self.result_count_cap,
                temp_path: &self.temp_path,
                tool_output_refs: &mut self.tool_output_refs,
            };
            let ctx = GatewayCtx {
                deps,
                materializer: &mut *self.materializer,
                approval,
                sink,
                cancel: &self.cancel,
                mcp,
            };
            let gateway_result = serve_connection(handle, ctx, &engine_done);
            (
                eng.join().expect("acp engine thread panicked"),
                gateway_result,
            )
        });
        // 6. A serve error after spawn surfaces as a transient failure; the
        //    ACP trace still rides (the CLI may have done work before the gap).
        let gateway_outcome = match gateway_result {
            Ok(o) => o,
            Err(e) => {
                return (
                    TurnOutcome::Failed(TurnFailure::Execute {
                        detail: format!("gateway serve failed: {e}"),
                    }),
                    acp_outcome.trace,
                );
            }
        };
        // 7. Merge + map onto TurnOutcome (same mapper + trace-extraction
        //    pattern as the built-in branch).
        let mut merged = merge_outcomes(gateway_outcome, acp_outcome);
        let trace = std::mem::take(&mut merged.trace);
        (turn_outcome_from_loop(merged), trace)
    }

    /// Append a turn to the conversation thread and return its outcome. Every
    /// outcome kind is recorded (ADR-0028 always-visible); the caller has
    /// already decided the outcome, so this just persists + returns it. The turn
    /// is wrapped in a [`TimelineEntry::Turn`] carrying both the IPC-visible
    /// [`TurnRecord`] and the persisted [`TurnAudit`] (ADR-0078) so alignment
    /// is structural (issue #325). Source/skill lifecycle events share the same
    /// timeline (ADR-0040) but never enter the LLM window. `trace` is the agent
    /// loop's recorded call trajectory for this turn; it snapshots into the
    /// turn's persisted audit so [`Self::build_recipe`]'s whole-file rebuild
    /// reads it per turn.
    fn record_turn(
        &mut self,
        question: &str,
        outcome: TurnOutcome,
        trace: Vec<TraceEntry>,
        skills: Vec<SkillProvenance>,
    ) -> TurnOutcome {
        // ADR-0089 Decision 4: on the first terminal turn, auto-name the
        // session from the first question's bounded truncation (ADR-0039
        // same-kind rule: verbatim question cut at a char boundary, never an
        // LLM summary). After this one-time trigger the name is never auto-
        // changed -- subsequent turns leave it untouched, and a user rename
        // sticks. Source/skill lifecycle events do not count as turns, so a
        // session that loaded files or mounted skills before its first
        // question still auto-names on that first question.
        let is_first_turn = !self
            .timeline
            .iter()
            .any(|e| matches!(e, TimelineEntry::Turn { .. }));
        if is_first_turn {
            self.persister
                .set_session_name(truncate_session_name(question));
        }
        // ADR-0078 (issue #297): the DISPLAY view of the trace rides the
        // TurnRecord so the rail can expand a completed turn's tool-call chain
        // (bounded summaries + the failed-call message; the full in-memory
        // payloads never cross IPC). Mapped before the audit consumes the
        // in-memory entries below.
        let trace_view: Vec<TraceEntryView> = trace.iter().map(TraceEntryView::from).collect();
        self.timeline.push(TimelineEntry::Turn {
            record: TurnRecord {
                question: question.to_string(),
                outcome: outcome.clone(),
                trace: trace_view,
                // Issue #381: the IPC provenance narrows to skills only (the
                // runtime kind stays in the persisted TurnAudit below -- backend
                // audit, never crosses to the webview). `skills` is already the
                // model::SkillProvenance shape record_turn receives.
                provenance: TurnProvenance {
                    skills: skills.clone(),
                },
            },
            // ADR-0078 (issue #319): the loop's real multi-call trace (mapped
            // to the recipe form) + the BuiltIn runtime provenance + the
            // mounted-skills provenance (ADR-0086, issue #364: each skill's
            // name + content_hash snapshotted at assembly time). The PERSISTED
            // form rides the Session (the recipe is its .duck layer, read by
            // build_recipe); the TurnRecord's display view above is the same
            // bounded shape.
            audit: TurnAudit::builtin(trace, skills),
        });
        // ADR-0034 per-terminal-turn atomic write: the recipe is rewritten
        // whole-file at the bound path (temp + rename). No-op when no .duck
        // is bound; a failure is logged (the prior file is intact and the
        // next turn retries).
        self.persist_if_bound();
        outcome
    }

    /// Build the recipe (ADR-0034). Facade delegate to
    /// [`RecipePersister::build_recipe`](recipe_persister::RecipePersister::build_recipe).
    pub fn build_recipe(&self) -> Recipe {
        self.persister
            .build_recipe(&self.working_set, &self.timeline)
    }

    /// Rewrite the recipe at the bound path (ADR-0034 atomic write). Facade
    /// delegate to [`RecipePersister::save_if_bound`](recipe_persister::RecipePersister::save_if_bound).
    fn persist_if_bound(&mut self) {
        // Migrate derived sources before building the recipe so their
        // source_path carries the portable (.duck-adjacent) location instead
        // of the temp staging path (issue #433, ADR-0087 D2). Without this,
        // derived sources created after the initial bind_duck would carry temp
        // paths in the recipe — wiped on session drop, breaking resume.
        if let Some(duck_path) = self.persister.duck_path().map(PathBuf::from) {
            self.migrate_derived_sources(&duck_path);
        }
        self.persister
            .save_if_bound(&self.working_set, &self.timeline);
    }

    /// Take (read + clear) the most recent per-turn persistence failure, if
    /// any (issue #120 typed error for IPC).
    pub fn take_persist_error(&mut self) -> Option<SaveError> {
        self.persister.take_persist_error()
    }

    /// Take (read + clear) the pending external-change conflict, if any
    /// (ADR-0035 Decision 3, issue #50).
    pub fn take_pending_conflict(&mut self) -> Option<PendingConflict> {
        self.persister.take_pending_conflict()
    }

    /// Resolve a pending conflict with "Keep Mine" (ADR-0035 Decision 3).
    pub fn conflict_keep_mine(&mut self) -> Result<(), SaveError> {
        self.persister
            .conflict_keep_mine(&self.working_set, &self.timeline)
    }

    /// Resolve a pending conflict with "Save As New" (ADR-0035 Decision 3).
    pub fn conflict_save_as_new(&mut self, new_path: PathBuf) -> Result<(), SaveError> {
        self.persister
            .conflict_save_as_new(new_path, &self.working_set, &self.timeline)
    }

    /// The turn-only view of the timeline, cloned out for the window assembler
    /// (ADR-0040): source + skill lifecycle events share the timeline but the
    /// LLM payload is built from turns alone. A clone (not a borrow) so the
    /// slice the assembler reads is `&[TurnRecord]` unchanged -- the assembler
    /// and its tests stay event-agnostic. The clone is negligible (a small
    /// thread, once per turn / active read) next to the LLM call it feeds.
    fn turns(&self) -> Vec<TurnRecord> {
        self.timeline
            .iter()
            .filter_map(|entry| match entry {
                TimelineEntry::Turn { record, .. } => Some(record.clone()),
                TimelineEntry::Source(_) | TimelineEntry::Skill(_) => None,
            })
            .collect()
    }

    /// The conversation thread (ADR-0028/0039/0040): the unified timeline of
    /// turns AND source/skill lifecycle events, projected to the IPC-visible
    /// [`ThreadEntry`] form. The thread is the source of truth the frontend
    /// renders; the window assembler reads only the turns (via [`Self::turns`])
    /// to build the provider payload (ADR-0023 window + ADR-0039 summary).
    /// Source/skill events are first-class here but never reach the window.
    /// The projection drops the persisted audit (ADR-0078) so the wire shape
    /// stays unchanged (issue #325).
    pub fn conversation(&self) -> Vec<ThreadEntry> {
        self.timeline
            .iter()
            .map(TimelineEntry::to_thread_entry)
            .collect()
    }

    /// Read one page of a dataset's rows (ADR-0024 windowed display). Cells are
    /// CAST to VARCHAR (NULL -> "") for uniform frontend rendering. `total` is
    /// the full row count, returned alongside the page so a truncated view never
    /// masquerades as complete (ADR-0030). Sources read `"<ref>".data`; results
    /// read `"<ref>"`. The FROM fragment, identifiers, and numeric LIMIT/OFFSET
    /// are all tool-generated, so the interpolation is safe.
    pub fn read_rows(
        &self,
        reference_name: &str,
        offset: u64,
        limit: u64,
    ) -> Result<RowPage, TurnError> {
        // Clamp the page size to the display cap (ADR-0005/0024) so a malformed
        // or hostile caller can't pull the whole table into memory.
        let limit = limit.min(MAX_READ_ROWS);
        let descriptor = self
            .working_set
            .get(reference_name)
            .ok_or_else(|| TurnError::UnknownDataset(reference_name.to_string()))?;
        let from = self
            .working_set
            .sql_from(reference_name)
            .ok_or_else(|| TurnError::UnknownDataset(reference_name.to_string()))?;
        let columns = descriptor.columns.clone();
        let selects: Vec<String> = columns
            .iter()
            .map(|c| format!("CAST({} AS VARCHAR)", quote_ident(&c.name)))
            .collect();
        let sql = format!(
            "SELECT {} FROM {} LIMIT {} OFFSET {}",
            selects.join(", "),
            from,
            limit,
            offset
        );
        let mut stmt = self
            .conn
            .prepare(&sql)
            .map_err(|e| TurnError::Execute(e.to_string()))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| TurnError::Execute(e.to_string()))?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| TurnError::Execute(e.to_string()))? {
            let mut cells = Vec::with_capacity(columns.len());
            for i in 0..columns.len() {
                let v: Option<String> =
                    row.get(i).map_err(|e| TurnError::Execute(e.to_string()))?;
                cells.push(v.unwrap_or_default());
            }
            out.push(cells);
        }
        Ok(RowPage {
            columns,
            rows: out,
            total: descriptor.row_count,
            offset,
            limit,
        })
    }

    /// Run arbitrary SQL on the session connection. Exposed for the read-only
    /// enforcement tests (AC5): writes against a source snapshot are rejected by
    /// the engine. Not part of the public ingest contract.
    pub fn execute_batch(&self, sql: &str) -> Result<(), duckdb::Error> {
        self.conn.execute_batch(sql)
    }

    /// Count rows in a snapshot's `data` table through its reference name
    /// (issue #11 AC1: a replace must make a later query see the *new* data).
    /// Exposed for the black-box tests alongside [`Self::execute_batch`] -- not
    /// part of the public ingest contract (the real query path arrives with the
    /// query loop, PRD #1).
    pub fn snapshot_row_count(&self, reference_name: &str) -> Result<i64, duckdb::Error> {
        self.conn.query_row(
            &format!("SELECT COUNT(*) FROM {}.data", quote_ident(reference_name)),
            [],
            |r| r.get(0),
        )
    }
}

/// Map the agent loop's structured outcome onto the four-way [`TurnOutcome`]
/// (ADR-0028, calibrated by ADR-0077/0081; issue #318). The termination routes:
///
/// - Converged (terminal text) with >=1 promotion -> [`TurnOutcome::Materialized`].
///   The LAST promotion is the turn's primary result (a later materialize
///   supersedes earlier ones as the analysis focus); its verbatim SQL rides
///   `sql`, the terminal text rides `assumption`. ADR-0022 monotonic numbering
///   already applied inside the loop (result_1, result_2, ...).
/// - Converged with no promotion -> [`TurnOutcome::Textual`] with
///   [`TextKind::Agent`]: the tool-calling contract carries no structural
///   clarify/refuse marker, so an honest answer, a clarification, and a
///   default-skillset boundary refusal (ADR-0079) all ride the agent kind --
///   the body text itself carries which.
/// - Step cap exhausted (the agent never converged) -> [`TurnOutcome::Failed`]
///   (`Execute`, carrying the cap). Provider faults map by class: NotWired /
///   InvalidConfig permanent, a surfaced transient fault an `Execute` failure
///   (the adapter's HTTP retry already ran; blind retry is abolished).
/// - Cancel (user / close / wall-clock watchdog) -> [`TurnOutcome::Cancelled`].
///
/// Tool-level errors (SQL failure, approval denial) never land here -- the
/// loop fed them back to the model for self-correction (ADR-0077); only a
/// trajectory that never converges exhausts the step cap.
fn turn_outcome_from_loop(outcome: LoopOutcome) -> TurnOutcome {
    match outcome.termination {
        Termination::Text(text) => {
            if outcome.promotions.is_empty() {
                TurnOutcome::Textual {
                    text_kind: TextKind::Agent,
                    body: text,
                    assumption: None,
                }
            } else {
                TurnOutcome::Materialized {
                    // ADR-0084: the outcome carries the FULL promotion chain in
                    // promotion order; the chain tail is the primary result
                    // (derived at the read sites, never folded here). Working
                    // set, history, recipe, and resume all see every promotion.
                    promotions: outcome.promotions,
                    // The tool-calling contract carries no viz intent (the
                    // presentation slice is separate); a plain table turn.
                    viz: None,
                    assumption: if text.trim().is_empty() {
                        None
                    } else {
                        Some(text)
                    },
                }
            }
        }
        Termination::StepCap(cap) => TurnOutcome::Failed(TurnFailure::Execute {
            detail: format!("agent did not converge within {cap} steps"),
        }),
        Termination::Cancelled => TurnOutcome::Cancelled,
        Termination::NotWired => TurnOutcome::Failed(TurnFailure::NotWired),
        Termination::InvalidConfig(detail) => {
            TurnOutcome::Failed(TurnFailure::InvalidConfig { detail })
        }
        Termination::Transient(detail) => TurnOutcome::Failed(TurnFailure::Execute { detail }),
    }
}

/// Merge the gateway's per-connection outcome with the ACP engine's loop
/// outcome into one [`LoopOutcome`] (issue #299 slice 9c, ADR-0085 +
/// ADR-0078).
///
/// The trace is de-duplicated across the two sources: a gateway-routed tool
/// (one of the built-in DuckDB set) appears in BOTH -- the gateway's
/// `tools/call` dispatch record (authoritative, ADR-0076 audit) and the CLI's
/// `session/update` tool-call notification. The gateway record wins for those
/// (it ran the SQL, so its success flag + excerpt are the truth); the ACP
/// pump's non-gateway entries (the CLI's own built-ins -- bash / edit / etc.,
/// which never touch the gateway) are appended. Promotions are gateway-only
/// (the ACP engine leaves them empty by design, slice 9a); termination +
/// `round_trips` are ACP-only (the gateway serves tools, it does not produce
/// a turn termination).
///
/// TODO(issue #299 E2E): a real claude-code drive may prefix MCP tool names
/// (e.g. `mcp__<server>__explore`) in its `session/update` notifications, in
/// which case the `builtin_metadata` filter would let a gateway-routed call
/// through as "non-gateway" and double it. The slice 9c integration test
/// drives a fake CLI that emits unprefixed names; real-CLI naming is verified
/// in the manual E2E checklist, and a normalization layer lands as a
/// follow-up if the E2E shows a prefix.
fn merge_outcomes(gateway: GatewayOutcome, mut acp: LoopOutcome) -> LoopOutcome {
    acp.promotions = gateway.promotions;
    let non_gateway: Vec<TraceEntry> = acp
        .trace
        .into_iter()
        .filter(|e| builtin_metadata(&e.name).is_none())
        .collect();
    let mut trace = gateway.trace;
    trace.extend(non_gateway);
    acp.trace = trace;
    acp
}

/// Resolve the ACP bridge binary path (issue #299 slice 9c, ADR-0085).
///
/// Returns `Err` with a turn-failure detail when `TOPTOPDUCK_ACP_BRIDGE_BIN` is
/// unset so the orchestrator surfaces a `TurnOutcome::Failed(Execute)` --
/// consistent with the `detect_adapter` and `bind_gateway` failure paths in
/// [`Session::run_external_turn`] -- instead of poisoning the session mutex
/// with a panic. The var is read at run time (`env!`/`option_env!` are
/// compile-time, and cargo only sets `CARGO_BIN_EXE_toptopduck-acp-bridge`
/// while compiling same-package integration tests, which the lib build never
/// sees). Integration tests set it (serially, mirroring the 9a
/// `ACP_FAKE_SCENARIO` env lock) to `env!("CARGO_BIN_EXE_toptopduck-acp-bridge")`
/// before driving a turn. Production Tauri sidecar bundling is a packaging-time
/// decision (ADR-0085 Consequences: the bridge bin production path) -- the
/// `[[bin]]` does not enter the default Tauri bundle, so a shipped app cannot
/// yet resolve this path; a follow-up ADR wires the sidecar. Centralizing the
/// lookup here means the follow-up changes one site.
fn bridge_bin_path() -> Result<String, String> {
    std::env::var("TOPTOPDUCK_ACP_BRIDGE_BIN").map_err(|_| {
        "TOPTOPDUCK_ACP_BRIDGE_BIN not set; the bridge binary path is injected by the \
         orchestrator (integration tests today; the Tauri sidecar bundle is the \
         ADR-0085 packaging-time follow-up)"
            .to_string()
    })
}

/// The bridge's port env var name. Mirrors the bridge binary's own const; the
/// bin is a pure-std target that does not import lib, so the name is duplicated
/// here -- a rename in either place fails the integration tests loudly rather
/// than the bridge silently reading a stale name.
const ENV_PORT: &str = "TOPTOPDUCK_GATEWAY_PORT";
/// The bridge's token env var name (mirrors the bridge binary).
const ENV_TOKEN: &str = "TOPTOPDUCK_GATEWAY_TOKEN";
/// The MCP server name advertised in the bridge descriptor (the CLI sees this
/// as the MCP server's `name`; cosmetic, pinned for trace clarity).
const GATEWAY_SERVER_NAME: &str = "toptopduck-gateway";

/// A no-op [`ApprovalSink`] for the [`Session::ask`] facade (tests and other
/// callers outside the command boundary). Built-in tools classify Allow at the
/// gateway WITHOUT emitting (zero approval, ADR-0080), so the sink's methods
/// are unreachable on the built-in tool table -- the no-op keeps `ask`
/// self-contained until external tools (which would suspend on the gate) land.
struct NullApprovalSink;

impl ApprovalSink for NullApprovalSink {
    fn emit_request(&self, _body: &ApprovalRequestBody) {}
    fn emit_resolved(&self, _body: &ApprovalRequestBody, _response: ApprovalResponse) {}
}

impl Drop for Session {
    fn drop(&mut self) {
        // ADR-0035 Decision 3 / issue #50: release the single-writer registry key
        // the persister holds for its bound `.duck`. Delegated to the persister
        // (issue #415) so the key release is owned by the persistence concern.
        // Fired BEFORE the drop signal so the delete-path awaiter resolves
        // precisely when the single-writer gate will succeed.
        self.persister.release_key();
        // ADR-0063: signal the close-and-wait-release awaiter (delete path) that
        // the canonical key has been released. Single-waiter (oneshot via std
        // mpsc); a closed receiver (waiter gone or timed out) makes send return
        // Err, which is swallowed here. `take()` moves the sender out so the
        // field is `None` and the later struct field-drop is pure deallocation.
        if let Some(tx) = self.drop_signal.take() {
            let _ = tx.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Session, TOOL_OUTPUT_DIR_NAME};
    use crate::model::{TurnFailure, TurnOutcome};
    use crate::provider::fake::FakeProvider;
    use crate::provider::tool_calling::{ToolTurnReply, ToolUse};
    use serde_json::json;
    use tempfile::NamedTempFile;

    // merge_outcomes (issue #299 slice 9c) + the agent-loop / gateway types it
    // composes -- tested in isolation here so a regression in the dedup
    // contract surfaces without driving the full Session -> AcpEngine -> bridge
    // chain.
    use super::merge_outcomes;
    use crate::approval::OperationKind;
    use crate::runtime::gateway::server::GatewayOutcome;
    use crate::session::agent_loop::{LoopOutcome, Termination, TraceEntry};

    /// A materialize tool call promoting `sql` -- the tool-calling contract's
    /// equivalent of the retired single-shot `ProviderReply::Sql`.
    fn materialize_call(sql: &str) -> ToolTurnReply {
        ToolTurnReply::ToolCalls(vec![ToolUse {
            id: "tu_1".into(),
            name: "materialize".into(),
            input: json!({ "sql": sql }),
        }])
    }

    /// An explore tool call running `sql` -- a read-classified call, so a
    /// scripted explore-then-materialize turn exercises a MULTI-call trace.
    fn explore_call(sql: &str) -> ToolTurnReply {
        ToolTurnReply::ToolCalls(vec![ToolUse {
            id: "tu_e".into(),
            name: "explore".into(),
            input: json!({ "sql": sql }),
        }])
    }

    /// Find the first Materialized turn in a built recipe -- the shared
    /// lookup the trace / provenance tests assert through (mirrors the
    /// blackbox's helper of the same name).
    fn materialized_turn(
        recipe: &crate::persistence::recipe::Recipe,
    ) -> &crate::persistence::recipe::RecipeTurn {
        use crate::persistence::recipe::{RecipeEntry, RecipeOutcome};
        recipe
            .history
            .iter()
            .find_map(|e| match e {
                RecipeEntry::Turn(t) if matches!(t.outcome, RecipeOutcome::Materialized { .. }) => {
                    Some(t)
                }
                _ => None,
            })
            .expect("a Materialized turn in history")
    }

    /// Ingest a one-row people.csv under a fresh tempdir with the scripted
    /// `provider`; returns the session (source loaded, reference name
    /// `people`) + the TempDir guard the caller holds so the CSV outlives the
    /// ingest. Shared by the trace / provenance persistence tests.
    fn session_with_people(provider: FakeProvider) -> (Session, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let csv = dir.path().join("people.csv");
        std::fs::write(&csv, "name,score\nAda,9\n").expect("write csv");
        let mut session = Session::with_provider(Box::new(provider)).expect("session");
        match session.ingest(&csv) {
            crate::model::LoadOutcome::Loaded(d) => assert_eq!(d.reference_name, "people"),
            other => panic!("ingest should load people.csv, got {other:?}"),
        }
        (session, dir)
    }

    // --- merge_outcomes (issue #299 slice 9c, ADR-0085 trace merge) -------

    /// Build a trace entry with default fields (the merge tests vary only
    /// `name` + `success`; the rest are inert for the dedup contract).
    fn trace_entry(id: &str, name: &str, success: bool) -> TraceEntry {
        TraceEntry {
            tool_use_id: id.into(),
            name: name.into(),
            operation_kind: OperationKind::Read,
            summary: format!("{name} summary"),
            success,
            result_excerpt: format!("{name} excerpt"),
        }
    }

    /// A gateway outcome carrying `trace` + no promotions.
    fn gateway_outcome(trace: Vec<TraceEntry>) -> GatewayOutcome {
        GatewayOutcome {
            trace,
            promotions: Vec::new(),
        }
    }

    /// An ACP loop outcome carrying `trace` + a textual termination.
    fn acp_outcome(trace: Vec<TraceEntry>) -> LoopOutcome {
        LoopOutcome {
            termination: Termination::Text("acp reply".into()),
            promotions: Vec::new(),
            trace,
            round_trips: 1,
        }
    }

    /// A gateway-routed builtin (`explore`) appears in BOTH sources when the
    /// CLI forwards its own tool-call notification; the gateway record wins
    /// (it ran the SQL, so its `success` flag + excerpt are authoritative),
    /// and the ACP duplicate is dropped.
    #[test]
    fn merge_outcomes_gateway_builtin_wins_over_acp_duplicate() {
        let gateway = gateway_outcome(vec![trace_entry("g1", "explore", true)]);
        let acp = acp_outcome(vec![trace_entry("a1", "explore", false)]);
        let merged = merge_outcomes(gateway, acp);
        assert_eq!(merged.trace.len(), 1, "the ACP duplicate is dropped");
        assert_eq!(merged.trace[0].tool_use_id, "g1");
        assert!(merged.trace[0].success, "the gateway success flag wins");
    }

    /// The CLI's own non-builtin tool calls (bash / edit / etc., which never
    /// touch the gateway) ride the ACP pump and are appended to the merged
    /// trace when the gateway has nothing for them.
    #[test]
    fn merge_outcomes_acp_non_builtin_appended() {
        let gateway = gateway_outcome(Vec::new());
        let acp = acp_outcome(vec![trace_entry("a1", "bash", true)]);
        let merged = merge_outcomes(gateway, acp);
        assert_eq!(merged.trace.len(), 1);
        assert_eq!(merged.trace[0].name, "bash");
    }

    /// A mixed turn: the gateway routed an `explore` (builtin) AND the CLI
    /// ran its own `bash` (non-builtin). The merged trace carries both in
    /// gateway-first order.
    #[test]
    fn merge_outcomes_gateway_builtin_plus_acp_non_builtin() {
        let gateway = gateway_outcome(vec![trace_entry("g1", "explore", true)]);
        let acp = acp_outcome(vec![trace_entry("a1", "bash", true)]);
        let merged = merge_outcomes(gateway, acp);
        assert_eq!(merged.trace.len(), 2);
        assert_eq!(merged.trace[0].name, "explore");
        assert_eq!(merged.trace[1].name, "bash");
    }

    /// Termination + round_trips are ACP-only (the gateway serves tools, it
    /// does not produce a turn termination). The merge preserves the ACP
    /// values verbatim.
    #[test]
    fn merge_outcomes_termination_and_round_trips_from_acp() {
        let gateway = gateway_outcome(Vec::new());
        let acp = LoopOutcome {
            termination: Termination::Text("done".into()),
            promotions: Vec::new(),
            trace: Vec::new(),
            round_trips: 3,
        };
        let merged = merge_outcomes(gateway, acp);
        assert_eq!(merged.termination, Termination::Text("done".into()));
        assert_eq!(merged.round_trips, 3);
    }

    /// Promotions are gateway-only (the ACP engine leaves them empty by
    /// design, slice 9a). The merge takes the gateway's promotions verbatim;
    /// a non-empty fixture would require a `DatasetDescriptor`, and the
    /// single-source rule is a one-line Rust assignment (`acp.promotions =
    /// gateway.promotions`) whose semantics the type system guarantees.
    #[test]
    fn merge_outcomes_promotions_single_source_gateway() {
        let gateway = gateway_outcome(Vec::new());
        let acp = acp_outcome(Vec::new());
        let merged = merge_outcomes(gateway, acp);
        assert!(merged.promotions.is_empty());
    }

    /// Issue #432 AC#1: `tool_output/` is eagerly created at session
    /// construction so external MCP stdio servers have a writable target on
    /// first spawn. The directory's lifecycle follows the TempDir RAII.
    #[test]
    fn tool_output_dir_exists_after_session_construction() {
        let session = Session::new().expect("session");
        assert!(
            session.temp_path.join(TOOL_OUTPUT_DIR_NAME).is_dir(),
            "tool_output/ must exist after session construction"
        );
    }

    #[test]
    fn build_recipe_for_a_fresh_session_is_empty() {
        // ADR-0034: a brand-new session has no sources, no turns, no active
        // dataset. Its recipe is the minimal valid v1 shape -- the same one
        // an empty working set persists to on first save.
        let session = Session::new().expect("session");
        let recipe = session.build_recipe();
        assert_eq!(
            recipe.format_version(),
            crate::persistence::RECIPE_FORMAT_VERSION
        );
        assert!(recipe.sources.is_empty(), "no sources");
        assert!(recipe.history.is_empty(), "no turns/events");
        assert!(recipe.active.is_none(), "no active dataset");
        assert!(recipe.session_name.is_empty(), "no name bound");
    }

    #[test]
    fn bind_duck_writes_a_readable_recipe_at_the_path() {
        // ADR-0034: bind_duck immediately persists one recipe at the bound
        // path (temp + rename), so the .duck exists after the call even
        // before any turn. The file reads back as a v1 recipe carrying the
        // session name.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("session.duck");
        let mut session = Session::new().expect("session");
        session
            .bind_duck(path.clone(), "我的分析".into())
            .expect("bind");
        assert_eq!(session.duck_path(), Some(path.as_path()));
        assert_eq!(session.session_name(), Some("我的分析"));
        let recipe = crate::persistence::read_duck(&path).expect("read back");
        assert_eq!(
            recipe.format_version(),
            crate::persistence::RECIPE_FORMAT_VERSION
        );
        assert_eq!(recipe.session_name, "我的分析");
        // Empty working set round-trips: no sources, no history, no active.
        assert!(recipe.sources.is_empty());
        assert!(recipe.history.is_empty());
        assert!(recipe.active.is_none());
    }

    #[test]
    fn build_recipe_records_relative_path_for_in_subtree_sources() {
        // ADR-0036 Decision 4 hybrid paths: a source inside the .duck file's directory
        // subtree is recorded with BOTH a relative path (the primary resolver,
        // which survives "move the folder" portability) and the absolute path
        // (the fallback). The out-of-subtree case (relative_path = None) is
        // covered by the black-box suite, whose fixture lives outside the
        // .duck tempdir and resumes through the absolute fallback.
        let dir = tempfile::tempdir().expect("tempdir");
        let duck = dir.path().join("session.duck");
        let in_subtree = dir.path().join("data.csv");
        std::fs::write(&in_subtree, "name,score\nAda,9\n").expect("write csv");

        let mut session = Session::new().expect("session");
        session
            .bind_duck(duck.clone(), "混合路径".into())
            .expect("bind");
        let reference_name = match session.ingest(&in_subtree) {
            crate::model::LoadOutcome::Loaded(d) => d.reference_name,
            other => panic!("in-subtree source should load, got {other:?}"),
        };
        let recipe = session.build_recipe();
        let src = recipe
            .sources
            .iter()
            .find(|s| s.reference_name == reference_name)
            .expect("source recorded");
        assert_eq!(
            src.relative_path.as_deref(),
            Some("data.csv"),
            "in-subtree source carries a path relative to the .duck directory"
        );
        assert!(
            std::path::Path::new(&src.source_path).is_absolute(),
            "absolute path is always present as the fallback resolver"
        );
    }

    #[test]
    fn build_recipe_persists_the_loops_real_trace_and_builtin_provenance() {
        // ADR-0078 (issue #319): the live write path persists the agent loop's
        // REAL recorded trace -- not the migration's synthetic single call --
        // and records BuiltIn runtime provenance on every live turn. A fresh
        // ask that materializes a result carries one `materialize` trace entry
        // whose summary is the verbatim SQL and whose result excerpt stays
        // empty (a successful call's payload is data-bearing -- the .duck
        // carries none of it, ADR-0036; the synthetic form is empty too);
        // provenance records `RuntimeKind::BuiltIn` (skills stay empty
        // -- skill tracking is unwired, ADR-0079). Pins the live path so a
        // future edit that drops the trace wiring or the provenance snapshot
        // fails here, not only in the persistence blackbox.
        use crate::approval::OperationKind;
        use crate::persistence::recipe::RuntimeKind;

        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "多少人",
            vec![
                Ok(materialize_call(
                    "SELECT COUNT(*) AS n FROM \"people\".data",
                )),
                Ok(ToolTurnReply::Text("done".into())),
            ],
        );
        let (mut session, _dir) = session_with_people(provider);
        let _ = session.ask("多少人");

        let recipe = session.build_recipe();
        let turn = materialized_turn(&recipe);
        assert_eq!(turn.trace.len(), 1, "the loop's recorded single call");
        assert_eq!(turn.trace[0].name, "materialize");
        assert_eq!(turn.trace[0].operation_kind, OperationKind::Write);
        assert_eq!(
            turn.trace[0].summary, "SELECT COUNT(*) AS n FROM \"people\".data",
            "summary is the verbatim SQL",
        );
        assert!(turn.trace[0].success, "the call succeeded");
        assert!(
            turn.trace[0].result_excerpt.is_empty(),
            "a success payload is data-bearing (columns/sample/row_count) -- \
             the .duck carries no materialized data (ADR-0036), so the \
             persisted success excerpt stays empty"
        );
        assert_eq!(
            turn.provenance.runtime,
            Some(RuntimeKind::BuiltIn),
            "a live turn records the built-in runtime"
        );
        assert!(turn.provenance.skills.is_empty(), "skill tracking unwired");
    }

    #[test]
    fn build_recipe_persists_the_full_multi_call_trace_in_call_order() {
        // ADR-0078 (issue #319): a turn that explores THEN materializes
        // persists BOTH calls, in call order, each with its operation badge --
        // the real multi-call trajectory, never a collapsed synthetic single
        // call. This is the AC's central seam: the migration's
        // synthetic_materialize_trace would show one `materialize` entry; the
        // real trace shows the explore that preceded it.
        use crate::approval::OperationKind;
        use crate::persistence::recipe::RuntimeKind;

        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "多少人",
            vec![
                Ok(explore_call("SELECT name FROM \"people\".data")),
                Ok(materialize_call(
                    "SELECT COUNT(*) AS n FROM \"people\".data",
                )),
                Ok(ToolTurnReply::Text("done".into())),
            ],
        );
        let (mut session, _dir) = session_with_people(provider);
        let _ = session.ask("多少人");

        let recipe = session.build_recipe();
        let turn = materialized_turn(&recipe);
        assert_eq!(
            turn.trace.len(),
            2,
            "both calls persist -- not a synthetic single call"
        );
        assert_eq!(turn.trace[0].name, "explore", "call order preserved");
        assert_eq!(turn.trace[0].operation_kind, OperationKind::Read);
        assert_eq!(turn.trace[1].name, "materialize");
        assert_eq!(turn.trace[1].operation_kind, OperationKind::Write);
        assert!(turn.trace.iter().all(|e| e.success));
        assert!(
            turn.trace.iter().all(|e| e.result_excerpt.is_empty()),
            "success excerpts stay empty (ADR-0036 contents boundary)"
        );
        assert_eq!(turn.provenance.runtime, Some(RuntimeKind::BuiltIn));
    }

    #[test]
    fn build_recipe_persists_a_failed_calls_excerpt_and_omits_success_excerpts() {
        // ADR-0078 / ADR-0036 (issue #319): the persisted excerpt is the
        // FAILURE audit anchor -- a failed materialize (bad SQL) records its
        // error string so a reopened turn can show what went wrong, while the
        // successful retry's data-bearing payload stays OUT of the .duck.
        // Self-correction trajectory (ADR-0077): the error routes back to the
        // model, which retries with good SQL and converges.
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "多少人",
            vec![
                Ok(materialize_call("SELECT FROM WHERE")),
                Ok(materialize_call(
                    "SELECT COUNT(*) AS n FROM \"people\".data",
                )),
                Ok(ToolTurnReply::Text("done".into())),
            ],
        );
        let (mut session, _dir) = session_with_people(provider);
        let outcome = session.ask("多少人");
        assert!(
            matches!(outcome, TurnOutcome::Materialized { .. }),
            "the retry converges to a materialized turn"
        );

        let recipe = session.build_recipe();
        let turn = materialized_turn(&recipe);
        assert_eq!(turn.trace.len(), 2, "the failed attempt is recorded too");
        assert!(!turn.trace[0].success, "first attempt failed (bad SQL)");
        assert!(
            !turn.trace[0].result_excerpt.is_empty(),
            "the failure carries its error string for cross-turn retrospection"
        );
        assert!(turn.trace[1].success, "the retry succeeded");
        assert!(
            turn.trace[1].result_excerpt.is_empty(),
            "the success payload never enters the .duck (ADR-0036)"
        );
    }

    #[test]
    fn build_recipe_persists_a_textual_turns_recorded_trace() {
        // ADR-0078 (issue #319): the trace is the TURN's persisted
        // substructure -- a textual answer that follows an explore call
        // persists that call's trace entry too (the audit anchor for "how was
        // this answer produced"), not just Materialized turns. The record
        // seam retains the loop's trace for every outcome kind.
        use crate::persistence::recipe::{RecipeEntry, RecipeOutcome};

        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "看看数据",
            vec![
                Ok(explore_call("SELECT name FROM \"people\".data")),
                Ok(ToolTurnReply::Text("只有一行".into())),
            ],
        );
        let (mut session, _dir) = session_with_people(provider);
        let _ = session.ask("看看数据");

        let recipe = session.build_recipe();
        let turn = recipe
            .history
            .iter()
            .find_map(|e| match e {
                RecipeEntry::Turn(t) if matches!(t.outcome, RecipeOutcome::Textual { .. }) => {
                    Some(t)
                }
                _ => None,
            })
            .expect("a Textual turn in history");
        assert_eq!(turn.trace.len(), 1, "the explore call rode the turn");
        assert_eq!(turn.trace[0].name, "explore");
    }

    #[test]
    fn build_recipe_drops_a_turn_whose_every_promotion_was_gc_d() {
        // ADR-0041 GC exception (issue #326): when every promotion of a
        // Materialized turn is reclaimed by gc_stale_results (DROP TABLE +
        // descriptor removed), build_recipe drops the turn -- unlike a stale
        // turn (table still present, kept visible).
        //
        // Setup: two asks, cap=1. replace cascades result_1 stale; q2's
        // materialize trips the cap -> GC reclaims result_1 -> q1 dropped.
        use crate::persistence::recipe::{RecipeEntry, RecipeOutcome};

        let provider = FakeProvider::new()
            .scripted_tool_turn_seq(
                "q1",
                vec![
                    Ok(materialize_call(
                        "SELECT COUNT(*) AS n FROM \"people\".data",
                    )),
                    Ok(ToolTurnReply::Text("done".into())),
                ],
            )
            .scripted_tool_turn_seq(
                "q2",
                vec![
                    Ok(materialize_call(
                        "SELECT COUNT(*) AS n FROM \"people\".data",
                    )),
                    Ok(ToolTurnReply::Text("done".into())),
                ],
            );
        let (mut session, dir) = session_with_people(provider);
        session.set_result_count_cap(1);

        // q1 materializes result_1; count 1 = cap -> no GC yet.
        match session.ask("q1") {
            TurnOutcome::Materialized { promotions, .. } => {
                assert_eq!(
                    promotions
                        .last()
                        .expect("q1 promotes")
                        .dataset
                        .reference_name,
                    "result_1"
                );
            }
            other => panic!("expected q1 to materialize result_1, got {other:?}"),
        }
        // Replace people -> result_1 cascade-stale.
        let replacement = dir.path().join("people_v2.csv");
        std::fs::write(&replacement, "name,score\nBob,7\n").expect("write replacement csv");
        match session.replace_source("people", &replacement) {
            crate::model::LoadOutcome::Loaded(_) => {}
            other => panic!("expected replace to succeed, got {other:?}"),
        }
        // q2 materializes against the new snapshot -> count 2 > cap 1 -> GC
        // reclaims the oldest stale (result_1).
        match session.ask("q2") {
            TurnOutcome::Materialized { promotions, .. } => {
                let primary = promotions.last().expect("q2 carries promotions");
                assert_eq!(primary.dataset.reference_name, "result_2");
            }
            other => panic!("expected Materialized result_2, got {other:?}"),
        }
        assert!(
            session.get("result_1").is_none(),
            "result_1 GC'd from the working set"
        );

        let recipe = session.build_recipe();
        // q1 is gone: its sole promotion (result_1) was GC'd, so the turn
        // cannot replay or render and is dropped from the recipe.
        let q1_present = recipe
            .history
            .iter()
            .any(|e| matches!(e, RecipeEntry::Turn(t) if t.question == "q1"));
        assert!(!q1_present, "q1 dropped -- every promotion was GC'd");
        // q2 survives: its promotion (result_2) is still active.
        let q2 = recipe
            .history
            .iter()
            .find_map(|e| match e {
                RecipeEntry::Turn(t) if t.question == "q2" => Some(t),
                _ => None,
            })
            .expect("q2 retained -- result_2 is active");
        assert!(
            matches!(q2.outcome, RecipeOutcome::Materialized { .. }),
            "q2 is a Materialized turn"
        );
    }

    #[test]
    fn build_recipe_keeps_a_turn_when_only_some_of_its_promotions_were_gc_d() {
        // ADR-0084 full-chain invariant: a Materialized turn persists EVERY
        // promotion. When only some are GC'd, the surviving promotions keep
        // the turn in the recipe (distinct from the all-GC'd drop above).
        //
        // Setup: q1 has two promotions (result_1, result_2), cap=2. replace
        // cascades both stale. q2 materializes result_3 -> count 3 > cap 2
        // -> GC reclaims only the oldest stale (result_1). q1 stays with
        // result_2 (stale) surviving.
        use crate::persistence::recipe::{RecipeEntry, RecipeOutcome};

        let provider = FakeProvider::new()
            .scripted_tool_turn_seq(
                "q1",
                vec![
                    Ok(materialize_call(
                        "SELECT COUNT(*) AS n FROM \"people\".data",
                    )),
                    Ok(materialize_call(
                        "SELECT COUNT(*) AS n FROM \"people\".data",
                    )),
                    Ok(ToolTurnReply::Text("done".into())),
                ],
            )
            .scripted_tool_turn_seq(
                "q2",
                vec![
                    Ok(materialize_call(
                        "SELECT COUNT(*) AS n FROM \"people\".data",
                    )),
                    Ok(ToolTurnReply::Text("done".into())),
                ],
            );
        let (mut session, dir) = session_with_people(provider);
        session.set_result_count_cap(2);

        // q1: two materializes -> result_1, result_2; count 2 = cap -> no GC.
        match session.ask("q1") {
            TurnOutcome::Materialized { promotions, .. } => {
                assert_eq!(promotions.len(), 2, "q1 promotes two results");
            }
            other => panic!("expected q1 Materialized, got {other:?}"),
        }
        // Replace people -> result_1, result_2 cascade-stale.
        let replacement = dir.path().join("people_v2.csv");
        std::fs::write(&replacement, "name,score\nBob,7\n").expect("write replacement csv");
        match session.replace_source("people", &replacement) {
            crate::model::LoadOutcome::Loaded(_) => {}
            other => panic!("expected replace to succeed, got {other:?}"),
        }
        // q2 materializes result_3 -> count 3 > cap 2 -> GC reclaims oldest
        // stale (result_1 only -- over = 1).
        match session.ask("q2") {
            TurnOutcome::Materialized { promotions, .. } => {
                let primary = promotions.last().expect("q2 carries promotions");
                assert_eq!(primary.dataset.reference_name, "result_3");
            }
            other => panic!("expected Materialized result_3, got {other:?}"),
        }
        assert!(
            session.get("result_1").is_none(),
            "result_1 GC'd from the working set"
        );
        assert!(
            session.get("result_2").is_some(),
            "result_2 survived -- only the oldest stale was reclaimed"
        );

        let recipe = session.build_recipe();
        // q1 survives: result_2 (stale) is still registered, so the turn has
        // one surviving promotion and is retained.
        let q1 = recipe
            .history
            .iter()
            .find_map(|e| match e {
                RecipeEntry::Turn(t) if t.question == "q1" => Some(t),
                _ => None,
            })
            .expect("q1 retained -- result_2 survived GC");
        let surviving: Vec<&String> = match &q1.outcome {
            RecipeOutcome::Materialized { promotions, .. } => {
                promotions.iter().map(|p| &p.reference_name).collect()
            }
            other => panic!("expected q1 Materialized, got {other:?}"),
        };
        assert_eq!(
            surviving,
            vec![&"result_2".to_string()],
            "q1 keeps only result_2 (result_1 was GC'd)"
        );
        // q2 survives: result_3 is active.
        let q2_present = recipe
            .history
            .iter()
            .any(|e| matches!(e, RecipeEntry::Turn(t) if t.question == "q2"));
        assert!(q2_present, "q2 retained -- result_3 is active");
    }

    #[test]
    fn build_recipe_persists_an_empty_trace_for_a_no_tool_turn() {
        // ADR-0078 (issue #328): a turn whose agent loop made NO tool calls
        // (a pure textual answer) carries an empty trace in the recipe.
        // build_recipe_persists_a_textual_turns_recorded_trace follows an
        // explore call (trace.len() == 1); this test pins the zero-call case
        // -- the empty-trace half of the audit-routing contract. The built-in
        // loop still ran (it answered), so provenance records BuiltIn.
        use crate::persistence::recipe::{RecipeEntry, RecipeOutcome, RuntimeKind};

        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "你好",
            vec![Ok(ToolTurnReply::Text("你好！有什么可以帮你的？".into()))],
        );
        let (mut session, _dir) = session_with_people(provider);
        let _ = session.ask("你好");

        let recipe = session.build_recipe();
        let turn = recipe
            .history
            .iter()
            .find_map(|e| match e {
                RecipeEntry::Turn(t) if matches!(t.outcome, RecipeOutcome::Textual { .. }) => {
                    Some(t)
                }
                _ => None,
            })
            .expect("a Textual turn in history");
        assert!(
            turn.trace.is_empty(),
            "a no-tool turn carries an empty trace"
        );
        assert_eq!(
            turn.provenance.runtime,
            Some(RuntimeKind::BuiltIn),
            "the built-in loop ran even without tool calls"
        );
    }

    #[test]
    fn build_recipe_round_trips_a_resumed_turns_harvested_trace_and_provenance() {
        // ADR-0078 (issue #328): on resume, TurnAudit::from_recipe_turn
        // harvests a turn's trace + provenance from the persisted recipe.
        // build_recipe must route those values back through
        // RecipeTurn::with_audit verbatim -- a regression to RecipeTurn::without_audit
        // (empty trace + default provenance) would silently drop the harvested
        // audit data. This test pins the resume path by injecting a timeline
        // entry whose audit was harvested from a recipe turn carrying a
        // non-empty trace + non-default (External) provenance.
        use super::{TimelineEntry, TurnAudit};
        use crate::approval::OperationKind;
        use crate::model::{TextKind, TurnOutcome, TurnRecord};
        use crate::persistence::recipe::{
            RecipeEntry, RecipeOutcome, RecipeTraceEntry, RecipeTurn, RuntimeKind,
            TurnProvenance as PersistedTurnProvenance,
        };

        // A recipe turn carrying data that must survive the round-trip.
        let harvested_trace = vec![RecipeTraceEntry {
            name: "explore".into(),
            operation_kind: OperationKind::Read,
            summary: "SELECT 1 AS n".into(),
            success: true,
            result_excerpt: String::new(),
        }];
        let harvested_provenance = PersistedTurnProvenance {
            runtime: Some(RuntimeKind::External),
            skills: vec![],
        };

        // Harvest the audit from the recipe turn (the resume path).
        let source_turn = RecipeTurn::with_audit(
            "resumed question",
            RecipeOutcome::Textual {
                text_kind: TextKind::Agent,
                body: "resumed body".into(),
                assumption: None,
            },
            harvested_trace.clone(),
            harvested_provenance.clone(),
        );
        let audit = TurnAudit::from_recipe_turn(&source_turn);

        // The IPC-visible record. Its trace + provenance are deliberately
        // empty/default -- build_recipe reads those from the audit, not the
        // record. The real resume path (resume.rs) populates record.trace from
        // the recipe, but here the emptiness sharpens the assertion: a
        // regression that reads record.trace instead of audit.trace would
        // produce an empty trace and fail the assert_eq below. External (not
        // BuiltIn) is chosen so a live-path overwrite (which stamps BuiltIn)
        // is also caught.
        let record = TurnRecord {
            question: "resumed question".into(),
            outcome: TurnOutcome::Textual {
                text_kind: TextKind::Agent,
                body: "resumed body".into(),
                assumption: None,
            },
            trace: vec![],
            provenance: Default::default(),
        };

        // Inject the timeline entry -- simulates a resumed session whose
        // timeline was seeded from the recipe.
        let mut session = Session::new().expect("session");
        session.timeline.push(TimelineEntry::Turn { record, audit });

        let recipe = session.build_recipe();
        let turn = recipe
            .history
            .iter()
            .find_map(|e| match e {
                RecipeEntry::Turn(t) => Some(t),
                _ => None,
            })
            .expect("a turn in history");
        assert_eq!(
            turn.trace, harvested_trace,
            "the harvested trace round-trips verbatim through build_recipe"
        );
        assert_eq!(
            turn.provenance, harvested_provenance,
            "the harvested provenance round-trips verbatim (External runtime preserved)"
        );
    }

    // M1 regression: a turn whose shape derivation fails must roll back the
    // already-created result_N. Here the derivation's fingerprint dump cannot be
    // written -- temp_path points at a file, so its "child" dump path has a file
    // as parent and the COPY ... TO fails, but only AFTER CREATE TABLE result_1
    // has succeeded. Without the DROP rollback the orphan table lingers
    // unregistered; the next materialize attempt's next_result_number reuses N
    // and clashes on CREATE, wedging every later turn (ADR-0022 never-reused).
    // Under the agent contract (ADR-0077) the derive failure routes back to the
    // model as a tool error; this scripted model never self-corrects (the
    // single call clamps, re-issued every round-trip), so the turn exhausts
    // the step cap and fails honestly -- but EVERY failed attempt must still
    // roll back result_1.
    #[test]
    fn ask_drops_the_result_table_when_shape_derivation_fails() {
        let provider =
            FakeProvider::new().scripted_tool_turn("建表", materialize_call("SELECT 1 AS n"));
        let mut session = Session::with_provider(Box::new(provider)).expect("session");
        // Derivation work dir whose parent is a file -> the fingerprint
        // COPY ... TO '<path>/result_1.fingerprint.csv' fails after CREATE.
        let file = NamedTempFile::new().expect("temp file");
        session.temp_path = file.path().to_path_buf();

        // The non-self-correcting trajectory exhausts the step cap and surfaces
        // as a typed Execute failure carrying the cap (the per-attempt engine
        // errors rode back to the model as tool results, ADR-0077 -- they are
        // not the turn-level detail).
        let detail = match session.ask("建表") {
            TurnOutcome::Failed(TurnFailure::Execute { detail }) => detail,
            other => panic!("expected Execute failure after derive failure, got {other:?}"),
        };
        assert!(
            detail.contains("did not converge"),
            "step-cap exhaustion carries the honest non-convergence detail: {detail:?}"
        );

        // result_1 was rolled back on every attempt: it is no longer a table in
        // the session DB. (A broken rollback would leave it lingering -> the
        // retry's next CREATE clashes and the probe below is non-zero.)
        let remaining: i64 = session
            .conn
            .query_row(
                "SELECT count(*) FROM information_schema.tables WHERE table_name = 'result_1'",
                [],
                |r| r.get(0),
            )
            .expect("information_schema probe");
        assert_eq!(
            remaining, 0,
            "result_1 must be dropped after the derive failure (M1)"
        );
    }

    #[test]
    fn resource_caps_are_applied_to_the_session_connection() {
        // AC3 (issue #25): the engine-level resource caps are set on the session
        // connection at construction (ADR-0005 L3). Read back via duckdb_settings
        // (PRAGMA-as-query is unsupported in this DuckDB for these keys).
        let session = Session::new().expect("session");
        let threads: String = session
            .conn
            .query_row(
                "SELECT value FROM duckdb_settings() WHERE name='threads'",
                [],
                |r| r.get(0),
            )
            .expect("threads setting");
        assert_eq!(threads, crate::guardrail::MAX_THREADS.to_string());
        let mem: String = session
            .conn
            .query_row(
                "SELECT value FROM duckdb_settings() WHERE name='memory_limit'",
                [],
                |r| r.get(0),
            )
            .expect("memory_limit setting");
        assert!(
            mem.contains('2') || mem.contains("512"),
            "memory_limit={mem}"
        );
    }

    // --- Derived source migration (issue #439 AC2) ----------------------------

    #[test]
    fn bind_duck_migrates_derived_sources_to_assets_dir() {
        // Stage a derived CSV in temp_path/derived/ (the staging area used by
        // derived_source::process when no .duck is bound, ADR-0087 D4), register
        // it in the working set with the staging path, then bind_duck. The
        // migration should copy the file to <duck_stem>.assets/ and update the
        // descriptor's source_path so the recipe carries the portable location.
        let mut session = Session::new().expect("session");

        let staging_dir = session
            .temp_path
            .join(super::derived_source::DERIVED_STAGING_DIR);
        std::fs::create_dir_all(&staging_dir).unwrap();
        let staging_csv = staging_dir.join("data.csv");
        std::fs::write(&staging_csv, "id,name\n1,alice\n").unwrap();

        // Register as a non-result source pointing at the staging path.
        session
            .working_set
            .register(crate::model::DatasetDescriptor {
                reference_name: "data".to_string(),
                display_name: "data".to_string(),
                source_path: staging_csv.to_string_lossy().to_string(),
                columns: vec![crate::model::ColumnSchema {
                    name: "id".into(),
                    canonical_type: "BIGINT".into(),
                }],
                row_count: 1,
                sample: vec![vec!["1".into(), "alice".into()]],
                fingerprint: "abc".into(),
                rectify: crate::model::RectifyProvenance::NotApplicable,
                privacy: crate::model::DatasetPrivacy::default(),
                stale: None,
            });

        // Use a temp dir for the .duck so .assets/ goes alongside it.
        let duck_dir = tempfile::tempdir().expect("duck dir");
        let duck_path = duck_dir.path().join("session.duck");

        session
            .bind_duck(duck_path.clone(), "test session".into())
            .expect("bind_duck");

        // ADR-0089: derived sources migrate to the per-session directory's
        // `assets/` subdirectory (replacing the former `{duck_stem}.assets/`).
        let assets_csv = duck_dir.path().join("assets").join("data.csv");
        assert!(
            assets_csv.exists(),
            "derived file migrated to assets/: {assets_csv:?}"
        );

        // AC2b: descriptor source_path updated to the assets/ path.
        let d = session
            .working_set
            .get("data")
            .expect("data still registered");
        assert!(
            d.source_path.ends_with("assets\\data.csv")
                || d.source_path.ends_with("assets/data.csv"),
            "source_path updated to assets/: {}",
            d.source_path
        );
        assert!(
            !d.source_path.contains("derived"),
            "staging path replaced: {}",
            d.source_path
        );

        // AC2c: recipe carries the portable (relative) path. ADR-0089: the
        // assets directory is now per-session `assets/` (not `{stem}.assets/`).
        let recipe = crate::persistence::read_duck(&duck_path).expect("read recipe");
        let src = recipe
            .sources
            .iter()
            .find(|s| s.reference_name == "data")
            .expect("data in recipe sources");
        assert!(
            src.source_path.ends_with("assets\\data.csv")
                || src.source_path.ends_with("assets/data.csv"),
            "recipe source_path is assets/: {}",
            src.source_path
        );
        assert!(
            src.relative_path
                .as_ref()
                .is_some_and(|p| p == "assets/data.csv" || p == "assets\\data.csv"),
            "recipe relative_path is assets/: {:?}",
            src.relative_path
        );
    }

    // --- ADR-0089 Decision 4: first-turn auto-naming -----------------------

    #[test]
    fn truncate_session_name_returns_short_input_unchanged() {
        assert_eq!(
            super::truncate_session_name("how many people?"),
            "how many people?"
        );
        assert_eq!(super::truncate_session_name("a"), "a");
        assert_eq!(super::truncate_session_name(""), "");
    }

    #[test]
    fn truncate_session_name_trims_whitespace() {
        assert_eq!(super::truncate_session_name("  how many?  "), "how many?");
    }

    #[test]
    fn truncate_session_name_cuts_with_ellipsis_at_cap() {
        // Exactly at the cap: no truncation.
        let exact: String = "x".repeat(super::SESSION_NAME_MAX_CHARS);
        assert_eq!(super::truncate_session_name(&exact), exact);

        // One over: head + ellipsis, total = cap + 1 chars.
        let over: String = "x".repeat(super::SESSION_NAME_MAX_CHARS + 1);
        let name = super::truncate_session_name(&over);
        let chars: Vec<char> = name.chars().collect();
        assert_eq!(chars.len(), super::SESSION_NAME_MAX_CHARS + 1);
        assert!(name.ends_with('…'));
    }

    #[test]
    fn truncate_session_name_is_char_boundary_safe() {
        // Multi-byte CJK: each char is 3 bytes. Truncation must never split
        // a code point.
        let input: String = "中".repeat(super::SESSION_NAME_MAX_CHARS + 10);
        let name = super::truncate_session_name(&input);
        let chars: Vec<char> = name.chars().collect();
        assert!(chars.len() <= super::SESSION_NAME_MAX_CHARS + 1);
        assert!(name.ends_with('…'));
    }

    /// Bind a session to a temp .duck file so record_turn's persist path is
    /// Some. Returns (session, _duck_file) — the caller holds the guard.
    fn session_with_duck(name: &str) -> (Session, NamedTempFile) {
        let duck = NamedTempFile::new().expect("temp .duck");
        let mut session = Session::new().expect("session");
        session
            .bind_duck(duck.path().to_path_buf(), name.to_string())
            .expect("bind");
        (session, duck)
    }

    #[test]
    fn record_turn_auto_names_on_first_turn() {
        let (mut session, _duck) = session_with_duck("");
        assert_eq!(session.session_name(), Some(""));

        // Simulate a terminal turn reaching record_turn.
        session.record_turn(
            "how many people?",
            TurnOutcome::Textual {
                text_kind: crate::model::TextKind::Agent,
                body: "42".into(),
                assumption: None,
            },
            Vec::new(),
            Vec::new(),
        );

        assert_eq!(
            session.session_name(),
            Some("how many people?"),
            "first terminal turn auto-names the session"
        );
    }

    #[test]
    fn record_turn_does_not_overwrite_on_second_turn() {
        let (mut session, _duck) = session_with_duck("");
        session.record_turn(
            "first question",
            TurnOutcome::Textual {
                text_kind: crate::model::TextKind::Agent,
                body: "answer 1".into(),
                assumption: None,
            },
            Vec::new(),
            Vec::new(),
        );
        assert_eq!(session.session_name(), Some("first question"));

        session.record_turn(
            "second question",
            TurnOutcome::Textual {
                text_kind: crate::model::TextKind::Agent,
                body: "answer 2".into(),
                assumption: None,
            },
            Vec::new(),
            Vec::new(),
        );
        assert_eq!(
            session.session_name(),
            Some("first question"),
            "subsequent turns do not overwrite the auto-name"
        );
    }

    #[test]
    fn record_turn_auto_name_truncates_long_question() {
        let (mut session, _duck) = session_with_duck("");
        let long_question = "a very long question that exceeds the session name cap".to_string();
        session.record_turn(
            &long_question,
            TurnOutcome::Textual {
                text_kind: crate::model::TextKind::Agent,
                body: "answer".into(),
                assumption: None,
            },
            Vec::new(),
            Vec::new(),
        );
        let name = session.session_name().expect("name set");
        let chars: Vec<char> = name.chars().collect();
        assert!(
            chars.len() <= super::SESSION_NAME_MAX_CHARS + 1,
            "auto-name is bounded: {name}"
        );
        assert!(name.ends_with('…'), "truncated name ends with ellipsis");
    }

    #[test]
    fn record_turn_first_turn_overwrites_then_subsequent_turns_preserve_rename() {
        let (mut session, _duck) = session_with_duck("");
        // User renames before the first turn.
        session.rename("My Analysis").expect("rename");
        assert_eq!(session.session_name(), Some("My Analysis"));

        // First terminal turn: per ADR-0089 Decision 4, the auto-name fires
        // unconditionally on the first turn (the ADR explicitly rejects a
        // name_is_placeholder flag). The user rename before the first turn
        // is overwritten -- but this is the designed behavior: the first
        // question's truncation is more meaningful, and a user is unlikely
        // to rename before asking.
        session.record_turn(
            "what is the total?",
            TurnOutcome::Textual {
                text_kind: crate::model::TextKind::Agent,
                body: "100".into(),
                assumption: None,
            },
            Vec::new(),
            Vec::new(),
        );
        assert_eq!(
            session.session_name(),
            Some("what is the total?"),
            "first turn auto-names (ADR-0089: no placeholder flag)"
        );

        // A SECOND user rename after the first turn sticks -- subsequent turns
        // never fire auto-naming.
        session.rename("Final Name").expect("rename");
        session.record_turn(
            "another question",
            TurnOutcome::Textual {
                text_kind: crate::model::TextKind::Agent,
                body: "42".into(),
                assumption: None,
            },
            Vec::new(),
            Vec::new(),
        );
        assert_eq!(
            session.session_name(),
            Some("Final Name"),
            "user rename after first turn is never overwritten"
        );
    }

    #[test]
    fn record_turn_auto_names_after_source_events() {
        // ADR-0089: source/skill lifecycle events do not count as turns.
        // A session that loaded a source before its first question still
        // auto-names on that first question.
        let (mut session, _duck) = session_with_duck("");
        // Simulate a source lifecycle event in the timeline.
        session.timeline.push(super::TimelineEntry::Source(
            crate::model::SourceLifecycleEvent {
                kind: crate::model::SourceLifecycleKind::Added,
                reference_name: "people".into(),
                display_name: "people".into(),
            },
        ));
        // First turn: should still auto-name because no Turn entries exist.
        session.record_turn(
            "analyze people",
            TurnOutcome::Textual {
                text_kind: crate::model::TextKind::Agent,
                body: "done".into(),
                assumption: None,
            },
            Vec::new(),
            Vec::new(),
        );
        assert_eq!(
            session.session_name(),
            Some("analyze people"),
            "source lifecycle events do not block auto-naming"
        );
    }

    #[test]
    fn record_turn_auto_names_on_failed_and_cancelled_first_turn() {
        // ADR-0089 Decision 4: "first terminal turn" includes all terminal
        // outcomes -- Failed / Cancelled / Materialized, not just Textual.
        // The auto-name logic in record_turn is outcome-agnostic (no match on
        // outcome before set_session_name). This test pins that contract so a
        // future `match outcome` guard does not silently regress it.
        let (mut session_a, _duck) = session_with_duck("");
        session_a.record_turn(
            "why did it break?",
            TurnOutcome::Failed(crate::model::TurnFailure::Execute {
                detail: "cap exhausted".into(),
            }),
            Vec::new(),
            Vec::new(),
        );
        assert_eq!(
            session_a.session_name(),
            Some("why did it break?"),
            "Failed first turn still auto-names"
        );

        let (mut session_b, _duck) = session_with_duck("");
        session_b.record_turn(
            "never finished",
            TurnOutcome::Cancelled,
            Vec::new(),
            Vec::new(),
        );
        assert_eq!(
            session_b.session_name(),
            Some("never finished"),
            "Cancelled first turn still auto-names"
        );
    }
}
