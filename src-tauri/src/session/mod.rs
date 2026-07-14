//! Per-session state: an in-memory DuckDB parent (working-set metadata + future
//! result_N) plus READ_ONLY-attached source snapshots (ADR-0004/0005/0012). The
//! per-session temp dir holds the snapshot files and is cleared on drop (ADR-0012).

pub mod materializer;
pub mod resume;
pub mod sandbox;
pub mod snapshot;
pub mod source_lifecycle;
pub mod turn_runner;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use calamine::Data;
use duckdb::Connection;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

use crate::cancel::CancelToken;
use crate::guardrail::{apply_resource_caps, DEFAULT_MAX_RESULT_ROWS};
use crate::ingest;
use crate::ingest::schema::quote_ident;
use crate::ingest::tidy::{auto_tidy, forward_fill_merges, TidyOutcome};
use crate::model::{
    DatasetDescriptor, DatasetPrivacy, GuidanceRequest, GuidanceSheet, LoadError, LoadOutcome,
    RectifyProvenance, RenameError, RowPage, SheetGuidance, SheetRectify, SourceLifecycleKind,
    ThreadEntry, TurnError, TurnOutcome, TurnPhase, TurnRecord,
};
use crate::persistence::recipe::{Recipe, RecipeEntry, RecipeOutcome, RecipeTurn, SourceRef};
use crate::persistence::registry::{canonicalize_duck, release, try_acquire};
use crate::persistence::{read_duck, save_atomic, SaveError};
use crate::provider::{Provider, UnwiredProvider};
use crate::session::materializer::{RealMaterializer, TurnDeps};
use crate::session::turn_runner::TurnRunner;
use crate::session_store::ClosingFlag;
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

/// Per-source integrity issue surfaced during resume (ADR-0035 honest degrade,
/// issue #49). Passed to the caller's [`Session::open_duck`] `on_source_issue`
/// callback so the UI (or test) can drive the re-link / abort / rebuild
/// decision -- the engine NEVER silently picks. Each variant names the source
/// + the path/fingerprint context the decision needs.
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

/// A pre-write external-change conflict surfaced by the hash check (ADR-0035
/// Decision 3, issue #50). When the `.duck` file's current on-disk hash differs from
/// the baseline the session recorded after its last successful write, the
/// auto-write is SUSPENDED and this notice is stashed in
/// [`Session::pending_conflict`] for the caller to read via
/// [`Session::take_pending_conflict`]. The engine NEVER silently clobbers the
/// externally-edited file; the caller resolves the conflict with one of three
/// options (reload / keep mine / save as new) via
/// [`Session::conflict_keep_mine`] / [`Session::conflict_save_as_new`] (and
/// drop + reopen for reload).
#[derive(Debug, Clone, serde::Serialize)]
pub struct PendingConflict {
    /// The bound `.duck` path whose on-disk content diverged.
    pub path: PathBuf,
    /// The hash the session recorded after its last successful write -- what
    /// the session believes the disk file SHOULD look like.
    pub expected_hash: String,
    /// The hash the session just computed from the file on disk -- evidence
    /// that an external edit (another window, a text editor, a sync tool)
    /// changed the file under us.
    pub found_hash: String,
}

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

/// SHA-256 of a `.duck` file's bytes (ADR-0035 Decision 3, issue #50). Used as the
/// pre-write external-change baseline: the session records this after every
/// successful write and compares the file's current hash before the next write.
/// The recipe is small text, so a whole-file read is the KISS choice (no
/// streaming needed at v1). Returns `Ok(None)` when the file does not exist --
/// a missing file is not a conflict (the next write recreates it; there is
/// nothing on disk to clobber), so the caller proceeds without a baseline.
fn hash_file(path: &Path) -> Result<Option<String>, std::io::Error> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let digest = hasher.finalize();
    Ok(Some(digest.iter().map(|b| format!("{b:02x}")).collect()))
}

pub struct Session {
    conn: Connection,
    working_set: WorkingSet,
    _temp_dir: TempDir, // held to keep its dir alive; cleared on drop (ADR-0012)
    temp_path: PathBuf,
    /// The turn orchestrator (ADR-0053): owns the retry loop, the cancel/in-
    /// flight guard, the optional timeout watchdog, and the outcome routing.
    /// Holds the provider and the materializer behind `Box<dyn ...>` (dyn, not
    /// generic) so this struct does not parameterize `commands.rs` / `lib.rs`.
    /// Built in [`Self::with_provider_and_cancel`]; `ask` is a facade over its
    /// [`TurnRunner::run_with_phase`].
    turn_runner: TurnRunner,
    /// The conversation thread (ADR-0028/0039/0040): a unified timeline of turns
    /// AND source lifecycle events, in order. The source of truth the frontend
    /// renders; the window assembler reads only the turns (via [`Self::turns`]),
    /// so source events occupy a timeline slot and stay always-visible yet never
    /// enter the LLM turn window or advance result_N (ADR-0040).
    history: Vec<ThreadEntry>,
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
    /// The bound `.duck` path (ADR-0034). When `Some`, every terminal turn
    /// and source lifecycle event atomically rewrites the recipe at this path
    /// (temp + rename, whole-file). `None` until the user saves / opens a
    /// `.duck` -- an in-memory-only session (the pre-persistence behavior).
    duck_path: Option<PathBuf>,
    /// The user-facing session name (ADR-0034). Carried in the recipe header
    /// and shown on resume; `None` for an in-memory-only session (the recipe
    /// falls back to an empty name).
    session_name: Option<String>,
    /// The most recent per-turn atomic-write failure (ADR-0034). Set by
    /// [`Self::persist_if_bound`] when a save fails (the typed [`SaveError`],
    /// captured verbatim -- issue #120); cleared by
    /// [`Self::take_persist_error`]. The in-memory turn always advances
    /// regardless (the user's work stays live); this field lets the UI
    /// surface the disk-vs-memory drift instead of silently relying on the
    /// next successful write to self-heal (ADR-0035 honest signal -- a
    /// dropped save is a correctness gap, not just a log line).
    persist_error: Option<SaveError>,
    /// The canonical form of [`Self::duck_path`] (ADR-0035 Decision 3, issue #50):
    /// the registry key under which this session holds the file. Every
    /// spelling of the same on-disk file collapses to one canonical path, so
    /// the single-writer contract cannot be evaded by a path synonym.
    /// `None` while unbound; set on bind / open and released on Drop.
    duck_canonical: Option<PathBuf>,
    /// SHA-256 of the `.duck` file's bytes as of the session's last
    /// successful write (ADR-0035 Decision 3, issue #50). The pre-write hash check
    /// compares the file's current hash against this baseline: a mismatch
    /// means an external edit landed between writes and the auto-write is
    /// suspended (never a silent clobber). `None` until the first successful
    /// write to a bound path; on `open_duck` it is seeded from the file as
    /// read (the resume baseline) so an external edit DURING resume is also
    /// caught.
    last_written_hash: Option<String>,
    /// A pre-write external-change conflict surfaced by the hash check
    /// (ADR-0035 Decision 3, issue #50). Set when the on-disk hash diverged from
    /// [`Self::last_written_hash`]; cleared by
    /// [`Self::take_pending_conflict`] or a successful conflict resolution.
    /// The auto-write is suspended while this is `Some` -- the engine never
    /// silently overwrites the externally-edited file.
    pending_conflict: Option<PendingConflict>,
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
        let conn = Connection::open_in_memory()?;
        // Engine-level resource caps (ADR-0005 L3): bind memory + threads before
        // any query runs so a runaway LLM SQL cannot OOM or monopolize the
        // machine. Best-effort; apply_resource_caps logs+swallows a rejection.
        apply_resource_caps(&conn);
        // TurnRunner owns the provider + materializer behind `Box<dyn>` (dyn,
        // not generic) so this struct does not parameterize the IPC layer
        // (ADR-0053). The materializer is stateless (RealMaterializer); the
        // admin connection / source_files / working_set it borrows live on this
        // Session and are passed per turn via TurnDeps.
        let turn_runner =
            TurnRunner::new(provider, Box::new(RealMaterializer), Arc::clone(&cancel));
        Ok(Self {
            conn,
            working_set: WorkingSet::default(),
            _temp_dir: temp_dir,
            temp_path,
            turn_runner,
            history: Vec::new(),
            result_row_cap: DEFAULT_MAX_RESULT_ROWS,
            result_count_cap: DEFAULT_RESULT_COUNT_CAP,
            source_files: HashMap::new(),
            cancel,
            closing: ClosingFlag::new(),
            duck_path: None,
            session_name: None,
            persist_error: None,
            duck_canonical: None,
            last_written_hash: None,
            pending_conflict: None,
            drop_signal: None,
        })
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

    /// Set a wall-clock ceiling on each turn (ADR-0005/0021 statement-timeout
    /// path). Forwards to the [`TurnRunner`], whose watchdog fires cancel on
    /// expiry; the running query is interrupted and the turn lands as Cancelled
    /// (ADR-0028 outcome D). `None` disables the turn-level timeout (the
    /// default; engine resource caps still apply). Tunable for deterministic
    /// timeout tests.
    pub fn set_turn_timeout(&mut self, timeout: Option<Duration>) {
        self.turn_runner.set_turn_timeout(timeout);
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
        let canonical = canonicalize_duck(&path).map_err(|e| SaveError::Io(e.to_string()))?;
        // Single-writer gate. Re-binding the SAME canonical path on this
        // session is an update (Save over the open file) and skips the
        // acquire; any other path -- including one another session holds --
        // goes through try_acquire, which refuses a duplicate.
        if self.duck_canonical.as_deref() != Some(canonical.as_path()) {
            if !try_acquire(&canonical) {
                return Err(SaveError::AlreadyOpen(canonical));
            }
            // Acquired the new key; release the old one (if any) so a
            // different session can open the previous .duck.
            if let Some(old) = self.duck_canonical.take() {
                release(&old);
            }
        }
        self.duck_canonical = Some(canonical);
        self.duck_path = Some(path);
        self.session_name = Some(session_name);
        // The first write to a newly bound path has no baseline to compare
        // against, so persist directly (persist_if_bound would also work --
        // last_written_hash is None -> skip the check); subsequent writes go
        // through persist_if_bound's hash check.
        let result = self.persist();
        if result.is_ok() {
            // Write succeeded -- seed the baseline so the next persist_if_bound
            // can detect an external edit. Best-effort (no `?`): a hash read
            // failure leaves last_written_hash = None, which makes the next
            // write skip the check. Returning an Err AFTER a successful write
            // would mislead the caller into retrying an already-applied bind.
            // Consistent with persist_if_bound / conflict_keep_mine.
            if let Some(path) = self.duck_path.as_deref() {
                if let Some(h) = hash_file(path).ok().flatten() {
                    self.last_written_hash = Some(h);
                }
            }
            // A freshly bound path has no pending conflict -- the baseline is now.
            self.pending_conflict = None;
        }
        // On Err: the binding still takes effect (in-memory state is correct;
        // the next turn's persist_if_bound retries the write). last_written_hash
        // is LEFT AS NONE on purpose -- the disk content is unknown after a
        // failed write, so seeding a baseline here would either freeze the
        // wrong bytes (a false conflict later) or match a later read and
        // silence the check. With baseline = None the next persist_if_bound
        // skips the check and writes -- acceptable because bind_duck is an
        // explicit user action, not an auto-save that ADR-0035 Decision 3
        // protects from clobbering.
        result
    }

    /// The bound `.duck` path, if any (ADR-0034). `None` for an in-memory-only
    /// session (the pre-persistence behavior).
    pub fn duck_path(&self) -> Option<&Path> {
        self.duck_path.as_deref()
    }

    /// The user-facing session name, if bound to a `.duck` (ADR-0034).
    pub fn session_name(&self) -> Option<&str> {
        self.session_name.as_deref()
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
        let resume_baseline = hash_file(path)
            .map_err(|e| ResumeError::Load(crate::persistence::io::LoadError::Io(e.to_string())))?;
        let mut session = Session::with_provider_and_cancel(provider, cancel)
            .map_err(|e| ResumeError::Load(crate::persistence::io::LoadError::Io(e.to_string())))?;
        session.session_name = Some(recipe.session_name.clone());
        session.last_written_hash = resume_baseline;
        session.duck_canonical = Some(canonical.clone());

        // Phase 1: re-read + verify each source (interactive re-link / rebuild).
        // Returns the set of rebuilt (dropped) sources; recipe.sources[i] is
        // updated in place for any relinked path.
        let rebuilt =
            session.resume_sources(path, &mut recipe, &mut on_progress, &mut on_source_issue)?;

        // Phase 2/3/4 via the Resumer deep module (ADR-0053 Decision 3): the
        // Resumer borrows the shared cancel + the SAME Materializer trait
        // object the live-turn path drives + the recipe. It does NOT hold the
        // Session -- each phase method borrows working_set / TurnDeps and
        // returns a structured result, which open_duck applies. Scoped so the
        // Resumer (and its disjoint-field borrows of session.cancel /
        // session.turn_runner) drops before phase 5's &mut session persist.
        {
            let mut resumer = resume::Resumer::new(
                &session.cancel,
                session.turn_runner.materializer_mut(),
                &recipe,
            );
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
                    source_files: &session.source_files,
                    working_set: &mut session.working_set,
                    result_row_cap: session.result_row_cap,
                    result_count_cap: session.result_count_cap,
                    temp_path: &session.temp_path,
                };
                resumer.replay(&mut deps, &mut on_progress)?
            };
            // Phase 4: rebuild the conversation timeline, truncated at the
            // replay breakpoint (if any). Post-break entries are dropped
            // ("对话停在断点").
            let timeline =
                resumer.rebuild_timeline(&mut session.working_set, replay_break.as_ref())?;
            session.history = timeline;
        }

        // Phase 5: re-bind the .duck path + persist the post-resume state.
        // build_recipe reads the live working set, so relinked paths, dropped
        // (rebuilt) sources, and the truncated timeline (failed turn at K)
        // land in the persisted recipe. A failure is non-blocking -- the
        // session is live; the banner surfaces the disk-vs-memory drift.
        // The post-resume persist runs the external-change hash check against
        // the resume_baseline seeded above -- if the file changed under us
        // during resume, the write is suspended and pending_conflict is set
        // (the caller surfaces the conflict UI; never a silent clobber).
        session.duck_path = Some(path.to_path_buf());
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
                detail: format!("挂载快照失败：{e}"),
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
    /// (recent_files, sidebar addressing, open_duck) stays valid; nothing else
    /// is rewritten or propagated. Trims surrounding whitespace and rejects a
    /// blank name. For a never-saved (unbound) session the name is still set in
    /// memory so the next save-as carries it; [`Self::persist_if_bound`] is a
    /// no-op when no `.duck` is bound. The persist is best-effort (like every
    /// terminal turn): a write failure does not roll back the in-memory rename --
    /// it surfaces via [`Self::take_persist_error`] and self-heals on the next
    /// successful write. Returns the trimmed name that landed.
    pub fn rename(&mut self, new_name: &str) -> Result<String, String> {
        let trimmed = new_name.trim();
        if trimmed.is_empty() {
            return Err("会话名不能为空".to_string());
        }
        let name = trimmed.to_string();
        self.session_name = Some(name.clone());
        self.persist_if_bound();
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

    /// Run one turn (PRD #1): assemble a schema-aware request, ask the provider
    /// (ADR-0009 contract: SQL or textual), and produce exactly one ADR-0028
    /// outcome -- result / textual / failed / cancelled. The single retry budget
    /// (malformed output + schema/runtime error) is consumed invisibly; on
    /// exhaustion the turn fails honestly. A cancel or timeout (ADR-0021) aborts
    /// to Cancelled and leaves the working set untouched. Every turn is recorded
    /// in the conversation thread (always visible, ADR-0028/0039); only a result
    /// advances result_N. Infallible -- a question always yields one outcome.
    pub fn ask(&mut self, question: &str) -> TurnOutcome {
        // Facade over TurnRunner (ADR-0053): assemble the provider request,
        // compute the stable result_N (a failed attempt registers nothing, so N
        // is stable across retries -- ADR-0022), drive the orchestrator with the
        // shared session state borrowed via TurnDeps, then record the outcome.
        // The retry / cancel / error-routing that used to live inline here
        // moved to [`TurnRunner::run_with_phase`]; `record_turn` stays on the facade (the
        // conversation timeline + persistence are session concerns, not turn
        // orchestration -- ADR-0053 Decision 2).
        self.ask_with_phase(question, |_| {})
    }

    /// Run one turn AND surface its discrete progress phases (ADR-0059). Same
    /// semantics as [`Self::ask`]; the `on_phase` callback receives a
    /// [`TurnPhase`] marker at each wait boundary (Thinking before the provider
    /// call, Querying before SQL execution), carrying the 1-based attempt so a
    /// blind retry is honestly visible. The command layer wraps this callback to
    /// emit the side-channel `turn-progress` Tauri event addressed by sessionId
    /// (ADR-0056/0059); the phase never enters the [`TurnOutcome`] contract.
    pub fn ask_with_phase(
        &mut self,
        question: &str,
        on_phase: impl FnMut(TurnPhase),
    ) -> TurnOutcome {
        let turns = self.turns();
        let request = window::assemble(question, &self.working_set, &turns);
        let result_name = format!("result_{}", self.working_set.next_result_number());
        // Disjoint field borrows: `run_with_phase` takes `&mut self.turn_runner`
        // while TurnDeps borrows `&self.conn` / `&self.source_files` /
        // `&mut self.working_set` / `&self.temp_path` -- distinct Session
        // fields, so they coexist without widening to `&mut self`. The block
        // scope drops the deps borrow before `record_turn` takes its own
        // `&mut self`.
        let outcome = {
            let mut deps = TurnDeps {
                conn: &self.conn,
                source_files: &self.source_files,
                working_set: &mut self.working_set,
                result_row_cap: self.result_row_cap,
                result_count_cap: self.result_count_cap,
                temp_path: &self.temp_path,
            };
            self.turn_runner
                .run_with_phase(&request, result_name, &mut deps, on_phase)
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
        self.record_turn(question, outcome)
    }

    /// Append a turn to the conversation thread and return its outcome. Every
    /// outcome kind is recorded (ADR-0028 always-visible); the caller has
    /// already decided the outcome, so this just persists + returns it. The turn
    /// is wrapped in a [`ThreadEntry::Turn`] -- source lifecycle events share
    /// the same timeline (ADR-0040) but never enter the LLM window.
    fn record_turn(&mut self, question: &str, outcome: TurnOutcome) -> TurnOutcome {
        self.history.push(ThreadEntry::Turn(TurnRecord {
            question: question.to_string(),
            outcome: outcome.clone(),
        }));
        // ADR-0034 per-terminal-turn atomic write: the recipe is rewritten
        // whole-file at the bound path (temp + rename). No-op when no .duck
        // is bound; a failure is logged (the prior file is intact and the
        // next turn retries).
        self.persist_if_bound();
        outcome
    }

    /// Append a source lifecycle event (ADR-0040) to the timeline. The event is
    /// first-class (always visible, occupies a slot) but NOT a turn, so it never
    /// enters the LLM window or advances result_N. The display label is carried
    /// verbatim so the thread can still name a dataset after it's removed.
    /// Build the recipe (ADR-0034) describing the current working set. The
    /// recipe is organized by current state, not as a historical ledger:
    /// only LIVE productive turns ride the replayable chain, while a stale
    /// (cascade-invalidated) result_N's turn stays in `history` marked stale
    /// (ADR-0041 point 2: kept for display + the LLM window, never replayed)
    /// rather than being silently dropped. A Materialized turn whose
    /// `result_N` is gone entirely (removed/GC'd, no descriptor) is dropped
    /// -- without a descriptor the turn cannot replay or render.
    pub fn build_recipe(&self) -> Recipe {
        // ADR-0036 Decision 4 hybrid paths: `source_path` is always absolute (fallback
        // resolver); `relative_path` is set when the source lives inside the
        // .duck file's directory subtree (primary resolver, survives "move the
        // folder"). strip_prefix succeeds exactly when the source is in the
        // subtree (cross-volume / outside-subtree -> None). Components are
        // rejoined with '/' so the stored path is cross-platform portable
        // (Path::join accepts '/' on Windows; POSIX-only readers can resolve it
        // too). Computed only when a .duck is bound -- an unbound session has
        // no .duck directory to be relative to, so relative_path stays None.
        let duck_dir = self.duck_path.as_deref().and_then(Path::parent);
        let sources: Vec<SourceRef> = self
            .working_set
            .list()
            .iter()
            .filter(|d| !self.working_set.is_result(&d.reference_name))
            .map(|d| {
                let relative_path = duck_dir
                    .and_then(|dir| Path::new(&d.source_path).strip_prefix(dir).ok())
                    .map(|rel| {
                        rel.components()
                            .filter_map(|c| c.as_os_str().to_str())
                            .collect::<Vec<_>>()
                            .join("/")
                    });
                SourceRef {
                    reference_name: d.reference_name.clone(),
                    display_name: d.display_name.clone(),
                    source_path: d.source_path.clone(),
                    relative_path,
                    rectify: d.rectify.clone(),
                    fingerprint: d.fingerprint.clone(),
                }
            })
            .collect();

        let history: Vec<RecipeEntry> = self
            .history
            .iter()
            .filter_map(|entry| match entry {
                ThreadEntry::Turn(record) => {
                    let outcome = match &record.outcome {
                        TurnOutcome::Materialized {
                            dataset,
                            sql,
                            viz: _,
                            assumption,
                        } => {
                            // The result_N must still be registered (a GC'd or
                            // otherwise removed descriptor leaves no trace --
                            // the turn cannot replay or render, so drop it).
                            // `?` here returns None from the filter_map closure
                            // (drop this entry), NOT from build_recipe.
                            let descriptor = self.working_set.get(&dataset.reference_name)?;
                            // sql is Some on every fresh Materialized turn; a
                            // None predates the field and cannot replay, so
                            // drop the turn rather than fabricate SQL. (A stale
                            // turn also keeps its SQL -- ADR-0041 point 2: the
                            // verbatim SQL stays visible in the window.)
                            let sql = sql.clone()?;
                            // display_name comes from the working set's CURRENT
                            // state, not the ask-time snapshot in history -- a
                            // user rename (ADR-0037) updates the working set,
                            // not the history entry, so the snapshot is stale.
                            let display_name = descriptor.display_name.clone();
                            RecipeOutcome::Materialized {
                                reference_name: dataset.reference_name.clone(),
                                display_name,
                                sql,
                                assumption: assumption.clone(),
                                // ADR-0041: a live result -> stale None
                                // (replayed); a cascade-invalidated result ->
                                // the anchor from its descriptor (dead turn,
                                // kept in history, never replayed). The anchor
                                // is what the UI's stale badge reads, so a
                                // reopen renders the same "invalidated by"
                                // provenance as the live session did.
                                stale: descriptor.stale.clone(),
                            }
                        }
                        TurnOutcome::Textual {
                            text_kind,
                            body,
                            assumption,
                        } => RecipeOutcome::Textual {
                            text_kind: *text_kind,
                            body: body.clone(),
                            assumption: assumption.clone(),
                        },
                        TurnOutcome::Failed { reason } => RecipeOutcome::Failed {
                            reason: reason.clone(),
                        },
                        TurnOutcome::Cancelled => RecipeOutcome::Cancelled,
                    };
                    Some(RecipeEntry::Turn(RecipeTurn {
                        question: record.question.clone(),
                        outcome,
                    }))
                }
                ThreadEntry::Source(ev) => Some(RecipeEntry::Source(ev.clone())),
            })
            .collect();

        let active = self.working_set.active().map(|d| d.reference_name.clone());

        // Route construction through the invariant-validating constructor.
        // The working set's own invariants guarantee build() succeeds here
        // -- `active` always tracks a registered source
        // (or None), `result_N` numbering is never reused (ADR-0022), and
        // source events always carry non-empty names -- so a failure is a
        // logic bug, surfaced fail-fast rather than persisted as a corrupt
        // recipe read_duck would later reject.
        Recipe::build(
            self.session_name.clone().unwrap_or_default(),
            sources,
            history,
            active,
        )
        .expect("Session::build_recipe produces a recipe satisfying Recipe::build invariants")
    }

    /// Rewrite the recipe at the bound path (ADR-0034 atomic write). No-op
    /// when no `.duck` is bound (in-memory-only session). A save failure does
    /// NOT roll back the in-memory turn -- the user's work stays live; the
    /// next turn retries the write and the prior recipe on disk is intact
    /// (temp + rename never leaves a half-written target).
    fn persist(&self) -> Result<(), SaveError> {
        let Some(path) = &self.duck_path else {
            return Ok(());
        };
        let recipe = self.build_recipe();
        save_atomic(path, &recipe)
    }

    /// Fire [`Self::persist`] after a terminal event, capturing a failure
    /// instead of propagating: a per-turn save error must not abort the turn
    /// (the in-memory state is already advanced; the disk copy self-heals on
    /// the next successful write, and the prior file is intact). The failure
    /// is captured in [`Self::persist_error`] so the UI can surface it as a
    /// non-blocking "未保存到磁盘" banner (ADR-0035 honest signal) -- silently
    /// relying on the next write to self-heal would mask a disk-vs-memory
    /// drift that closes the app losing the unsaved turns.
    ///
    /// ADR-0035 Decision 3 / issue #50 external-change check: before writing, hash the
    /// file on disk and compare against [`Self::last_written_hash`]. A mismatch
    /// means the file was edited externally (another window, a text editor, a
    /// sync tool) since the session's last successful write -- the auto-write
    /// is SUSPENDED and a [`PendingConflict`] is stashed for the caller
    /// ([`Self::take_pending_conflict`]). The engine NEVER silently clobbers
    /// the externally-edited file; the user picks reload / keep mine / save as
    /// new. A missing file is not a conflict (nothing to clobber) -- the write
    /// proceeds and recreates the file. A hash READ failure is treated
    /// conservatively as a possible undetectable edit (Windows share lock, AV
    /// scan, permission flip) and ALSO suspends the write: `save_atomic` does
    /// a rename, not a read, so proceeding would clobber bytes the check could
    /// not see. The check is skipped while a conflict is already pending (the
    /// caller has not yet resolved the prior one) so the surfaced notice stays
    /// stable.
    fn persist_if_bound(&mut self) {
        let Some(path) = self.duck_path.as_deref() else {
            return; // unbound -- in-memory-only session, nothing to persist.
        };
        // While a conflict is pending, the auto-write is SUSPENDED (ADR-0035
        // Decision 3): the caller has not resolved the prior divergence, so
        // writing would clobber the externally-edited file the user is mid-
        // decision on, and re-detecting would overwrite the stashed notice.
        // Skip BOTH detection AND the write; the caller's resolution drives
        // the next step. (Without this early return the outer persist() below
        // would run on every subsequent turn and silently clobber.)
        if self.pending_conflict.is_some() {
            return;
        }
        // External-change check (ADR-0035 Decision 3, issue #50). A baseline
        // exists after the first successful write to a bound path (and is
        // seeded from the file as read on `open_duck`, so an edit during resume
        // is also caught).
        if let Some(baseline) = self.last_written_hash.clone() {
            match hash_file(path) {
                Ok(Some(current)) if current != baseline => {
                    self.pending_conflict = Some(PendingConflict {
                        path: path.to_path_buf(),
                        expected_hash: baseline,
                        found_hash: current,
                    });
                    log::warn!(
                        target: "toptopduck::session",
                        "检测到 .duck 外部变更，挂起自动写盘：{}",
                        path.display()
                    );
                    return; // Suspend the write -- do NOT clobber.
                }
                Ok(_) => {} // Match (or file missing) -> proceed.
                Err(e) => {
                    // Fail-safe (ADR-0035 Decision 3): a hash read failure
                    // might hide an external edit we cannot see. Suspend
                    // the write and surface a conflict so the user decides
                    // (reload / keep mine / save as new) -- never silently
                    // clobber bytes the check could not read. The
                    // found_hash carries the read error so the UI can tell
                    // "could not read" apart from a real hash divergence.
                    self.pending_conflict = Some(PendingConflict {
                        path: path.to_path_buf(),
                        expected_hash: baseline,
                        found_hash: format!("<read failed: {e}>"),
                    });
                    log::warn!(
                        target: "toptopduck::session",
                        "外部变更检测读 .duck 失败，保守挂起自动写盘：{}",
                        path.display()
                    );
                    return;
                }
            }
        }
        if let Err(e) = self.persist() {
            log::error!(target: "toptopduck::session", "自动保存 .duck 失败：{e}");
            // Stash the latest failure (overwrites a prior unread one -- the
            // most recent is the most actionable). Cleared by take_persist_error.
            // Captured as the typed SaveError (issue #120) so the frontend
            // narrows on `kind` and renders a locale message; the underlying
            // io/serde/rename detail or the AlreadyOpen path rides the fold.
            self.persist_error = Some(e);
            return;
        }
        // Successful write -- refresh the baseline so the NEXT write's check
        // compares against what we just wrote (not a stale prior baseline).
        // hash_file best-effort: a failure leaves the old baseline, which at
        // worst causes a false conflict on the next write (the user resolves
        // it -- never a silent clobber).
        if let Some(h) = hash_file(path).ok().flatten() {
            self.last_written_hash = Some(h);
        }
    }

    /// Take (read + clear) the most recent per-turn persistence failure, if
    /// any. The command layer exposes this so the frontend can show a
    /// non-blocking banner after each turn / source event / resume. The
    /// failure is cleared on read so a turn that subsequently saves
    /// successfully does not re-surface the stale error. Returns the typed
    /// [`SaveError`] (issue #120) so the frontend narrows on `kind` and
    /// renders a locale message instead of matching a backend Display string.
    pub fn take_persist_error(&mut self) -> Option<SaveError> {
        self.persist_error.take()
    }

    /// Take (read + clear) the pending external-change conflict, if any
    /// (ADR-0035 Decision 3, issue #50). The command layer polls this after each
    /// turn / source event / resume; a non-`None` value means the auto-write
    /// was suspended because the `.duck` file's on-disk hash diverged from the
    /// session's baseline, and the caller must surface the three-option
    /// conflict UI. Cleared on read so a turn that subsequently resolves the
    /// conflict does not re-surface the stale notice. While a conflict is
    /// pending, [`Self::persist_if_bound`] skips further writes (and further
    /// detection) -- the caller's resolution drives the next step.
    pub fn take_pending_conflict(&mut self) -> Option<PendingConflict> {
        self.pending_conflict.take()
    }

    /// Resolve a pending conflict with "Keep Mine" (ADR-0035 Decision 3, issue #50):
    /// force-write the in-memory recipe to the bound `.duck` path,
    /// overwriting the externally-edited on-disk file. The user explicitly
    /// chose to discard the external edit, so this is the ONE path that
    /// overwrites -- and only ever on explicit user resolution, never silently
    /// from the auto-write path. Refreshes the baseline hash so subsequent
    /// auto-writes compare against the freshly written file. Clears the
    /// pending conflict.
    ///
    /// Returns [`SaveError::Io`] if no path is bound (the conflict machinery
    /// only fires on a bound session, so this is a logic bug, not a user
    /// path). A real write failure is returned for the caller to retry or
    /// surface; the pending conflict stays uncleared so the user can retry.
    pub fn conflict_keep_mine(&mut self) -> Result<(), SaveError> {
        let path = self
            .duck_path
            .clone()
            .ok_or_else(|| SaveError::Io("未绑定 .duck，无法解决冲突".into()))?;
        let recipe = self.build_recipe();
        save_atomic(&path, &recipe)?;
        // save succeeded -- the conflict IS resolved (disk now holds in-memory
        // state, the external edit overwritten by explicit user choice).
        // Refresh the baseline best-effort: a hash failure leaves the stale
        // baseline, and the next persist_if_bound re-detects + self-heals
        // (never a silent clobber). Propagating the hash error after a
        // successful save would mislead the caller into retrying an
        // already-applied resolution AND leave pending_conflict set, so the
        // session contradicts itself (disk resolved, memory says not).
        if let Some(h) = hash_file(&path).ok().flatten() {
            self.last_written_hash = Some(h);
        }
        self.pending_conflict = None;
        Ok(())
    }

    /// Resolve a pending conflict with "Save As New" (ADR-0035 Decision 3, issue #50):
    /// write the in-memory recipe to a NEW path, leaving the original
    /// (externally-edited) `.duck` file untouched. The session re-binds to the
    /// new path (releases the old canonical key, acquires the new one), so
    /// subsequent auto-writes target the new file. Refreshes the baseline hash
    /// against the new file. Clears the pending conflict.
    ///
    /// Single-writer (ADR-0035 Decision 3): the new path must NOT be already held by
    /// another Session in this process -- returns [`SaveError::AlreadyOpen`]
    /// without writing, leaving the conflict pending for the user to pick a
    /// different path. Acquiring the new key before releasing the old one is
    /// safe: the two canonical paths differ (the new path is a different
    /// file), so the brief overlap cannot deadlock.
    pub fn conflict_save_as_new(&mut self, new_path: PathBuf) -> Result<(), SaveError> {
        let canonical = canonicalize_duck(&new_path).map_err(|e| SaveError::Io(e.to_string()))?;
        // Same canonical path as the current binding: the caller meant "keep
        // mine", not "save as new" (save-as-new would overwrite the externally
        // edited file the user is trying to preserve). Surface as AlreadyOpen
        // so the caller routes to keep_mine.
        if self.duck_canonical.as_deref() == Some(canonical.as_path()) {
            return Err(SaveError::AlreadyOpen(canonical));
        }
        if !try_acquire(&canonical) {
            return Err(SaveError::AlreadyOpen(canonical));
        }
        let recipe = self.build_recipe();
        if let Err(e) = save_atomic(&new_path, &recipe) {
            // Release the just-acquired key so a different session / a retry
            // can target the same path; the conflict stays pending.
            release(&canonical);
            return Err(e);
        }
        // save_atomic succeeded -- the conflict IS resolved. Hash best-effort
        // (consistent with conflict_keep_mine): a hash read failure does NOT
        // roll back the rebind. Rolling back here would leave three
        // contradictory truths: the new file exists on disk, the session
        // reports "still bound to the old path", and the caller gets an Err
        // for a save that actually succeeded. last_written_hash = None makes
        // the next persist_if_bound skip the check, which is safe (the file
        // was just written by us). Release the old canonical AFTER recording
        // the new one on the session so a panic between acquire and rebind
        // cannot leak the new key (Session::drop releases whatever
        // duck_canonical holds).
        let new_hash = hash_file(&new_path).ok().flatten();
        if let Some(old) = self.duck_canonical.take() {
            release(&old);
        }
        self.duck_canonical = Some(canonical);
        self.duck_path = Some(new_path);
        self.last_written_hash = new_hash;
        self.pending_conflict = None;
        Ok(())
    }

    /// The turn-only view of the timeline, cloned out for the window assembler
    /// (ADR-0040): source lifecycle events share the timeline but the LLM
    /// payload is built from turns alone. A clone (not a borrow) so the slice
    /// the assembler reads is `&[TurnRecord]` unchanged -- the assembler and its
    /// tests stay source-event-agnostic. The clone is negligible (a small
    /// thread, once per turn / active read) next to the LLM call it feeds.
    fn turns(&self) -> Vec<TurnRecord> {
        self.history
            .iter()
            .filter_map(|entry| match entry {
                ThreadEntry::Turn(record) => Some(record.clone()),
                ThreadEntry::Source(_) => None,
            })
            .collect()
    }

    /// The conversation thread (ADR-0028/0039/0040): the unified timeline of
    /// turns AND source lifecycle events, in order. The thread is the source of
    /// truth the frontend renders; the window assembler reads only the turns
    /// (via [`Self::turns`]) to build the provider payload (ADR-0023 window +
    /// ADR-0039 summary). Source events are first-class here but never reach
    /// the window.
    pub fn conversation(&self) -> &[ThreadEntry] {
        &self.history
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

impl Drop for Session {
    fn drop(&mut self) {
        // ADR-0035 Decision 3 / issue #50: release the single-writer registry key the
        // session holds for its bound `.duck`. registry::release logs + swallows
        // a poisoned lock (Drop must not panic); see release's doc for the
        // degraded mode a poison leaves behind.
        if let Some(canonical) = self.duck_canonical.take() {
            release(&canonical);
        }
        // ADR-0063: signal the close-and-wait-release awaiter (delete path) that
        // the canonical key has been released -- fired AFTER the release above so
        // the awaiter resolves precisely when the single-writer gate will succeed.
        // Single-waiter (oneshot via std mpsc); a closed receiver (waiter gone or
        // timed out) makes send return Err, which is swallowed here. `take()`
        // moves the sender out so the field is `None` and the later struct
        // field-drop is pure deallocation -- dropping an `mpsc::Sender` never
        // calls `send` (send is a `&self` method), so there is no double-fire
        // risk to guard against; `take` is ownership transfer, not a guard.
        if let Some(tx) = self.drop_signal.take() {
            let _ = tx.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Session;
    use crate::model::TurnOutcome;
    use crate::provider::fake::FakeProvider;
    use crate::provider::ProviderReply;
    use tempfile::NamedTempFile;

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

    // M1 regression: a turn whose shape derivation fails must roll back the
    // already-created result_N. Here the derivation's fingerprint dump cannot be
    // written -- temp_path points at a file, so its "child" dump path has a file
    // as parent and the COPY ... TO fails, but only AFTER CREATE TABLE result_1
    // has succeeded. Without the DROP rollback the orphan table lingers
    // unregistered; within this turn's retry loop the next attempt's
    // next_result_number reuses N and clashes on CREATE, and across later turns
    // every ask wedges on the same clash (ADR-0022 never-reused). The derive
    // failure is retried up to the budget (ADR-0028 single loop), then the turn
    // fails honestly -- but every failed attempt must still roll back result_1.
    #[test]
    fn ask_drops_the_result_table_when_shape_derivation_fails() {
        let provider = FakeProvider::new().scripted(
            "建表",
            ProviderReply::Sql {
                sql: "SELECT 1 AS n".into(),
                viz: None,
                assumption: None,
            },
        );
        let mut session = Session::with_provider(Box::new(provider)).expect("session");
        // Derivation work dir whose parent is a file -> the fingerprint
        // COPY ... TO '<path>/result_1.fingerprint.csv' fails after CREATE.
        let file = NamedTempFile::new().expect("temp file");
        session.temp_path = file.path().to_path_buf();

        // The derive failure exhausts the retry budget and surfaces as a failed
        // turn whose reason carries the execution-step failure.
        let reason = match session.ask("建表") {
            TurnOutcome::Failed { reason } => reason,
            other => panic!("expected Failed after derive failure, got {other:?}"),
        };
        assert!(
            reason.contains("执行查询失败"),
            "derive failure reason should carry the execution prefix, got {reason:?}"
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
}
