//! Per-session state: an in-memory DuckDB parent (working-set metadata + future
//! result_N) plus READ_ONLY-attached source snapshots (ADR-0004/0005/0012).
//! Snapshots live in the per-session tree's `snapshots/` dir, resident until
//! session delete (ADR-0136); the temp dir is scratch space (swap files, sheet
//! CSVs) cleared on drop (ADR-0012), and only unbound test sessions keep their
//! snapshots there.

pub mod artifacts;
mod companion;
pub mod derived_source;
pub(crate) mod engine;
pub mod ingest;
pub mod inline_materialize;
pub mod loop_contract;
pub mod loop_runtime;
pub mod materializer;
pub mod outcome_merge;
pub(crate) mod progress;
pub mod recipe_persister;
pub mod resume;
mod rows_io;
pub mod sandbox;
pub mod skills;
pub mod snapshot;
pub mod source_lifecycle;
pub mod store;
pub(crate) mod turn_dispatch;
pub mod turn_entry;
pub mod turn_runner;
pub(crate) mod workspace;
pub(crate) mod workspace_tools;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tempfile::TempDir;

use engine::AdminEngine;

use crate::approval::{ApprovalRequestBody, ApprovalResponse, ApprovalSink, ApprovalState};
use crate::cancel::CancelToken;
use crate::ingest::schema::quote_ident;
use crate::model::{
    DatasetDescriptor, DatasetPrivacy, DeleteImpactEntry, ExportRowsError, RenameError, RowPage,
    RowReadError, SkillLifecycleEvent, SkillProvenance, SourceLifecycleEvent, ThreadEntry,
    TraceRound, TurnOutcome, TurnProvenance, TurnRecord, TurnRuntime,
};
use crate::persistence::recipe::{
    LastRuntime, Recipe, RecipeTraceRound, RecipeTurn, RuntimeKind,
    TurnProvenance as PersistedTurnProvenance,
};
use crate::persistence::SaveError;
use crate::provider::keychain::KeychainStore;
use crate::provider::{Provider, UnwiredProvider};
use crate::runtime::acp::adapter::AdapterSpec;
use crate::session::loop_contract::LoopRound;
use crate::session::materializer::{CachedDerivedRef, Materializer, RealMaterializer};
use crate::session::store::ClosingFlag;
use crate::turn_window;
use crate::workingset::WorkingSet;
use crate::SessionId;

// Re-export the resume global-state probe (ADR-0053 Decision 3) after its
// move into `session::resume`. Since ADR-0056 the LIVE command-layer resume
// gate is per-session (`SessionHandle::is_resuming`, read by
// `commands::reject_if_resuming`); this process-global `is_resuming` /
// `resuming_count` pair is retained ONLY as the integration-test RAII probe
// (persistence_blackbox.rs asserts it rises and clears around a resume). It
// is further re-exported from `lib.rs` so those tests can reach it.
pub use resume::{is_resuming, resuming_count};

// Re-export the turn's data inputs after their move into
// `session::turn_runner` (ADR-0053): the pub turn entry `ask_with_phase`
// takes it, so the parameter type rides the same public path -- the
// pub-module-plus-re-export dual path `resume` already rides, keeping
// `session::TurnInputs` stable for its existing consumers.
pub use turn_runner::TurnInputs;

// Re-export the turn entry's parameter pair (issue #1414) on the same
// pub-module-plus-re-export dual path `resume` and `turn_runner` above
// already ride, keeping `session::TurnDeps` / `session::TurnPorts`
// stable for the rig that consumes them.
pub use turn_entry::{TurnDeps, TurnPorts};

/// The subdirectory name under the session temp dir where external MCP tools
/// write their output files (ADR-0087 Decision 3), and where the CLI executor
/// spills an over-cap stdout (the tee semantics whose full byte range becomes
/// a derived-source candidate). Created eagerly at session construction;
/// lifecycle follows the TempDir RAII. The path is passed to each stdio MCP
/// server via `TOPTOPDUCK_TOOL_OUTPUT_DIR` (see `mcp::client`).
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
/// (the same as [`crate::session::store::SessionError`]). The `open_recipe`
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
    /// Reading or parsing the recipe.json failed (ADR-0036 version / parse / IO).
    Load(crate::persistence::io::LoadError),
    /// A source path was refused at the resume boundary for a non-recoverable
    /// reason -- today, a relative_path that escapes the `recipe.json`'s directory
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
    /// re-materialized by `Resumer::replay` is not registered. A
    /// replay SQL failure itself is NOT reported here -- it lands as a partial
    /// session with that turn rendered as `Failed` (ADR-0035 honest partial
    /// state). This variant signals a logic bug or a hand-edited recipe whose
    /// history references a result the chain never produced.
    Replay {
        reference_name: String,
        detail: String,
    },
    /// Mounting a tree snapshot onto admin failed on the watermark-hit restore
    /// path (ADR-0136 D3). The recipe.json itself read fine -- the failure is
    /// the read-only ATTACH of an in-tree snapshot -- so this is NOT
    /// [`Self::Load`] (whose frontend message blames the recipe file read).
    /// `probe` already validated every snapshot before `restore_hit` ran, so
    /// landing here means fresh corruption in the probe-to-attach window and
    /// the replay fallback would re-fail on the same disk state.
    Restore {
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
    /// ADR-0035 Decision 3 / issue #50: the canonical `recipe.json` path is already held
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
            Self::Restore {
                reference_name,
                detail,
            } => write!(f, "恢复树内快照「{reference_name}」失败：{detail}"),
            Self::ActiveMissing(name) => write!(f, "会话焦点指向未注册的源「{name}」"),
            Self::Cancelled => write!(f, "已取消恢复"),
            Self::Aborted => write!(f, "已中止恢复"),
            Self::AlreadyOpen(p) => {
                write!(
                    f,
                    "该 recipe.json 已在本进程打开，不能重复打开：{}",
                    p.display()
                )
            }
        }
    }
}
impl std::error::Error for ResumeError {}

/// Why a session rename was rejected (ADR-0060, issue #81). The single refusal
/// is a blank name; a persist write failure does NOT surface here -- it rides
/// [`Session::take_persist_error`] (best-effort persist, self-heals on the next
/// write). Crosses IPC as this serde struct, wrapped in
/// [`SessionError::RenameSession`](crate::session::store::SessionError) (issue
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
/// issue #49). Passed to the caller's [`Session::open_recipe`] `on_source_issue`
/// callback so the UI (or test) can drive the re-link / abort / rebuild
/// decision -- the engine NEVER silently picks. Each variant names the source
/// + the path/fingerprint context the decision needs.
///
/// C1 (issue #121): `SourceIssue` does NOT yet cross IPC as a typed value --
/// `open_recipe`'s `on_source_issue` callback always aborts today (no re-link
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

/// A non-blocking source status notice from the resume watermark HIT path
/// (ADR-0136 D3). On a hit the working set IS the ingest-time snapshot, so a
/// missing or drifted source file no longer blocks or re-links -- but the
/// user deserves to know the on-disk file no longer backs the loaded data.
/// Drained once by the frontend via the `take_source_notices` command.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum SourceNotice {
    /// The resolved source path no longer exists.
    Missing { reference_name: String },
    /// The file exists but its (mtime, size) differs from the settle-time
    /// stamp -- a heuristic drift signal, not a content check.
    Changed { reference_name: String },
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
/// is the runtime id the `open_recipe` command received (a typed UUID). The field
/// is required -- resume progress without a session it belongs to is not
/// addressable.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ResumeProgress {
    pub session_id: SessionId,
    pub event: ResumeEvent,
}

/// The session's external-runtime model + thought-level pair as ONE named
/// value: the pair crosses every boundary (the handle slot, the Session
/// mirror, the resume restore, the `set_session_posture` IPC argument) as
/// a unit, so a transposed `(model, thought_level)` cannot compile
/// silently -- two same-typed `Option<String>` parameters could. Same
/// shape as `app_config::ModelPosture` but deliberately session-local:
/// this module (and `session::store`) imports no app-config posture types,
/// so the persisted recipe facts and the machine-preference config stay
/// separate layers. The serde derives carry no app-config dependency -- the wire
/// keys are this type's own field names, and unknown keys are rejected so
/// a drifted mirror cannot silently read as `None` (issue #606).
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PosturePair {
    /// The model id exactly as the picker set it.
    pub model: Option<String>,
    /// The thought-level id exactly as the picker set it.
    pub thought_level: Option<String>,
}

/// The recipe-header facts the persister layers onto every built recipe
/// (ADR-0095, extended by ADR-0102 Decision 1): the model +
/// thought-level selections, the discovered-catalog cache, the last
/// effective segment header's runtime, and the session's workspace
/// binding (ADR-0137). Plain data; mirrors the handle-held
/// user choices at every persist point -- the turn-top mirror, and the set
/// commands' persist-now write, which stamps the runtime choice beside the
/// pair it persists. At turn end `record_turn` re-stamps `last_runtime`
/// from the turn's own attribution snapshot; the two agree by construction
/// (the turn runs on the runtime the mirror carried).
#[derive(Debug, Clone, Default)]
pub struct SessionRuntimeFacts {
    pub model: Option<String>,
    pub thought_level: Option<String>,
    pub cached_discovered: Option<crate::session::loop_contract::DiscoveredRuntime>,
    pub last_runtime: Option<LastRuntime>,
    /// The session's workspace binding (ADR-0137, issue #1381): the canonical
    /// directory agent-authored processes work in, fixed at creation
    /// (user-selected) or at the first disk-need moment (lazily minted) and
    /// immutable afterwards. Not a runtime fact semantically -- it rides this
    /// struct because the struct is the recipe-header facts carrier, so the
    /// binding persists + resumes through the same single storage as the
    /// posture facts (no second copy to drift).
    pub workspace: Option<std::path::PathBuf>,
}

pub struct Session {
    /// The session-level admin engine (ADR-0104): an on-demand unit -- open +
    /// resource caps in one step at first need, held until close. The single
    /// acquisition point every engine consumer resolves through.
    admin_engine: AdminEngine,
    working_set: WorkingSet,
    _temp_dir: TempDir, // held to keep its dir alive; cleared on drop (ADR-0012)
    temp_path: PathBuf,
    /// The lazy-mint source for the default workspace (ADR-0137, issue
    /// #1381): the fixed product-domain workspaces root (the DEFAULT
    /// sessions root's sibling), seated by the command layer at
    /// creation / resume. The binding itself lives in
    /// [`SessionRuntimeFacts::workspace`] -- the recipe-header facts carrier.
    /// `None` (test constructors) disables minting; disk-need consumers then
    /// keep the temp-dir cwd.
    workspaces_root: Option<PathBuf>,
    /// The workspace registry (ADR-0138, issue #1384): the organizational
    /// ledger the bind + mint mount points record into and the close-time
    /// reclaim deletes from. Seated by the command layer at creation /
    /// resume, beside [`Self::workspaces_root`]; `None` (test constructors)
    /// disconnects the ledger -- the session runs on, unrecorded.
    workspace_registry: Option<std::sync::Arc<crate::workspace::WorkspaceRegistry>>,
    /// The LLM provider (ADR-0007/0064), held behind `Arc<dyn>` (dyn, not
    /// generic) so this struct does not parameterize `commands.rs` / `lib.rs`.
    /// [`Self::ask_with_phase`] reads the live response locale off it for the
    /// system prompt and hands the Arc to the wiring seam each turn (ADR-0107,
    /// issue #669): a profile-backed provider constructs the upstream
    /// streamer inside the loop runtime, anything else bridges onto the
    /// loop -- either way the provider crosses into the loop's driver thread,
    /// which is why the handle is `Arc` (a `Box` cannot be shared across the
    /// `std::thread::scope` boundary). Built (converted from the `Box` the
    /// constructors keep taking, so no call site changes) in
    /// [`Self::with_provider_and_cancel`].
    provider: Arc<dyn Provider>,
    /// The shared materializer (ADR-0053): the SAME trait object the live-turn
    /// agent loop drives (`materialize` tool calls) and the resume path borrows
    /// (recipe replay) -- one promotion mechanism across both paths, so a fake
    /// materializer injected for a `Resumer` unit test exercises the replay
    /// branch without DuckDB / a filesystem. Stateless (`RealMaterializer`);
    /// the admin connection / source_files / working_set it borrows live on
    /// this Session and are passed per turn via [`materializer::DispatchDeps`]. Held on the
    /// Session itself (not inside the loop, which is built per turn) so the
    /// resume borrow and the live-turn borrow share one object.
    materializer: Box<dyn Materializer>,
    /// The store-minted session identity (#886): stamped by
    /// [`SessionStore::create`] right after the id is minted (the same
    /// post-construction wiring as the closing flag and the drop signal),
    /// and re-stamped by the resume path (`commands::open_recipe`) so a
    /// reopened session keeps its id -- the projection's no-progress kill
    /// log attributes the silenced turn to its session. `None` on
    /// store-less Sessions (tests, non-command paths); the warn omits the
    /// attribution then.
    session_id: Option<SessionId>,
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
    /// allowed to balloon memory. Seeded from the session-level engine-defaults
    /// snapshot at construction (issue #741; default
    /// [`crate::guardrail::DEFAULT_MAX_RESULT_ROWS`]); tunable via
    /// [`Self::set_result_row_cap`] (e.g. tests lower it for a fast,
    /// deterministic cap-hit).
    result_row_cap: u64,
    /// Ceiling on the number of registered `result_N` (ADR-0013 M=100). When a
    /// freshly materialized result pushes the count over the cap, the oldest
    /// stale results are auto-reclaimed; active results are never auto-deleted.
    /// Defaults to `Tunables`' (so a bare construction matches the unconfigured
    /// config default); the create/resume command layer overrides it from the
    /// current app-config at the construction point (#1446 -- the same
    /// session-level snapshot semantics as the engine defaults, so changes
    /// reach later sessions only). Tests lower it via
    /// [`Self::set_result_count_cap`] for a fast, deterministic GC trigger --
    /// the count-cap twin of [`Self::result_row_cap`].
    result_count_cap: usize,
    /// Recent-turn window size N (ADR-0023): how many trailing turns the
    /// window assembler ships full before folding older turns to summaries.
    /// Defaults to `Tunables`' (so a bare construction matches the
    /// unconfigured config default); the create/resume command layer
    /// overrides it from the current app-config at the construction point
    /// (#1445 -- the same session-level snapshot semantics as the engine
    /// defaults, so changes reach later sessions only). Written once by the
    /// create/resume command layer and never mutated afterward; the turn
    /// runner threads it into every `turn_window` assembly entry.
    window_turns: usize,
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
    /// The parsed sheets of a workbook parked on the guided-load dialog (issue
    /// #750): auto-tidy parsed the workbook fully for the `NeedsGuidance`
    /// outcome, and holding the parse until the dialog resolves makes
    /// preview-window paging zero-reparse. Set on `NeedsGuidance`, dropped on
    /// guided commit and on the dialog-cancel discard command (see
    /// [`ingest::GuidanceRetention`]).
    guidance_retained: Option<ingest::GuidanceRetention>,
    /// Cancellation + single-in-flight signal for the query loop (ADR-0021,
    /// issue #28). `Arc`-shared with the cancel command (and the timeout
    /// watchdog) so a cancel fires WITHOUT the session lock -- `ask` holds it
    /// for the whole turn. Clone it out via [`Self::cancel_token`] before the
    /// lock is taken (e.g. the command layer registers it as managed state).
    cancel: Arc<CancelToken>,
    /// ADR-0055 close-tab lifecycle: the shared closing flag, set by
    /// `close_session` (via the [`SessionStore`](crate::session::store::SessionStore)
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
    /// The persistence concern (issue #415): `recipe.json` binding, projection,
    /// write loop, conflict detection, and the single-writer registry key.
    /// Extracted from the former inline fields so the projection + write
    /// state machine are testable without a DuckDB connection.
    persister: recipe_persister::RecipePersister,
    /// ADR-0063: the sender half of the close-and-wait-release drop signal. The
    /// matching receiver lives on the [`SessionHandle`](crate::session::store::SessionHandle);
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
    /// drives the built-in loop runtime; `Some(spec)` drives the external ACP
    /// engine for one CLI on the next turn. Issue #353 wired this to the
    /// composer runtime picker: the command layer mirrors the session's
    /// handle-held runtime choice into this field at each turn top (see the
    /// `ask` command), so the dispatch below reads exactly the runtime the
    /// user picked, and a switch lands at the turn boundary. Integration
    /// tests still toggle it directly via [`Self::set_external_runtime`].
    external_runtime: Option<AdapterSpec>,
    /// The last external turn's discovered model / thought-level catalog
    /// (ADR-0095). See [`Self::last_discovered_runtime`].
    last_discovered_runtime: Option<crate::session::loop_contract::DiscoveredRuntime>,
    /// The single source of truth for the session-level model / thought-level
    /// selections + the discovery cache (ADR-0095). Mirrored from the handle
    /// at each turn top (the same pattern as [`Self::external_runtime`]) and
    /// consumed by BOTH [`Self::run_external_turn`] (the turn input's model /
    /// thought_level ride `.model` / `.thought_level`) and the persister
    /// (the recipe header) -- one storage, so the turn's input and the
    /// persisted recipe can never diverge (issue #530). `None` selections
    /// leave the CLI's own defaults; no-op on the built-in runtime (its model
    /// comes from the provider profile; BYOK thought levels are a separate
    /// future ADR). The `set_session_posture` command also writes it so the
    /// next auto-write persists a selection made WITHOUT a following turn
    /// (the resume promise, ADR-0095 D6).
    runtime_facts: SessionRuntimeFacts,
    /// The session's discovery snapshot (ADR-0119 Decision 3, issue #983):
    /// the enabled set at session creation, immutable within the session.
    /// Materialized once at creation (from the same seed computation the
    /// mount fold seeds from) and restored from the recipe header on resume;
    /// the metadata index lists it wholesale every turn. The legacy mount /
    /// activation folds stay live during the channel coexistence period --
    /// this field is the new assembly source, not a mirror of either.
    discovery_snapshot: Vec<String>,
    /// Non-blocking source status notices collected on the resume watermark
    /// hit path (ADR-0136 D3): a source file that is missing or drifted does
    /// not block the hit, but the fact surfaces to the UI once via the
    /// `take_source_notices` command. Empty on every non-hit resume.
    source_notices: Vec<SourceNotice>,
    /// The session-INVOKED skill names (ADR-0119 Decision 4, issue #983): a
    /// live memoization of the timeline's turn-invocation fold
    /// ([`crate::persistence::recipe::Recipe::invoked_skills`]) -- monotonic
    /// by construction, nothing can un-invoke a past turn. Grown by
    /// `record_turn` (both actors' invocations land there) and re-folded at
    /// resume. The `read_skill_file` gate's eligibility base (its
    /// turn-start snapshot) reads through it.
    invoked_skills: Vec<String>,
}

/// One entry in the session's unified timeline (issue #325). Replaces the
/// former pair of index-aligned `Vec<ThreadEntry>` + `Vec<TurnAudit>` so
/// alignment is structural (compile-time): a turn entry CANNOT exist without
/// its audit, and a non-turn entry (Source/Skill lifecycle) CANNOT carry
/// audit data. The `TurnAudit::default()` sentinel is eliminated.
// A deliberately un-boxed variant: the Turn arm (record + round-grouped
// audit) is large, but the timeline holds one entry per turn and each
// projection clones it once per turn / active read (see `turns`'s clone
// note) -- negligible next to the LLM call it feeds. Boxing would churn
// every match site for no measurable win (same stance as the
// `too_many_arguments` allows below).
#[allow(clippy::large_enum_variant)]
#[derive(Debug)]
pub(super) enum TimelineEntry {
    /// A conversation turn: the IPC-visible [`TurnRecord`] paired with the
    /// turn's persisted audit (trace + provenance, ADR-0078), plus -- for a
    /// turn the resume DEGRADED to Failed -- the original Materialized
    /// recipe entry (replay preservation: the timeline renders the honest
    /// Failed, the next persist writes the recorded entry back verbatim).
    /// `None` on every live-recorded turn and every non-degraded resume
    /// entry; never crosses the IPC boundary.
    Turn {
        record: TurnRecord,
        audit: TurnAudit,
        preserved: Option<Box<crate::persistence::recipe::RecipeTurn>>,
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
    /// The turn's persisted round-grouped execution trace (ADR-0078, grouped
    /// per ADR-0103); empty for no-tool turns.
    trace: Vec<RecipeTraceRound>,
    /// The turn's token usage (ADR-0129, issue #1270): the audit-face twin
    /// of [`TurnRecord::usage`] -- the same settle-frozen value on both
    /// halves of the timeline entry, persisted with the trace (Decision 4:
    /// turn level, the recipe.json audit anchor).
    usage: Option<crate::model::TurnUsage>,
    /// The turn's context-occupancy reading (ADR-0130): the audit-face twin
    /// of [`TurnRecord::occupancy`] -- the same settle-frozen reading on
    /// both halves of the timeline entry, persisted with the trace and
    /// round-tripping on resume. A separate channel from `usage` (ADR-0130
    /// Decision 3): a reference figure, never billing evidence.
    occupancy: Option<crate::model::OccupancySnapshot>,
    /// The turn's runtime + skill provenance (ADR-0078/0081/0101). The
    /// PERSISTED shape (recipe::TurnProvenance, aliased here): the runtime
    /// kind + the external adapter id + the mounted skills, for the recipe.json
    /// audit anchor. The IPC TurnRecord mirrors the same attribution through
    /// [`crate::model::TurnRuntime`] (ADR-0101).
    provenance: PersistedTurnProvenance,
}

impl TurnAudit {
    /// The audit for one just-recorded turn (ADR-0078/0081, issue #319;
    /// ADR-0086, issue #364; ADR-0101): the loop's real multi-call trace
    /// mapped to its persisted form + the turn's runtime attribution +
    /// the turn's skill provenance (each invoked `name` + its
    /// `content_hash` pinned at the name's last invocation of the turn,
    /// ADR-0119). `skills` is empty when no
    /// skill was invoked (the field is default-omitted from the recipe.json
    /// while empty); the projection onto the persisted pair (kind + the
    /// external adapter id) happens inside, so callers pass the one wire
    /// attribution.
    fn from_execution(
        rounds: Vec<LoopRound>,
        usage: Option<crate::model::TurnUsage>,
        occupancy: Option<crate::model::OccupancySnapshot>,
        skills: Vec<SkillProvenance>,
        runtime: TurnRuntime,
    ) -> Self {
        let (runtime_kind, adapter_id, adapter_display_name) = match &runtime {
            TurnRuntime::BuiltIn => (RuntimeKind::BuiltIn, None, None),
            TurnRuntime::External {
                adapter_id,
                display_name,
            } => (
                RuntimeKind::External,
                adapter_id.clone(),
                display_name.clone(),
            ),
        };
        Self {
            trace: rounds
                .into_iter()
                .map(RecipeTraceRound::from_live_round)
                .collect(),
            usage,
            occupancy,
            provenance: PersistedTurnProvenance {
                runtime: Some(runtime_kind),
                adapter_id,
                adapter_display_name,
                skills,
            },
        }
    }

    /// The audit harvested from one persisted recipe turn (resume, ADR-0078):
    /// a turn's trace + provenance round-trip verbatim from the recipe.json. Called
    /// only for `RecipeEntry::Turn` -- source and skill lifecycle entries are
    /// not turns and never produce a [`TurnAudit`].
    fn from_recipe_turn(turn: &RecipeTurn) -> Self {
        Self {
            trace: turn.trace.clone(),
            usage: turn.usage.clone(),
            occupancy: turn.occupancy,
            provenance: turn.provenance.clone(),
        }
    }

    /// Read-only access to the persisted trace (for RecipePersister's
    /// projection, issue #415).
    pub(super) fn trace(&self) -> &[RecipeTraceRound] {
        &self.trace
    }

    /// Read-only access to the persisted provenance (for RecipePersister's
    /// projection, issue #415).
    pub(super) fn provenance(&self) -> &PersistedTurnProvenance {
        &self.provenance
    }

    /// Read-only access to the turn's token usage (ADR-0129, issue #1270;
    /// for RecipePersister's projection).
    pub(super) fn usage(&self) -> Option<&crate::model::TurnUsage> {
        self.usage.as_ref()
    }

    /// Read-only access to the turn's occupancy reading (ADR-0130; for
    /// RecipePersister's projection).
    pub(super) fn occupancy(&self) -> Option<crate::model::OccupancySnapshot> {
        self.occupancy
    }

    /// Test-only constructor with explicit trace + provenance (issue #415).
    #[cfg(test)]
    pub(super) fn test_new(
        trace: Vec<RecipeTraceRound>,
        provenance: PersistedTurnProvenance,
    ) -> Self {
        Self {
            trace,
            usage: None,
            occupancy: None,
            provenance,
        }
    }
}

impl Session {
    pub fn new() -> anyhow::Result<Self> {
        Self::with_provider_and_cancel(
            Box::new(UnwiredProvider),
            Arc::new(CancelToken::new()),
            crate::app_config::model::EngineDefaults::default(),
        )
    }

    /// Tune the materialized-result row ceiling (ADR-0005 L3, "可调"). A query
    /// whose result would exceed `cap` rows aborts with a resource error. The
    /// session seeds this from the engine-defaults snapshot at construction
    /// (issue #741 -- the persisted `row_cap`, default
    /// [`DEFAULT_MAX_RESULT_ROWS`]); tests lower it after construction for a
    /// fast, deterministic cap-hit.
    pub fn set_result_row_cap(&mut self, cap: u64) {
        self.result_row_cap = cap;
    }

    /// Tune the result-count ceiling (ADR-0013 M=100, "可调"). When the
    /// registered `result_N` count exceeds `cap`, the oldest stale results are
    /// auto-reclaimed on the next materialization; active results are never
    /// auto-deleted. The command layer applies the configured
    /// `tunables.result_count_cap` through this setter at the session's
    /// construction point (#1446); tests lower it for a fast, deterministic
    /// GC trigger (mirroring [`Self::set_result_row_cap`]).
    pub fn set_result_count_cap(&mut self, cap: usize) {
        self.result_count_cap = cap;
    }

    /// Tune the recent-turn window size (ADR-0023 N=20, "可调"). The command
    /// layer applies the configured `tunables.window_turns` through this
    /// setter at the session's construction point (#1445); the turn runner
    /// reads the field when assembling each turn's provider payload.
    pub fn set_window_turns(&mut self, turns: usize) {
        self.window_turns = turns;
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

    /// Mirror the handle-held session-level model + thought-level pair
    /// into the Session at turn top (ADR-0095, the `set_external_runtime`
    /// pattern): the command layer calls this right after the runtime choice
    /// mirror, so both take effect at the same turn boundary. Writes
    /// `runtime_facts` only -- the single storage both the turn input
    /// and the persister read (issue #530). `pub` so the IPC test seam can
    /// toggle without the command layer.
    pub fn set_external_model_config(&mut self, posture: PosturePair) {
        self.runtime_facts.model = posture.model;
        self.runtime_facts.thought_level = posture.thought_level;
    }

    /// Stamp the handle-held runtime choice into the recipe-header facts as
    /// the last effective segment header (ADR-0102 Decision 1): the set
    /// commands call
    /// this beside their persist-now pair write, so a persisted posture pair
    /// always travels under its own runtime -- a switch followed by a
    /// selection and a close without a turn resumes on the runtime the pair
    /// belongs to (ADR-0102 Decision 1's same-source construction claim,
    /// closed at the persist-now point). `record_turn` re-stamps at turn end
    /// from the turn's own attribution; the values agree because the turn
    /// runs on the runtime the turn-top mirror carried. Unconditional:
    /// `None` is the built-in runtime and stamps `BuiltIn` (a built-in
    /// session's posture is a no-op, so the header names the runtime the
    /// next resume continues). `pub` for the same test-seam reason as
    /// [`Self::set_external_model_config`].
    pub fn stamp_last_runtime(&mut self, runtime: Option<AdapterSpec>) {
        self.runtime_facts.last_runtime = match runtime {
            None => Some(LastRuntime::BuiltIn),
            Some(spec) => Some(LastRuntime::External(spec.id.as_str().to_owned())),
        };
    }

    /// Read the recipe-header ADR-0095 facts (the persister layers them onto
    /// every built recipe). Exposed so the `set_session_posture` command can
    /// persist a selection made without a following turn.
    pub fn runtime_facts(&self) -> &SessionRuntimeFacts {
        &self.runtime_facts
    }

    /// The last turn's discovered runtime catalog (ADR-0095): snapshotted
    /// from the ACP engine's `LoopOutcome.discovered_runtime` at
    /// [`Self::run_external_turn`] so the command layer can mirror it onto
    /// the SessionHandle (lock-light reads) without re-running a turn.
    /// `None` until the first ACP turn (and after a resume -- the recipe's
    /// cached copy is restored onto the handle by open_recipe). A
    /// pre-handshake ACP failure yields no discovery and RETAINS the
    /// previous turn's catalog (issue #530); the `ask` mirror -- today's
    /// only reader -- re-writes the same value, so the retention is
    /// idempotent.
    pub fn last_discovered_runtime(
        &self,
    ) -> Option<crate::session::loop_contract::DiscoveredRuntime> {
        self.last_discovered_runtime.clone()
    }

    /// Record the turn's discovered runtime catalog (see
    /// [`Self::last_discovered_runtime`]). Called by
    /// [`Self::snapshot_discovered_runtime`], which both `run_external_turn`
    /// exit faces route through; takes a bare value -- a post-handshake ACP
    /// exit always carries a catalog (an empty one is a real state: the CLI
    /// offered no models), so there is no "no discovery" arm here;
    /// pre-handshake failures yield `None` and the caller skips the call
    /// (issue #530).
    pub fn set_last_discovered_runtime(
        &mut self,
        discovered: crate::session::loop_contract::DiscoveredRuntime,
    ) {
        self.runtime_facts.cached_discovered = Some(discovered.clone());
        self.last_discovered_runtime = Some(discovered);
    }

    /// Build a session with an explicit provider (tests inject a scripted fake;
    /// the real LLM client wires in #29). The default [`Self::new`] uses
    /// [`UnwiredProvider`] -- every turn is refused until a provider is set.
    pub fn with_provider(provider: Box<dyn Provider>) -> anyhow::Result<Self> {
        Self::with_provider_and_cancel(
            provider,
            Arc::new(CancelToken::new()),
            crate::app_config::model::EngineDefaults::default(),
        )
    }

    /// Build a session with an explicit provider AND a shared cancel token
    /// (ADR-0021, issue #28), seeded from the session-level engine-defaults
    /// snapshot (issue #741): the caller reads the CURRENT app-config at the
    /// construction point, so the snapshot semantics fall out -- settings
    /// changes after construction only reach later sessions, and a resumed
    /// session takes the current config exactly like a new one (the recipe
    /// carries no engine fields). `row_cap` seeds from the snapshot; the caps
    /// ride the admin engine's copy of it. The token is `Arc`-cloned to the
    /// cancel command and the timeout watchdog so a cancel fires without the
    /// session lock; `with_provider` / `new` allocate a private token for
    /// callers that don't need cross-thread cancel. Tests that drive
    /// cancel/timeout inject a token they also hold, so they can observe
    /// `is_in_flight` / fire `request`.
    pub fn with_provider_and_cancel(
        provider: Box<dyn Provider>,
        cancel: Arc<CancelToken>,
        engine_defaults: crate::app_config::model::EngineDefaults,
    ) -> anyhow::Result<Self> {
        // Box -> Arc: the signature keeps taking the Box every call site
        // builds; the conversion happens once here (issue #669) because the
        // turn's runner hands the provider across the loop's thread scope.
        let provider: Arc<dyn Provider> = provider.into();
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
        // The admin engine is an on-demand unit (ADR-0104 Decision 1): the
        // session is constructed with no DuckDB instance; the first SQL need
        // resolves through the unit's acquisition point, and the connection
        // is then held until session close (no idle reclaim). It carries the
        // session-level engine-defaults snapshot (issue #741) and applies it
        // at first materialization; the per-turn sandboxes read the same
        // snapshot through it.
        let admin_engine = AdminEngine::new(engine_defaults.clone());
        // The provider (Arc, see the field doc) + materializer (`Box<dyn>`)
        // live on the Session (dyn, not generic) so this struct does not
        // parameterize the IPC layer (ADR-0053). The turn's runner borrows
        // both per turn; the resume path borrows the same materializer for
        // the recipe replay. The materializer is stateless (RealMaterializer);
        // the admin connection / source_files / working_set it borrows live
        // on this Session and are passed per turn via DispatchDeps.
        Ok(Self {
            admin_engine,
            working_set: WorkingSet::default(),
            _temp_dir: temp_dir,
            temp_path,
            workspaces_root: None,
            workspace_registry: None,
            provider,
            materializer: Box::new(RealMaterializer),
            session_id: None,
            timeline: Vec::new(),
            result_row_cap: engine_defaults.row_cap,
            result_count_cap: crate::app_config::model::Tunables::default().result_count_cap
                as usize,
            window_turns: crate::app_config::model::Tunables::default().window_turns as usize,
            source_files: HashMap::new(),
            tool_output_refs: HashMap::new(),
            guidance_retained: None,
            cancel,
            closing: ClosingFlag::new(),
            persister: recipe_persister::RecipePersister::new(),
            drop_signal: None,
            external_runtime: None,
            last_discovered_runtime: None,
            runtime_facts: SessionRuntimeFacts::default(),
            discovery_snapshot: Vec::new(),
            invoked_skills: Vec::new(),
            source_notices: Vec::new(),
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
    /// the receiver on the handle. On resume (`open_recipe`), a FRESH pair is
    /// installed on both ends so the resumed session's Drop reaches the handle's
    /// current receiver (the old pair is orphaned -- the pre-replace session's
    /// Drop fires the old sender into a closed receiver, a harmless no-op).
    pub fn set_drop_signal(&mut self, tx: std::sync::mpsc::Sender<()>) {
        self.drop_signal = Some(tx);
    }

    /// Stamp the session identity (#886). Two production stampers:
    /// [`SessionStore::create`] (fresh sessions, before the handle becomes
    /// reachable) and the resume path in `commands::open_recipe` (a reopened
    /// session keeps the SAME id). A store-less Session keeps `None` and
    /// its no-progress kill log simply omits the session attribution.
    pub fn set_session_id(&mut self, id: SessionId) {
        self.session_id = Some(id);
    }

    /// The stamped identity, for tests pinning the store / resume wiring
    /// (#886): `None` until one of the two production stampers runs.
    /// Test-only -- production reads the attribution through the kill log.
    #[cfg(test)]
    pub(crate) fn session_id(&self) -> Option<&SessionId> {
        self.session_id.as_ref()
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

    /// Bind this session to a `recipe.json` path (ADR-0034) and immediately persist
    /// one full recipe. After this, every terminal turn and source lifecycle
    /// event atomically rewrites the recipe (temp + rename). The session name
    /// rides the recipe header and is shown on resume. Returns the save error
    /// (if any) so the caller can surface it -- the binding still takes effect
    /// so in-memory state is correct even if the first write fails.
    ///
    /// ADR-0035 Decision 3 / issue #50 single-writer: the canonical path is acquired
    /// in the process-global registry BEFORE the write. A second `bind_recipe`
    /// of a path another Session already holds returns
    /// [`SaveError::AlreadyOpen`] without touching the file. Re-binding the
    /// SAME canonical path on the SAME session (e.g. a Save over the open
    /// file) is allowed -- it is an update, not a second opener. Moving from
    /// one `recipe.json` to another releases the old canonical key so a different
    /// session can open it.
    pub fn bind_recipe(&mut self, path: PathBuf, session_name: String) -> Result<(), SaveError> {
        let result = self.persister.bind(
            path,
            session_name,
            &self.working_set,
            &self.timeline,
            &self.runtime_facts,
        );
        // ADR-0136 D2: a bound session materializes onto the tree companion
        // DB. Set only on a successful bind so a failed bind leaves the
        // engine on its unbound (in-memory) footing.
        if result.is_ok() {
            self.point_engine_at_tree();
        }
        result
    }

    /// Point the admin engine at the bound session tree's companion DB
    /// (ADR-0136 D2) and expose the tree snapshot directory. No-op pieces for
    /// an unbound session (test constructors) -- the engine stays in-memory
    /// and copy-in keeps using the temp dir.
    fn point_engine_at_tree(&mut self) {
        if let Some(dir) = self.recipe_path().and_then(Path::parent) {
            self.admin_engine
                .set_db_path(dir.join(companion::COMPANION_FILE_NAME));
        }
    }

    /// Where source copy-in drops `<ref>.duckdb` snapshots: the per-session
    /// tree's `snapshots/` when bound (ADR-0136 D1 -- the snapshot survives
    /// close and the resume hit path mounts it without re-reading the source
    /// file), else the session temp dir (unbound sessions; the pre-0136
    /// behavior).
    fn snapshot_dir(&self) -> PathBuf {
        match self.recipe_path().and_then(Path::parent) {
            Some(tree) => companion::snapshots_dir(tree),
            None => self.temp_path.clone(),
        }
    }

    /// The bound `recipe.json` path, if any (ADR-0034/0089). Since ADR-0089 every
    /// production session is bound at `create_session`, so `None` is reachable
    /// only from test constructors (`Session::new`, `with_provider`).
    pub fn recipe_path(&self) -> Option<&Path> {
        self.persister.recipe_path()
    }

    /// The manifest-referenced artifact paths across the held timeline
    /// (ADR-0137 Decision 6's preview whitelist source, borrowed form):
    /// the ask-path grant reads this instead of cloning the whole thread
    /// through [`Self::conversation`]; the thread-read command uses the
    /// projected [`crate::session::artifacts::referenced_paths`] on
    /// entries it already owns.
    pub fn referenced_artifact_paths(&self) -> Vec<PathBuf> {
        self.timeline
            .iter()
            .filter_map(|entry| match entry {
                TimelineEntry::Turn { record, .. } => Some(record),
                _ => None,
            })
            .flat_map(|record| record.artifacts.iter().map(|a| PathBuf::from(&a.path)))
            .collect()
    }

    /// Whether the timeline carries no content at all (ADR-0089 Decision 6):
    /// no turns, no source lifecycle events, no skill lifecycle events. Used by
    /// `close_session` to decide whether to delete the per-session directory so
    /// empty sessions do not linger in the sidebar as "新会话" entries.
    pub fn is_timeline_empty(&self) -> bool {
        self.timeline.is_empty()
    }

    /// The user-facing session name, if bound to a `recipe.json` (ADR-0034).
    pub fn session_name(&self) -> Option<&str> {
        self.persister.session_name()
    }

    pub fn list(&self) -> Vec<DatasetDescriptor> {
        self.working_set.list().to_vec()
    }

    /// The delete-impact preview (issue #1063): the live results a source
    /// removal would mark stale, resolved to display labels in ascending
    /// `result_N` order. Read-only convenience for the delete-confirm
    /// dialogs; see [`WorkingSet::stale_impact_preview`].
    pub fn delete_impact_preview(&self, reference_name: &str) -> Vec<DeleteImpactEntry> {
        self.working_set.stale_impact_preview(reference_name)
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
        turn_window::resolve_active(&self.working_set, &turns)
            .and_then(|name| self.working_set.get(&name).cloned())
    }

    pub fn get(&self, reference_name: &str) -> Option<DatasetDescriptor> {
        self.working_set.get(reference_name).cloned()
    }

    /// Auto-name the session from a question's bounded truncation (ADR-0089
    /// Decision 4, calibrated by issue #1353): the shared naming core for
    /// the turn-start push (`ask_with_phase_and_auto_name`, which emits) and
    /// `record_turn`'s silent same-value fallback. Memory-only -- the disk
    /// persists at the terminal turn's recipe save. Returns the landed name.
    fn auto_name_from_question(&mut self, question: &str) -> String {
        let name = truncate_session_name(question);
        self.persister.set_session_name(name.clone());
        name
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
    /// bound `recipe.json` so the new name survives resume. Display-only at the
    /// session level -- the bound path is untouched, so every external reference
    /// (sidebar addressing, open_recipe) stays valid; nothing else
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
            .save_if_bound(&self.working_set, &self.timeline, &self.runtime_facts);
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
    /// store-attached pair on the built-in tool table. The first question
    /// also auto-names the session (ADR-0089 Decision 4) -- this routes
    /// through [`Self::ask_with_phase_and_auto_name`].
    pub fn ask(&mut self, question: &str) -> TurnOutcome {
        let approval = ApprovalState::new();
        let sink = NullApprovalSink;
        // No external MCP servers in the test / non-command path: built-in
        // tools only. The keychain is an empty KeychainStore (a stateless unit
        // struct, ADR-0029) -- get_mcp_secret reads None for every env key, so
        // a server with keychain_env_keys still spawns, just secret-free.
        let keychain = KeychainStore::new();
        // No discovery snapshot either: tests that need skill injection call
        // ask_with_phase directly with resolved fragments (issue #364).
        let inputs = TurnInputs::empty(&keychain);
        self.ask_with_phase_and_auto_name(question, &approval, &sink, |_| {}, |_| {}, &inputs)
    }

    // Turn orchestration (ask_with_phase / run_external_turn /
    // snapshot_discovered_runtime / TurnInputs) lives in turn_runner.rs
    // (#1108; ADR-0053 Decision 1); this facade keeps the session-state
    // surface + settle (record_turn, ADR-0053 Decision 1).

    /// Append a turn to the conversation thread and return its outcome. Every
    /// outcome kind is recorded (ADR-0028 always-visible); the caller has
    /// already decided the outcome, so this just persists + returns it. The turn
    /// is wrapped in a [`TimelineEntry::Turn`] carrying both the IPC-visible
    /// [`TurnRecord`] and the persisted [`TurnAudit`] (ADR-0078) so alignment
    /// is structural (issue #325). Source/skill lifecycle events share the same
    /// timeline (ADR-0040) but never enter the LLM window. `trace` is the agent
    /// loop's recorded call trajectory for this turn; it snapshots into the
    /// turn's persisted audit so [`Self::build_recipe`]'s whole-file rebuild
    /// reads it per turn. `presented` is the turn's `present_files`
    /// declaration channel (ADR-0124): merged with the reply scan into the
    /// record's frozen artifact manifest here, at settle.
    #[allow(clippy::too_many_arguments)]
    fn record_turn(
        &mut self,
        question: &str,
        outcome: TurnOutcome,
        rounds: Vec<LoopRound>,
        invocations: Vec<crate::model::SkillInvocation>,
        runtime: TurnRuntime,
        asked_at: Option<u64>,
        presented: Vec<String>,
        usage: Option<crate::model::TurnUsage>,
        occupancy: Option<crate::model::OccupancySnapshot>,
    ) -> TurnOutcome {
        // Identical repeats collapse (review Important 3, issue #983): the
        // user channel dedupes at staging, so this catches the agent's
        // identical re-invoke -- one invocation renders, persists, and
        // replays once. Full-record equality by design: a re-invocation
        // after a mid-turn edit (a different hash) is a distinct, honest
        // record and survives.
        let mut unique_invocations: Vec<crate::model::SkillInvocation> = Vec::new();
        for invocation in &invocations {
            crate::util::push_unique(&mut unique_invocations, invocation);
        }
        let invocations = unique_invocations;
        // ADR-0119 (issue #983): the turn's skill provenance is the
        // invocation records' name set -- the skills that shaped this turn --
        // one row per name in first-invocation order, the hash pinned at
        // each name's LAST invocation of the turn (see
        // [`fold_skill_provenance`]). The same records also grow the
        // session-invoked fold (Decision 4: monotonic by construction --
        // nothing can un-invoke a past turn).
        let skills = fold_skill_provenance(&invocations);
        // The session-invoked fold grows off the SAME per-name fold (one row
        // per name, first-invocation order) -- no second pass over the
        // records (issue #989 G).
        for p in &skills {
            crate::util::push_unique(&mut self.invoked_skills, &p.name);
        }
        // ADR-0102 Decision 1 (issue #589): stamp the turn's executing runtime
        // into the recipe-header facts, so the per-terminal-turn persist below
        // records which runtime ran the turn -- the resume continuation input.
        // Derived from the same attribution snapshot the thread badge reads,
        // so header and badge cannot disagree. The legacy
        // External-without-id shape cannot name an adapter, so it leaves the
        // previous stamp in place (the live path always carries `Some`; see
        // the attribution construction in `ask_with_phase`).
        self.runtime_facts.last_runtime = match &runtime {
            TurnRuntime::BuiltIn => Some(LastRuntime::BuiltIn),
            TurnRuntime::External {
                adapter_id: Some(id),
                ..
            } => Some(LastRuntime::External(id.clone())),
            TurnRuntime::External {
                adapter_id: None, ..
            } => self.runtime_facts.last_runtime.clone(),
        };
        // ADR-0089 Decision 4 (calibrated by issue #1353): the first
        // question's bounded truncation (ADR-0039 same-kind rule: verbatim
        // question cut at a char boundary, never an LLM summary) auto-names
        // the session at turn START (`ask_with_phase_and_auto_name`, before
        // any runtime branch). This block is the silent same-value fallback:
        // turn-start naming writes no timeline entry, so the predicate still
        // holds here and the re-set is idempotent -- it exists for direct
        // `record_turn` callers (tests) and adds nothing in production.
        // After this one-time trigger the name is never auto-changed --
        // subsequent turns leave it untouched, and a user rename sticks.
        // One window excepted: a rename between acceptance and the first
        // turn's record still meets this fallback and is overwritten.
        // The no-turn test is the shared predicate's one definition (see
        // `timeline_has_turn`).
        if !self.timeline_has_turn() {
            self.auto_name_from_question(question);
        }
        // ADR-0078 (issue #297): the DISPLAY view of the trace rides the
        // TurnRecord so the rail can expand a completed turn's tool-call chain
        // (bounded summaries + the failed-call message; the full in-memory
        // payloads never cross IPC). Mapped before the audit consumes the
        // in-memory entries below.
        let trace_view: Vec<TraceRound> = rounds.iter().map(TraceRound::from).collect();
        // ADR-0124 (issue #1087): the turn's artifact manifest, computed
        // ONCE here at settle (non-streaming -- the full reply text and the
        // tool channel are both final): the `present_files` declarations
        // merged with the reply-text scan, resolved against the session
        // workspace (the agent's cwd; the temp dir only for a
        // workspace-less in-memory turn), deduped, capped. ADR-0137
        // Decision 6 (#1383): every entry references its file IN PLACE --
        // nothing is copied into the per-session `artifacts/` directory
        // (that materialization face is retired; a legacy manifest pointing
        // there still renders and replays unchanged). Frozen on the record;
        // existence is a render-time fact.
        let artifacts = artifacts::settle_manifest(
            &presented,
            artifacts::reply_body(&outcome),
            self.runtime_facts
                .workspace
                .as_deref()
                .unwrap_or(&self.temp_path),
        );
        self.timeline.push(TimelineEntry::Turn {
            record: TurnRecord {
                question: question.to_string(),
                outcome: outcome.clone(),
                trace: trace_view,
                // ADR-0103 (issue #608): the turn's own timestamps -- the
                // ask (stamped at `ask_with_phase`'s top) and the settle
                // (now, at record time, clamped onto the ask so a backward
                // clock correction cannot invert the pair, issue #617). A
                // live-recorded turn carries both (barring an unreadable
                // clock); resumed pre-v5 turns carry neither (honest
                // degrade).
                asked_at,
                settled_at: clamp_settle(now_epoch_ms(), asked_at),
                // Issue #381 (skills) + ADR-0101 (attribution): the IPC
                // provenance carries the INVOKED skills (ADR-0119) AND the
                // turn's executing runtime -- the thread renders the
                // attribution as a per-segment badge. The invocation records
                // ride the turn verbatim.
                provenance: TurnProvenance {
                    skills: skills.clone(),
                    runtime: Some(runtime.clone()),
                },
                invocations: invocations.clone(),
                artifacts,
                // ADR-0129 (issue #1270): the usage rides the record
                // (display) and the audit (persistence) -- the same
                // settle-frozen value on both halves. ADR-0130: the
                // occupancy reading rides the same pair (its own channel,
                // never folded into the usage).
                usage: usage.clone(),
                occupancy,
            },
            // ADR-0078 (issue #319) + ADR-0101: the loop's real multi-call
            // trace (mapped to the recipe form) + the runtime attribution +
            // the turn's skill provenance (ADR-0119: each invoked name +
            // its content_hash pinned at the name's last invocation of the
            // turn). The
            // PERSISTED form rides the Session (the recipe is its recipe.json
            // layer, read by build_recipe); the TurnRecord's display view
            // above is the same bounded shape.
            audit: TurnAudit::from_execution(rounds, usage, occupancy, skills, runtime),
            preserved: None,
        });
        // ADR-0034 per-terminal-turn atomic write: the recipe is rewritten
        // whole-file at the bound path (temp + rename). No-op when no recipe.json
        // is bound; a failure is logged (the prior file is intact and the
        // next turn retries).
        self.persist_if_bound();
        outcome
    }

    /// Build the recipe (ADR-0034). Facade delegate to
    /// [`RecipePersister::build_recipe`](recipe_persister::RecipePersister::build_recipe).
    pub fn build_recipe(&self) -> Recipe {
        self.persister
            .build_recipe(&self.working_set, &self.timeline, &self.runtime_facts)
    }

    /// Rewrite the recipe at the bound path (ADR-0034 atomic write). Facade
    /// delegate to [`RecipePersister::save_if_bound`](recipe_persister::RecipePersister::save_if_bound).
    /// Persist the recipe now (shared auto-write path). In addition to the
    /// per-turn write, the ADR-0095 set-commands call this so a selection
    /// made without a following turn survives a close (Decision 6). A
    /// successful write also stamps the companion watermark (ADR-0136 D3)
    /// when the engine has materialized.
    pub fn persist_if_bound(&mut self) {
        self.persister
            .save_if_bound(&self.working_set, &self.timeline, &self.runtime_facts);
        // Stamp only after a write actually landed: a suspended (conflict) or
        // failed write leaves the recipe file behind while the in-memory
        // working set moved on -- stamping then would desync the watermark
        // from the persisted chain and force a needless replay. Unbound
        // sessions and unmaterialized engines (no companion file yet,
        // ADR-0136 D2 zero-file rule) skip -- stamping must not be what
        // materializes a zero-instance session.
        if self.persister.persist_outcome() == Ok(true) && self.admin_engine.is_materialized() {
            self.stamp_companion();
        }
    }

    /// Stamp the companion's `_meta` row with the current chain digest +
    /// settled working-set shape (ADR-0136 D3). Best-effort + logged: a
    /// failed stamp costs one replay on the next open, nothing more.
    fn stamp_companion(&mut self) {
        let Some(recipe_path) = self.recipe_path().map(PathBuf::from) else {
            return;
        };
        let recipe = self.build_recipe();
        // The source (mtime, size) heuristic snapshot, taken over the same
        // hybrid resolution the resume hit path checks (relative-to-recipe
        // first, absolute fallback) so a moved session tree does not
        // false-positive a "changed" notice.
        let mut source_stats = std::collections::HashMap::new();
        for src in &recipe.sources {
            if let Ok(path) = Self::resolve_source_path(&recipe_path, src) {
                if let Some(stat) = companion::source_stat(&path) {
                    source_stats.insert(src.reference_name.clone(), stat);
                }
            }
        }
        let Ok(conn) = self.admin_engine.acquire() else {
            log::warn!(
                target: "toptopduck::session",
                "companion stamp skipped: engine acquire failed after materialization check"
            );
            return;
        };
        if let Err(e) = companion::stamp(conn, &recipe, &self.working_set, source_stats) {
            log::warn!(
                target: "toptopduck::session",
                "companion watermark stamp failed (next open replays once): {e}"
            );
        }
    }

    /// Take (read + clear) the most recent per-turn persistence failure, if
    /// any (issue #120 typed error for IPC).
    pub fn take_persist_error(&mut self) -> Option<SaveError> {
        self.persister.take_persist_error()
    }

    /// Take (read + clear) the resume-hit path's source status notices
    /// (ADR-0136 D3). Drained once by the `take_source_notices` command.
    pub fn take_source_notices(&mut self) -> Vec<SourceNotice> {
        std::mem::take(&mut self.source_notices)
    }

    /// Non-consuming snapshot of the persist outcome right after the
    /// caller's own [`Self::persist_if_bound`] (the ADR-0095 set command,
    /// issue #529): `Err` = the write failed (typed), `Ok(false)` = the
    /// write was suspended on a pending ADR-0035 conflict, `Ok(true)` = a
    /// write landed (or the session is unbound -- in-memory-only, nothing
    /// to persist). Unlike [`Self::take_persist_error`], this does not
    /// consume the shared banner channel.
    pub fn persist_outcome(&self) -> Result<bool, SaveError> {
        self.persister.persist_outcome()
    }

    /// Take (read + clear) the pending external-change conflict, if any
    /// (ADR-0035 Decision 3, issue #50).
    pub fn take_pending_conflict(&mut self) -> Option<PendingConflict> {
        self.persister.take_pending_conflict()
    }

    /// Resolve a pending conflict with "Keep Mine" (ADR-0035 Decision 3).
    pub fn conflict_keep_mine(&mut self) -> Result<(), SaveError> {
        self.persister
            .conflict_keep_mine(&self.working_set, &self.timeline, &self.runtime_facts)
    }

    /// Resolve a pending conflict with "Save As New" (ADR-0035 Decision 3).
    pub fn conflict_save_as_new(&mut self, new_path: PathBuf) -> Result<(), SaveError> {
        self.persister.conflict_save_as_new(
            new_path,
            &self.working_set,
            &self.timeline,
            &self.runtime_facts,
        )
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
    // The result-set read / export / copy species lives in `rows_io` (issue
    // #1113): free functions over this session's borrowed (cancel, working
    // set, engine), unit-tested at that seam (ADR-0053 Decision 6). The
    // delegations below keep the facade's public surface stable for
    // `commands.rs`.
    pub fn read_rows(
        &self,
        reference_name: &str,
        offset: u64,
        limit: u64,
    ) -> Result<RowPage, RowReadError> {
        rows_io::read_rows(
            &self.working_set,
            &self.admin_engine,
            reference_name,
            offset,
            limit,
        )
    }

    pub fn export_rows_csv(
        &self,
        reference_name: &str,
        path: &str,
        confirmed: bool,
    ) -> Result<(), ExportRowsError> {
        rows_io::export_rows_csv(
            &self.cancel,
            &self.working_set,
            &self.admin_engine,
            reference_name,
            path,
            confirmed,
        )
    }

    pub fn read_rows_tsv(
        &self,
        reference_name: &str,
        confirmed: bool,
    ) -> Result<String, RowReadError> {
        rows_io::read_rows_tsv(
            &self.cancel,
            &self.working_set,
            &self.admin_engine,
            reference_name,
            confirmed,
        )
    }

    /// Run arbitrary SQL on the session connection, materializing the engine
    /// on first need. Exposed for the read-only enforcement tests (AC5):
    /// writes against a source snapshot are rejected by the engine. Not part
    /// of the public ingest contract.
    pub fn execute_batch(&self, sql: &str) -> anyhow::Result<()> {
        self.admin_engine.execute_batch(sql)
    }

    /// Count rows in a snapshot's `data` table through its reference name
    /// (issue #11 AC1: a replace must make a later query see the *new* data).
    /// Exposed for the black-box tests alongside [`Self::execute_batch`] -- not
    /// part of the public ingest contract (the real query path arrives with the
    /// query loop, PRD #1).
    pub fn snapshot_row_count(&self, reference_name: &str) -> anyhow::Result<i64> {
        let conn = self.admin_engine.acquire()?;
        Ok(conn.query_row(
            &format!("SELECT COUNT(*) FROM {}.data", quote_ident(reference_name)),
            [],
            |r| r.get(0),
        )?)
    }
}

// The gateway/ACP outcome merge family lives in `outcome_merge` (#1106;
// ADR-0085 trace merge, #299 slice 9c).

/// Current Unix epoch time in milliseconds (ADR-0103, issue #608): the
/// clock the turn's `asked_at` / `settled_at` timestamps read. Millisecond
/// precision matches the timestamp grain the chat projection renders. A
/// clock read that fails (unreachable before 2038 on every supported
/// platform) degrades to `None` -- the same honest-degrade shape as a
/// pre-v5 turn (rendered without a timestamp), never a synthetic epoch-0.
fn now_epoch_ms() -> Option<u64> {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

/// Clamp the settle stamp onto the ask stamp (issue #617): the two reads
/// hit the wall clock separately (ask at submit, settle at record time), so
/// a backward clock correction in between could yield `settled_at <
/// asked_at` for the same turn. The settle floors at the ask; an unreadable
/// clock at settle time stays `None` (the same honest-degrade shape as
/// [`now_epoch_ms`], never a synthetic epoch-0).
fn clamp_settle(now: Option<u64>, asked: Option<u64>) -> Option<u64> {
    match (now, asked) {
        (Some(now), Some(asked)) => Some(now.max(asked)),
        (now, _) => now,
    }
}

/// The env var carrying the ACP bridge binary's absolute path (ADR-0085).
/// Declared by the reader (turn orchestration) and shared with the
/// `lib.rs` injector (`inject_bridge_bin`, the one dev/installed path per
/// ADR-0132) so the name cannot drift between inject and read. The
/// integration-test injector lives in a separate crate and hardcodes the
/// literal -- a rename caught by those tests failing loudly, the same
/// drift guard `ENV_PORT` in `turn_runner` documents.
pub(crate) const ACP_BRIDGE_BIN_ENV: &str = "TOPTOPDUCK_ACP_BRIDGE_BIN";

/// The MCP server name advertised in the bridge descriptor (the CLI sees this
/// as the MCP server's `name`). Load-bearing beyond trace clarity: the
/// claude-code adapter's `--allowedTools` value and the ACP engine's gateway
/// tool-name prefix both derive from it (issue #800) — literal copies guarded
/// by tests.
pub(crate) const GATEWAY_SERVER_NAME: &str = "toptopduck-gateway";

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
        // ADR-0136 D3: fold the companion's WAL into the main file on a clean
        // close so the tree holds one self-contained `analytics.duckdb` (a hard
        // kill instead leaves the WAL, which DuckDB replays on next open).
        self.admin_engine.checkpoint();
        // ADR-0035 Decision 3 / issue #50: release the single-writer registry key
        // the persister holds for its bound `recipe.json`. Delegated to the persister
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

/// Fold the turn's invocation records into the turn's skill provenance
/// (ADR-0119 Decision 2, issue #987): the invocation NAME set -- one row
/// per name, first-invocation order -- each row's `content_hash` pinned at
/// that name's LAST invocation of the turn. The final bytes are the drift
/// anchor (they shaped the turn's final output); the full
/// per-invocation audit, every hash included, rides the turn's invocation
/// records, so the overwrite loses no evidence.
fn fold_skill_provenance(invocations: &[crate::model::SkillInvocation]) -> Vec<SkillProvenance> {
    let mut skills: Vec<SkillProvenance> = Vec::new();
    for invocation in invocations {
        match skills.iter_mut().find(|p| p.name == invocation.name) {
            Some(existing) => existing.content_hash = invocation.content_hash.clone(),
            None => skills.push(SkillProvenance {
                name: invocation.name.clone(),
                content_hash: invocation.content_hash.clone(),
            }),
        }
    }
    skills
}

#[cfg(test)]
mod tests {
    use super::{clamp_settle, Session, TOOL_OUTPUT_DIR_NAME};
    use std::path::Path;

    use crate::model::{ThreadEntry, TurnFailure, TurnOutcome, TurnRuntime};
    use crate::provider::fake::FakeProvider;
    use crate::provider::tool_calling::{ToolTurnMessage, ToolTurnReply, ToolUse};
    use crate::provider::ProviderError;
    use serde_json::json;
    use tempfile::NamedTempFile;

    // Issue #617: the settle stamp reads the wall clock a second time after
    // the ask stamp, so a backward clock correction (NTP, a manual change)
    // could record settled_at < asked_at for the same turn. The clamp keeps
    // the pair monotonic; an unreadable clock stays None (honest degrade,
    // never a synthetic value).
    #[test]
    fn clamp_settle_keeps_the_pair_monotonic() {
        assert_eq!(clamp_settle(Some(150), Some(100)), Some(150));
        // Clock stepped backward between the two reads: settle floors at ask.
        assert_eq!(clamp_settle(Some(90), Some(100)), Some(100));
        assert_eq!(clamp_settle(None, Some(100)), None);
        assert_eq!(clamp_settle(Some(150), None), Some(150));
        assert_eq!(clamp_settle(None, None), None);
    }

    /// A materialize tool call promoting `sql` -- the tool-calling contract's
    /// equivalent of the retired single-shot `ProviderReply::Sql`.
    fn materialize_call(sql: &str) -> ToolTurnReply {
        ToolTurnReply::tool_calls(vec![ToolUse {
            id: "tu_1".into(),
            name: "materialize".into(),
            input: json!({ "sql": sql }),
        }])
    }

    /// An explore tool call running `sql` -- a read-classified call, so a
    /// scripted explore-then-materialize turn exercises a MULTI-call trace.
    fn explore_call(sql: &str) -> ToolTurnReply {
        ToolTurnReply::tool_calls(vec![ToolUse {
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

    /// Issue #741 AC: the snapshot's `row_cap` seeds the session's row ceiling
    /// at construction (the cap-hit path itself is pinned by the blackbox
    /// tests that lower the cap and assert the resource abort).
    #[test]
    fn row_cap_seeds_from_the_session_snapshot() {
        let snapshot = crate::app_config::model::EngineDefaults {
            row_cap: 7,
            ..Default::default()
        };
        let session = Session::with_provider_and_cancel(
            Box::new(crate::provider::UnwiredProvider),
            std::sync::Arc::new(crate::cancel::CancelToken::new()),
            snapshot,
        )
        .expect("session");
        assert_eq!(session.result_row_cap, 7);
        // The no-snapshot convenience constructors stay on the constants.
        let default_session = Session::new().expect("default session");
        assert_eq!(
            default_session.result_row_cap,
            crate::guardrail::DEFAULT_MAX_RESULT_ROWS
        );
    }

    /// Issue #741: the construction seam itself applies the snapshot. The
    /// unit-level pins cover `AdminEngine::new` in isolation, but the seam is
    /// where a revert to the compile-time default would still compile (the
    /// `row_cap` seed keeps the parameter "used") and keep every suite
    /// green -- so force the real first SQL need through the seam and read
    /// the cap back off the live connection.
    #[test]
    fn the_construction_seam_applies_the_snapshot_caps() {
        let snapshot = crate::app_config::model::EngineDefaults {
            memory_limit: "256MB".to_string(),
            threads: 2,
            row_cap: 500,
        };
        let session = Session::with_provider_and_cancel(
            Box::new(crate::provider::UnwiredProvider),
            std::sync::Arc::new(crate::cancel::CancelToken::new()),
            snapshot,
        )
        .expect("session");
        let conn = session.admin_engine.acquire().expect("first SQL need");
        crate::guardrail::tests::assert_memory_cap_lands(conn, 256e6);
        let (_, threads) = crate::guardrail::tests::read_caps(conn);
        assert_eq!(
            threads, "2",
            "the seam threads the snapshot, not a constant"
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
    fn bind_recipe_writes_a_readable_recipe_at_the_path() {
        // ADR-0034: bind_recipe immediately persists one recipe at the bound
        // path (temp + rename), so the recipe.json exists after the call even
        // before any turn. The file reads back as a v1 recipe carrying the
        // session name.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("recipe.json");
        let mut session = Session::new().expect("session");
        session
            .bind_recipe(path.clone(), "我的分析".into())
            .expect("bind");
        assert_eq!(session.recipe_path(), Some(path.as_path()));
        assert_eq!(session.session_name(), Some("我的分析"));
        let recipe = crate::persistence::read_recipe(&path).expect("read back");
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
        // ADR-0036 Decision 4 hybrid paths: a source inside the recipe.json file's directory
        // subtree is recorded with BOTH a relative path (the primary resolver,
        // which survives "move the folder" portability) and the absolute path
        // (the fallback). The out-of-subtree case (relative_path = None) is
        // covered by the black-box suite, whose fixture lives outside the
        // recipe.json tempdir and resumes through the absolute fallback.
        let dir = tempfile::tempdir().expect("tempdir");
        let duck = dir.path().join("recipe.json");
        let in_subtree = dir.path().join("data.csv");
        std::fs::write(&in_subtree, "name,score\nAda,9\n").expect("write csv");

        let mut session = Session::new().expect("session");
        session
            .bind_recipe(duck.clone(), "混合路径".into())
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
            "in-subtree source carries a path relative to the recipe.json directory"
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
        // empty (a successful call's payload is data-bearing -- the recipe.json
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
        assert_eq!(turn.trace[0].calls[0].name, "materialize");
        assert_eq!(turn.trace[0].calls[0].operation_kind, OperationKind::Write);
        assert_eq!(
            turn.trace[0].calls[0].summary, "SELECT COUNT(*) AS n FROM \"people\".data",
            "summary is the verbatim SQL",
        );
        assert!(turn.trace[0].calls[0].success, "the call succeeded");
        assert!(
            turn.trace[0].calls[0].result_excerpt.is_empty(),
            "a success payload is data-bearing (columns/sample/row_count) -- \
             the recipe.json carries no materialized data (ADR-0036), so the \
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
        assert_eq!(
            turn.trace[0].calls[0].name, "explore",
            "call order preserved"
        );
        assert_eq!(turn.trace[0].calls[0].operation_kind, OperationKind::Read);
        assert_eq!(turn.trace[1].calls[0].name, "materialize");
        assert_eq!(turn.trace[1].calls[0].operation_kind, OperationKind::Write);
        assert!(turn
            .trace
            .iter()
            .flat_map(|r| r.calls.iter())
            .all(|e| e.success));
        assert!(
            turn.trace
                .iter()
                .flat_map(|r| r.calls.iter())
                .all(|e| e.result_excerpt.is_empty()),
            "success excerpts stay empty (ADR-0036 contents boundary)"
        );
        assert_eq!(turn.provenance.runtime, Some(RuntimeKind::BuiltIn));
    }

    #[test]
    fn build_recipe_persists_a_failed_calls_excerpt_and_omits_success_excerpts() {
        // ADR-0078 / ADR-0036 (issue #319): the persisted excerpt is the
        // FAILURE audit anchor -- a failed materialize (bad SQL) records its
        // error string so a reopened turn can show what went wrong, while the
        // successful retry's data-bearing payload stays OUT of the recipe.json.
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
        assert!(
            !turn.trace[0].calls[0].success,
            "first attempt failed (bad SQL)"
        );
        assert!(
            !turn.trace[0].calls[0].result_excerpt.is_empty(),
            "the failure carries its error string for cross-turn retrospection"
        );
        assert!(turn.trace[1].calls[0].success, "the retry succeeded");
        assert!(
            turn.trace[1].calls[0].result_excerpt.is_empty(),
            "the success payload never enters the recipe.json (ADR-0036)"
        );
    }

    #[test]
    fn bare_construction_seeds_the_configured_default_count_cap() {
        // #1446: a bare construction (no command-layer override yet) must
        // equal the UNCONFIGURED config default, so the only source of M=100
        // is DEFAULT_RESULT_COUNT_CAP via Tunables -- the create/resume
        // command layer then snapshots the persisted tunable over this floor
        // through set_result_count_cap. The expectation anchors the constant
        // directly: asserting `Tunables::default()` here would travel with a
        // Default-impl mutation (both sides derive from it), leaving the
        // impl's tie to DEFAULT_RESULT_COUNT_CAP unanchored.
        let session = Session::new().expect("bare construction");
        assert_eq!(
            session.result_count_cap,
            crate::workingset::DEFAULT_RESULT_COUNT_CAP
        );
    }

    #[test]
    fn bare_construction_seeds_the_configured_default_window() {
        // #1445: the window twin of the count-cap pin above -- a bare
        // construction (no command-layer override yet) must equal the
        // UNCONFIGURED config default, so the only source of N=20 is
        // WINDOW_TURNS via Tunables; the create/resume command layer then
        // snapshots the persisted tunable over this floor through
        // set_window_turns. The expectation anchors the constant directly
        // (the count-cap pin's anti-drift rationale above applies verbatim).
        let session = Session::new().expect("bare construction");
        assert_eq!(session.window_turns, crate::turn_window::WINDOW_TURNS);
    }

    #[test]
    fn ask_windows_the_conversation_on_the_session_snapshot() {
        // #1445: the window seam -- the runner must thread the session's
        // `window_turns` into the assembly, and the bare-construction pin
        // above cannot catch a dropped construction-point setter call or a
        // runner-site revert to the constant (both compile clean and keep
        // every suite green -- the failure mode the #741 engine seam test
        // pins for the caps, here for the window). Drive four live asks at
        // N=2 and read the assembled conversation off the fake's capture
        // handle: the oldest turn folds to a summary (its response text
        // never rides the window), the two recent turns ship full.
        let provider = FakeProvider::new()
            .scripted_tool_turn("第一问", ToolTurnReply::Text("第一答".into()))
            .scripted_tool_turn("第二问", ToolTurnReply::Text("第二答".into()))
            .scripted_tool_turn("第三问", ToolTurnReply::Text("第三答".into()))
            .scripted_tool_turn("第四问", ToolTurnReply::Text("第四答".into()));
        let handle = provider.captured_tool_turns();
        let (mut session, _dir) = session_with_people(provider);
        session.set_window_turns(2);
        for question in ["第一问", "第二问", "第三问", "第四问"] {
            let _ = session.ask(question);
        }
        let captured = handle.lock().unwrap();
        assert_eq!(captured.len(), 4, "one assembled request per ask");
        let last = captured.last().unwrap();
        // Three history turns x two entries + the asking question.
        assert_eq!(last.messages.len(), 7);
        let content = |i: usize| match &last.messages[i] {
            ToolTurnMessage::User { content } => content.clone(),
            ToolTurnMessage::Assistant { text, .. } => text.clone().unwrap_or_default(),
            ToolTurnMessage::ToolResult { content, .. } => content.clone(),
        };
        // The folded oldest turn ships its verbatim question plus the
        // no-result summary note -- never its response text.
        assert_eq!(content(0), "第一问");
        assert!(content(1).contains("未生成结果"));
        // The two in-window turns ship question + response verbatim.
        assert_eq!(content(2), "第二问");
        assert!(content(3).contains("第二答"));
        assert_eq!(content(4), "第三问");
        assert!(content(5).contains("第三答"));
        assert_eq!(content(6), "第四问");
        assert!(
            !last.messages.iter().any(|m| match m {
                ToolTurnMessage::User { content } | ToolTurnMessage::ToolResult { content, .. } =>
                    content.contains("第一答"),
                ToolTurnMessage::Assistant { text, .. } => {
                    text.as_deref().is_some_and(|t| t.contains("第一答"))
                }
            }),
            "the folded turn's response text never rides the window"
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
        assert_eq!(turn.trace[0].calls[0].name, "explore");
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
        // Effect-level pin (PR #654 deferred note): the GC branch is
        // warn-only, so the physical DROP must be probed -- a broken DROP
        // would stay green through the bookkeeping assertions above.
        let remaining: i64 = session
            .admin_engine
            .conn()
            .query_row(
                "SELECT count(*) FROM information_schema.tables WHERE table_name = 'result_1'",
                [],
                |r| r.get(0),
            )
            .expect("information_schema probe");
        assert_eq!(
            remaining, 0,
            "result_1 physically dropped from the engine by GC"
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
            RecipeEntry, RecipeOutcome, RecipeTraceEntry, RecipeTraceRound, RecipeTurn,
            RuntimeKind, TurnProvenance as PersistedTurnProvenance, TurnTimestamps,
        };

        // A recipe turn carrying data that must survive the round-trip.
        let harvested_trace = vec![RecipeTraceEntry {
            name: "explore".into(),
            operation_kind: OperationKind::Read,
            summary: "SELECT 1 AS n".into(),
            success: true,
            result_excerpt: String::new(),
            sub_rounds: None,
        }];
        let harvested_provenance = PersistedTurnProvenance {
            runtime: Some(RuntimeKind::External),
            adapter_id: None,
            adapter_display_name: None,
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
            vec![RecipeTraceRound {
                thinking: None,
                text: None,
                calls: harvested_trace.clone(),
            }],
            harvested_provenance.clone(),
            TurnTimestamps::default(),
        );
        let audit = TurnAudit::from_recipe_turn(&source_turn);

        // The IPC-visible record. Its trace + provenance are deliberately
        // empty/default -- build_recipe reads those from the audit, not the
        // record. The real resume path (resume.rs) populates record.trace from
        // the recipe, but here the emptiness sharpens the assertion: a
        // regression that reads record.trace instead of audit.trace would
        // produce an empty trace and fail the assert_eq below. External (not
        // BuiltIn) is chosen so a re-synthesized live-path provenance (which
        // stamps the turn-top attribution, not the harvested one) is also
        // caught.
        let record = TurnRecord {
            question: "resumed question".into(),
            outcome: TurnOutcome::Textual {
                text_kind: TextKind::Agent,
                body: "resumed body".into(),
                assumption: None,
            },
            trace: vec![],
            provenance: Default::default(),
            asked_at: None,
            settled_at: None,
            invocations: Vec::new(),
            artifacts: Vec::new(),
            usage: None,
            occupancy: None,
        };

        // Inject the timeline entry -- simulates a resumed session whose
        // timeline was seeded from the recipe.
        let mut session = Session::new().expect("session");
        session.timeline.push(TimelineEntry::Turn {
            record,
            audit,
            preserved: None,
        });

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
            turn.trace,
            vec![RecipeTraceRound {
                thinking: None,
                text: None,
                calls: harvested_trace,
            }],
            "the harvested trace round-trips verbatim through build_recipe"
        );
        assert_eq!(
            turn.provenance, harvested_provenance,
            "the harvested provenance round-trips verbatim (External runtime preserved)"
        );
    }

    #[test]
    fn record_turn_attribution_lands_on_record_and_audit() {
        // ADR-0101: the turn-top attribution snapshot lands on BOTH halves of
        // the timeline entry -- the IPC TurnRecord's provenance (the thread
        // badge source) and the persisted TurnAudit (the recipe.json anchor). An
        // external turn names its adapter id; a built-in turn records only
        // the kind and never an id.
        use super::PersistedTurnProvenance;
        use super::TimelineEntry;
        use crate::persistence::recipe::{LastRuntime, RecipeEntry, RuntimeKind};

        fn textual(body: &str) -> TurnOutcome {
            TurnOutcome::Textual {
                text_kind: crate::model::TextKind::Agent,
                body: body.into(),
                assumption: None,
            }
        }

        let mut session = Session::new().expect("session");
        session.record_turn(
            "external question",
            textual("external answer"),
            Vec::new(),
            Vec::new(),
            TurnRuntime::External {
                adapter_id: Some("gemini-cli".into()),
                // Issue #1351: a display name distinct from the id pins the
                // passthrough (an equal pair could pass by coincidence).
                display_name: Some("Gemini CLI".into()),
            },
            None,
            Vec::new(),
            None, // no usage evidence (test fixture)
            None,
        );
        // ADR-0102 (issue #589): the same attribution snapshot stamps the
        // recipe-header `last_runtime` -- here the external turn's adapter.
        assert_eq!(
            session.runtime_facts().last_runtime,
            Some(LastRuntime::External("gemini-cli".into())),
            "the header stamp follows the recorded turn's runtime"
        );
        session.record_turn(
            "built-in question",
            textual("built-in answer"),
            Vec::new(),
            Vec::new(),
            TurnRuntime::BuiltIn,
            None,
            Vec::new(),
            None, // no usage evidence (test fixture)
            None,
        );

        let external = match &session.timeline[0] {
            TimelineEntry::Turn {
                record,
                audit,
                preserved: _,
            } => (record, audit),
            _ => panic!("first entry is a turn"),
        };
        let builtin = match &session.timeline[1] {
            TimelineEntry::Turn {
                record,
                audit,
                preserved: _,
            } => (record, audit),
            _ => panic!("second entry is a turn"),
        };
        // Wire half: the thread's badge source.
        assert_eq!(
            external.0.provenance.runtime,
            Some(TurnRuntime::External {
                adapter_id: Some("gemini-cli".into()),
                display_name: Some("Gemini CLI".into()),
            }),
            "the external turn's wire provenance names the adapter"
        );
        assert_eq!(
            builtin.0.provenance.runtime,
            Some(TurnRuntime::BuiltIn),
            "the built-in turn's wire provenance carries only the kind"
        );
        // Persisted half: the recipe.json anchor.
        assert_eq!(external.1.provenance().runtime, Some(RuntimeKind::External));
        assert_eq!(
            external.1.provenance().adapter_id.as_deref(),
            Some("gemini-cli"),
            "the external turn's audit persists the adapter id"
        );
        assert_eq!(builtin.1.provenance().runtime, Some(RuntimeKind::BuiltIn));
        assert_eq!(
            builtin.1.provenance().adapter_id,
            None,
            "the built-in turn's audit never carries an adapter id"
        );
        // And the projection round-trips both into the recipe.json recipe shape.
        let recipe = session.build_recipe();
        let mut turns = recipe.history.iter().filter_map(|e| match e {
            RecipeEntry::Turn(t) => Some(t.provenance.clone()),
            _ => None,
        });
        assert_eq!(
            turns.next(),
            Some(PersistedTurnProvenance {
                runtime: Some(RuntimeKind::External),
                adapter_id: Some("gemini-cli".into()),
                adapter_display_name: Some("Gemini CLI".into()),
                skills: Vec::new(),
            })
        );
        assert_eq!(
            turns.next(),
            Some(PersistedTurnProvenance {
                runtime: Some(RuntimeKind::BuiltIn),
                adapter_id: None,
                adapter_display_name: None,
                skills: Vec::new(),
            })
        );
        // The later built-in turn overwrote the stamp, and the projection
        // layers it onto the built recipe's header (one batch with the
        // posture pair + the catalog).
        assert_eq!(
            session.runtime_facts().last_runtime,
            Some(LastRuntime::BuiltIn),
            "the last recorded turn's runtime wins"
        );
        assert_eq!(
            recipe.last_runtime,
            Some(LastRuntime::BuiltIn),
            "the built recipe carries the stamp on its header"
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
    // single call clamps, re-issued every round-trip). The loop runtime's
    // loop detection (ADR-0107 Decision 4, inherited by ADR-0116) stops the
    // non-converging trajectory -- steer at 3 identical calls, abort on the
    // repeat after the nudge -- long before the 24-step cap, failing
    // honestly with the loop's own reason; EVERY failed attempt must still
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

        // The non-self-correcting trajectory is stopped by loop detection and
        // surfaces as a typed Execute failure carrying the honest repetition
        // reason (the per-attempt engine errors rode back to the model as tool
        // results, ADR-0077 -- they are not the turn-level detail).
        let detail = match session.ask("建表") {
            TurnOutcome::Failed(TurnFailure::Execute { detail }) => detail,
            other => panic!("expected Execute failure after derive failure, got {other:?}"),
        };
        assert!(
            detail.contains("identical arguments"),
            "loop-detection stop carries the honest repetition detail: {detail:?}"
        );

        // result_1 was rolled back on every attempt: it is no longer a table in
        // the session DB. (A broken rollback would leave it lingering -> the
        // retry's next CREATE clashes and the probe below is non-zero.)
        let remaining: i64 = session
            .admin_engine
            .conn()
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

    // The bridged fault vocabulary (issue #669): a bridged provider's error
    // classification survives the upstream round-trip unchanged. The bridge
    // encodes each app fault onto the upstream error channel and the loop's
    // terminal derivation reads it back into the SAME TurnFailure kinds the
    // self-written loop surfaced -- one round-trip, no upstream retry
    // (ADR-0044: none of the three are retryable there).
    #[test]
    fn ask_maps_a_bridged_invalid_config_onto_the_typed_failure() {
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "坏端点",
            vec![Err(ProviderError::InvalidConfig(
                "scheme `file` is not http/https".into(),
            ))],
        );
        let mut session = Session::with_provider(Box::new(provider)).expect("session");
        match session.ask("坏端点") {
            TurnOutcome::Failed(TurnFailure::InvalidConfig { detail }) => {
                assert!(detail.contains("scheme"), "{detail}");
            }
            other => panic!("expected InvalidConfig, got {other:?}"),
        }
    }

    #[test]
    fn ask_maps_a_bridged_unavailable_onto_execute_verbatim() {
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "断连",
            vec![Err(ProviderError::Unavailable("connection reset".into()))],
        );
        let mut session = Session::with_provider(Box::new(provider)).expect("session");
        match session.ask("断连") {
            TurnOutcome::Failed(TurnFailure::Execute { detail }) => {
                assert_eq!(detail, "connection reset");
            }
            other => panic!("expected Execute, got {other:?}"),
        }
    }

    // --- ADR-0104 on-demand materialization (issue #652) ----------------------

    /// AC1/AC7: a session that only chats never materializes the engine --
    /// zero DuckDB instances from creation to close -- and working-set
    /// metadata reads (descriptor-only paths) don't materialize either.
    #[test]
    fn text_only_session_never_materializes_the_engine() {
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "你好",
            vec![Ok(ToolTurnReply::Text("你好！有什么可以帮你的？".into()))],
        );
        let mut session = Session::with_provider(Box::new(provider)).expect("session");
        assert!(
            !session.admin_engine.is_materialized(),
            "construction materializes nothing"
        );
        match session.ask("你好") {
            TurnOutcome::Textual { .. } => {}
            other => panic!("expected a textual turn, got {other:?}"),
        }
        // Metadata reads: descriptor-only paths over the working set.
        let _ = session.list();
        let _ = session.active();
        let _ = session.get("anything");
        assert!(
            !session.admin_engine.is_materialized(),
            "a no-tool turn + metadata reads keep the engine at zero instances"
        );
    }

    /// ADR-0136 D2 zero-file rule for a BOUND session: the settle persists
    /// the recipe, but the stamp gate refuses to be the thing that
    /// materializes the engine -- no companion file may appear for a session
    /// that never ran SQL. The unbound AC1 test above cannot see this: its
    /// stamp path is a no-op.
    #[test]
    fn a_bound_text_only_session_never_gains_a_companion_file() {
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "你好",
            vec![Ok(ToolTurnReply::Text("你好！有什么可以帮你的？".into()))],
        );
        let dir = tempfile::tempdir().expect("tempdir");
        let recipe = dir.path().join("recipe.json");
        let mut session = Session::with_provider(Box::new(provider)).expect("session");
        session
            .bind_recipe(recipe.clone(), "零文件".into())
            .expect("bind");
        match session.ask("你好") {
            TurnOutcome::Textual { .. } => {}
            other => panic!("expected a textual turn, got {other:?}"),
        }
        assert!(recipe.exists(), "the text turn settled the recipe");
        assert!(
            !session.admin_engine.is_materialized(),
            "the stamp gate must not materialize a zero-instance session"
        );
        assert!(
            !dir.path()
                .join(super::companion::COMPANION_FILE_NAME)
                .exists(),
            "no companion file for a no-SQL session"
        );
        drop(session);
        assert!(
            !dir.path()
                .join(super::companion::COMPANION_FILE_NAME)
                .exists(),
            "still no companion after close"
        );
    }

    /// AC2: a turn whose only tool call routes to an external (MCP) tool
    /// never touches the engine. Under the loop runtime (ADR-0116) the
    /// tool table rig was given does not carry the external server's entry
    /// (the inputs are empty here), so the model's call lands as the
    /// unknown-tool terminal (Decision 5's honest transient -- terminal,
    /// not an error result fed back for the model to answer on top) -- and
    /// the engine stays at zero instances either way,
    /// which is the materialization assertion this AC pins.
    #[test]
    fn present_files_turn_records_manifest_and_trace_row() {
        // ADR-0124 (issue #1087) end-to-end: the built-in turn's
        // `present_files` call lands on the turn's artifact manifest (the
        // tool channel's declaration; the reply scan's hit of the same
        // MISSING file is existence-filtered, not deduped) and records an
        // honest trace row. No approval seeding: delivery is a declaration,
        // intercepted ahead of the gate.
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "生成报告",
            vec![
                Ok(ToolTurnReply::tool_calls(vec![ToolUse {
                    id: "tu_pf".into(),
                    name: "present_files".into(),
                    input: json!({"files": ["report.html"]}),
                }])),
                Ok(ToolTurnReply::Text("报告已生成：report.html".into())),
            ],
        );
        let mut session = Session::with_provider(Box::new(provider)).expect("session");
        let outcome = session.ask("生成报告");
        assert!(matches!(outcome, TurnOutcome::Textual { .. }));
        let entry = session
            .conversation()
            .into_iter()
            .find_map(|e| match e {
                ThreadEntry::Turn(r) if r.question == "生成报告" => Some(r),
                _ => None,
            })
            .expect("the turn recorded");
        // The declared file does not exist, so the entry keeps the resolved
        // temp path (an explicit declaration survives the heuristic
        // existence filter); the reply text's scan hit of the SAME missing
        // file dies at that filter -- one entry, from the declaration.
        assert_eq!(
            entry.artifacts.len(),
            1,
            "one entry from the declaration; the scan hit is existence-filtered"
        );
        assert_eq!(entry.artifacts[0].file_name, "report.html");
        assert!(
            Path::new(&entry.artifacts[0].path).is_absolute(),
            "the manifest stores absolute paths"
        );
        // The call records an honest trace row (AC: the call enters the
        // execution trace).
        assert_eq!(entry.trace[0].calls.len(), 1);
        assert_eq!(entry.trace[0].calls[0].name, "present_files");
        assert!(entry.trace[0].calls[0].success);
    }

    /// ADR-0124 Decision 2 (issue #1087), recalibrated by ADR-0137
    /// Decision 6 (#1383): a declared hit enters the manifest IN PLACE --
    /// nothing is copied into a per-session `artifacts/` directory (which
    /// is never created), and the recipe persists the same in-place
    /// manifest.
    #[test]
    fn present_files_turn_references_declared_hits_in_place() {
        let duck_dir = tempfile::tempdir().expect("duck dir");
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "生成网页",
            vec![
                Ok(ToolTurnReply::tool_calls(vec![ToolUse {
                    id: "tu_pf".into(),
                    name: "present_files".into(),
                    input: json!({"files": ["page.html"]}),
                }])),
                Ok(ToolTurnReply::Text("done".into())),
            ],
        );
        let mut session = Session::with_provider(Box::new(provider)).expect("session");
        session
            .bind_recipe(duck_dir.path().join("recipe.json"), "s".into())
            .expect("bind");
        let report = session.temp_path.join("page.html");
        std::fs::write(&report, "<html/>").expect("write temp report");
        session.ask("生成网页");
        let entry = session
            .conversation()
            .into_iter()
            .find_map(|e| match e {
                ThreadEntry::Turn(r) if r.question == "生成网页" => Some(r),
                _ => None,
            })
            .expect("the turn recorded");
        assert_eq!(entry.artifacts.len(), 1);
        assert_eq!(
            Path::new(&entry.artifacts[0].path),
            session.temp_path.join("page.html"),
            "the manifest stores the in-place path"
        );
        assert!(
            Path::new(&entry.artifacts[0].path).is_file(),
            "the referenced file is there"
        );
        assert!(
            !duck_dir.path().join("artifacts").exists(),
            "no materialization directory is ever created"
        );
        // And the recipe persisted the same in-place manifest (the
        // `recipe.json` is the reopen path).
        let recipe = session.build_recipe();
        let persisted = recipe
            .history
            .iter()
            .find_map(|e| match e {
                crate::persistence::recipe::RecipeEntry::Turn(t) if t.question == "生成网页" => {
                    Some(t.artifacts.clone())
                }
                _ => None,
            })
            .expect("the persisted turn");
        assert_eq!(persisted.len(), 1);
        assert_eq!(persisted[0].path, entry.artifacts[0].path);
    }

    /// ADR-0137 Decision 6's workspace leg (issue #1383): with a bound
    /// workspace the settle base is the WORKSPACE -- a relative
    /// declaration resolves against it and enters the manifest under its
    /// own in-place absolute path, never against the session temp dir
    /// (the #1381 TRANSITION window this closes). The sibling test above
    /// pins the workspace-less fallback leg (the temp basis).
    #[test]
    fn present_files_turn_references_workspace_hits_under_the_workspace_base() {
        let duck_dir = tempfile::tempdir().expect("duck dir");
        let workspace_dir = tempfile::tempdir().expect("workspace dir");
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "生成网页",
            vec![
                Ok(ToolTurnReply::tool_calls(vec![ToolUse {
                    id: "tu_pf".into(),
                    name: "present_files".into(),
                    input: json!({"files": ["page.html"]}),
                }])),
                Ok(ToolTurnReply::Text("done".into())),
            ],
        );
        let mut session = Session::with_provider(Box::new(provider)).expect("session");
        session.set_workspace(
            workspace_dir
                .path()
                .canonicalize()
                .expect("canonical workspace"),
        );
        session
            .bind_recipe(duck_dir.path().join("recipe.json"), "s".into())
            .expect("bind");
        // The deliverable lives in the workspace; a same-named decoy in the
        // temp dir must NOT win the resolution (the base is the workspace,
        // not the temp dir).
        std::fs::write(workspace_dir.path().join("page.html"), "<html/>")
            .expect("write workspace report");
        std::fs::write(session.temp_path.join("page.html"), "decoy").expect("write temp decoy");
        let _ = session.ask("生成网页");
        let entry = session
            .conversation()
            .into_iter()
            .find_map(|e| match e {
                ThreadEntry::Turn(r) if r.question == "生成网页" => Some(r),
                _ => None,
            })
            .expect("the turn recorded");
        assert_eq!(entry.artifacts.len(), 1);
        assert_eq!(
            Path::new(&entry.artifacts[0].path),
            workspace_dir
                .path()
                .canonicalize()
                .expect("canonical workspace")
                .join("page.html"),
            "a relative declaration resolves against the workspace, in place"
        );
        assert!(
            !Path::new(&entry.artifacts[0].path).starts_with(&session.temp_path),
            "the temp dir never enters the manifest while a workspace is bound"
        );
    }

    #[test]
    fn external_tool_only_turn_does_not_materialize_the_engine() {
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "查天气",
            vec![
                Ok(ToolTurnReply::tool_calls(vec![ToolUse {
                    id: "tu_x".into(),
                    name: "mcp__weather__lookup".into(),
                    input: json!({ "city": "上海" }),
                }])),
                Ok(ToolTurnReply::Text("没有可用的天气服务。".into())),
            ],
        );
        let mut session = Session::with_provider(Box::new(provider)).expect("session");
        let approval = crate::approval::ApprovalState::new();
        approval.seed_trust(&crate::approval::ToolKey::external(
            "weather",
            "mcp__weather__lookup",
        ));
        let keychain = super::KeychainStore::new();
        let inputs = super::TurnInputs::empty(&keychain);
        let outcome = session.ask_with_phase(
            "查天气",
            &approval,
            &super::NullApprovalSink,
            |_| {},
            &inputs,
        );
        match outcome {
            TurnOutcome::Failed(TurnFailure::Execute { detail }) => {
                assert!(
                    detail.contains("unknown tool") && detail.contains("mcp__weather__lookup"),
                    "the unknown-tool terminal carries the honest name: {detail:?}"
                );
            }
            other => panic!("expected the unknown-tool Execute failure, got {other:?}"),
        }
        assert!(
            !session.admin_engine.is_materialized(),
            "an external-tool-only turn keeps the engine at zero instances"
        );
    }

    /// A (#987): the provenance fold dedupes by NAME -- one row per name in
    /// first-appearance order, the hash pinned at the name's LAST invocation
    /// of the turn (a mid-turn edit + re-invoke overwrites the anchor, never
    /// lands a second row).
    #[test]
    fn provenance_fold_dedupes_by_name_keeping_the_last_hash() {
        let invocation = |name: &str, hash: &str| crate::model::SkillInvocation {
            name: name.to_string(),
            body: String::new(),
            actor: crate::model::SkillLifecycleActor::Agent,
            content_hash: hash.to_string(),
        };
        let folded = super::fold_skill_provenance(&[
            invocation("sql-coach", "hash-1"),
            invocation("pdf-tools", "hash-3"),
            invocation("sql-coach", "hash-2"),
        ]);
        assert_eq!(
            folded,
            vec![
                crate::model::SkillProvenance {
                    name: "sql-coach".to_string(),
                    content_hash: "hash-2".to_string(),
                },
                crate::model::SkillProvenance {
                    name: "pdf-tools".to_string(),
                    content_hash: "hash-3".to_string(),
                },
            ],
            "one row per name, first-appearance order, the last hash wins"
        );
    }

    /// AC3/AC4: literal SQL on an empty working set is a legal materialize --
    /// it materializes the engine on the spot, and the engine then stays
    /// held (one-way, no idle reclaim) across later no-tool turns.
    #[test]
    fn literal_sql_on_an_empty_working_set_materializes_and_holds() {
        let provider = FakeProvider::new()
            .scripted_tool_turn_seq(
                "q1",
                vec![
                    Ok(materialize_call("SELECT 1 AS one")),
                    Ok(ToolTurnReply::Text("done".into())),
                ],
            )
            .scripted_tool_turn_seq("q2", vec![Ok(ToolTurnReply::Text("again".into()))]);
        let mut session = Session::with_provider(Box::new(provider)).expect("session");
        assert!(
            !session.admin_engine.is_materialized(),
            "empty working set starts at zero instances"
        );
        match session.ask("q1") {
            TurnOutcome::Materialized { .. } => {}
            other => panic!("expected Materialized, got {other:?}"),
        }
        assert!(
            session.admin_engine.is_materialized(),
            "the first SQL need materialized the engine"
        );
        let _ = session.ask("q2");
        assert!(
            session.admin_engine.is_materialized(),
            "a materialized engine is held -- no idle reclaim"
        );
    }

    #[test]
    fn resource_caps_are_applied_to_the_session_connection() {
        // AC3 (issue #25): the engine-level resource caps are set when the
        // engine materializes (ADR-0005 L3 + ADR-0104 Decision 1: open +
        // caps in one step). Read back via duckdb_settings (PRAGMA-as-query
        // is unsupported in this DuckDB for these keys).
        let session = Session::new().expect("session");
        let conn = session
            .admin_engine
            .acquire()
            .expect("first need materializes the engine");
        let threads: String = conn
            .query_row(
                "SELECT value FROM duckdb_settings() WHERE name='threads'",
                [],
                |r| r.get(0),
            )
            .expect("threads setting");
        assert_eq!(threads, crate::guardrail::MAX_THREADS.to_string());
        let mem: String = conn
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

    /// Bind a session to a temp recipe.json file so record_turn's persist path is
    /// Some. Returns (session, _recipe_file) — the caller holds the guard.
    fn session_with_recipe(name: &str) -> (Session, NamedTempFile) {
        let duck = NamedTempFile::new().expect("temp recipe.json");
        let mut session = Session::new().expect("session");
        session
            .bind_recipe(duck.path().to_path_buf(), name.to_string())
            .expect("bind");
        (session, duck)
    }

    #[test]
    fn record_turn_auto_names_on_first_turn() {
        let (mut session, _duck) = session_with_recipe("");
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
            TurnRuntime::BuiltIn,
            None,
            Vec::new(),
            None, // no usage evidence (test fixture)
            None,
        );

        assert_eq!(
            session.session_name(),
            Some("how many people?"),
            "first recorded turn auto-names the session (record_turn fallback)"
        );
    }

    /// Issue #1353 (ADR-0089 Decision 4 calibrated): the first question's
    /// ACCEPTANCE names the session -- the push fires once, at turn start
    /// before the turn settles, and `record_turn`'s fallback re-sets the
    /// same value silently (no second event).
    #[test]
    fn ask_with_auto_name_fires_once_at_first_question_acceptance() {
        let provider = crate::provider::fake::FakeProvider::new().scripted_tool_turn_seq(
            "how many people?",
            vec![Ok(ToolTurnReply::Text("42".into()))],
        );
        let mut session = Session::with_provider(Box::new(provider)).expect("session");
        let approval = crate::approval::ApprovalState::new();
        let keychain = super::KeychainStore::new();
        let inputs = super::TurnInputs::empty(&keychain);
        // The shared observation sequence pins the ORDERING contract: the
        // name push lands before the turn emits its first phase event (i.e.
        // ahead of everything the terminal state could race against).
        #[derive(Debug, PartialEq)]
        enum Obs {
            Named(String),
            Phase,
        }
        let obs: std::sync::Arc<std::sync::Mutex<Vec<Obs>>> = Default::default();
        let obs_phase = std::sync::Arc::clone(&obs);
        session.ask_with_phase_and_auto_name(
            "how many people?",
            &approval,
            &super::NullApprovalSink,
            move |phase| {
                if matches!(phase, crate::model::TurnPhase::Thinking { .. }) {
                    obs_phase.lock().expect("obs lock").push(Obs::Phase);
                }
            },
            |name| {
                obs.lock()
                    .expect("obs lock")
                    .push(Obs::Named(name.to_string()));
            },
            &inputs,
        );
        let obs = obs.lock().expect("obs lock");
        // Exactly one push across the whole turn (the turn-start site fired
        // it; the record_turn fallback re-set the same value silently) ...
        assert_eq!(obs.iter().filter(|o| matches!(o, Obs::Named(_))).count(), 1);
        // ... and it precedes the turn's first phase event.
        assert_eq!(
            obs.first(),
            Some(&Obs::Named("how many people?".to_string()))
        );
        drop(obs);
        assert_eq!(
            session.session_name(),
            Some("how many people?"),
            "the turn-start push names the session before the turn settles"
        );
    }

    /// Issue #1353: only the FIRST question names -- a session that already
    /// holds a recorded turn never auto-names (or fires the push) again.
    #[test]
    fn ask_with_auto_name_does_not_fire_on_subsequent_questions() {
        let provider = crate::provider::fake::FakeProvider::new()
            .scripted_tool_turn_seq(
                "first question",
                vec![Ok(ToolTurnReply::Text("answer 1".into()))],
            )
            .scripted_tool_turn_seq(
                "second question",
                vec![Ok(ToolTurnReply::Text("answer 2".into()))],
            );
        let mut session = Session::with_provider(Box::new(provider)).expect("session");
        let approval = crate::approval::ApprovalState::new();
        let keychain = super::KeychainStore::new();
        let inputs = super::TurnInputs::empty(&keychain);
        let mut fires = 0u32;
        for question in ["first question", "second question"] {
            session.ask_with_phase_and_auto_name(
                question,
                &approval,
                &super::NullApprovalSink,
                |_| {},
                |_| fires += 1,
                &inputs,
            );
        }
        assert_eq!(fires, 1, "only the first question's acceptance names");
        assert_eq!(session.session_name(), Some("first question"));
    }

    #[test]
    fn record_turn_does_not_overwrite_on_second_turn() {
        let (mut session, _duck) = session_with_recipe("");
        session.record_turn(
            "first question",
            TurnOutcome::Textual {
                text_kind: crate::model::TextKind::Agent,
                body: "answer 1".into(),
                assumption: None,
            },
            Vec::new(),
            Vec::new(),
            TurnRuntime::BuiltIn,
            None,
            Vec::new(),
            None, // no usage evidence (test fixture)
            None,
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
            TurnRuntime::BuiltIn,
            None,
            Vec::new(),
            None, // no usage evidence (test fixture)
            None,
        );
        assert_eq!(
            session.session_name(),
            Some("first question"),
            "subsequent turns do not overwrite the auto-name"
        );
    }

    #[test]
    fn record_turn_auto_name_truncates_long_question() {
        let (mut session, _duck) = session_with_recipe("");
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
            TurnRuntime::BuiltIn,
            None,
            Vec::new(),
            None, // no usage evidence (test fixture)
            None,
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
        let (mut session, _duck) = session_with_recipe("");
        // User renames before the first turn.
        session.rename("My Analysis").expect("rename");
        assert_eq!(session.session_name(), Some("My Analysis"));

        // First recorded turn: the acceptance-time naming (ADR-0089
        // Decision 4, calibrated by #1353) already fired, and record_turn's
        // same-value fallback re-applies the truncation here (the ADR
        // explicitly rejects a name_is_placeholder flag). The user rename
        // before the first turn is overwritten -- designed behavior: the
        // first question's truncation is more meaningful, and a user is
        // unlikely to rename before asking.
        session.record_turn(
            "what is the total?",
            TurnOutcome::Textual {
                text_kind: crate::model::TextKind::Agent,
                body: "100".into(),
                assumption: None,
            },
            Vec::new(),
            Vec::new(),
            TurnRuntime::BuiltIn,
            None,
            Vec::new(),
            None, // no usage evidence (test fixture)
            None,
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
            TurnRuntime::BuiltIn,
            None,
            Vec::new(),
            None, // no usage evidence (test fixture)
            None,
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
        let (mut session, _duck) = session_with_recipe("");
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
            TurnRuntime::BuiltIn,
            None,
            Vec::new(),
            None, // no usage evidence (test fixture)
            None,
        );
        assert_eq!(
            session.session_name(),
            Some("analyze people"),
            "source lifecycle events do not block auto-naming"
        );
    }

    #[test]
    fn record_turn_auto_names_on_failed_and_cancelled_first_turn() {
        // ADR-0089 Decision 4: naming is outcome-agnostic -- the
        // acceptance-time trigger already fired before any outcome existed,
        // and record_turn's fallback re-applies it for Failed / Cancelled /
        // Materialized, not just Textual (no match on outcome before
        // set_session_name). This test pins that contract so a future
        // `match outcome` guard does not silently regress it.
        let (mut session_a, _duck) = session_with_recipe("");
        session_a.record_turn(
            "why did it break?",
            TurnOutcome::Failed(crate::model::TurnFailure::Execute {
                detail: "cap exhausted".into(),
            }),
            Vec::new(),
            Vec::new(),
            TurnRuntime::BuiltIn,
            None,
            Vec::new(),
            None, // no usage evidence (test fixture)
            None,
        );
        assert_eq!(
            session_a.session_name(),
            Some("why did it break?"),
            "Failed first turn still auto-names"
        );

        let (mut session_b, _duck) = session_with_recipe("");
        session_b.record_turn(
            "never finished",
            TurnOutcome::Cancelled(None),
            Vec::new(),
            Vec::new(),
            TurnRuntime::BuiltIn,
            None,
            Vec::new(),
            None, // no usage evidence (test fixture)
            None,
        );
        assert_eq!(
            session_b.session_name(),
            Some("never finished"),
            "Cancelled first turn still auto-names"
        );
    }

    // --- is_timeline_empty (ADR-0089 Decision 6) --------------------------

    #[test]
    fn is_timeline_empty_true_for_fresh_session() {
        let session = Session::new().expect("session");
        assert!(
            session.is_timeline_empty(),
            "fresh session has an empty timeline"
        );
    }

    #[test]
    fn is_timeline_empty_false_after_ingest() {
        // An ingest adds a Source lifecycle event to the timeline.
        let dir = tempfile::tempdir().expect("tempdir");
        let csv = dir.path().join("people.csv");
        std::fs::write(&csv, "name,score\nAda,9\n").expect("write csv");
        let mut session = Session::with_provider(Box::new(FakeProvider::new())).expect("session");
        match session.ingest(&csv) {
            crate::model::LoadOutcome::Loaded(d) => assert_eq!(d.reference_name, "people"),
            other => panic!("ingest should load, got {other:?}"),
        }
        assert!(
            !session.is_timeline_empty(),
            "session with a source event is not empty"
        );
    }

    #[test]
    fn is_timeline_empty_false_after_turn() {
        // A turn (even Cancelled) adds a Turn entry to the timeline.
        let mut session = Session::new().expect("session");
        session.record_turn(
            "q",
            TurnOutcome::Cancelled(None),
            Vec::new(),
            Vec::new(),
            TurnRuntime::BuiltIn,
            None,
            Vec::new(),
            None, // no usage evidence (test fixture)
            None,
        );
        assert!(
            !session.is_timeline_empty(),
            "session with a turn is not empty"
        );
    }

    #[test]
    fn is_timeline_empty_false_after_skill_event() {
        // A skill lifecycle event occupies a timeline slot (ADR-0086, the
        // third TimelineEntry variant). v7 sessions no longer write one
        // (ADR-0119 Decision 2), but a migrated pre-v7 file still carries
        // them -- the emptiness read must see them regardless.
        use super::TimelineEntry;

        let mut session = Session::with_provider(Box::new(FakeProvider::new())).expect("session");
        session
            .timeline
            .push(TimelineEntry::Skill(crate::model::SkillLifecycleEvent {
                kind: crate::model::SkillLifecycleKind::Mount,
                name: "code-review".to_string(),
                actor: None,
            }));
        assert!(
            !session.is_timeline_empty(),
            "session with a skill lifecycle event is not empty"
        );
    }

    /// A turn whose SQL references a scratch file in the session temp dir
    /// survives close -> reopen through the copy-in snapshot pipeline
    /// (ADR-0137 Decision 4): the reference persists as a snapshot at live
    /// time, settle mints NO `assets/` dead file and leaves the SQL at its
    /// temp spelling (ADR-0137 Decision 6, issue #1383), and the reopen
    /// restores result_1 on a watermark hit without ever replaying the
    /// structurally dead temp reference. The bare-path workaround shape: a
    /// python/bash tool writes the csv, `read_csv_auto` reads it back.
    #[test]
    fn temp_sql_reference_survives_close_and_reopen_via_the_snapshot_pipeline() {
        use crate::model::ThreadEntry;

        let dir = tempfile::tempdir().expect("session dir");
        let duck = dir.path().join("recipe.json");

        // Bind FIRST: the snapshot pipeline derives its tree destination
        // from the bound duck path, and createSession binds from the start
        // (ADR-0089) -- an ask recorded before any binding has nowhere
        // durable to snapshot into.
        let mut session = Session::new().expect("session");
        session.bind_recipe(duck.clone(), "t".into()).expect("bind");

        // The scripted SQL must name a path inside the session temp dir,
        // which only exists once the session is constructed.
        let csv = session.temp_path.join("kline.csv");
        std::fs::write(
            &csv,
            "close,open
1,2
",
        )
        .expect("scratch csv");
        let sql = format!(
            "SELECT COUNT(*) AS n FROM read_csv_auto('{}')",
            csv.to_string_lossy()
        );
        session.provider = std::sync::Arc::new(FakeProvider::new().scripted_tool_turn_seq(
            "查",
            vec![
                Ok(materialize_call(&sql)),
                Ok(ToolTurnReply::Text("done".into())),
            ],
        ));
        let outcome = session.ask("查");
        assert!(
            matches!(outcome, TurnOutcome::Materialized { .. }),
            "the live turn materialized, got {outcome:?}"
        );

        // The scratch reference never registers as a dataset under its own
        // name -- only result_1 does.
        assert!(
            session.get("kline").is_none(),
            "the scratch reference is not a dataset"
        );

        // ADR-0137 Decision 6 (#1383): no `assets/` dead file is minted and
        // the recorded SQL keeps its temp spelling -- persistence rides the
        // copy-in snapshot pipeline, not a settle-time copy.
        assert!(
            !dir.path().join("assets").join("kline.csv").exists(),
            "no dead-file copy is minted under assets/"
        );
        let recipe = session.build_recipe();
        let turn = materialized_turn(&recipe);
        let promoted_sql = match &turn.outcome {
            crate::persistence::recipe::RecipeOutcome::Materialized { promotions, .. } => {
                promotions[0].sql.clone()
            }
            other => panic!("recorded outcome must be Materialized, got {other:?}"),
        };
        assert_eq!(
            promoted_sql,
            format!(
                "SELECT COUNT(*) AS n FROM read_csv_auto('{}')",
                csv.to_string_lossy()
            ),
            "the recorded SQL keeps its temp spelling"
        );

        drop(session);

        // Reopen LLM-free: the watermark hits against the snapshot
        // pipeline's companion state -- result_1 restores whole without
        // ever replaying the (structurally dead) temp reference.
        let resumed = Session::open_recipe(
            &duck,
            std::sync::Arc::new(crate::cancel::CancelToken::new()),
            Box::new(crate::provider::UnwiredProvider),
            Default::default(),
            |_| {},
            |_| panic!("no source issues expected"),
            |_| panic!("no active-abandoned callback expected"),
        )
        .expect("resume");
        assert!(
            resumed.get("result_1").is_some(),
            "the watermark hit restores result_1"
        );
        let any_failed = resumed.conversation().iter().any(|e| {
            matches!(
                e,
                ThreadEntry::Turn(t) if matches!(t.outcome, TurnOutcome::Failed(_))
            )
        });
        assert!(!any_failed, "no Failed turn after reopen");
    }

    /// A legacy recipe whose recorded SQL points into the per-session
    /// `assets/` tree (a pre-#1383 settle's materialized copy) still
    /// replays green on reopen while the copy is on disk: the absolute
    /// spelling rides ADR-0137 D4's full-path face (the legacy read-gate
    /// is retired), so the live turn's preflight allows the read, and
    /// with the companion dropped the replay leg re-executes the stored
    /// SQL against the copy and re-registers the result; a dead copy
    /// degrades per ADR-0035 instead.
    #[test]
    fn a_legacy_assets_reference_replays_green_on_reopen() {
        let dir = tempfile::tempdir().expect("session dir");
        let duck = dir.path().join("recipe.json");
        // What a pre-#1383 settle would have left: a dead file under assets/.
        let assets_csv = dir.path().join("assets").join("kline.csv");
        std::fs::create_dir_all(assets_csv.parent().expect("assets parent")).expect("dirs");
        std::fs::write(&assets_csv, "v\n1\n").expect("write assets copy");

        let mut session = Session::new().expect("session");
        session.bind_recipe(duck.clone(), "t".into()).expect("bind");
        let sql = format!(
            "SELECT COUNT(*) AS n FROM read_csv_auto('{}')",
            assets_csv.to_string_lossy()
        );
        session.provider = std::sync::Arc::new(FakeProvider::new().scripted_tool_turn_seq(
            "查",
            vec![
                Ok(materialize_call(&sql)),
                Ok(ToolTurnReply::Text("done".into())),
            ],
        ));
        let outcome = session.ask("查");
        assert!(
            matches!(outcome, TurnOutcome::Materialized { .. }),
            "the live turn referencing the assets copy materialized, got {outcome:?}"
        );
        drop(session);

        // Drop the companion so the watermark cannot hit: the replay leg
        // must re-execute the stored assets-path SQL and stay green.
        std::fs::remove_file(dir.path().join("analytics.duckdb")).expect("drop companion");
        let resumed = Session::open_recipe(
            &duck,
            std::sync::Arc::new(crate::cancel::CancelToken::new()),
            Box::new(crate::provider::UnwiredProvider),
            Default::default(),
            |_| {},
            |_| panic!("no source issues expected"),
            |_| panic!("no active-abandoned callback expected"),
        )
        .expect("resume");
        assert!(
            resumed.get("result_1").is_some(),
            "the replay re-registered result_1 from the assets copy"
        );
        let any_failed = resumed.conversation().iter().any(|e| {
            matches!(
                e,
                ThreadEntry::Turn(t) if matches!(t.outcome, TurnOutcome::Failed(_))
            )
        });
        assert!(!any_failed, "the legacy assets replay stays green");
    }

    /// The dead-file leg of the retired assets read-gate: when the legacy
    /// recipe's assets copy no longer exists at reopen, resume surfaces it
    /// through the source-missing face (the claim-time registration points
    /// at the dead copy), and an Abort leaves the on-disk recipe untouched
    /// -- the honest ADR-0035 degrade, no silent fallback, no dropped
    /// record.
    #[test]
    fn a_dead_assets_reference_surfaces_the_source_missing_face() {
        use crate::session::{SourceIssue, SourceResolution};

        let dir = tempfile::tempdir().expect("session dir");
        let duck = dir.path().join("recipe.json");
        // The copy exists for the live ask (the turn materializes off it),
        // then dies before the reopen.
        let assets_csv = dir.path().join("assets").join("kline.csv");
        std::fs::create_dir_all(assets_csv.parent().expect("assets parent")).expect("dirs");
        std::fs::write(
            &assets_csv,
            "v
1
",
        )
        .expect("write assets copy");

        let mut session = Session::new().expect("session");
        session.bind_recipe(duck.clone(), "t".into()).expect("bind");
        let sql = format!(
            "SELECT COUNT(*) AS n FROM read_csv_auto('{}')",
            assets_csv.to_string_lossy()
        );
        session.provider = std::sync::Arc::new(FakeProvider::new().scripted_tool_turn_seq(
            "查",
            vec![
                Ok(materialize_call(&sql)),
                Ok(ToolTurnReply::Text("done".into())),
            ],
        ));
        assert!(matches!(
            session.ask("查"),
            TurnOutcome::Materialized { .. }
        ));
        drop(session);

        std::fs::remove_file(&assets_csv).expect("kill the assets copy");
        std::fs::remove_file(dir.path().join("analytics.duckdb")).expect("drop companion");
        let issues = std::cell::RefCell::new(Vec::new());
        let outcome = Session::open_recipe(
            &duck,
            std::sync::Arc::new(crate::cancel::CancelToken::new()),
            Box::new(crate::provider::UnwiredProvider),
            Default::default(),
            |_| {},
            |issue| {
                issues.borrow_mut().push(issue);
                SourceResolution::Abort
            },
            |_| panic!("no active-abandoned callback expected"),
        );
        assert!(outcome.is_err(), "the dead assets copy aborts the resume");
        assert_eq!(issues.borrow().len(), 1, "exactly one source issue");
        assert!(
            matches!(&issues.borrow()[0], SourceIssue::Missing { .. }),
            "the issue is the missing-file face: {:?}",
            issues.borrow()[0]
        );
        assert!(
            duck.exists(),
            "the on-disk recipe is untouched by the abort"
        );
    }

    /// The retired bind-time migration (issue #1390): a derived source
    /// staged in the temp dir stays put across bind_recipe -- no `assets/`
    /// directory is minted beside the recipe, and both the descriptor and
    /// the persisted recipe keep the staging source_path. Persistence
    /// rides the copy-in snapshot pipeline; a staging path that dies with
    /// the temp dir degrades on resume through the source-missing face.
    #[test]
    fn bind_recipe_mints_no_assets_dir_for_staged_derived_sources() {
        let mut session = Session::new().expect("session");
        let staging_dir = session
            .temp_path
            .join(super::derived_source::DERIVED_STAGING_DIR);
        std::fs::create_dir_all(&staging_dir).unwrap();
        let staging_csv = staging_dir.join("data.csv");
        std::fs::write(&staging_csv, "id,name\n1,alice\n").unwrap();
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

        let duck_dir = tempfile::tempdir().expect("duck dir");
        let recipe_path = duck_dir.path().join("recipe.json");
        session
            .bind_recipe(recipe_path.clone(), "t".into())
            .expect("bind_recipe");

        assert!(
            !duck_dir.path().join("assets").exists(),
            "no assets/ minted beside the recipe"
        );
        let d = session.working_set.get("data").expect("data registered");
        assert!(
            d.source_path.contains("derived"),
            "the staging source_path is untouched: {}",
            d.source_path
        );
        let recipe = crate::persistence::read_recipe(&recipe_path).expect("read recipe");
        let src = recipe
            .sources
            .iter()
            .find(|s| s.reference_name == "data")
            .expect("data in recipe sources");
        assert!(
            src.source_path.contains("derived"),
            "the recipe keeps the staging path: {}",
            src.source_path
        );
    }

    /// The temp-staging spelling of the missing face: a derived source
    /// whose descriptor still points into the session's wiped temp staging
    /// dir (the pre-#1383 legacy recipe shape) degrades at a companion-less
    /// reopen exactly like a dead assets copy -- one Missing issue, an
    /// Abort, the on-disk recipe untouched. Live sessions snapshot into
    /// the session tree; this pins the staging spelling onto the same
    /// source-missing leg (issue #1390 review).
    #[test]
    fn a_wiped_staging_reference_surfaces_the_source_missing_face() {
        use crate::session::{SourceIssue, SourceResolution};

        let dir = tempfile::tempdir().expect("session dir");
        let duck = dir.path().join("recipe.json");
        let mut session = Session::new().expect("session");
        session.bind_recipe(duck.clone(), "t".into()).expect("bind");
        // Stage + register the legacy shape: source_path inside
        // temp_path/derived/. No materialized turn runs, so no companion is
        // minted -- the reopen takes the watermark-miss leg.
        let staging_csv = session
            .temp_path
            .join(super::derived_source::DERIVED_STAGING_DIR)
            .join("data.csv");
        std::fs::create_dir_all(staging_csv.parent().expect("staging parent")).expect("dirs");
        std::fs::write(&staging_csv, "id\n1\n").expect("write staging file");
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
                sample: vec![vec!["1".into()]],
                fingerprint: "abc".into(),
                rectify: crate::model::RectifyProvenance::NotApplicable,
                privacy: crate::model::DatasetPrivacy::default(),
                stale: None,
            });
        session.persist_if_bound();
        drop(session); // the TempDir wipe kills the staging file

        let issues = std::cell::RefCell::new(Vec::new());
        let outcome = Session::open_recipe(
            &duck,
            std::sync::Arc::new(crate::cancel::CancelToken::new()),
            Box::new(crate::provider::UnwiredProvider),
            Default::default(),
            |_| {},
            |issue| {
                issues.borrow_mut().push(issue);
                SourceResolution::Abort
            },
            |_| panic!("no active-abandoned callback expected"),
        );
        assert!(outcome.is_err(), "the wiped staging path aborts the resume");
        assert_eq!(issues.borrow().len(), 1, "exactly one source issue");
        assert!(
            matches!(&issues.borrow()[0], SourceIssue::Missing { .. }),
            "the issue is the missing-file face: {:?}",
            issues.borrow()[0]
        );
        assert!(
            duck.exists(),
            "the on-disk recipe is untouched by the abort"
        );
    }

    /// A persistent break cause degrades the conversation from the
    /// breakpoint on without ever dropping a recorded turn: repeated
    /// close/reopen cycles keep every turn the intervening sessions added
    /// (ADR-0035 Decision 2 -- display degrades from the breakpoint on, the
    /// persisted history does not), the result_N minting waterline never
    /// reuses a recorded number (ADR-0022), and restoring the dead reference
    /// returns the whole conversation to Materialized on the next resume.
    #[test]
    fn degraded_tail_survives_repeated_resumes_and_recovers() {
        use crate::model::ThreadEntry;
        use crate::provider::UnwiredProvider;

        let dir = tempfile::tempdir().expect("session dir");
        let duck = dir.path().join("recipe.json");

        let mut session = Session::new().expect("session");
        session.bind_recipe(duck.clone(), "t".into()).expect("bind");
        let csv = |name: &str, body: &str| {
            let p = session.temp_path.join(name);
            std::fs::write(&p, format!("v\n{body}\n")).expect("scratch csv");
            p
        };
        let read_sql = |p: &std::path::Path| {
            format!(
                "SELECT COUNT(*) AS n FROM read_csv_auto('{}')",
                p.to_string_lossy()
            )
        };

        // Three recorded turns: result_1 reads a user-directory original
        // (outlives the session, so its replay stays green across the
        // degrade window), result_2 reads a temp scratch file (the recorded
        // SQL keeps its temp spelling -- ADR-0137 Decision 6 minted no
        // assets/ copy -- and the temp dir dies with the session: the break
        // cause), result_3 is a plain table read with no read_* path.
        let user_dir = tempfile::tempdir().expect("user dir");
        let k1 = user_dir.path().join("kline.csv");
        std::fs::write(&k1, "v\n1\n").expect("user csv");
        let k2 = csv("kline2.csv", "2");
        session.provider = std::sync::Arc::new(FakeProvider::new().scripted_tool_turn_seq(
            "查",
            vec![
                Ok(materialize_call(&read_sql(&k1))),
                Ok(ToolTurnReply::Text("done".into())),
                Ok(materialize_call(&read_sql(&k2))),
                Ok(ToolTurnReply::Text("done".into())),
                Ok(materialize_call("SELECT COUNT(*) AS n FROM result_1")),
                Ok(ToolTurnReply::Text("done".into())),
            ],
        ));
        for _ in 0..3 {
            assert!(
                matches!(session.ask("查"), TurnOutcome::Materialized { .. }),
                "all three live turns materialize"
            );
        }
        drop(session);

        // The persistent break cause is structural since ADR-0137 Decision
        // 6: the recorded SQL keeps its temp spelling and the temp dir died
        // with the process, so every replay breaks at result_2 until the
        // file is restored at its recorded path. The companion is removed
        // too: with it present the open would HIT and restore the
        // pre-degrade working set whole (ADR-0136 Why 3 -- the hit path's
        // replay-break failure surface is gone); forcing the miss is what
        // keeps the DEGRADE machinery under test (see the sibling test
        // below for the hit-path counterpart).
        std::fs::remove_file(dir.path().join("analytics.duckdb")).expect("drop companion");

        // Reopen 1: replay breaks at result_2 -> turns 2 and 3 degrade
        // (break Failed + not-attempted Failed), nothing drops. Then one new
        // turn -- the mint must take result_4 (the recorded result_2 /
        // result_3 are absent from the working set; only the ADR-0022
        // waterline keeps their numbers off the table).
        let mut s1 = Session::open_recipe(
            &duck,
            std::sync::Arc::new(crate::cancel::CancelToken::new()),
            Box::new(FakeProvider::new().scripted_tool_turn_seq(
                "再查",
                vec![
                    Ok(materialize_call("SELECT COUNT(*) AS n FROM result_1")),
                    Ok(ToolTurnReply::Text("done".into())),
                ],
            )),
            Default::default(),
            |_| {},
            |_| panic!("no source issues expected"),
            |_| panic!("no active-abandoned callback expected"),
        )
        .expect("resume 1");
        assert_eq!(s1.conversation().len(), 3, "no recorded turn dropped");
        assert!(s1.get("result_1").is_some());
        assert!(
            s1.get("result_2").is_none() && s1.get("result_3").is_none(),
            "the degraded turns contribute no working-set results"
        );
        match s1.ask("再查") {
            TurnOutcome::Materialized { promotions, .. } => {
                assert_eq!(
                    promotions.last().map(|p| p.dataset.reference_name.as_str()),
                    Some("result_4"),
                    "the mint takes the waterline number, not the absent result_2"
                );
            }
            other => panic!("the post-degrade ask materializes, got {other:?}"),
        }
        drop(s1);

        // Reopen 2 with the cause STILL present: the same break recurs and
        // the turn added between the resumes must survive it -- the recorded
        // history is never re-truncated (the recurring-shredder regression).
        let s2 = Session::open_recipe(
            &duck,
            std::sync::Arc::new(crate::cancel::CancelToken::new()),
            Box::new(UnwiredProvider),
            Default::default(),
            |_| {},
            |_| panic!("no source issues expected"),
            |_| panic!("no active-abandoned callback expected"),
        )
        .expect("resume 2");
        assert_eq!(
            s2.conversation().len(),
            4,
            "the turn added during the degraded window survives the recurring break"
        );
        assert!(s2.get("result_1").is_some());
        drop(s2);

        // Restore the dead reference at its recorded temp path (the dir
        // itself died with the session, so it is recreated): the next
        // resume replays the whole chain green and the entire conversation
        // returns to Materialized.
        std::fs::create_dir_all(k2.parent().expect("temp parent"))
            .and_then(|_| std::fs::write(&k2, "v\n2\n"))
            .expect("restore");
        let s3 = Session::open_recipe(
            &duck,
            std::sync::Arc::new(crate::cancel::CancelToken::new()),
            Box::new(UnwiredProvider),
            Default::default(),
            |_| {},
            |_| panic!("no source issues expected"),
            |_| panic!("no active-abandoned callback expected"),
        )
        .expect("resume 3");
        let any_failed = s3.conversation().iter().any(|e| {
            matches!(
                e,
                ThreadEntry::Turn(t) if matches!(t.outcome, TurnOutcome::Failed(_))
            )
        });
        assert!(!any_failed, "the recovered conversation has no Failed turn");
        for name in ["result_1", "result_2", "result_3", "result_4"] {
            assert!(s3.get(name).is_some(), "{name} re-materialized on recovery");
        }
    }

    /// The ADR-0136 hit-path counterpart of the degrade test above: with the
    /// companion intact, a structurally dead replay reference after settle
    /// does NOT degrade the reopen -- the watermark hits, the working set
    /// restores whole, and the replay-break failure surface simply never
    /// runs (ADR-0136 Why 3: recovery determinism -- the settled data
    /// survives in the companion, independent of the replay path's dead
    /// reference). Since ADR-0137 Decision 6 (#1383) the dead reference is
    /// the NORMAL shape: no `assets/` dead file is ever minted and the
    /// recorded SQL keeps its temp spelling.
    #[test]
    fn a_deleted_replay_asset_does_not_degrade_a_watermark_hit_reopen() {
        use crate::provider::UnwiredProvider;

        let dir = tempfile::tempdir().expect("session dir");
        let duck = dir.path().join("recipe.json");
        let assets = |name: &str| dir.path().join("assets").join(name);

        let mut session = Session::new().expect("session");
        session
            .bind_recipe(duck.clone(), "hit".into())
            .expect("bind");
        let k1 = session.temp_path.join("kline.csv");
        std::fs::write(&k1, "v\n1\n").expect("scratch csv");

        session.provider = std::sync::Arc::new(FakeProvider::new().scripted_tool_turn_seq(
            "查",
            vec![
                Ok(materialize_call(&format!(
                    "SELECT COUNT(*) AS n FROM read_csv_auto('{}')",
                    k1.to_string_lossy()
                ))),
                Ok(ToolTurnReply::Text("done".into())),
            ],
        ));
        assert!(matches!(
            session.ask("查"),
            TurnOutcome::Materialized { .. }
        ));
        drop(session);

        // The dead-file copy the original test deleted is never minted
        // (ADR-0137 Decision 6) -- the dead reference is the recorded SQL's
        // temp spelling itself, and the companion still matches the settled
        // chain.
        assert!(
            !assets("kline.csv").exists(),
            "no dead-file copy was minted under assets/"
        );

        let resumed = Session::open_recipe(
            &duck,
            std::sync::Arc::new(crate::cancel::CancelToken::new()),
            Box::new(UnwiredProvider),
            Default::default(),
            |_| panic!("the hit path fires no progress events"),
            |_| panic!("no source issues expected"),
            |_| panic!("no active-abandoned callback expected"),
        )
        .expect("hit resume");
        assert!(
            resumed.get("result_1").is_some(),
            "the settled result survives in the companion; the dead asset is irrelevant on a hit"
        );
        let any_failed = resumed.conversation().iter().any(|e| {
            matches!(
                e,
                ThreadEntry::Turn(t) if matches!(t.outcome, TurnOutcome::Failed(_))
            )
        });
        assert!(!any_failed, "a hit reopen never degrades");
    }
}
