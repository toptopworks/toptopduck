//! Turn-artifact dual-channel discovery (ADR-0124, issue #1087).
//!
//! Two channels, each where it is controllable: the built-in loop runtime
//! injects the `present_files` tool (a MUST-grade explicit declaration --
//! the definition + resolver live here, the interception beside the other
//! meta-tools in [`crate::session::turn_dispatch`]), and every runtime
//! (external CLIs included) gets its reply text SCANNED for deliverable
//! paths -- three regex families: markdown link targets, quoted /
//! backtick-wrapped paths (spaces allowed), and whitelist-constrained bare
//! tokens. Both channels merge at turn settle into ONE manifest
//! ([`settle_manifest`]): explicit declarations first (their order is the
//! viewing priority, the first entry primary), scan hits existence-filtered
//! (a heuristic channel must not mint dead cards), deduplicated by resolved
//! absolute path, capped at [`ARTIFACT_CAP`] entries.
//!
//! Hits that resolve INSIDE the session temp working directory (the
//! external agent's cwd / the built-in tool output area -- wiped on session
//! close) are materialized by copy into the per-session persistent
//! `artifacts/` directory (beside `session.duck`, the same per-session
//! directory semantics as the derived-source `assets/` channel); the
//! manifest stores the materialized path. User-directory absolute hits
//! stay in place -- the app does not copy user files. File existence is a
//! runtime fact checked at render time; the manifest never rewrites.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{json, Value};

use crate::model::TurnArtifact;
use crate::provider::tool_calling::{ToolDefinition, ToolUse};

/// The canonical name of the deliverable-presentation meta-tool.
pub(crate) const PRESENT_FILES: &str = "present_files";

/// The per-session persistent artifacts directory name: a subdirectory of
/// the session directory (the `.duck`'s parent, `{sessions_root}/{uuid}/`),
/// created lazily at the first settle-time materialization. Session
/// deletion removes the whole per-session directory, so `artifacts/` rides
/// the existing cleanup semantics.
pub(crate) const ARTIFACTS_DIR_NAME: &str = "artifacts";

/// The per-session persistent artifacts directory (ADR-0124 Decision 2):
/// `artifacts/` under the session directory (the bound `.duck`'s parent).
/// `None` for an unbound session -- materialization degrades to keeping
/// temp paths. One source for the settle computation and the command
/// boundary's asset-scope grant, so the two cannot drift.
pub(crate) fn artifacts_dir(duck_path: Option<&Path>) -> Option<PathBuf> {
    duck_path
        .and_then(Path::parent)
        .map(|parent| parent.join(ARTIFACTS_DIR_NAME))
}

/// The per-turn manifest cap (ADR-0124 Decision 1): a turn's merged
/// artifact manifest holds at most this many entries.
pub(crate) const ARTIFACT_CAP: usize = 8;

/// The deliverable extension whitelist (the scan channel's constraint,
/// ADR-0124 Decision 1): the formats a reply-text hit must carry to count
/// as a deliverable. Case-insensitive.
const DELIVERABLE_EXTENSIONS: [&str; 7] = ["pdf", "docx", "xlsx", "pptx", "html", "htm", "md"];

/// Scheme prefixes that mark a hit as a remote / non-file reference, not a
/// local deliverable path (the `file://` family is a separate scan channel
/// by decision -- out of scope).
const NON_FILE_PREFIXES: [&str; 5] = ["http://", "https://", "ftp://", "file://", "mailto:"];

/// Family 1: markdown link targets, `[label](target)`. The target is one
/// parenthesis- and whitespace-free span; an image `![...](...)` matches
/// the same shape (the whitelist decides whether it is a deliverable).
static MD_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\]\(([^()\s]+)\)").expect("markdown-link regex"));

/// Family 2: quoted / backtick-wrapped spans. Unlike the bare-token family
/// this carries paths WITH spaces (`"my report.pdf"`); the whitelist check
/// on the extracted span rejects ordinary quoted prose.
static QUOTED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"["'`]([^"'`\r\n]{1,400})["'`]"#).expect("quoted regex"));

/// Family 3: bare tokens ending in a whitelisted extension. The character
/// class excludes quotes and pairing punctuation so a token does not run
/// past a quote boundary; the trailing `\b` rejects longer extensions
/// (`report.pdfx` -- f/x are both word chars, no boundary there).
static BARE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(?i)[^\s'`"<>\x5b\x5d(){{}}]+\.({})\b"#,
        DELIVERABLE_EXTENSIONS.join("|")
    ))
    .expect("bare-path regex")
});

/// The `present_files` tool definition (ADR-0124 Decision 1). English by
/// the tool-face language split (the `invoke_skill` precedent). Mounted
/// unconditionally on the built-in loop runtime's table only -- external
/// CLIs have no injection point and no system-prompt clause.
pub(crate) fn present_files_definition() -> ToolDefinition {
    ToolDefinition {
        name: PRESENT_FILES.to_string(),
        description: "Present the turn's deliverable files (reports, pages, documents) to \
             the user. Call this once at the end of any task that produced a \
             viewable output file. `files` is an ordered list of file paths: the \
             order is the viewing priority and the first entry is the primary \
             deliverable. Paths may be absolute or relative to the working \
             directory."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "files": {
                    "type": "array",
                    "items": { "type": "string" },
                    "minItems": 1,
                    "description": "Deliverable file paths in viewing-priority order; \
                         the first is the primary."
                }
            },
            "required": ["files"],
        }),
    }
}

/// Why a `present_files` call resolved the way it did -- the same
/// Local/Refused shape the skill meta-tools use (a refusal is the call's
/// own error, never a gate suspension and never a trace entry).
#[derive(Debug)]
pub(crate) enum PresentFilesOutcome {
    /// Accepted: the paths landed on the turn's channel; the summary +
    /// payload ride the standard local meta-call envelope (phase pair +
    /// one trace row).
    Local { summary: String, payload: Value },
    /// Malformed input: the message rides back as the call's error.
    Refused(String),
}

/// Resolve one `present_files` call against the turn's accumulating
/// channel (ADR-0124 Decision 1): a non-empty `files` array of non-empty
/// strings appends verbatim -- validation, resolution, and materialization
/// are settle concerns, one place for both channels.
pub(crate) fn resolve_present_files(
    call: &ToolUse,
    channel: &mut Vec<String>,
) -> PresentFilesOutcome {
    let files = call
        .input
        .get("files")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if files.is_empty() {
        return PresentFilesOutcome::Refused(format!(
            "{PRESENT_FILES} requires a non-empty `files` array of file paths"
        ));
    }
    let summary = format!("{} file(s) presented", files.len());
    let payload = json!({ "recorded": files.len(), "files": files });
    channel.extend(files);
    PresentFilesOutcome::Local { summary, payload }
}

/// The turn's reply text for the scan channel: the Materialized terminal
/// body or the Textual body -- the prose the user reads, where deliverable
/// paths are mentioned. Failed / cancelled turns carry no reply to scan
/// (the turn delivered nothing).
pub(crate) fn reply_body(outcome: &crate::model::TurnOutcome) -> &str {
    match outcome {
        crate::model::TurnOutcome::Materialized {
            body: Some(body), ..
        } => body,
        crate::model::TurnOutcome::Textual { body, .. } => body,
        crate::model::TurnOutcome::Materialized { .. }
        | crate::model::TurnOutcome::Failed(_)
        | crate::model::TurnOutcome::Cancelled(_) => "",
    }
}

/// Whether a candidate path carries a deliverable extension
/// (case-insensitive).
fn is_deliverable(candidate: &str) -> bool {
    Path::new(candidate)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| {
            let lower = e.to_ascii_lowercase();
            DELIVERABLE_EXTENSIONS.contains(&lower.as_str())
        })
}

/// Whether a candidate is a local file path rather than a remote /
/// scheme-prefixed reference.
fn is_file_reference(candidate: &str) -> bool {
    let lower = candidate.to_ascii_lowercase();
    !NON_FILE_PREFIXES.iter().any(|p| lower.starts_with(p))
}

/// Scan one turn's reply text for deliverable paths (ADR-0124 Decision 1)
/// and return the raw candidates in first-seen order, deduplicated by
/// string. Resolution (relative -> absolute) is the caller's settle
/// concern -- the scan is pure text extraction.
pub(crate) fn scan_reply_text(text: &str) -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();
    let mut push = |hit: &str| {
        let trimmed = hit.trim();
        if is_deliverable(trimmed)
            && is_file_reference(trimmed)
            && !candidates.iter().any(|c| c == trimmed)
        {
            candidates.push(trimmed.to_string());
        }
    };
    // The wrapping families' full match spans, so a bare-token hit INSIDE
    // one (`"my report.pdf"` also yields the partial `report.pdf` from the
    // bare family) is subsumed by the wrapping hit and dropped -- the
    // partial resolves to a different, wrong path.
    let mut wrapped: Vec<std::ops::Range<usize>> = Vec::new();
    for caps in MD_LINK.captures_iter(text) {
        wrapped.push(caps.get(0).expect("md-link match").range());
        push(caps.get(1).expect("md-link capture").as_str());
    }
    for caps in QUOTED.captures_iter(text) {
        wrapped.push(caps.get(0).expect("quoted match").range());
        push(caps.get(1).expect("quoted capture").as_str());
    }
    for mat in BARE.find_iter(text) {
        if wrapped
            .iter()
            .any(|r| mat.start() >= r.start && mat.end() <= r.end)
        {
            continue;
        }
        push(mat.as_str());
    }
    candidates
}

/// Resolve one raw candidate against the turn's working-directory basis
/// (the session temp dir: the external agent's cwd, the built-in tool
/// output area's parent). A leading `./` is trimmed so the resolved string
/// carries no redundant component.
fn resolve(candidate: &str, cwd: &Path) -> PathBuf {
    let trimmed = candidate.trim();
    let cleaned = trimmed.strip_prefix("./").unwrap_or(trimmed);
    let path = Path::new(cleaned);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    }
}

/// Merge the two channels into the turn's artifact manifest
/// (ADR-0124 Decision 2 -- the settle computation). Channel 1
/// (`presented`, the tool channel) keeps its order verbatim: the order IS
/// the viewing priority, the first entry the primary, and a declared path
/// enters even if missing (an explicit contract the card degrades
/// honestly). Channel 2 (the scan of `reply_text`) is
/// existence-filtered. Deduplication is by resolved absolute path; the
/// merged list truncates to [`ARTIFACT_CAP`]. Materialization (temp hits
/// copied into `artifacts_dir`) rewrites entries in place; a `None`
/// `artifacts_dir` (an unbound session) skips materialization entirely.
/// The dedup key for [`settle_manifest`]: case-folded on Windows (the
/// FS is case-insensitive), verbatim elsewhere.
fn dedup_key(path: &Path) -> String {
    let text = path.to_string_lossy();
    #[cfg(windows)]
    {
        text.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        text.into_owned()
    }
}

pub(crate) fn settle_manifest(
    presented: &[String],
    reply_text: &str,
    cwd: &Path,
    artifacts_dir: Option<&Path>,
) -> Vec<TurnArtifact> {
    // Dedup keys: exact on case-sensitive filesystems, case-folded on
    // Windows -- one file reached from both channels under two spellings
    // (`Dup.pdf` declared, `dup.pdf` scanned) is ONE entry either way.
    let mut keys: Vec<String> = Vec::new();
    let mut resolved: Vec<PathBuf> = Vec::new();
    let mut push_unique = |path: PathBuf| {
        let key = dedup_key(&path);
        if !keys.contains(&key) {
            keys.push(key);
            resolved.push(path);
        }
    };
    for candidate in presented {
        push_unique(resolve(candidate, cwd));
    }
    for candidate in scan_reply_text(reply_text) {
        let path = resolve(&candidate, cwd);
        if path.is_file() {
            push_unique(path);
        }
    }
    resolved.truncate(ARTIFACT_CAP);
    resolved
        .into_iter()
        .enumerate()
        .map(|(index, path)| {
            let path = materialize(path, cwd, artifacts_dir);
            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            TurnArtifact {
                path: path.to_string_lossy().into_owned(),
                file_name,
                primary: index == 0,
            }
        })
        .collect()
}

/// Materialize one resolved hit (the persistence ruling, ADR-0124 Decision
/// 2): a hit under the session temp working directory is COPIED into the
/// per-session `artifacts/` directory (the temp dir dies with the session;
/// the manifest must survive a close/reopen) and the copy's path is
/// returned; anything else (a user-directory absolute hit) returns
/// unchanged -- the app does not copy user files. Best-effort + logged: a
/// copy failure leaves the temp path in place (the card degrades after
/// close, honestly). A same-name collision takes a `_2`, `_3`, ... suffix
/// so two distinct same-named files never overwrite each other.
fn materialize(path: PathBuf, cwd: &Path, artifacts_dir: Option<&Path>) -> PathBuf {
    let Some(dir) = artifacts_dir else {
        return path;
    };
    if !path.starts_with(cwd) || !path.is_file() {
        return path;
    }
    if let Err(e) = std::fs::create_dir_all(dir) {
        log::warn!(
            target: "toptopduck::session",
            "artifact materialization skipped: cannot create {}: {e}",
            dir.display()
        );
        return path;
    }
    let file_name = match path.file_name().and_then(|n| n.to_str()) {
        Some(name) => name.to_string(),
        None => return path,
    };
    let mut target = dir.join(&file_name);
    let mut counter = 2u32;
    while target.exists() {
        let stem = Path::new(&file_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("artifact");
        let ext = Path::new(&file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default();
        target = dir.join(format!("{stem}_{counter}.{ext}"));
        counter += 1;
    }
    match std::fs::copy(&path, &target) {
        Ok(_) => target,
        Err(e) => {
            log::warn!(
                target: "toptopduck::session",
                "artifact materialization failed for {}: {e}",
                path.display()
            );
            path
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One candidate per family, the URL / non-whitelist rejects, and
    /// first-seen dedup -- the scan contract in one pass.
    #[test]
    fn scan_hits_all_three_families_and_rejects_non_files() {
        let text = "报告写好了：[结果报告](out/report.pdf)，\
                    也生成了 \"my report.docx\" 和 `charts.html`，\
                    数据表在 data.xlsx。\
                    参考 https://example.com/report.pdf 与 archive.zip。";
        let hits = scan_reply_text(text);
        assert_eq!(
            hits,
            vec![
                "out/report.pdf",
                "my report.docx",
                "charts.html",
                "data.xlsx",
            ],
            "family order is md-link, quoted, bare; URLs and non-whitelisted \
             extensions never enter"
        );
    }

    /// Windows absolute paths and CJK file names hit the bare family; a
    /// longer extension (`report.pdfx`) does not.
    #[test]
    fn scan_matches_windows_absolute_and_cjk_names() {
        let hits = scan_reply_text(
            "输出在 C:\\Users\\me\\Documents\\报告.html，附 readout.pdfx（非白名单）。",
        );
        assert_eq!(hits, vec!["C:\\Users\\me\\Documents\\报告.html"]);
    }

    #[test]
    fn scan_bare_token_rejects_longer_extensions() {
        let hits = scan_reply_text("见 readout.pdfx 与 manual.pdf5 以及 real.md");
        assert_eq!(hits, vec!["real.md"]);
    }

    #[test]
    fn resolve_present_files_appends_ordered_paths_to_the_channel() {
        let mut channel = Vec::new();
        let call = ToolUse {
            id: "tu_1".into(),
            name: PRESENT_FILES.into(),
            input: json!({"files": ["report.html", "C:/data/table.xlsx"]}),
        };
        match resolve_present_files(&call, &mut channel) {
            PresentFilesOutcome::Local { summary, payload } => {
                assert_eq!(summary, "2 file(s) presented");
                assert_eq!(payload["recorded"], 2);
            }
            other => panic!("expected Local, got {other:?}"),
        }
        assert_eq!(channel, vec!["report.html", "C:/data/table.xlsx"]);
    }

    #[test]
    fn resolve_present_files_refuses_empty_or_malformed_input() {
        for input in [json!({"files": []}), json!({"files": ["  "]}), json!({})] {
            let call = ToolUse {
                id: "tu_2".into(),
                name: PRESENT_FILES.into(),
                input,
            };
            assert!(
                matches!(
                    resolve_present_files(&call, &mut Vec::new()),
                    PresentFilesOutcome::Refused(_)
                ),
                "malformed input must refuse"
            );
        }
    }

    #[test]
    fn present_files_definition_names_the_tool_and_orders_the_files_parameter() {
        let def = present_files_definition();
        assert_eq!(def.name, PRESENT_FILES);
        assert!(
            def.input_schema["required"]
                .as_array()
                .expect("required array")
                .iter()
                .any(|v| v == "files"),
            "files is required"
        );
    }

    /// The merge contract: channel 1 order preserved (viewing priority,
    /// first = primary), the same file from both channels dedupes to ONE
    /// entry (the presented one keeps its slot).
    #[test]
    fn settle_manifest_dedupes_the_same_file_across_channels() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cwd = dir.path();
        // Both candidates exist, so the heuristic filter drops neither.
        std::fs::write(cwd.join("dup.pdf"), "x").expect("write");
        std::fs::write(cwd.join("other.pdf"), "x").expect("write");
        let manifest = settle_manifest(
            &["dup.pdf".to_string(), "other.pdf".to_string()],
            "见 dup.pdf（与已交付同一份）",
            cwd,
            None,
        );
        let dup_count = manifest.iter().filter(|a| a.file_name == "dup.pdf").count();
        assert_eq!(
            dup_count, 1,
            "the same file from both channels is ONE entry"
        );
        assert_eq!(manifest.len(), 2, "the distinct second file survives");
        assert!(manifest[0].primary, "the first presented entry is primary");
        assert_eq!(manifest[0].file_name, "dup.pdf");
    }

    /// Windows FS case-insensitivity: one file reached under two spellings
    /// (declared `Dup.pdf`, scanned `dup.pdf`) merges to one entry -- the
    /// dedup key is case-folded there (Unix keeps exact keys, so this pins
    /// the Windows arm only).
    #[cfg(windows)]
    #[test]
    fn settle_manifest_dedupes_case_folded_spellings_on_windows() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cwd = dir.path();
        std::fs::write(cwd.join("dup.pdf"), "x").expect("write");
        let manifest = settle_manifest(&["Dup.pdf".to_string()], "见 dup.pdf", cwd, None);
        assert_eq!(manifest.len(), 1, "two spellings of one file merge");
        assert!(
            manifest[0].path.ends_with("Dup.pdf"),
            "the presented spelling wins"
        );
    }

    /// The manifest caps at [`ARTIFACT_CAP`] entries; the cap keeps the
    /// earliest (priority-ordered) hits.
    #[test]
    fn settle_manifest_caps_at_eight_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cwd = dir.path();
        let mut presented = Vec::new();
        for i in 1..=10 {
            presented.push(format!("declared_{i}.pdf"));
        }
        let manifest = settle_manifest(&presented, "", cwd, None);
        assert_eq!(manifest.len(), ARTIFACT_CAP);
        assert!(manifest[0].primary, "the first entry is primary");
        assert!(
            manifest[1..].iter().all(|a| !a.primary),
            "exactly one primary"
        );
        assert_eq!(manifest[7].file_name, "declared_8.pdf");
    }

    /// Relative candidates resolve against the cwd basis (the external
    /// agent's cwd / session working dir).
    #[test]
    fn settle_manifest_resolves_relative_paths_against_cwd() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cwd = dir.path();
        std::fs::write(cwd.join("notes.md"), "x").expect("write");
        let manifest = settle_manifest(&[], "见 notes.md", cwd, None);
        assert_eq!(manifest.len(), 1);
        assert!(
            Path::new(&manifest[0].path).is_absolute(),
            "the manifest stores absolute paths"
        );
        assert!(manifest[0].path.ends_with("notes.md"));
        assert_eq!(manifest[0].file_name, "notes.md");
    }

    /// The heuristic channel is existence-filtered; an explicit
    /// declaration stays even when missing (honest dead card).
    #[test]
    fn settle_manifest_filters_nonexistent_scan_hits_but_keeps_declarations() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cwd = dir.path();
        let manifest = settle_manifest(
            &["declared_but_missing.html".to_string()],
            "见 ghost.pdf（从未生成）",
            cwd,
            None,
        );
        assert_eq!(manifest.len(), 1);
        assert!(manifest[0].path.ends_with("declared_but_missing.html"));
    }

    /// The persistence ruling: a temp-working-dir hit copies into the
    /// per-session artifacts directory (the manifest carries the
    /// materialized path); a user-directory hit stays in place.
    #[test]
    fn settle_manifest_materializes_temp_hits_and_keeps_user_dir_hits() {
        let work = tempfile::tempdir().expect("workdir");
        let session = tempfile::tempdir().expect("session dir");
        let cwd = work.path();
        let artifacts_dir = session.path().join(ARTIFACTS_DIR_NAME);
        std::fs::write(cwd.join("report.html"), "<html/>").expect("write");
        let user_dir = tempfile::tempdir().expect("user dir");
        let user_pdf = user_dir.path().join("external.pdf");
        std::fs::write(&user_pdf, "pdf").expect("write");

        let manifest = settle_manifest(
            &[
                "report.html".to_string(),
                user_pdf.to_string_lossy().into_owned(),
            ],
            "",
            cwd,
            Some(&artifacts_dir),
        );
        assert_eq!(manifest.len(), 2);
        assert!(
            manifest[0]
                .path
                .starts_with(artifacts_dir.to_str().expect("utf8 path")),
            "the temp hit's manifest path is the materialized copy: {}",
            manifest[0].path
        );
        assert!(Path::new(&manifest[0].path).is_file(), "the copy exists");
        assert_eq!(manifest[0].file_name, "report.html");
        assert_eq!(
            manifest[1].path,
            user_pdf.to_string_lossy(),
            "a user-directory hit stays in place (no copy)"
        );
        assert!(!manifest[1].path.contains(ARTIFACTS_DIR_NAME));
    }

    /// Two distinct same-named temp files never overwrite each other's
    /// materialized copies (`_2` disambiguation).
    #[test]
    fn settle_manifest_disambiguates_same_named_materializations() {
        let work = tempfile::tempdir().expect("workdir");
        let session = tempfile::tempdir().expect("session dir");
        let cwd = work.path();
        let artifacts_dir = session.path().join(ARTIFACTS_DIR_NAME);
        std::fs::create_dir_all(cwd.join("a")).expect("dirs");
        std::fs::create_dir_all(cwd.join("b")).expect("dirs");
        std::fs::write(cwd.join("a").join("report.md"), "one").expect("write");
        std::fs::write(cwd.join("b").join("report.md"), "two").expect("write");

        let manifest = settle_manifest(
            &["a/report.md".to_string(), "b/report.md".to_string()],
            "",
            cwd,
            Some(&artifacts_dir),
        );
        assert_eq!(manifest.len(), 2);
        assert_eq!(manifest[0].file_name, "report.md");
        assert_eq!(manifest[1].file_name, "report_2.md");
        let first = std::fs::read_to_string(&manifest[0].path).expect("copy 1");
        let second = std::fs::read_to_string(&manifest[1].path).expect("copy 2");
        assert_eq!(first, "one");
        assert_eq!(second, "two");
    }

    /// An unbound session (no artifacts dir) keeps temp paths -- the
    /// in-memory session degrades, nothing is written to disk.
    #[test]
    fn settle_manifest_without_an_artifacts_dir_keeps_temp_paths() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cwd = dir.path();
        std::fs::write(cwd.join("page.html"), "x").expect("write");
        let manifest = settle_manifest(&["page.html".to_string()], "", cwd, None);
        assert_eq!(manifest.len(), 1);
        assert!(
            Path::new(&manifest[0].path).starts_with(cwd),
            "no copy without a target"
        );
    }
}
