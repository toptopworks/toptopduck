//! Per-session state: an in-memory DuckDB parent (working-set metadata + future
//! result_N) plus READ_ONLY-attached source snapshots (ADR-0004/0005/0012). The
//! per-session temp dir holds the snapshot files and is cleared on drop (ADR-0012).

pub mod sandbox;
pub mod snapshot;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use calamine::Data;
use duckdb::Connection;
use tempfile::TempDir;

use crate::cancel::CancelToken;
use crate::guardrail::{
    apply_resource_caps, classify_duckdb_error, ExecError, ExecErrorKind, DEFAULT_MAX_RESULT_ROWS,
};
use crate::ingest;
use crate::ingest::schema::quote_ident;
use crate::ingest::tidy::{auto_tidy, forward_fill_merges, TidyOutcome};
use crate::model::{
    DatasetDescriptor, DatasetPrivacy, GuidanceRequest, GuidanceSheet, LoadError, LoadOutcome,
    RectifyProvenance, RemoveSourceError, RenameError, RowPage, SheetGuidance, SheetRectify,
    SourceLifecycleEvent, SourceLifecycleKind, StaleAnchor, StaleReason, ThreadEntry, TurnError,
    TurnOutcome, TurnRecord, EXECUTE_FAIL_PREFIX, RESOURCE_FAIL_PREFIX,
};
use crate::persistence::recipe::{
    Recipe, RecipeEntry, RecipeOutcome, RecipeTurn, SourceRef, RECIPE_FORMAT_VERSION,
};
use crate::persistence::{read_duck, save_atomic, SaveError};
use crate::provider::{Provider, ProviderError, ProviderReply, UnwiredProvider};
use crate::session::snapshot::derive_table;
use crate::window;
use crate::workingset::{WorkingSet, DEFAULT_RESULT_COUNT_CAP};

/// Raw rows surfaced per sheet in the guided-load preview -- enough to spot the
/// header row and any separator/sub-header/footer rows to skip (ADR-0015).
const GUIDANCE_PREVIEW_ROWS: usize = 12;

/// Upper bound on a single read_rows page (ADR-0005/0024 display cap). A larger
/// requested limit is clamped so a malformed/hostile caller can't pull the whole
/// table into memory; the physical table still holds the full result.
const MAX_READ_ROWS: u64 = 10_000;

/// Single retry budget per turn (ADR-0028): malformed contract violations and
/// schema/runtime execution errors share one budget. The initial attempt plus
/// this many retries (default 2 -> 3 total attempts); exhaustion yields a
/// failed outcome with an honest reason. Resource caps / timeouts do NOT enter
/// the loop (the same SQL would hit the same wall) -- those become the cancel
/// outcome in #28. The retry is invisible to the user: one question = one
/// thread entry = one outcome.
const TURN_RETRY_BUDGET: u32 = 2;

/// Why a resume failed (ADR-0035 honest degrade). The interactive re-link /
/// drift / active-abandoned decisions land via [`SourceIssue`] /
/// [`ActiveAbandoned`] callbacks; this enum covers the non-interactive
/// failures (corrupt recipe, path-traversal refusal, user cancel / abort).
#[derive(Debug)]
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
    /// The recipe's active pointer names a source that was never in
    /// `recipe.sources` (a corrupt recipe -- the write path never persists an
    /// active name that is not a registered source). Distinct from an active
    /// source that WAS in the recipe but got rebuilt: that case is resolvable
    /// via [`ActiveAbandoned`] and never reaches this variant.
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
    /// The recorded path no longer exists (deleted / moved / renamed), or the
    /// file is present but unreadable (parse error / unsupported format). The
    /// user may re-link to the moved file, abort, or rebuild (re-upload later).
    Missing {
        reference_name: String,
        /// The path the recipe recorded (absolute fallback form).
        recorded_path: String,
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
    /// data in a later turn. If the rebuilt source was the active source,
    /// [`ActiveAbandoned`] fires next (AC5).
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

/// Where the replay chain broke (ADR-0035 honest partial state, issue #49 AC6).
/// Round K's SQL failed; the working set holds K-1 materialized results, and
/// the timeline ends at turn K rendered as `Failed` (ADR-0028 outcome C).
/// Turns after K in the recipe's history are dropped (the conversation stops at
/// the breakpoint). Internal to resume -- the partial state is observable via
/// the resumed Session's working set + history.
#[derive(Debug, Clone)]
struct ReplayBreak {
    reference_name: String,
    reason: String,
}

/// One progress event during resume (ADR-0034 visible progress). Fired per
/// source verification and per replayed turn so the UI can render a
/// deterministic progress bar.
#[derive(Debug, Clone, serde::Serialize)]
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

pub struct Session {
    conn: Connection,
    working_set: WorkingSet,
    _temp_dir: TempDir, // held to keep its dir alive; cleared on drop (ADR-0012)
    temp_path: PathBuf,
    /// The LLM provider behind the turn orchestrator (ADR-0007). Defaults to
    /// [`UnwiredProvider`] (real Claude wires in #29); tests inject a scripted
    /// fake via [`Self::with_provider`]. `Send` so the session is shareable
    /// behind an `Arc<Mutex>` and turns can run on a blocking thread.
    provider: Box<dyn Provider>,
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
    /// Optional wall-clock ceiling on one turn (ADR-0005/0021 statement-timeout
    /// path). When set, `ask` arms a watchdog that fires `cancel.request()` on
    /// expiry; the running query is interrupted and the turn lands as Cancelled
    /// (ADR-0028 outcome D -- timeout shares the cancel abort path). `None`
    /// (default) means no turn-level timeout; engine resource caps
    /// (ADR-0005 L3) still bound runaway queries. Tunable for tests.
    turn_timeout: Option<Duration>,
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
    /// [`Self::persist_if_bound`] when a save fails; cleared by
    /// [`Self::take_persist_error`]. The in-memory turn always advances
    /// regardless (the user's work stays live); this field lets the UI
    /// surface the disk-vs-memory drift instead of silently relying on the
    /// next successful write to self-heal (ADR-0035 honest signal -- a
    /// dropped save is a correctness gap, not just a log line).
    persist_error: Option<String>,
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
        Ok(Self {
            conn,
            working_set: WorkingSet::default(),
            _temp_dir: temp_dir,
            temp_path,
            provider,
            history: Vec::new(),
            result_row_cap: DEFAULT_MAX_RESULT_ROWS,
            result_count_cap: DEFAULT_RESULT_COUNT_CAP,
            source_files: HashMap::new(),
            cancel,
            turn_timeout: None,
            duck_path: None,
            session_name: None,
            persist_error: None,
        })
    }

    /// A clone of the shared cancel token (ADR-0021, issue #28). The command
    /// layer takes this BEFORE the session lock so the cancel command can fire
    /// without contending for the lock `ask` holds for the whole turn; tests
    /// clone it to observe `is_in_flight` / drive `request` from another thread.
    pub fn cancel_token(&self) -> Arc<CancelToken> {
        Arc::clone(&self.cancel)
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
    /// path). When set, `ask` arms a watchdog that fires cancel on expiry; the
    /// running query is interrupted and the turn lands as Cancelled (ADR-0028
    /// outcome D). `None` disables the turn-level timeout (the default; engine
    /// resource caps still apply). Tunable for deterministic timeout tests.
    pub fn set_turn_timeout(&mut self, timeout: Option<Duration>) {
        self.turn_timeout = timeout;
    }

    /// Bind this session to a `.duck` path (ADR-0034) and immediately persist
    /// one full recipe. After this, every terminal turn and source lifecycle
    /// event atomically rewrites the recipe (temp + rename). The session name
    /// rides the recipe header and is shown on resume. Returns the save error
    /// (if any) so the caller can surface it -- the binding still takes effect
    /// so in-memory state is correct even if the first write fails.
    pub fn bind_duck(&mut self, path: PathBuf, session_name: String) -> Result<(), SaveError> {
        self.duck_path = Some(path);
        self.session_name = Some(session_name);
        self.persist()
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
    pub fn open_duck(
        path: &Path,
        cancel: Arc<CancelToken>,
        provider: Box<dyn Provider>,
        mut on_progress: impl FnMut(ResumeEvent),
        mut on_source_issue: impl FnMut(SourceIssue) -> SourceResolution,
        mut on_active_abandoned: impl FnMut(ActiveAbandoned) -> ActiveResolution,
    ) -> Result<Session, ResumeError> {
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
        let mut session = Session::with_provider_and_cancel(provider, cancel)
            .map_err(|e| ResumeError::Load(crate::persistence::io::LoadError::Io(e.to_string())))?;
        session.session_name = Some(recipe.session_name.clone());

        // Phase 1: re-read + verify each source (interactive re-link / rebuild).
        // Returns the set of rebuilt (dropped) sources; recipe.sources[i] is
        // updated in place for any relinked path.
        let rebuilt =
            session.resume_sources(path, &mut recipe, &mut on_progress, &mut on_source_issue)?;

        // Phase 2: resolve the active-SOURCE pointer. The happy path restores
        // recipe.active; if the active was rebuilt + others remain, the caller
        // picks an explicit continuation (ADR-0035 no-silent-fallback, AC5).
        session.resolve_active_pointer(&recipe, &rebuilt, &mut on_active_abandoned)?;

        // Phase 3: replay the productive SQL chain (partial on failure -- K-1
        // results preserved, K rendered as Failed, AC6).
        let replay_break = session.resume_replay(&recipe, &mut on_progress)?;

        // Phase 4: rebuild the conversation timeline, truncated at the replay
        // breakpoint (if any). Post-break entries are dropped ("对话停在断点").
        session.resume_history(&recipe, replay_break.as_ref())?;

        // Phase 5: re-bind the .duck path + persist the post-resume state.
        // build_recipe reads the live working set, so relinked paths, dropped
        // (rebuilt) sources, and the truncated timeline (failed turn at K)
        // land in the persisted recipe. A failure is non-blocking -- the
        // session is live; the banner surfaces the disk-vs-memory drift.
        session.duck_path = Some(path.to_path_buf());
        session.persist_if_bound();

        Ok(session)
    }

    /// Resolve a recipe source path to a filesystem path (ADR-0036 §4 hybrid
    /// paths). The relative form -- taken against the `.duck` file's
    /// directory -- wins when present and the candidate exists; that is the
    /// form that survives "move the folder" portability. Otherwise the
    /// absolute `source_path` is the fallback. Fingerprint verification
    /// upstream catches a wrong pick, so the choice here is safe.
    ///
    /// Trust boundary (rust/security.md §input-validation + ADR-0036): the
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
                                let _ = self.rename_display(&src.reference_name, &src.display_name);
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
                    Err(_) => {
                        // Missing: path doesn't exist or unreadable (parse
                        // error / unsupported format / Excel needs guidance).
                        // The user may re-link to the moved file (path updated,
                        // recipe re-verified), abort, or rebuild (skip this
                        // source). The raw LoadError detail is intentionally
                        // not surfaced -- the issue's recorded_path is enough
                        // for the user to act, and the engine's contract is
                        // "this source is unavailable", not "here is why".
                        let resolution = on_source_issue(SourceIssue::Missing {
                            reference_name: src.reference_name.clone(),
                            recorded_path: src.source_path.clone(),
                        });
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

    /// Resume phase 2 (ADR-0035, issue #49 AC5): resolve the active-SOURCE
    /// pointer after the per-source integrity pass. The happy path restores
    /// `recipe.active` (still registered). If the active source was rebuilt
    /// (dropped) and other sources remain, ADR-0035 forbids auto-fallback --
    /// the caller must name an explicit continuation. When the last source was
    /// rebuilt (no sources remain), the working set stays empty + `active` is
    /// `None` without a callback (the empty state IS the honest end). A
    /// corrupt recipe whose `active` was never a registered source surfaces as
    /// [`ResumeError::ActiveMissing`] (never the interactive path).
    fn resolve_active_pointer(
        &mut self,
        recipe: &Recipe,
        rebuilt: &HashSet<String>,
        on_active_abandoned: &mut impl FnMut(ActiveAbandoned) -> ActiveResolution,
    ) -> Result<(), ResumeError> {
        let Some(active_name) = recipe.active.clone() else {
            return Ok(()); // no active pointer (empty working set recipe)
        };
        // Happy path: active still registered. Restore the pointer (ingest
        // left it on the last-registered source; an explicit prior user
        // continuation choice must be re-applied here, ADR-0035/0037).
        if self.working_set.get(&active_name).is_some() {
            return if self.working_set.set_active(&active_name) {
                Ok(())
            } else {
                // set_active rejects a result_N name; the recipe invariant says
                // active is always a source, so a failure here is corruption.
                Err(ResumeError::ActiveMissing(active_name))
            };
        }
        // Active not in the working set. If it was NOT rebuilt, it names a
        // source that was never in recipe.sources -> corrupt recipe.
        if !rebuilt.contains(&active_name) {
            return Err(ResumeError::ActiveMissing(active_name));
        }
        // Active was rebuilt. ADR-0035: no silent fallback. The remaining
        // registered sources (excluding result_N) are the continuation menu.
        let remaining: Vec<String> = self
            .working_set
            .list()
            .iter()
            .filter(|d| !self.working_set.is_result(&d.reference_name))
            .map(|d| d.reference_name.clone())
            .collect();
        if remaining.is_empty() {
            // The last source was rebuilt -> empty working set, active None.
            // (working_set.remove already cleared active when the rebuilt
            // active source was detached.) No callback -- nothing to choose
            // from, and the empty state is the user's honest end (upload new).
            return Ok(());
        }
        match on_active_abandoned(ActiveAbandoned {
            abandoned: active_name,
            remaining: remaining.clone(),
        }) {
            ActiveResolution::ContinueWith(name) => {
                if remaining.contains(&name) && self.working_set.set_active(&name) {
                    Ok(())
                } else {
                    // Caller named a source not in `remaining` -- a stale view
                    // or a direct IPC race. Surface as ActiveMissing rather
                    // than silently writing a dangling pointer.
                    Err(ResumeError::ActiveMissing(name))
                }
            }
            ActiveResolution::Abort => Err(ResumeError::Aborted),
        }
    }

    /// Resume phase 3 (ADR-0034/0035, issue #49 AC6): eagerly re-execute the
    /// productive SQL chain LLM-free (the SQL lives in the recipe). Reuses the
    /// #1 materialize path so result_N numbering, sandboxing, and shape
    /// derivation match a live turn (ADR-0009). Replay starts from an empty
    /// result set, so result_N numbers line up with the recipe's recording
    /// order. Fires one `Replay` progress event per turn.
    ///
    /// On a round-K SQL failure (data drift / dropped column / abandoned
    /// source referenced by the chain) resume does NOT abort: turn K is
    /// rendered as `Failed` (ADR-0028 outcome C), turns K+1.. are dropped
    /// ("对话停在断点"), and K-1's materialized results stay in the working set
    /// (ADR-0035 honest partial state). Returns the [`ReplayBreak`] so phase 4
    /// knows where to truncate; `None` means the whole chain replayed.
    fn resume_replay(
        &mut self,
        recipe: &Recipe,
        on_progress: &mut impl FnMut(ResumeEvent),
    ) -> Result<Option<ReplayBreak>, ResumeError> {
        let chain = recipe.productive_chain();
        let total = chain.len();
        let cancel = Arc::clone(&self.cancel);
        for (i, turn) in chain.iter().enumerate() {
            // Honor a user cancel between turns (ADR-0021): without this poll
            // a click of 停止 during replay would only get the engine interrupt
            // on the CURRENT SQL, surface as a partial break, and look
            // indistinguishable from data corruption. The cancel lands here as
            // ResumeError::Cancelled BEFORE the next turn's SQL starts.
            if cancel.is_requested() {
                return Err(ResumeError::Cancelled);
            }
            on_progress(ResumeEvent::Replay {
                index: i + 1,
                total,
                reference_name: turn.reference_name.clone(),
            });
            match self.try_materialize(&turn.sql, &cancel) {
                Ok(descriptor) => {
                    if descriptor.display_name != turn.display_name {
                        let _ = self.rename_display(&turn.reference_name, &turn.display_name);
                    }
                }
                Err(e) => {
                    // Round K failed -- stop here. K-1 results are in the
                    // working set; K will render as Failed; K+1.. are dropped
                    // by resume_history (truncate at this reference name).
                    return Ok(Some(ReplayBreak {
                        reference_name: turn.reference_name.clone(),
                        reason: format!("{}{}", EXECUTE_FAIL_PREFIX, e.detail),
                    }));
                }
            }
        }
        Ok(None)
    }

    /// Resume phase 4 (ADR-0028/0039/0040, issue #49 AC6): rebuild the
    /// conversation timeline from the recipe, truncated at the replay
    /// breakpoint if any. The Materialized turns' descriptors come from the
    /// working set (just re-built by replay, display names restored); the
    /// break turn (if any) renders as `Failed` with the replay's reason
    /// (ADR-0028 outcome C); entries strictly after the break turn are dropped
    /// (the conversation stops at the breakpoint). viz is None (ADR-0036 not
    /// persisted), so a reopened chart renders as a table (ADR-0033).
    fn resume_history(
        &mut self,
        recipe: &Recipe,
        break_at: Option<&ReplayBreak>,
    ) -> Result<(), ResumeError> {
        // Locate the break turn's history index (if any) to truncate there.
        // The productive_chain is the Materialized turns in timeline order, so
        // turn K in that order maps to one history entry by reference name.
        let break_idx = break_at.and_then(|brk| {
            recipe.history.iter().position(|entry| match entry {
                RecipeEntry::Turn(t) => matches!(
                    &t.outcome,
                    RecipeOutcome::Materialized { reference_name, .. }
                        if reference_name == &brk.reference_name
                ),
                _ => false,
            })
        });
        // Truncate inclusive of the break turn -- it becomes the Failed entry
        // at the end. Entries after it are dropped ("对话停在断点").
        let end = break_idx.map(|i| i + 1).unwrap_or(recipe.history.len());

        self.history = recipe.history[..end]
            .iter()
            .map(|entry| match entry {
                RecipeEntry::Turn(turn) => {
                    let outcome = match &turn.outcome {
                        RecipeOutcome::Materialized {
                            reference_name,
                            sql,
                            assumption,
                            ..
                        } => {
                            // The break turn renders as Failed (replay broke
                            // here), NOT as Materialized -- the result was
                            // never re-materialized.
                            if break_at
                                .map(|b| b.reference_name == *reference_name)
                                .unwrap_or(false)
                            {
                                TurnOutcome::Failed {
                                    reason: break_at.unwrap().reason.clone(),
                                }
                            } else {
                                let dataset =
                                    self.working_set.get(reference_name).cloned().ok_or_else(
                                        || ResumeError::Replay {
                                            reference_name: reference_name.clone(),
                                            detail: format!(
                                                "重放后未在 working_set 中找到 {reference_name}"
                                            ),
                                        },
                                    )?;
                                TurnOutcome::Materialized {
                                    dataset: Box::new(dataset),
                                    sql: Some(sql.clone()),
                                    viz: None,
                                    assumption: assumption.clone(),
                                }
                            }
                        }
                        RecipeOutcome::Textual {
                            text_kind,
                            body,
                            assumption,
                        } => TurnOutcome::Textual {
                            text_kind: *text_kind,
                            body: body.clone(),
                            assumption: assumption.clone(),
                        },
                        RecipeOutcome::Failed { reason } => TurnOutcome::Failed {
                            reason: reason.clone(),
                        },
                        RecipeOutcome::Cancelled => TurnOutcome::Cancelled,
                    };
                    Ok(ThreadEntry::Turn(TurnRecord {
                        question: turn.question.clone(),
                        outcome,
                    }))
                }
                RecipeEntry::Source(ev) => Ok(ThreadEntry::Source(ev.clone())),
            })
            .collect::<Result<Vec<_>, ResumeError>>()?;
        Ok(())
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
        if let Err(e) = self
            .conn
            .execute_batch(&format!("DETACH {};", quote_ident(reference_name)))
        {
            log::warn!(
                target: "toptopduck::session",
                "DETACH during resume re-link for {reference_name} failed: {e}"
            );
        }
        let snapshot_path = self
            .source_files
            .remove(reference_name)
            .unwrap_or_else(|| self.temp_path.join(format!("{reference_name}.duckdb")));
        if let Err(e) = fs::remove_file(&snapshot_path) {
            log::warn!(
                target: "toptopduck::session",
                "snapshot file removal during resume re-link for {reference_name}: {e}"
            );
        }
        self.working_set.remove(reference_name);
    }

    /// Ingest a file. Transactional: on any failure the working set is unchanged
    /// (bad files never pollute the session -- PRD AC7). CSV/Parquet/JSON share
    /// one copy-in path -- only the DuckDB reader differs (ADR-0032 shared
    /// contract, no format-specific branches). Excel (.xlsx) goes through
    /// [`Self::ingest_excel`]: each sheet becomes its own Dataset.
    pub fn ingest(&mut self, path: &Path) -> LoadOutcome {
        let dispatched = ingest::dispatch(path);
        match dispatched {
            // Legacy .xls is rejected up front with an actionable hint (ADR-0015)
            // -- never reaches copy-in, leaves the working set untouched.
            ingest::Dispatched::Xls => LoadOutcome::Error(LoadError::LegacyExcel),
            ingest::Dispatched::Xlsx => self.ingest_excel(path),
            _ => {
                let Some(reader) = ingest::reader_for(&dispatched) else {
                    let requested = match dispatched {
                        ingest::Dispatched::Unsupported(ext) => ext,
                        // Unreachable today (Xls/Xlsx are handled above); kept
                        // total so a future variant can't silently fall through.
                        _ => String::new(),
                    };
                    return LoadOutcome::Error(LoadError::UnsupportedFormat { requested });
                };
                self.ingest_structured(path, reader)
            }
        }
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

    /// Remove a source Dataset from the working set (issue #38, ADR-0040). The
    /// first source-removal path: detaches the read-only snapshot, deletes its
    /// file, drops the dataset from the shared namespace, and appends a
    /// `Deleted` source lifecycle event to the thread. The event is first-class
    /// (always visible, occupies a timeline slot) but NOT a turn -- it never
    /// enters the LLM window or advances result_N.
    ///
    /// This slice handles only **non-active sources with no derived results**:
    /// - Removing the active source would silently change the user's analysis
    ///   focus; ADR-0035 forbids a silent jump, so explicit re-selection lands
    ///   in #39 and removal of the active source is refused here.
    /// - Removing a source while any `result_N` exists needs the stale-cascade
    ///   engine (#40) to mark dependent derivations stale honestly; without it,
    ///   removal is refused. The conservative "any result exists" guard is the
    ///   only provenance-free way to guarantee "no derived dependency" today.
    ///
    /// DETACH and snapshot-file removal are best-effort + logged (never silently
    /// swallowed): a failure leaves a ghost attachment or a stray temp file, but
    /// the working set (the source of truth) still reflects the removal and the
    /// session temp dir is wiped on drop. The session Mutex serializes this
    /// against an in-flight turn (correctness); the frontend's shared `loading`
    /// flag additionally disables source-management UI during the ADR-0040
    /// execution window (UX), so no in-flight guard is needed here.
    pub fn remove_source(&mut self, reference_name: &str) -> Result<(), RemoveSourceError> {
        // Snapshot the descriptor before any mutation: its display label rides
        // the Deleted event (the thread must still name what was removed after
        // the dataset is gone), and the active/unknown checks need it up front.
        let descriptor = self
            .working_set
            .get(reference_name)
            .ok_or_else(|| RemoveSourceError::NotFound(reference_name.to_string()))?
            .clone();

        // Dependent results no longer block removal (#40 stale-cascade engine):
        // commit_removal transitively marks every downstream result_N stale
        // (ADR-0013/0040), so a delete always cascades instead of refusing.

        // Refuse the active source WHEN other sources remain: removing it would
        // silently move the user's focus (ADR-0035) -- the caller must go
        // through `remove_active_source` (issue #39) to name an explicit
        // continuation. AC4 exception: when this is the LAST source, fall
        // through to `commit_removal` -- the working set goes empty and the UI
        // prompts upload, which IS the user's explicit end state (no silent
        // jump happens because there is nothing left to jump to).
        // NOTE: `working_set.active()` (the active-SOURCE pointer = most-recent
        // source) is the right check here, not `Session::active`/resolve_active
        // (user focus = latest result, else active source). Removing a source
        // concerns only the source pointer: a result may exist and the cascade
        // marks its downstream stale, but that does not move the source pointer
        // -- the focus pointer is handled by remove_active_source's explicit
        // continuation path.
        let is_active = self
            .working_set
            .active()
            .map(|a| a.reference_name == reference_name)
            .unwrap_or(false);
        if is_active && self.working_set.list().len() > 1 {
            return Err(RemoveSourceError::IsActive {
                reference_name: reference_name.to_string(),
                display_name: descriptor.display_name,
            });
        }

        self.commit_removal(reference_name, &descriptor.display_name);
        Ok(())
    }

    /// Delete the current ACTIVE source and repoint the focus pointer at an
    /// explicit continuation source the user chose from the remaining set
    /// (issue #39, ADR-0035 -- no silent fallback). Atomic w.r.t. the working
    /// set: the focus moves to `continue_with` AND the removed source is
    /// dropped + a `Deleted` event appended in one call.
    ///
    /// Guards (each surfaces a distinct `RemoveSourceError` so a stale view /
    /// direct IPC cannot smuggle an inconsistent state):
    /// - `reference_name` must be the active source (else `NotActive`);
    /// - `continue_with` must be a remaining source -- registered, not the
    ///   removed name, not a `result_N` (else `InvalidContinueWith`).
    ///
    /// Dependent results no longer block removal (#40 cascade marks them stale
    /// on commit), so there is no `HasDerivatives` refusal on this path.
    ///
    /// The frontend's confirm dialog already excludes every
    /// `InvalidContinueWith` / `NotActive` case, so reaching those branches
    /// means the view raced a concurrent mutation; the working set is left
    /// untouched and the caller refreshes and retries.
    pub fn remove_active_source(
        &mut self,
        reference_name: &str,
        continue_with: &str,
    ) -> Result<(), RemoveSourceError> {
        // Snapshot the descriptor before any mutation: its display label rides
        // the Deleted event once the source is gone.
        let descriptor = self
            .working_set
            .get(reference_name)
            .ok_or_else(|| RemoveSourceError::NotFound(reference_name.to_string()))?
            .clone();

        // The dialog only fires for the active source; a non-active `ref` here
        // is a stale view or a direct IPC. Refuse before touching anything --
        // the caller should refresh and pick the right path (`remove_source`).
        let is_active = self
            .working_set
            .active()
            .map(|a| a.reference_name == reference_name)
            .unwrap_or(false);
        if !is_active {
            return Err(RemoveSourceError::NotActive(reference_name.to_string()));
        }

        // The continuation must differ from the removed name (the dialog lists
        // only the OTHER sources; an equal name is a logic bug / stale view).
        if continue_with == reference_name {
            return Err(RemoveSourceError::InvalidContinueWith(
                continue_with.to_string(),
            ));
        }

        // No derived-dependency guard: #40's cascade marks downstream results
        // stale on commit, so removal proceeds regardless of results.

        // Repoint the focus at the chosen continuation BEFORE the removal.
        // `set_active` gates on registered + non-result, so a `false` here =
        // `continue_with` is not a remaining source (missing or a `result_N`);
        // nothing was mutated yet (active stays on the original focus).
        if !self.working_set.set_active(continue_with) {
            return Err(RemoveSourceError::InvalidContinueWith(
                continue_with.to_string(),
            ));
        }

        // Active now names `continue_with`, so `commit_removal`'s
        // `working_set.remove(reference_name)` will NOT clear active (the
        // matched-name branch only fires when active == the removed name) --
        // the focus stays on the user's explicit choice.
        self.commit_removal(reference_name, &descriptor.display_name);
        Ok(())
    }

    /// Commit a source removal: DETACH the read-only snapshot catalog, delete
    /// its snapshot file, drop the working-set entry, and append a `Deleted`
    /// lifecycle event. Extracted from `remove_source` so `remove_active_source`
    /// shares the exact same commit steps (KISS / DRY -- one place that owns
    /// the best-effort I/O + event append). All I/O here is best-effort +
    /// logged: a failure leaves a ghost attachment or a stray temp file, but
    /// the working set (source of truth) still reflects the removal and the
    /// session temp dir is wiped on drop. The session Mutex serializes this
    /// against an in-flight turn; the frontend's shared `loading` flag adds the
    /// ADR-0040 execution-window UX guard, so no in-flight guard is needed here.
    fn commit_removal(&mut self, reference_name: &str, display_name: &str) {
        // Cascade stale (issue #40, ADR-0013/0025/0040): before the source
        // leaves the working set, transitively mark every result_N downstream
        // of it (direct + via chained results) as stale, each carrying this
        // Deleted event's identity as its traceability anchor. Stale results
        // stay registered (visible) -- only the source is removed below.
        let newly_stale = self.working_set.cascade_stale(
            reference_name,
            StaleAnchor {
                reference_name: reference_name.to_string(),
                display_name: display_name.to_string(),
                reason: StaleReason::Deleted,
            },
        );
        if !newly_stale.is_empty() {
            log::info!(
                target: "toptopduck::session",
                "删除源「{reference_name}」级联失效：{}", newly_stale.join(", ")
            );
        }

        // DETACH the read-only snapshot catalog (mirrors rollback_excel). A
        // DETACH failure leaves a ghost attachment that cannot affect
        // correctness (the working set no longer names it; a later same-name
        // ingest de-conflicts), but is kept diagnosable.
        if let Err(e) = self
            .conn
            .execute_batch(&format!("DETACH {};", quote_ident(reference_name)))
        {
            log::warn!(
                target: "toptopduck::session",
                "DETACH failed during removal for {reference_name}: {e}"
            );
        }

        // Delete the snapshot file. source_files holds the real attached path
        // (a replace may have left it at a swap path); fall back to the formal
        // <ref>.duckdb name only when no entry was tracked. On Windows a held
        // handle can make remove_file fail, but the session temp dir is wiped
        // on drop either way.
        let snapshot_path = self
            .source_files
            .remove(reference_name)
            .unwrap_or_else(|| self.temp_path.join(format!("{reference_name}.duckdb")));
        if let Err(e) = fs::remove_file(&snapshot_path) {
            log::warn!(
                target: "toptopduck::session",
                "snapshot file removal failed during removal for {reference_name}: {e}"
            );
        }

        // Drop the dataset (clears active-if-match + results membership) and
        // append the Deleted event. The display label was captured by the
        // caller, so the event still names what was removed.
        self.working_set.remove(reference_name);
        self.append_source_event(SourceLifecycleKind::Deleted, reference_name, display_name);
    }

    /// Re-upload a file onto an existing dataset's reference name (ADR-0042,
    /// issue #11 slice 4b): a fresh snapshot takes over the name and the old
    /// snapshot is discarded. Distinct from [`Self::ingest`] (add): the reference
    /// name to take over is explicit, and the new snapshot does **not** receive a
    /// de-conflicted new name.
    ///
    /// Transactional up to the file swap. The new snapshot is pre-attached under
    /// a `__swap` alias and confirmed readable **before** the old one is touched,
    /// so any failure up to and including that confirmation (copy-in parse, new-
    /// snapshot mount, swap/release, old-DETACH) leaves the working set and the
    /// old snapshot untouched and still queryable. Only after the new snapshot is
    /// confirmed is the old one detached and its file removed; the swap file is
    /// then promoted to the formal name (or attached in place when the rename is
    /// blocked by a lingering old handle). That promote operates on an already-
    /// verified file, so the post-confirm steps are deterministic file moves plus
    /// a re-ATTACH of the same file under the reference name.
    ///
    /// Only structured files (CSV/Parquet/JSON) are supported here -- they map
    /// 1:1 to a single snapshot taking over the name. Excel workbooks (multi-
    /// sheet semantics, guided rectify) need their own replace path and are out
    /// of scope for this slice; passing one returns an error and leaves the
    /// working set untouched. `.xls` is rejected with the same actionable hint as
    /// ingest. This is also the sole way to fix a mis-inferred type or a bad
    /// rectify: source snapshots are read-only, so the data can only be swapped
    /// by re-uploading (ADR-0020).
    pub fn replace_source(&mut self, reference_name: &str, path: &Path) -> LoadOutcome {
        // The reference name must already be loaded -- a replace targets an
        // existing source, it never creates one.
        let existing = match self.working_set.get(reference_name) {
            Some(d) => d.clone(),
            None => {
                return LoadOutcome::Error(LoadError::Other {
                    detail: format!("找不到引用名为「{reference_name}」的数据集，无法换源"),
                })
            }
        };

        // Dispatch the new file. Same front door as ingest: .xls rejected up
        // front; structured formats go to copy-in; .xlsx is refused here (its
        // multi-sheet / guided replace semantics are a separate slice).
        let dispatched = ingest::dispatch(path);
        let reader = match dispatched {
            ingest::Dispatched::Xls => return LoadOutcome::Error(LoadError::LegacyExcel),
            ingest::Dispatched::Xlsx => {
                return LoadOutcome::Error(LoadError::Other {
                    detail: "换源暂不支持 Excel 工作簿（多 sheet 语义待定），请改用结构化文件"
                        .into(),
                });
            }
            _ => match ingest::reader_for(&dispatched) {
                Some(r) => r,
                None => {
                    let requested = match dispatched {
                        ingest::Dispatched::Unsupported(ext) => ext,
                        _ => String::new(),
                    };
                    return LoadOutcome::Error(LoadError::UnsupportedFormat { requested });
                }
            },
        };

        // Copy-in the new file under a swap stem: the old snapshot's file
        // (`<ref>.duckdb`) is still attached and held, so the new one must land
        // elsewhere first. copy_in clears any stale swap file from a prior failed
        // attempt before writing.
        let swap_alias = format!("{reference_name}__swap");
        let new_snap = match ingest::loader::copy_in(path, &self.temp_path, &swap_alias, reader) {
            Ok(s) => s,
            Err(e) => return LoadOutcome::Error(e),
        };

        // Confirm the new snapshot mounts BEFORE retiring the old one: pre-attach
        // it under the swap alias (distinct from `<ref>`, so both co-exist). A
        // mount failure here means the new file is unusable -- the swap file is
        // removed and the old snapshot stays attached and queryable, working set
        // untouched. This front-loads the only non-deterministic failure (can the
        // engine open this snapshot?) ahead of any destructive step, so a bad new
        // file never costs the user the old one.
        let swap_path = new_snap.file_path.to_string_lossy().into_owned();
        if let Err(e) = self.conn.execute_batch(&format!(
            "ATTACH '{swap_path}' AS {} (READ_ONLY);",
            quote_ident(&swap_alias),
        )) {
            log::warn!(
                target: "toptopduck::session",
                "pre-attach of new snapshot failed during replace for {reference_name}: {e}"
            );
            let _ = fs::remove_file(&new_snap.file_path);
            return LoadOutcome::Error(LoadError::Other {
                // Prefix-free: App.tsx prepends "换源失败：" for kind "replace",
                // matching the load path (loadErrorMessage surfaces detail verbatim).
                detail: format!("无法挂载新快照（{e}）"),
            });
        }
        // Release the swap file's handle so the promote step can rename it. This
        // DETACHes the very attachment just confirmed, so it cannot fail for a
        // file-content reason; on failure the old snapshot is still attached and
        // queryable, so we abort before any damage (the swap file is best-effort
        // removed, though the held handle may keep it until session drop).
        if let Err(e) = self
            .conn
            .execute_batch(&format!("DETACH {};", quote_ident(&swap_alias)))
        {
            log::warn!(
                target: "toptopduck::session",
                "DETACH swap failed during replace for {reference_name}: {e}"
            );
            let _ = fs::remove_file(&new_snap.file_path);
            return LoadOutcome::Error(LoadError::Other {
                detail: format!("无法释放新快照（{e}）"),
            });
        }

        // New snapshot confirmed -- retire the old one. DETACH first to release
        // the old file's handle (Windows won't remove a held file); if DETACH
        // fails the old snapshot is still attached and usable, so the swap file is
        // orphaned and removed, and the error is reported with the working set
        // untouched.
        if let Err(e) = self
            .conn
            .execute_batch(&format!("DETACH {};", quote_ident(reference_name)))
        {
            log::warn!(
                target: "toptopduck::session",
                "DETACH old failed during replace for {reference_name}: {e}"
            );
            let _ = fs::remove_file(&new_snap.file_path);
            return LoadOutcome::Error(LoadError::Other {
                detail: format!("无法释放旧快照（{e}）"),
            });
        }
        // Old detached -- remove its file. Best-effort (mirrors rollback_excel):
        // a remove failure (e.g. a lingering handle on Windows) is logged, then
        // the promote step falls back to attaching the swap file in place.
        let formal = self.temp_path.join(format!("{reference_name}.duckdb"));
        if let Err(e) = fs::remove_file(&formal) {
            log::warn!(
                target: "toptopduck::session",
                "old snapshot file removal during replace for {reference_name}: {e}"
            );
        }
        // Promote the swap file to the formal name when possible; if rename
        // fails (the old file couldn't be cleared), attach the swap file where
        // it is -- the session temp dir is wiped on drop either way.
        let attach_path = match fs::rename(&new_snap.file_path, &formal) {
            Ok(()) => formal.to_string_lossy().into_owned(),
            Err(e) => {
                log::warn!(
                    target: "toptopduck::session",
                    "rename swap->formal during replace for {reference_name}: {e}"
                );
                swap_path
            }
        };
        // Post-confirm window -- unrecoverable from here on. The old snapshot
        // is already detached and its file best-effort removed, so a failure at
        // this final ATTACH leaves the session half-attached: `reference_name`
        // has no attachment, yet `working_set` still holds the stale descriptor
        // (it is updated only after this succeeds). In practice this ATTACH
        // cannot fail -- the same file attached successfully in the pre-attach
        // step, and the session is single-threaded under its Mutex -- so the
        // only realistic triggers are OS-level (e.g. an AV scan locking the
        // renamed path). Recovery is a session restart; accepted as the
        // implementation-level cost of skipping a swap-then-cleanup round-trip
        // (not an ADR-level decision -- a second attach-pass would complicate
        // the replace path for a near-zero-probability OS-level failure).
        if let Err(e) = self.conn.execute_batch(&format!(
            "ATTACH '{attach_path}' AS {} (READ_ONLY);",
            quote_ident(reference_name)
        )) {
            return LoadOutcome::Error(LoadError::Other {
                detail: format!("无法挂载新快照（{e}）"),
            });
        }

        // Record the post-replace attached file (formal name, or the swap path
        // when the rename fallback fired) for the sandbox re-attach path.
        self.source_files
            .insert(reference_name.to_string(), PathBuf::from(&attach_path));

        // Capture the carried-over display label before the descriptor swap --
        // the Replaced event + cascade anchor name what was replaced, and a
        // future carry-over rule change must not retroactively alter either.
        let display_name = existing.display_name.clone();

        // Cascade stale (issue #41, ADR-0025/0041): before the new descriptor
        // commits, transitively mark every result_N downstream of this source
        // stale, each carrying this Replaced event's identity with reason =
        // Replaced. The reference name is stable (the new snapshot just took it
        // over), so the cascade keys correctly; a result already stale keeps
        // its first anchor (ADR-0041 终局死轮). Mirrors `commit_removal`'s
        // delete-cascade -- distinct in reason, and in that the source stays
        // registered (the descriptor swap happens just below).
        let newly_stale = self.working_set.cascade_stale(
            reference_name,
            StaleAnchor {
                reference_name: reference_name.to_string(),
                display_name: display_name.clone(),
                reason: StaleReason::Replaced,
            },
        );
        if !newly_stale.is_empty() {
            log::info!(
                target: "toptopduck::session",
                "换源「{reference_name}」级联失效：{}", newly_stale.join(", ")
            );
        }

        // Commit: update the descriptor in place. The reference name is stable
        // (every existing reference now resolves to the new data); the display
        // label carries over (a user rename survives the replace, ADR-0037); the
        // privacy config carries over too (issue #9 AC4: a source's privacy
        // intent survives a re-upload -- entries for columns that no longer exist
        // are ignored at read time, ADR-0011); the body reflects the new snapshot.
        // A source itself is never stale (the cascade marks result_N, not the
        // source descriptor).
        let updated = DatasetDescriptor {
            reference_name: reference_name.to_string(),
            display_name: existing.display_name,
            source_path: path.to_string_lossy().to_string(),
            columns: new_snap.columns,
            row_count: new_snap.row_count,
            sample: new_snap.sample,
            fingerprint: new_snap.fingerprint,
            rectify: RectifyProvenance::NotApplicable,
            privacy: existing.privacy,
            stale: None,
        };
        // `replace` returns `false` only on an unregistered name -- a logic bug,
        // not a user error (the `existing` lookup at the top confirmed
        // registration, and the cascade above marks result_N, not the source
        // descriptor). Assert so a future regression can't silently leave the
        // source unswapped while the Replaced event still lands below.
        assert!(
            self.working_set.replace(updated.clone()),
            "replace_source targets a confirmed-existing source"
        );

        // Append the Replaced source lifecycle event (ADR-0040, issue #41):
        // first-class in the thread (always visible, occupies a slot) but NOT a
        // turn -- never enters the LLM window or advances result_N. The display
        // label was captured above so the event still names what was replaced.
        self.append_source_event(SourceLifecycleKind::Replaced, reference_name, &display_name);

        LoadOutcome::Loaded(updated)
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
        // Single in-flight + cancellation (ADR-0021, issue #28): begin the turn
        // on the shared token (marks in-flight, clears any stale request from a
        // prior turn) and arm the optional timeout watchdog. The guard is held
        // to end of scope -- its Drop clears in-flight + the interrupt slot on
        // every exit (including the early Cancelled returns below) and
        // invalidates the watchdog so a late timeout cannot fire into the next
        // turn. Clone the Arc into a local so `&cancel` borrows that local, not
        // `&mut self` (try_materialize takes &mut self).
        let cancel = Arc::clone(&self.cancel);
        let guard = cancel.begin_turn();
        if let Some(timeout) = self.turn_timeout {
            let alive = guard.watchdog_alive();
            let token = Arc::clone(&cancel);
            // Detached: the alive flag is its only tie to this turn. A turn that
            // finishes before the deadline drops the guard -> alive=false -> the
            // watchdog wakes, sees false, and does not fire. KNOWN RACE (follow-up
            // to #28): if the watchdog reads alive=true and then the turn ends and
            // a new turn begins before request() runs, the cancel lands on the new
            // turn. The window is a handful of instructions between the load and
            // request(), only reachable when timeout ~= the prior turn's runtime;
            // default turn_timeout=None spawns nothing, so production exposure is
            // near zero. A generation/turn-id guard closes it fully (deferred).
            // catch_unwind keeps this detached thread self-sufficient: request()
            // degrades on lock poison (see CancelToken::request), but any residual
            // panic is logged instead of killing the thread silently.
            thread::spawn(move || {
                thread::sleep(timeout);
                if alive.load(Ordering::SeqCst)
                    && catch_unwind(AssertUnwindSafe(|| token.request())).is_err()
                {
                    log::error!(
                        target: "toptopduck::session",
                        "turn watchdog panicked firing cancel; timeout path may be impaired"
                    );
                }
            });
        }

        // The window assembler consumes turns only (ADR-0040): source lifecycle
        // events live in the same timeline but are filtered out here, so they
        // never enter the LLM turn window or occupy an N=20 slot.
        let turns = self.turns();
        let request = window::assemble(question, &self.working_set, &turns);
        // Collect each attempt's failure so exhaustion surfaces them all, not
        // just the last -- a SQL execution error (the actionable kind) would
        // otherwise be overwritten by a later transient Unavailable. Consecutive
        // identical failures dedupe so a persistently-bad SQL isn't repeated
        // across attempts.
        let mut failures: Vec<String> = Vec::new();
        for _attempt in 0..=TURN_RETRY_BUDGET {
            // Cancel check at the loop top: a cancel that arrived before the
            // first attempt or during the prior attempt aborts immediately as
            // Cancelled (ADR-0021/0028 outcome D). No retry -- the user asked to
            // stop, and a timed-out SQL would re-hit the same wall.
            if cancel.is_requested() {
                return self.record_turn(question, TurnOutcome::Cancelled);
            }
            match self.provider.generate(&request) {
                // Textual branch (ADR-0017/0018): a valid non-result turn -- no
                // retry, no result_N. The provider's text + assumption ride the
                // outcome verbatim. A cancel that arrived during the (possibly
                // slow) provider call wins over a textual reply: the user asked
                // to stop, so this is Cancelled, not a clarification.
                Ok(ProviderReply::Text {
                    kind,
                    body,
                    assumption,
                }) => {
                    if cancel.is_requested() {
                        return self.record_turn(question, TurnOutcome::Cancelled);
                    }
                    let outcome = TurnOutcome::Textual {
                        text_kind: kind,
                        body,
                        assumption,
                    };
                    return self.record_turn(question, outcome);
                }
                // SQL branch: execute + materialize. A schema/runtime failure
                // (bad reference, type error) consumes the budget and retries;
                // a resource-cap hit does NOT retry (the same SQL would hit the
                // same wall, ADR-0005/0028) and fails immediately. A cancel
                // during the query interrupts DuckDB; the resulting error is a
                // Cancelled turn, not a retryable failure. Success materializes
                // result_N.
                Ok(ProviderReply::Sql {
                    sql,
                    viz,
                    assumption,
                }) => {
                    // Re-check after the (possibly slow) provider call: if the
                    // provider blocked past a cancel/timeout, stop now without
                    // touching DuckDB.
                    if cancel.is_requested() {
                        return self.record_turn(question, TurnOutcome::Cancelled);
                    }
                    match self.try_materialize(&sql, &cancel) {
                        Ok(dataset) => {
                            let outcome = TurnOutcome::Materialized {
                                dataset: Box::new(dataset),
                                sql: Some(sql),
                                viz,
                                assumption,
                            };
                            return self.record_turn(question, outcome);
                        }
                        Err(exec_err) => {
                            // A cancel during the query (engine interrupt or a
                            // mid-query flag) is Cancelled, not a retryable
                            // failure -- check the flag before routing on kind.
                            if cancel.is_requested() {
                                return self.record_turn(question, TurnOutcome::Cancelled);
                            }
                            match exec_err.kind {
                                // Resource cap: abort now -- retrying cannot help.
                                ExecErrorKind::Resource => {
                                    let outcome = TurnOutcome::Failed {
                                        reason: format!(
                                            "{}{}",
                                            RESOURCE_FAIL_PREFIX, exec_err.detail
                                        ),
                                    };
                                    return self.record_turn(question, outcome);
                                }
                                // Stale reference (issue #40, ADR-0013 invariant
                                // 2): refuse without retry -- the same SQL would
                                // reference the same stale result, so retrying
                                // only burns budget. Honest Failed turn naming
                                // the dead reference (the pre-check already wrote
                                // a full Chinese reason into exec_err.detail).
                                ExecErrorKind::StaleReference => {
                                    let outcome = TurnOutcome::Failed {
                                        reason: exec_err.detail.clone(),
                                    };
                                    return self.record_turn(question, outcome);
                                }
                                // Guard-checked above: try_materialize only emits
                                // Cancelled when is_requested() is true, which the
                                // pre-check already routed to TurnOutcome::Cancelled.
                                // The arm turns the invariant into a runtime contract
                                // -- a future second caller of try_materialize that
                                // forgets the pre-check fails loudly here instead of
                                // silently retrying a cancel.
                                ExecErrorKind::Cancelled => unreachable!(
                                    "Cancelled kind is guard-checked above; \
                                     try_materialize only emits it when is_requested() \
                                     is true"
                                ),
                                // Schema/runtime: feed the budget and retry.
                                _ => Self::push_failure(
                                    &mut failures,
                                    format!("{}{}", EXECUTE_FAIL_PREFIX, exec_err.detail),
                                ),
                            }
                        }
                    }
                }
                // NotWired is permanent (no provider configured) -- retrying
                // cannot help, so the turn fails immediately without consuming
                // the budget.
                Err(ProviderError::NotWired) => {
                    let outcome = TurnOutcome::Failed {
                        reason: ProviderError::NotWired.to_string(),
                    };
                    return self.record_turn(question, outcome);
                }
                // A contract violation / transient call failure -- consume the
                // budget and retry with the SAME request (blind retry). The real
                // client's error re-feed lands in #29; the scripted fake's queue
                // advances per call.
                Err(ProviderError::Unavailable(detail)) => {
                    Self::push_failure(
                        &mut failures,
                        ProviderError::Unavailable(detail).to_string(),
                    );
                }
            }
        }
        // Budget exhausted: surface the accumulated failures honestly as a failed
        // turn. The "重试预算耗尽" prefix distinguishes this from a permanent
        // NotWired failure (which never consumes the budget, ADR-0028), so the
        // two failure paths read distinctly to the user.
        let detail = if failures.is_empty() {
            "未知错误".to_string()
        } else {
            failures.join("；")
        };
        let outcome = TurnOutcome::Failed {
            reason: format!("重试预算耗尽：{detail}"),
        };
        self.record_turn(question, outcome)
    }

    /// Record one retry attempt's failure, deduping consecutive identical
    /// failures: a persistent error isn't repeated across attempts, while
    /// distinct failures (e.g. a SQL error then a transient Unavailable) are
    /// all kept so budget exhaustion surfaces the full picture, not just the
    /// last attempt.
    fn push_failure(failures: &mut Vec<String>, detail: String) {
        match failures.last() {
            Some(last) if last == &detail => {} // consecutive duplicate -- skip
            _ => failures.push(detail),
        }
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
    fn append_source_event(
        &mut self,
        kind: SourceLifecycleKind,
        reference_name: &str,
        display_name: &str,
    ) {
        self.history.push(ThreadEntry::Source(SourceLifecycleEvent {
            kind,
            reference_name: reference_name.to_string(),
            display_name: display_name.to_string(),
        }));
        // ADR-0034 / ADR-0040: a source lifecycle operation also lands its
        // terminal state to the recipe atomically (changing the current
        // source set is a recipe mutation, not just a thread entry).
        self.persist_if_bound();
    }

    /// Build the recipe (ADR-0034) describing the current working set. The
    /// recipe is organized by current state, not as a historical ledger:
    /// only still-valid productive turns ride the replayable chain, and the
    /// history mirrors the always-visible timeline (turns + source events).
    /// A Materialized turn whose `result_N` has since gone stale (cascade)
    /// or been removed is dropped -- it cannot replay; the tracer-bullet
    /// happy path has none (full stale-render lands in a later slice).
    pub fn build_recipe(&self) -> Recipe {
        // ADR-0036 §4 hybrid paths: `source_path` is always absolute (fallback
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
                            // Only keep a Materialized turn if its result_N is
                            // still an active member (registered + not stale).
                            let live = self.working_set.get(&dataset.reference_name);
                            let active = live.map(|d| d.stale.is_none()).unwrap_or(false);
                            if !active {
                                return None;
                            }
                            // sql is Some on every fresh Materialized turn; a
                            // None predates the field and cannot replay, so
                            // drop the turn rather than fabricate SQL.
                            let sql = sql.clone()?;
                            // display_name comes from the working set's CURRENT
                            // state, not the ask-time snapshot in history -- a
                            // user rename (ADR-0037) updates the working set,
                            // not the history entry, so the snapshot is stale.
                            let display_name = live
                                .map(|d| d.display_name.clone())
                                .unwrap_or_else(|| dataset.display_name.clone());
                            RecipeOutcome::Materialized {
                                reference_name: dataset.reference_name.clone(),
                                display_name,
                                sql,
                                assumption: assumption.clone(),
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

        Recipe {
            format_version: RECIPE_FORMAT_VERSION,
            session_name: self.session_name.clone().unwrap_or_default(),
            sources,
            history,
            active,
        }
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
    fn persist_if_bound(&mut self) {
        if let Err(e) = self.persist() {
            log::error!(target: "toptopduck::session", "自动保存 .duck 失败：{e}");
            // Stash the latest failure (overwrites a prior unread one -- the
            // most recent is the most actionable). Cleared by take_persist_error.
            self.persist_error = Some(e.to_string());
        }
    }

    /// Take (read + clear) the most recent per-turn persistence failure, if
    /// any. The command layer exposes this so the frontend can show a
    /// non-blocking banner after each turn / source event / resume. The
    /// failure is cleared on read so a turn that subsequently saves
    /// successfully does not re-surface the stale error.
    pub fn take_persist_error(&mut self) -> Option<String> {
        self.persist_error.take()
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

    /// Execute one provider SQL and materialize it as result_N (ADR-0003/0024),
    /// deriving + registering the result. Returns `Err` carrying a classified
    /// [`ExecError`] on any failure: a rejected CREATE (engine error -- the
    /// wrapping rejects mutating statements and COPY/ATTACH/INSTALL/LOAD as
    /// parser errors; ADR-0005), a hit resource cap, or a shape-derivation
    /// failure. The caller's retry loop routes on the kind: Resource aborts,
    /// Schema/Runtime retry (ADR-0028).
    ///
    /// On a shape-derivation failure the just-created result_N is rolled back
    /// first: an orphan table left unregistered would make the next attempt's
    /// `next_result_number` reuse N and clash on CREATE, wedging every later
    /// turn (ADR-0022 never-reused). The DROP is best-effort but its own failure
    /// is folded into the detail so a wedged session is observable, not
    /// silently masked (M1 regression).
    ///
    /// Engine guardrails (ADR-0005): the SQL runs on a locked-down sandbox
    /// ([`crate::session::sandbox`]) with LocalFileSystem disabled, then is
    /// embedded as `CREATE TABLE result_N AS SELECT * FROM (<sql>) LIMIT cap+1`.
    /// The disabled filesystem refuses read_* table functions; the subquery
    /// wrapping means a non-SELECT statement (DROP/ALTER/INSERT/UPDATE/DELETE,
    /// COPY/ATTACH/INSTALL/LOAD) is a parser error before it can touch a source
    /// or the filesystem; the LIMIT pushes down into the scan so at most cap+1
    /// rows materialize, capping memory on a runaway join. The result name is
    /// tool-generated; the SQL is provider-supplied -- the only live provider
    /// returning SQL today is the scripted test fake (the real LLM wires in #29).
    fn try_materialize(
        &mut self,
        sql: &str,
        cancel: &crate::cancel::CancelToken,
    ) -> Result<DatasetDescriptor, ExecError> {
        // result_N is max+1, never reused (ADR-0022). Re-derived each attempt:
        // a failed attempt registers nothing, so N is stable across retries.
        let n = self.working_set.next_result_number();
        let result_name = format!("result_{n}");

        // Stale-reference refusal (ADR-0013 invariant 2) + provenance record
        // (issue #40): parse the SQL once before touching the sandbox so a
        // stale reference is rejected without burning setup or retry budget.
        // The same analysis yields the dependency set recorded after a
        // successful materialize -- the cascade reads it on a later source
        // delete. Conservative parse failure (deps = all members) is recorded
        // as-is so a delete never under-cascades ("宁可多失效不漏失效").
        let deps = crate::provenance::analyze(sql, &self.working_set);
        if let Some(stale_ref) = deps.stale_ref.as_ref() {
            return Err(ExecError::new(
                ExecErrorKind::StaleReference,
                format!("引用了已失效的 {stale_ref}（因源已删除而失效，不能在新查询中引用）"),
            ));
        }

        // Provider SQL runs on a locked-down sandbox (ADR-0005 read_* closure):
        // a separate instance with LocalFileSystem disabled, so a read_* table
        // function is refused by the engine ("... disabled by configuration").
        // Sources are re-attached READ_ONLY (zero-copy; concurrent read-only
        // attach is allowed) and prior results are mirrored in, so the SQL
        // resolves identically to admin. Only the sandbox runs provider SQL;
        // admin runs tool-controlled DML. The sandbox is dropped at end of scope
        // (lockdown is irreversible, so it is single-use).
        let sandbox_conn = sandbox::open()?;
        sandbox::attach_sources(&sandbox_conn, &self.working_set, &self.source_files)?;
        sandbox::mirror_results(&sandbox_conn, &self.conn, &self.working_set)?;
        sandbox::lockdown(&sandbox_conn)?;

        // Register the sandbox interrupt handle so a cancel can abort THIS query
        // at source (ADR-0021 DuckDB interrupt). Scoped to the provider SQL only:
        // cleared right after the CREATE+count, so the tool-controlled
        // install/derive steps below (fast, on admin) are never disrupted by a
        // cancel -- the orchestrator's post-call flag check lands those as
        // Cancelled without touching the working set.
        cancel.set_interrupt(sandbox_conn.interrupt_handle());

        // Resource cap (ADR-0005 L3): bracket the query and LIMIT to cap+1 so a
        // runaway cross-join cannot balloon memory (DuckDB pushes LIMIT into the
        // scan, so only cap+1 rows ever materialize). The brackets make LIMIT
        // bind to the whole query output; a trailing ';' is stripped so the
        // subquery parses. Below, a count of cap+1 means the true result
        // exceeded the cap -> abort (silent truncation is forbidden, ADR-0030).
        let inner = sql.trim().trim_end_matches(';').trim_end();
        let cap_plus_one = self.result_row_cap.saturating_add(1);
        let create_sql = format!(
            "CREATE TABLE {} AS SELECT * FROM ({inner}) AS _src LIMIT {cap_plus_one}",
            quote_ident(&result_name),
        );
        let create_outcome = sandbox_conn.execute_batch(&create_sql);
        // The provider SQL is done (success or failure) -- stop associating the
        // interrupt handle so a later cancel cannot reach this connection.
        cancel.clear_interrupt();
        if let Err(e) = create_outcome {
            // The engine rejected the CREATE on the sandbox -- a parser error
            // from a mutating statement / COPY / ATTACH the wrapping bars, a
            // read_* refusal ("disabled by configuration"), a schema error, a
            // runtime error, OR the interrupt from a cancel (surfaces as a
            // generic DuckDB failure -> Runtime here). The caller re-checks the
            // cancel flag and routes a cancel to Cancelled before any retry, so
            // the kind only chooses the non-cancel routing.
            return Err(ExecError::new(
                classify_duckdb_error(&e.to_string()),
                e.to_string(),
            ));
        }
        // Row-count governor on the sandbox: count == cap+1 -> the true result
        // exceeded the cap. Aborts as Resource; the sandbox is dropped (admin
        // untouched), so -- unlike the install/derive steps below -- no rollback
        // of result_N is needed here.
        let rows: i64 = match sandbox_conn.query_row(
            &format!("SELECT COUNT(*) FROM {}", quote_ident(&result_name)),
            [],
            |r| r.get(0),
        ) {
            Ok(rows) => rows,
            Err(e) => return Err(ExecError::new(ExecErrorKind::Runtime, e.to_string())),
        };
        if rows as u64 > self.result_row_cap {
            return Err(ExecError::new(
                ExecErrorKind::Resource,
                format!("结果行数（{rows}）超过上限 {}", self.result_row_cap),
            ));
        }
        // Cancel landed between the query's success and the install: the partial
        // result_N exists on the sandbox only (admin untouched), so no rollback
        // is needed -- drop the sandbox and let the caller record Cancelled. The
        // check goes after the resource governor so a genuine over-cap result is
        // not misread as a cancel. The kind is Cancelled (not Resource) so the
        // signal stays type-honest -- outcome D, not a cap hit (ADR-0028).
        if cancel.is_requested() {
            return Err(ExecError::new(
                ExecErrorKind::Cancelled,
                "查询已取消".to_string(),
            ));
        }

        // Install the new result onto admin (Value mirror). A failure can leave
        // a partial result_N on admin, so roll it back (ADR-0022 never-reused).
        if let Err(e) =
            sandbox::install_result(&self.conn, &sandbox_conn, &result_name, &result_name)
        {
            let detail = Self::rollback_result(&self.conn, &result_name, e.detail);
            return Err(ExecError::new(ExecErrorKind::Runtime, detail));
        }

        // Derive the result's shape from admin's installed table -- the same
        // derivation a source snapshot uses (DRY). A derive failure also rolls
        // back result_N (orphan table would wedge later turns, ADR-0022).
        let shape = match derive_table(&self.conn, &result_name, &self.temp_path, &result_name) {
            Ok(shape) => shape,
            Err(e) => {
                let detail = Self::rollback_result(&self.conn, &result_name, e.to_string());
                return Err(ExecError::new(ExecErrorKind::Runtime, detail));
            }
        };
        let descriptor = DatasetDescriptor {
            reference_name: result_name.clone(),
            display_name: result_name.clone(),
            source_path: String::new(), // derived -- no source file (ADR-0004)
            columns: shape.columns,
            row_count: shape.row_count,
            sample: shape.sample,
            fingerprint: shape.fingerprint,
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: None,
        };
        // Record the just-materialized result's provenance (issue #40,
        // ADR-0025): the dependency set the pre-check computed. The cascade
        // reads this on a later source delete to find dependents. Recorded
        // under `result_name` (stable identity) AFTER register_result, so the
        // member_names snapshot at analyze time already excluded this new
        // result -- no self-dependency. `deps.refs` was pre-intersected with
        // the then-live working set (members present at the parse moment).
        self.working_set.register_result(descriptor.clone());
        self.working_set.record_provenance(&result_name, deps.refs);

        // GC cap (ADR-0013 M=100, issue #42): if the result_N total now
        // exceeds the cap, auto-reclaim the oldest stale results. The fresh
        // result is active (stale is None), so it is never a candidate; active
        // results survive even when older than every stale result. Reclaimed
        // results keep their producing turn in the thread (visible history) --
        // only their data becomes unreferenceable.
        let reclaimed = self.gc_stale_results();
        if !reclaimed.is_empty() {
            log::info!(
                target: "toptopduck::session",
                "GC 回收最老 stale：{}",
                reclaimed.join(", ")
            );
        }
        Ok(descriptor)
    }

    /// Auto-reclaim the oldest stale results when the `result_N` count exceeds
    /// the cap (ADR-0013, issue #42). GC runs only against stale results --
    /// active results are never auto-deleted. For each candidate: drop the
    /// physical table (best-effort; an orphan from a failed DROP is harmless --
    /// the working-set removal below is the authority on "gone", and the
    /// session temp dir is wiped on drop either way), then remove the registry
    /// entry (reference name + result membership + provenance edge). The
    /// producing turn stays in the thread (AC: round entries preserved). The
    /// new result's number is unaffected -- `next_result_number` scans only
    /// registered results, so a GC'd number becomes a permanent hole
    /// (ADR-0022). Returns the reclaimed names so the caller can log the
    /// reclaim's reach.
    fn gc_stale_results(&mut self) -> Vec<String> {
        let candidates = self.working_set.gc_stale_candidates(self.result_count_cap);
        for name in &candidates {
            let drop_sql = format!("DROP TABLE {}", quote_ident(name));
            if let Err(e) = self.conn.execute_batch(&drop_sql) {
                // Best-effort, and deliberately warn (not error). The asymmetry
                // vs `rollback_result`'s error-grade DROP is grounded in
                // ADR-0022: rollback drops an UN-registered result_N, so an
                // orphan makes the next `next_result_number` (max over
                // registered names) reuse N and clash on CREATE -> wedge. GC
                // drops an already-registered older result_K, and the
                // `remove` below drops it from the registry, so the next
                // number is max(remaining)+1 > K -- the orphan never collides
                // with a future CREATE. warn keeps a recurring engine failure
                // observable without overstating a non-wedging cleanup miss.
                log::warn!(
                    target: "toptopduck::session",
                    "GC DROP of stale {name} failed: {e}"
                );
            }
            self.working_set.remove(name);
        }
        candidates
    }

    /// Drop a just-created result_N table and fold any cleanup failure into the
    /// reported detail. An orphan result_N would make the next attempt's
    /// `next_result_number` reuse N and clash on CREATE, wedging every later
    /// turn (ADR-0022 never-reused) -- the M1 regression. Surfacing the DROP
    /// failure keeps a wedged session observable instead of silently masked.
    fn rollback_result(conn: &Connection, result_name: &str, detail: String) -> String {
        let drop_sql = format!("DROP TABLE {}", quote_ident(result_name));
        match conn.execute_batch(&drop_sql) {
            Ok(()) => detail,
            Err(drop_err) => {
                // Session-wedge-grade failure: an orphan result_N makes the next
                // attempt reuse N and clash on CREATE, wedging every later turn
                // (ADR-0022). Log at error so it is observable server-side, not
                // just folded into the user-facing reason string.
                log::error!(
                    target: "toptopduck::session",
                    "rollback DROP of {result_name} failed: {drop_err}; session may wedge on next result_N reuse (ADR-0022)"
                );
                format!(
                    "{detail}; cleanup DROP of {result_name} also failed: {drop_err} (orphan table may wedge later turns)"
                )
            }
        }
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
            recipe.format_version,
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
            recipe.format_version,
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
        // ADR-0036 §4 hybrid paths: a source inside the .duck file's directory
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
