//! The extraction engine's runtime half (issue #1530): the turn executor,
//! the single-running + latest-pending scheduler, and the workspace-keyed
//! status hub the panel reads. The pure half (prompt / guards / chain /
//! parser) lives in [`super::extract`].
//!
//! Posture (ADR-0147 + issue #1530): extraction NEVER blocks the session --
//! it runs on its own thread, a close aborts (drops the pending slot and
//! voids late results via a generation bump) and drains for a bounded
//! window only. The scheduler scope is the SESSION (close is a session
//! event); the status scope is the WORKSPACE (the memory is a workspace
//! asset -- two sessions on one workspace share one panel truth).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::app_config::AppConfig;
use crate::provider::keychain::{ProviderConfigSource, StaticConfig};
use crate::provider::live_config::LiveProviderConfig;
use crate::provider::tool_calling::{ToolTurnMessage, ToolTurnReply, ToolTurnRequest};
use crate::provider::{LiveProvider, Provider};
use crate::workspace::extract::{self, ExtractedMemory};
use crate::workspace::memory::{self, MemoryEntry, MemorySource};
use crate::workspace::registry::WorkspaceRegistry;

/// The bounded close-time drain window: how long a session close waits for
/// an in-flight model call before giving up (the call keeps running
/// detached; its late result is voided by the generation check, so it can
/// never land in the next session's status).
const CLOSE_DRAIN_WINDOW: Duration = Duration::from_secs(5);

/// The red-cap threshold (issue #1530): at this index usage the extraction
/// PAUSES (skip + panel hint) -- never auto-deletes. The panel's yellow
/// band starts at 80; this is the red band the write side enforces.
pub(crate) const RED_CAP_PERCENT: u8 = 95;

/// One after-turn extraction request (issue #1530): everything the executor
/// needs, cloned into whichever slot takes it.
#[derive(Debug, Clone)]
pub struct ExtractionJob {
    pub workspace: PathBuf,
    pub session_id: String,
    pub question: String,
    pub response_text: String,
    /// The tool names this turn invoked (guard 2's input).
    pub turn_tool_names: Vec<String>,
}

/// Why an extraction was skipped (the panel's "已跳过" faces).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    /// No provider resolves on the chain (ADR-0147 Decision 7's tail).
    NoProvider,
    /// The workspace's `auto_extraction` toggle is off.
    ToggleOff,
    /// The index usage is at the red cap -- extraction paused (no deletion).
    IndexCap,
}

/// The panel-facing extraction status (issue #1530's three panel states,
/// with the skip reason and failure detail spelled out). Internally tagged
/// (`state`) -- the wire shape the frontend's discriminated union reads.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ExtractionStatus {
    Running,
    Skipped { reason: SkipReason },
    NoNewFacts,
    Extracted { titles: Vec<String> },
    Failed { detail: String },
}

/// Run one extraction to its terminal status. `None` means a guard fired
/// (fragment user block / in-turn memory write): the LAST real outcome
/// stays the panel's truth, so the caller must not record anything.
///
/// The defensive order matters: toggle and red-cap are checked BEFORE any
/// model call is spent, the guards before the chain resolution.
pub(crate) fn perform_extraction(
    job: &ExtractionJob,
    registry: &WorkspaceRegistry,
    live: &LiveProviderConfig,
) -> Option<ExtractionStatus> {
    use ExtractionStatus::Skipped;
    if !registry.auto_extraction(&job.workspace) {
        return Some(Skipped {
            reason: SkipReason::ToggleOff,
        });
    }
    let rows = memory::load_rows(&job.workspace);
    if memory::index_usage_percent(&rows) >= RED_CAP_PERCENT {
        return Some(Skipped {
            reason: SkipReason::IndexCap,
        });
    }
    if !extract::has_independent_user_block(&job.question)
        || extract::has_memory_write_segment(&job.turn_tool_names)
    {
        return None;
    }
    let cfg: AppConfig = live.load();
    let Some(profile) = extract::resolve_extraction_profile(&cfg) else {
        return Some(Skipped {
            reason: SkipReason::NoProvider,
        });
    };
    let key = live.keychain().fetch_key_for(&profile.id).ok().flatten();
    let Some(key) = key else {
        return Some(Skipped {
            reason: SkipReason::NoProvider,
        });
    };
    let static_cfg = StaticConfig {
        key: Some(key),
        base_url: profile.base_url.clone(),
        model: profile.model.clone(),
        locale: live.locale(),
        protocol: profile.protocol,
    };
    let locale = static_cfg.locale;
    perform_with_provider(job, &LiveProvider::new(static_cfg), locale, &rows)
}

/// The provider-facing half of [`perform_extraction`] (the test seam: a
/// scripted [`crate::provider::fake::FakeProvider`] stands in for the live
/// one). Guards and the chain are already settled by the caller -- this is
/// the model call, the parse, and the persist.
fn perform_with_provider(
    job: &ExtractionJob,
    provider: &dyn Provider,
    locale: crate::provider::prompt::ResponseLocale,
    rows: &[memory::MemoryIndexRow],
) -> Option<ExtractionStatus> {
    let existing_titles: Vec<String> = rows.iter().map(|r| r.title.clone()).collect();
    let request = ToolTurnRequest {
        system: extract::render_extraction_system_prompt(locale),
        messages: vec![ToolTurnMessage::user(
            extract::render_extraction_user_message(
                &job.question,
                &job.response_text,
                &existing_titles,
            ),
        )],
        tools: Vec::new(),
        max_tokens: extract::EXTRACTION_MAX_TOKENS,
        thought_level: None,
    };
    let reply = match provider.generate_tool_turn(&request) {
        Ok(reply) => reply,
        Err(err) => {
            return Some(ExtractionStatus::Failed {
                detail: err.to_string(),
            })
        }
    };
    let ToolTurnReply::Text(text) = reply.reply else {
        return Some(ExtractionStatus::Failed {
            detail: "extraction reply carried tool calls".to_string(),
        });
    };
    let entries = extract::parse_extraction_reply(&text);
    if entries.is_empty() {
        return Some(ExtractionStatus::NoNewFacts);
    }
    Some(persist_entries(job, &entries))
}

/// Persist the parsed entries via the #1529 write primitive (host-stamped
/// `source: extract` + `origin_session`, today's absolute date). The first
/// index-full refusal pauses extraction for the batch -- a partial batch
/// keeps what landed (each entry is independently whole).
fn persist_entries(job: &ExtractionJob, entries: &[ExtractedMemory]) -> ExtractionStatus {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let mut titles = Vec::with_capacity(entries.len());
    for entry in entries {
        let memory = MemoryEntry {
            name: entry.name.trim().to_string(),
            description: entry.description.trim().to_string(),
            r#type: entry.memory_type().expect("parser filtered the enum"),
            origin_session: Some(job.session_id.clone()),
            saved_at: today.clone(),
            source: MemorySource::Extract,
        };
        match memory::save_entry(&job.workspace, &memory, &entry.body) {
            Ok(row) => titles.push(row.title),
            Err(memory::MemoryError::IndexFull { detail }) => {
                log::warn!(
                    target: "toptopduck::workspace_memory",
                    "extraction paused at the index red cap: {detail}"
                );
                return ExtractionStatus::Skipped {
                    reason: SkipReason::IndexCap,
                };
            }
            Err(err) => {
                return ExtractionStatus::Failed {
                    detail: err.to_string(),
                }
            }
        }
    }
    ExtractionStatus::Extracted { titles }
}

/// One step of the executor seam (tests inject a gate; production injects
/// [`perform_extraction`] over the live config).
type ExecuteFn = Arc<dyn Fn(ExtractionJob) -> Option<ExtractionStatus> + Send + Sync>;
/// The status write-back seam (the hub installs the workspace-keyed map).
type ReportFn = Arc<dyn Fn(&Path, ExtractionStatus) + Send + Sync>;

struct SchedulerInner {
    /// Bumped by every close: results from an older generation are voided,
    /// and the pending slot is dropped with the bump.
    generation: u64,
    running: bool,
    pending: Option<ExtractionJob>,
}

/// The single-session scheduler (issue #1530): ONE running extraction plus
/// ONE pending slot that a newer request OVERWRITES -- no queue, so a burst
/// of turns costs at most two model calls (the in-flight one + the latest).
pub(crate) struct ExtractionScheduler {
    inner: Arc<(Mutex<SchedulerInner>, Condvar)>,
    execute: ExecuteFn,
    report: ReportFn,
}

impl ExtractionScheduler {
    pub(crate) fn new(execute: ExecuteFn, report: ReportFn) -> Self {
        Self {
            inner: Arc::new((
                Mutex::new(SchedulerInner {
                    generation: 0,
                    running: false,
                    pending: None,
                }),
                Condvar::new(),
            )),
            execute,
            report,
        }
    }

    /// Submit a job: pending-slot overwrite while running, otherwise start
    /// immediately (recording the Running status first).
    pub(crate) fn submit(&self, job: ExtractionJob) {
        let (lock, _) = &*self.inner;
        let mut inner = lock.lock().expect("extraction scheduler lock poisoned");
        if inner.running {
            inner.pending = Some(job);
            return;
        }
        inner.running = true;
        (self.report)(&job.workspace, ExtractionStatus::Running);
        self.spawn_locked(inner, job);
    }

    /// Close-time abort + bounded drain (issue #1530): bump the generation
    /// (voiding every in-flight or future result of this era), drop the
    /// pending slot, then wait -- at most [`CLOSE_DRAIN_WINDOW`] -- for the
    /// running call to settle. A call slower than the window keeps running
    /// detached; its late result dies on the generation check.
    pub(crate) fn close_and_drain(&self) {
        let (lock, cv) = &*self.inner;
        let mut inner = lock.lock().expect("extraction scheduler lock poisoned");
        inner.generation += 1;
        inner.pending = None;
        let deadline = Instant::now() + CLOSE_DRAIN_WINDOW;
        while inner.running {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let (guard, _) = cv
                .wait_timeout(inner, deadline - now)
                .expect("drain wait poisoned");
            inner = guard;
        }
    }

    /// Spawn the runner for `job` under a HELD guard (running already
    /// true), releasing it before the thread starts so the thread can
    /// re-acquire on settle.
    fn spawn_locked(&self, inner: MutexGuard<'_, SchedulerInner>, job: ExtractionJob) {
        let generation = inner.generation;
        let state = Arc::clone(&self.inner);
        let rollback_state = Arc::clone(&state);
        let execute = Arc::clone(&self.execute);
        let report = Arc::clone(&self.report);
        drop(inner);
        let spawned = std::thread::Builder::new()
            .name("memory-extraction".into())
            .spawn(move || run_one(state, execute, report, job, generation));
        if let Err(err) = spawned {
            // A failed spawn must not strand `running` -- roll the slot back
            // so the next submit starts instead of deadlocking the lane.
            log::error!(target: "toptopduck::workspace_memory", "extraction thread spawn failed: {err}");
            let (lock, cv) = &*rollback_state;
            let mut inner = lock.lock().expect("extraction scheduler lock poisoned");
            if inner.generation == generation {
                inner.running = false;
                cv.notify_all();
            }
        }
    }
}

/// One extraction's settle protocol: clear the running flag, then (same
/// generation only) report the result and chain the pending job.
fn run_one(
    state: Arc<(Mutex<SchedulerInner>, Condvar)>,
    execute: ExecuteFn,
    report: ReportFn,
    job: ExtractionJob,
    generation: u64,
) {
    let result = execute(job.clone());
    let (lock, cv) = &*state;
    let mut inner = lock.lock().expect("extraction scheduler lock poisoned");
    inner.running = false;
    cv.notify_all();
    if inner.generation != generation {
        return; // a close voided this era: the result dies here
    }
    if let Some(status) = result {
        report(&job.workspace, status);
    }
    if let Some(next) = inner.pending.take() {
        inner.running = true;
        drop(inner);
        report(&next.workspace, ExtractionStatus::Running);
        let next_gen = generation;
        let rollback_state = Arc::clone(&state);
        let spawned = std::thread::Builder::new()
            .name("memory-extraction".into())
            .spawn(move || run_one(state, execute, report, next, next_gen));
        if let Err(err) = spawned {
            log::error!(target: "toptopduck::workspace_memory", "extraction thread spawn failed: {err}");
            let (lock, cv) = &*rollback_state;
            let mut inner = lock.lock().expect("extraction scheduler lock poisoned");
            // Same-generation guard as `spawn_locked`'s rollback: a close in
            // the spawn gap owns the flag now -- clearing it would cancel
            // the next era's in-flight call.
            if inner.generation == next_gen {
                inner.running = false;
                cv.notify_all();
            }
        }
    }
}

/// The Tauri-state hub (issue #1530): one scheduler per SESSION (close is
/// the abort boundary), one latest status per WORKSPACE (the panel truth --
/// sessions on the same workspace share it).
pub struct ExtractionHub {
    statuses: Arc<Mutex<HashMap<PathBuf, ExtractionStatus>>>,
    schedulers: Mutex<HashMap<String, Arc<ExtractionScheduler>>>,
    registry: Arc<WorkspaceRegistry>,
    live: LiveProviderConfig,
}

impl ExtractionHub {
    pub fn new(registry: Arc<WorkspaceRegistry>, live: LiveProviderConfig) -> Self {
        Self {
            statuses: Arc::new(Mutex::new(HashMap::new())),
            schedulers: Mutex::new(HashMap::new()),
            registry,
            live,
        }
    }

    /// The turn-settled entry point (the ask command calls this after a
    /// successful turn): applies the workspace toggle at the gate -- off
    /// records the skip face without spawning anything, on hands the job to
    /// the session's scheduler.
    pub fn submit_turn(
        &self,
        session_id: &str,
        workspace: &Path,
        question: &str,
        response_text: &str,
        turn_tool_names: Vec<String>,
    ) {
        if !self.registry.auto_extraction(workspace) {
            self.record(
                workspace,
                ExtractionStatus::Skipped {
                    reason: SkipReason::ToggleOff,
                },
            );
            return;
        }
        let job = ExtractionJob {
            workspace: workspace.to_path_buf(),
            session_id: session_id.to_string(),
            question: question.to_string(),
            response_text: response_text.to_string(),
            turn_tool_names,
        };
        let scheduler = self.scheduler_for(session_id);
        scheduler.submit(job);
    }

    /// The session-close counterpart: abort + bounded drain, then forget
    /// the scheduler (a same-id rebirth starts a fresh lane).
    pub fn close_and_drain(&self, session_id: &str) {
        let scheduler = {
            let mut schedulers = self.schedulers.lock().expect("hub schedulers poisoned");
            schedulers.remove(session_id)
        };
        if let Some(scheduler) = scheduler {
            scheduler.close_and_drain();
        }
    }

    /// The panel's read: the workspace's latest status, if any.
    pub fn status(&self, workspace: &Path) -> Option<ExtractionStatus> {
        let statuses = self.statuses.lock().expect("hub statuses poisoned");
        statuses.get(workspace).cloned()
    }

    fn record(&self, workspace: &Path, status: ExtractionStatus) {
        let mut statuses = self.statuses.lock().expect("hub statuses poisoned");
        statuses.insert(workspace.to_path_buf(), status);
    }

    fn scheduler_for(&self, session_id: &str) -> Arc<ExtractionScheduler> {
        let mut schedulers = self.schedulers.lock().expect("hub schedulers poisoned");
        if let Some(existing) = schedulers.get(session_id) {
            return Arc::clone(existing);
        }
        let registry = Arc::clone(&self.registry);
        let live = self.live.clone();
        let execute: ExecuteFn = Arc::new(move |job| perform_extraction(&job, &registry, &live));
        let statuses = Arc::clone(&self.statuses);
        let report: ReportFn = Arc::new(move |workspace, status| {
            if let Ok(mut map) = statuses.lock() {
                map.insert(workspace.to_path_buf(), status);
            }
        });
        let scheduler = Arc::new(ExtractionScheduler::new(execute, report));
        schedulers.insert(session_id.to_string(), Arc::clone(&scheduler));
        scheduler
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::fake::FakeProvider;
    use crate::provider::keychain::KeychainStore;
    use crate::provider::prompt::ResponseLocale;

    fn job(workspace: &Path, question: &str) -> ExtractionJob {
        ExtractionJob {
            workspace: workspace.to_path_buf(),
            session_id: "s-1".to_string(),
            question: question.to_string(),
            response_text: "好的。".to_string(),
            turn_tool_names: Vec::new(),
        }
    }

    /// Poll an observation until it yields `Some` or the deadline passes
    /// (background-thread settles are asynchronous by design).
    fn wait_for<T>(deadline: Duration, mut probe: impl FnMut() -> Option<T>) -> T {
        let end = Instant::now() + deadline;
        loop {
            if let Some(value) = probe() {
                return value;
            }
            assert!(
                Instant::now() < end,
                "condition not met within {deadline:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// A start gate the first executor call parks on (the concurrency
    /// suites' deterministic "slow model call" double).
    struct Gate {
        open: Mutex<bool>,
        cv: Condvar,
    }

    impl Gate {
        fn new() -> Self {
            Self {
                open: Mutex::new(false),
                cv: Condvar::new(),
            }
        }

        fn wait_open(&self) {
            let mut open = self.open.lock().expect("gate lock poisoned");
            while !*open {
                open = self.cv.wait(open).expect("gate wait poisoned");
            }
        }

        fn release(&self) {
            let mut open = self.open.lock().expect("gate lock poisoned");
            *open = true;
            self.cv.notify_all();
        }
    }

    // --- perform_with_provider over a scripted FakeProvider -----------------

    /// The happy path: a two-entry reply lands two files with the host
    /// stamps (`source: extract`, `origin_session`), and the status carries
    /// the landed titles.
    #[test]
    fn extraction_lands_entries_with_host_stamps() {
        let workspace = tempfile::tempdir().expect("workspace");
        let the_job = job(workspace.path(), "记住：回复一律用中文");
        let rows = memory::load_rows(workspace.path());
        let provider = FakeProvider::new().scripted_tool_turn(
            &extract::render_extraction_user_message(&the_job.question, &the_job.response_text, &[]),
            ToolTurnReply::Text(
                r#"[{"name":"偏好中文回复","description":"回复语言用中文","type":"feedback","body":"用户要求所有回复使用中文。"},{"name":"项目代号甲","description":"本项目代号","type":"project","body":"本项目内部代号是甲。"}]"#
                    .to_string(),
            ),
        );
        let status = perform_with_provider(&the_job, &provider, ResponseLocale::ZhCN, &rows)
            .expect("a terminal status");
        assert_eq!(
            status,
            ExtractionStatus::Extracted {
                titles: vec!["偏好中文回复".to_string(), "项目代号甲".to_string()]
            }
        );
        // The CJK title's file rides the FNV-hash slug fallback (#1529's
        // naming rule); read it back through the derived index's file name.
        let rows = memory::load_rows(workspace.path());
        assert_eq!(rows.len(), 2, "the derived index follows the files");
        let feedback_file = rows
            .iter()
            .find(|r| r.title == "偏好中文回复")
            .expect("the row exists")
            .file
            .clone();
        assert!(
            feedback_file.starts_with("feedback-n"),
            "the pure-CJK title hashed its slug: {feedback_file}"
        );
        let file = std::fs::read_to_string(
            workspace
                .path()
                .join(".toptopduck/memory")
                .join(feedback_file),
        )
        .expect("the landed file");
        assert!(file.contains("source: extract"), "{file}");
        assert!(file.contains("origin_session: s-1"), "{file}");
    }

    /// The no-op reply shape: an empty array (or any unparsable text) is
    /// NoNewFacts -- never a failure.
    #[test]
    fn an_empty_array_reply_is_no_new_facts() {
        let workspace = tempfile::tempdir().expect("workspace");
        let the_job = job(workspace.path(), "普通问题没有持久事实");
        let provider = FakeProvider::new().scripted_tool_turn(
            &extract::render_extraction_user_message(
                &the_job.question,
                &the_job.response_text,
                &[],
            ),
            ToolTurnReply::Text("[]".to_string()),
        );
        let status = perform_with_provider(&the_job, &provider, ResponseLocale::ZhCN, &[])
            .expect("a terminal status");
        assert_eq!(status, ExtractionStatus::NoNewFacts);
    }

    /// A provider error is Failed with the error text (a skip it is not --
    /// the chain was wired; the call itself broke).
    #[test]
    fn a_provider_error_is_failed() {
        let workspace = tempfile::tempdir().expect("workspace");
        let the_job = job(workspace.path(), "记住这个偏好");
        // No script staged: the fake refuses as NotWired.
        let status =
            perform_with_provider(&the_job, &FakeProvider::new(), ResponseLocale::ZhCN, &[])
                .expect("a terminal status");
        assert!(
            matches!(status, ExtractionStatus::Failed { .. }),
            "{status:?}"
        );
    }

    // --- the scheduler's two slots (gated executor) -------------------------

    /// The pending-slot contract (issue #1530): while one extraction runs,
    /// a newer request OVERWRITES the pending slot -- B then C executes
    /// only A and C, and the final status is C's.
    #[test]
    fn pending_slot_keeps_only_the_latest_request() {
        let workspace = tempfile::tempdir().expect("workspace");
        let gate = Arc::new(Gate::new());
        let calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let statuses: Arc<Mutex<HashMap<PathBuf, ExtractionStatus>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let scheduler = {
            let gate = Arc::clone(&gate);
            let calls = Arc::clone(&calls);
            let statuses = Arc::clone(&statuses);
            ExtractionScheduler::new(
                Arc::new(move |the_job| {
                    calls
                        .lock()
                        .expect("calls lock poisoned")
                        .push(the_job.question.clone());
                    gate.wait_open();
                    Some(ExtractionStatus::Extracted {
                        titles: vec![the_job.question],
                    })
                }),
                Arc::new(move |workspace, status| {
                    statuses
                        .lock()
                        .expect("statuses lock poisoned")
                        .insert(workspace.to_path_buf(), status);
                }),
            )
        };
        scheduler.submit(job(workspace.path(), "A"));
        scheduler.submit(job(workspace.path(), "B"));
        scheduler.submit(job(workspace.path(), "C"));
        gate.release();
        wait_for(Duration::from_secs(5), || {
            let map = statuses.lock().expect("statuses lock poisoned");
            match map.get(workspace.path()) {
                Some(ExtractionStatus::Extracted { titles }) if titles == &["C".to_string()] => {
                    Some(())
                }
                _ => None,
            }
        });
        assert_eq!(
            calls.lock().expect("calls lock poisoned").as_slice(),
            ["A".to_string(), "C".to_string()].as_slice(),
            "B was overwritten in the pending slot; only the latest ran"
        );
    }

    /// The close contract (issue #1530): a close bumps the generation --
    /// the pending slot dies unexecuted and the in-flight result is voided
    /// (never lands in the status); a later submit on the same scheduler
    /// runs normally.
    #[test]
    fn close_voids_the_pending_slot_and_late_results() {
        let workspace = tempfile::tempdir().expect("workspace");
        let gate = Arc::new(Gate::new());
        let calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let statuses: Arc<Mutex<HashMap<PathBuf, ExtractionStatus>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let scheduler = {
            let gate = Arc::clone(&gate);
            let calls = Arc::clone(&calls);
            let statuses = Arc::clone(&statuses);
            Arc::new(ExtractionScheduler::new(
                Arc::new(move |the_job| {
                    calls
                        .lock()
                        .expect("calls lock poisoned")
                        .push(the_job.question.clone());
                    gate.wait_open();
                    Some(ExtractionStatus::Extracted {
                        titles: vec![the_job.question],
                    })
                }),
                Arc::new(move |workspace, status| {
                    statuses
                        .lock()
                        .expect("statuses lock poisoned")
                        .insert(workspace.to_path_buf(), status);
                }),
            ))
        };
        scheduler.submit(job(workspace.path(), "A"));
        scheduler.submit(job(workspace.path(), "B"));
        let closer = {
            let scheduler = Arc::clone(&scheduler);
            std::thread::spawn(move || scheduler.close_and_drain())
        };
        // Let the closer enter its drain wait, then settle A: the close
        // returns (bounded), B never runs, and A's late result is voided.
        std::thread::sleep(Duration::from_millis(50));
        gate.release();
        closer.join().expect("closer thread");
        assert_eq!(
            calls.lock().expect("calls lock poisoned").as_slice(),
            ["A".to_string()].as_slice(),
            "the pending slot died with the close"
        );
        // The submit-time Running face may linger (the era's terminal state
        // was voided); what must NOT exist is A's terminal Extracted.
        assert_ne!(
            statuses
                .lock()
                .expect("statuses lock poisoned")
                .get(workspace.path()),
            Some(&ExtractionStatus::Extracted {
                titles: vec!["A".to_string()]
            }),
            "the voided era's result never lands"
        );
        // The lane itself survives: a fresh submit runs and reports.
        gate.release();
        scheduler.submit(job(workspace.path(), "C"));
        wait_for(Duration::from_secs(5), || {
            let map = statuses.lock().expect("statuses lock poisoned");
            match map.get(workspace.path()) {
                Some(ExtractionStatus::Extracted { titles }) if titles == &["C".to_string()] => {
                    Some(())
                }
                _ => None,
            }
        });
    }

    /// The wire contract (the review-found HIGH): the status serializes
    /// with the internal `state` tag the frontend's discriminated union
    /// reads -- pin the exact JSON so a dropped `tag` attribute can never
    /// silently blank every panel face again.
    #[test]
    fn the_status_wire_carries_the_state_tag() {
        assert_eq!(
            serde_json::to_string(&ExtractionStatus::Running).expect("serialize"),
            r#"{"state":"running"}"#
        );
        assert_eq!(
            serde_json::to_string(&ExtractionStatus::Skipped {
                reason: SkipReason::NoProvider
            })
            .expect("serialize"),
            r#"{"state":"skipped","reason":"no_provider"}"#
        );
        assert_eq!(
            serde_json::to_string(&ExtractionStatus::NoNewFacts).expect("serialize"),
            r#"{"state":"no_new_facts"}"#
        );
    }

    // --- the hub ------------------------------------------------------------

    fn hub_under(tmp: &Path) -> (Arc<WorkspaceRegistry>, ExtractionHub) {
        let registry = Arc::new(WorkspaceRegistry::new(tmp.join("workspaces.json")));
        let live = LiveProviderConfig::new(KeychainStore::new(), tmp.join("config.json"));
        let hub = ExtractionHub::new(Arc::clone(&registry), live);
        (registry, hub)
    }

    /// Toggle off at the gate: the skip face records, no scheduler spawns,
    /// no model call can happen (the zero-profile live config doubles as
    /// the proof -- an executor run would have ended in NoProvider).
    #[test]
    fn hub_toggle_off_records_the_skip_face() {
        let tmp = tempfile::tempdir().expect("tmp");
        let (registry, hub) = hub_under(tmp.path());
        let dir = tmp.path().join("ws");
        std::fs::create_dir_all(&dir).expect("mkdir");
        registry.record_at(&dir, None, true, 1_000).expect("record");
        hub.submit_turn("s-1", &dir, "记住偏好", "好", Vec::new());
        assert_eq!(
            hub.status(&dir),
            Some(ExtractionStatus::Skipped {
                reason: SkipReason::ToggleOff
            })
        );
    }

    /// The chain's tail (ADR-0147 Decision 7): a workspace with the toggle
    /// on but no provider configured resolves the NoProvider skip, and the
    /// read path (the memory files) is untouched.
    #[test]
    fn hub_no_provider_resolves_the_skip_tail() {
        let tmp = tempfile::tempdir().expect("tmp");
        let (registry, hub) = hub_under(tmp.path());
        let dir = tmp.path().join("ws");
        std::fs::create_dir_all(&dir).expect("mkdir");
        registry.record_at(&dir, None, true, 1_000).expect("record");
        registry.set_auto_extraction(&dir, true).expect("opt in");
        hub.submit_turn("s-1", &dir, "记住这个偏好", "好", Vec::new());
        // Wait past the transient Running face to the terminal skip.
        let status = wait_for(Duration::from_secs(5), || match hub.status(&dir) {
            Some(status) if status != ExtractionStatus::Running => Some(status),
            _ => None,
        });
        assert_eq!(
            status,
            ExtractionStatus::Skipped {
                reason: SkipReason::NoProvider
            }
        );
        assert!(
            !dir.join(".toptopduck").exists(),
            "zero footprint: no provider means no write ever happened"
        );
        // Close is a no-op-but-clean return for an unknown session id.
        hub.close_and_drain("never-seen");
    }
}
