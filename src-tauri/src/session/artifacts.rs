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
//! Every entry references its file IN PLACE (ADR-0137 Decision 6, issue
//! #1383): a resolved hit -- workspace or user-directory original alike --
//! enters the manifest under its absolute path, nothing is copied into the
//! session tree, and the app does not copy user files. The copy-into-
//! `artifacts/` materialization face is retired (its temp-dir domain is
//! permanently empty under the lazily minted workspace), and with no
//! external users the resume-time backfill went with it; legacy manifest
//! entries pointing there still render (the file-level preview grant names
//! them like any other member). File existence is a runtime fact checked
//! at render time; the manifest never rewrites.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{json, Value};

use crate::model::{ThreadEntry, TurnArtifact};
use crate::provider::tool_calling::{ToolDefinition, ToolUse};

/// The canonical name of the deliverable-presentation meta-tool.
pub(crate) const PRESENT_FILES: &str = "present_files";

/// The per-turn manifest cap (ADR-0124 Decision 1): a turn's merged
/// artifact manifest holds at most this many entries.
const ARTIFACT_CAP: usize = 8;

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
/// on the extracted span rejects ordinary quoted prose. Delimiters pair
/// strictly -- each alternative opens and closes with the same mark,
/// straight or curly (PR #1089 review: independent pairing let an
/// apostrophe eat a following opening quote), and a single-quoted span may
/// not contain a double quote, so contractions flanking a quoted path
/// never swallow it.
static QUOTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#""([^"\r\n]{1,400})"|'([^'"\r\n]{1,400})'|`([^`\r\n]{1,400})`|“([^“”\r\n]{1,400})”|‘([^‘’\r\n]{1,400})’"#,
    )
    .expect("quoted regex")
});

/// The captured span of one [`QUOTED`] match -- the alternation's five
/// capture groups, exactly one of which is present.
fn quoted_capture<'t>(caps: &regex::Captures<'t>) -> &'t str {
    (1..=5)
        .find_map(|i| caps.get(i))
        .map(|m| m.as_str())
        .expect("quoted capture")
}

/// Family 3: bare tokens ending in a whitelisted extension. The FIRST
/// character is its own ASCII path-start class so adjacent prose never
/// becomes part of the token (a CJK word directly before `report.md`
/// would otherwise be swallowed into the candidate, which then dies at
/// the settle existence filter; PR #1089 review), and the rest of the
/// class also excludes curly quotes and CJK punctuation. Longer
/// extensions (`report.pdfx`) are rejected after the match via
/// [`ends_at_token_boundary`]: the regex crate has no lookahead, and its
/// Unicode-aware `\b` would reject the CJK word chars that legitimately
/// follow a mention.
static BARE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(?i)[A-Za-z0-9_~./\\-][^\s'`"“”‘’<>\x5b\x5d(){{}}（）【】，。、；：]*\.({})"#,
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
/// strings appends verbatim. Schema-strict (the `invoke_skill` stance,
/// #1090): any non-string or blank member refuses the WHOLE call -- a
/// partial accept would report a filtered count the model never asked
/// for. Validation, resolution, and materialization are settle concerns,
/// one place for both channels.
pub(crate) fn resolve_present_files(
    call: &ToolUse,
    channel: &mut Vec<String>,
) -> PresentFilesOutcome {
    let refuse = || {
        PresentFilesOutcome::Refused(format!(
            "{PRESENT_FILES} requires a non-empty `files` array of non-empty file path strings"
        ))
    };
    let Some(values) = call.input.get("files").and_then(Value::as_array) else {
        return refuse();
    };
    let mut files = Vec::with_capacity(values.len());
    for value in values {
        let Some(path) = value.as_str() else {
            return refuse();
        };
        if path.trim().is_empty() {
            return refuse();
        }
        files.push(path.to_string());
    }
    if files.is_empty() {
        return refuse();
    }
    let summary = format!("{} file(s) presented", files.len());
    let payload = json!({ "recorded": files.len(), "files": files });
    channel.extend(files);
    PresentFilesOutcome::Local { summary, payload }
}

/// The turn's reply text for the scan channel: the Materialized terminal
/// body or the Textual body -- the prose the user reads, where deliverable
/// paths are mentioned. Failed / cancelled turns carry no reply prose to
/// scan; their tool-channel declarations, if any, still land on the
/// manifest (the scan is only one of the two channels).
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
    // partial resolves to a different, wrong path. A QUOTED span subsumes
    // only when the capture plausibly IS the path (at most one bare hit
    // inside, no CJK prose -- PR #1089 review): quoted prose mentioning
    // two files, or CJK prose mentioning one, would otherwise swallow the
    // genuine bare hits and the phrase itself dies at the settle existence
    // filter, losing the delivery. Markdown link targets always subsume --
    // a target is a single token, so the inner bare hit is only its echo.
    let mut wrapped: Vec<std::ops::Range<usize>> = Vec::new();
    for caps in MD_LINK.captures_iter(text) {
        wrapped.push(caps.get(0).expect("md-link match").range());
        push(caps.get(1).expect("md-link capture").as_str());
    }
    for caps in QUOTED.captures_iter(text) {
        let span = caps.get(0).expect("quoted match").range();
        let capture = quoted_capture(&caps);
        let plausibly_path = BARE.find_iter(capture).count() <= 1 && !capture.chars().any(is_cjk);
        if plausibly_path {
            wrapped.push(span);
        }
        push(capture);
    }
    for mat in BARE.find_iter(text) {
        if !ends_at_token_boundary(text, mat.end()) {
            continue; // a longer extension (`report.pdfx`) -- not this token
        }
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

/// Whether the character at `end` in `text` continues an ASCII token (a
/// longer extension, `report.pdfx`) -- the code-level replacement for a
/// trailing `\b`, which the regex crate would make Unicode-aware and
/// thereby reject the CJK word chars that legitimately follow a mention
/// (`report.md` followed by the word for "file" is a hit, not a miss).
fn ends_at_token_boundary(text: &str, end: usize) -> bool {
    !text[end..]
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Whether a char is in the CJK unified ideographs block -- this app's
/// primary prose script; its presence in a quoted span marks prose, not a
/// path (see the subsumption rule in [`scan_reply_text`]).
fn is_cjk(c: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&c)
}

/// Resolve one raw candidate against the turn's working-directory basis:
/// the session workspace when bound (ADR-0137 -- the agent's cwd for both
/// the external and the built-in loop), the temp dir only for a
/// workspace-less in-memory turn. A leading `./` is trimmed so the
/// resolved string carries no redundant component.
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
/// merged list truncates to [`ARTIFACT_CAP`]. Every entry references its
/// file in place (ADR-0137 Decision 6): nothing is copied, and the entry's
/// [`TurnArtifact::durable`] is simply `session_bound` -- a bound
/// session's references (workspace or user-directory originals) survive
/// the close in place, while an unbound in-memory session's manifest has
/// nowhere to outlive the close.
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
    session_bound: bool,
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
    let durable = session_bound;
    resolved
        .into_iter()
        .map(|path| {
            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            TurnArtifact {
                path: path.to_string_lossy().into_owned(),
                file_name,
                durable,
            }
        })
        .collect()
}

/// The manifest-referenced file paths across a whole thread (ADR-0137
/// Decision 6's preview whitelist source): the `TurnArtifact` paths of
/// every turn record, first-seen order, deduplicated. The command boundary
/// grants the asset protocol scope file-by-file from exactly this set --
/// the workspace directory as a whole is deliberately NOT granted, so an
/// arbitrary html sitting beside a deliverable never becomes
/// iframe-renderable by proximity.
pub(crate) fn referenced_paths(entries: &[ThreadEntry]) -> Vec<PathBuf> {
    let mut seen: Vec<PathBuf> = Vec::new();
    for entry in entries {
        let ThreadEntry::Turn(record) = entry else {
            continue;
        };
        for artifact in &record.artifacts {
            let path = PathBuf::from(&artifact.path);
            if !seen.contains(&path) {
                seen.push(path);
            }
        }
    }
    seen
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

    /// PR #1089 review Important 2: delimiters pair strictly (an
    /// apostrophe never eats a following opening quote, even with a
    /// second contraction flanking the path), and quoted prose
    /// mentioning files does not subsume the bare hits inside it -- the
    /// prose span itself dies at the settle existence filter, but the
    /// genuine paths survive.
    #[test]
    fn scan_pairs_quotes_strictly_and_keeps_prose_bare_hits() {
        let hits = scan_reply_text(
            "I've durable \"Q3 report.pdf\", and it's also in \"see a.pdf and b.pdf\".",
        );
        assert_eq!(
            hits,
            vec!["Q3 report.pdf", "see a.pdf and b.pdf", "a.pdf", "b.pdf",]
        );
    }

    /// PR #1089 review Important 3: the primary-language reply shapes.
    /// A CJK word directly before the path no longer becomes part of the
    /// token, a CJK word right after the extension is a legitimate
    /// follower (not a longer extension), and curly quotes wrap CJK
    /// file names the ASCII quote class never opened.
    #[test]
    fn scan_matches_cjk_adjacent_and_curly_quoted_paths() {
        let hits = scan_reply_text("已生成report.md文件，另见“最终报告.pdf”。");
        assert_eq!(hits, vec!["最终报告.pdf", "report.md"]);
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

    /// Schema-strict stance (#1090): a mixed-type array is refused WHOLE
    /// (the `invoke_skill` precedent) -- silently dropping the non-string
    /// members would report a filtered count the model never asked for.
    #[test]
    fn resolve_present_files_refuses_mixed_type_arrays_whole() {
        let mut channel = Vec::new();
        let call = ToolUse {
            id: "tu_3".into(),
            name: PRESENT_FILES.into(),
            input: json!({"files": ["/a.pdf", 5]}),
        };
        match resolve_present_files(&call, &mut channel) {
            PresentFilesOutcome::Refused(message) => {
                assert!(
                    message.contains("present_files"),
                    "names the tool: {message}"
                );
            }
            other => panic!("expected Refused, got {other:?}"),
        }
        assert!(channel.is_empty(), "a refused call lands nothing");
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
            false,
        );
        let dup_count = manifest.iter().filter(|a| a.file_name == "dup.pdf").count();
        assert_eq!(
            dup_count, 1,
            "the same file from both channels is ONE entry"
        );
        assert_eq!(manifest.len(), 2, "the distinct second file survives");
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
        let manifest = settle_manifest(&["Dup.pdf".to_string()], "见 dup.pdf", cwd, false);
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
        let manifest = settle_manifest(&presented, "", cwd, false);
        assert_eq!(manifest.len(), ARTIFACT_CAP);
        assert_eq!(manifest[7].file_name, "declared_8.pdf");
    }

    /// Channel priority (#1091 review): the presented channel merges
    /// ahead of the scan channel, so the derived primary (the first
    /// entry) keeps the declaration's viewing priority over a scan hit.
    /// Pinned platform-independently -- the case-folded sibling that
    /// also kills a merge-order swap is cfg(windows), and CI runs Linux.
    #[test]
    fn settle_manifest_keeps_presented_order_ahead_of_scan_hits() {
        let work = tempfile::tempdir().expect("workdir");
        let cwd = work.path();
        std::fs::write(cwd.join("a.pdf"), "x").expect("write");
        let manifest = settle_manifest(
            &["b.pdf".to_string()],
            "the table is ready, see a.pdf for the full view",
            cwd,
            false,
        );
        assert_eq!(manifest.len(), 2);
        assert_eq!(manifest[0].file_name, "b.pdf", "the declaration leads");
        assert_eq!(manifest[1].file_name, "a.pdf", "the scan hit follows");
    }

    /// In-place reference means nothing lands on disk no matter how many
    /// files the manifest keeps: a capped bound-session settle leaves the
    /// per-session `artifacts/` directory uncreated (ADR-0137 Decision 6
    /// -- the materialization face is gone, so there are no copies to
    /// orphan).
    #[test]
    fn settle_manifest_capped_settles_without_creating_the_artifacts_dir() {
        let work = tempfile::tempdir().expect("workdir");
        let session = tempfile::tempdir().expect("session dir");
        let cwd = work.path();
        let artifacts_dir = session.path().join("artifacts");
        let mut presented = Vec::new();
        for i in 1..=10 {
            let name = format!("declared_{i}.pdf");
            std::fs::write(cwd.join(&name), "x").expect("write");
            presented.push(name);
        }
        let manifest = settle_manifest(&presented, "", cwd, true);
        assert_eq!(manifest.len(), ARTIFACT_CAP);
        assert!(
            !artifacts_dir.exists(),
            "an in-place manifest writes nothing to the session tree"
        );
    }

    /// The three empty arms of [`reply_body`] (#1090): a failed turn, a
    /// cancelled turn, and a bodiless Materialized outcome all scan "".
    #[test]
    fn reply_body_is_empty_for_failed_cancelled_and_bodiless_materialized() {
        use crate::model::{CancelledReason, TurnFailure, TurnOutcome};
        assert_eq!(
            reply_body(&TurnOutcome::Failed(TurnFailure::NotWired)),
            "",
            "a failed turn has no reply prose to scan"
        );
        assert_eq!(
            reply_body(&TurnOutcome::Cancelled(Some(CancelledReason::NoProgress))),
            "",
            "a cancelled turn has no reply prose to scan"
        );
        assert_eq!(
            reply_body(&TurnOutcome::Materialized {
                promotions: Vec::new(),
                viz: None,
                body: None,
                assumption: None,
            }),
            "",
            "a bodiless Materialized turn has no reply prose to scan"
        );
    }

    /// The `durable` honest face (#1090): a materialized temp hit, a
    /// user-directory original, and a declared-but-missing entry are
    /// The `durable` honest face (#1090, recalibrated by ADR-0137 Decision
    /// 6): every entry under a BOUND session -- a workspace hit, a
    /// user-directory original, a declared-but-missing path -- is durable
    /// (in-place references survive the close by nature); only an unbound
    /// in-memory session's temp paths are not -- openable until the
    /// session closes, gone after. Deadness stays the render-time
    /// existence fact's job, not this flag's.
    #[test]
    fn settle_manifest_marks_the_saved_honest_face() {
        let work = tempfile::tempdir().expect("workdir");
        let cwd = work.path();
        std::fs::write(cwd.join("page.html"), "x").expect("write");
        let user_dir = tempfile::tempdir().expect("user dir");
        let user_pdf = user_dir.path().join("external.pdf");
        std::fs::write(&user_pdf, "pdf").expect("write");

        // Unbound session: nothing persists, the temp path is not durable.
        let unbound = settle_manifest(&["page.html".to_string()], "", cwd, false);
        assert_eq!(unbound.len(), 1);
        assert!(!unbound[0].durable, "an unbound session saves nothing");

        // Bound session: the workspace hit, the user-directory original,
        // and a declared-but-missing entry are all durable in place.
        let bound = settle_manifest(
            &[
                "page.html".to_string(),
                user_pdf.to_string_lossy().into_owned(),
                "ghost.pdf".to_string(),
            ],
            "",
            cwd,
            true,
        );
        assert_eq!(bound.len(), 3);
        assert!(bound[0].durable, "a workspace hit is durable in place");
        assert!(
            bound[1].durable,
            "a user-directory original is durable in place"
        );
        assert!(
            bound[2].durable,
            "a missing declaration is not this flag's job"
        );
    }

    /// Relative candidates resolve against the cwd basis (the external
    /// agent's cwd / session working dir).
    #[test]
    fn settle_manifest_resolves_relative_paths_against_cwd() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cwd = dir.path();
        std::fs::write(cwd.join("notes.md"), "x").expect("write");
        let manifest = settle_manifest(&[], "见 notes.md", cwd, false);
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
            false,
        );
        assert_eq!(manifest.len(), 1);
        assert!(manifest[0].path.ends_with("declared_but_missing.html"));
    }

    /// The in-place ruling (ADR-0137 Decision 6): a workspace hit enters
    /// the manifest under its own absolute path with nothing copied (the
    /// per-session `artifacts/` directory is never created); a
    /// user-directory hit behaves identically -- the app does not copy
    /// user files.
    #[test]
    fn settle_manifest_references_workspace_and_user_dir_hits_in_place() {
        let work = tempfile::tempdir().expect("workdir");
        let session = tempfile::tempdir().expect("session dir");
        let cwd = work.path();
        let artifacts_dir = session.path().join("artifacts");
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
            true,
        );
        assert_eq!(manifest.len(), 2);
        assert_eq!(
            manifest[0].path,
            cwd.join("report.html").to_string_lossy(),
            "the workspace hit is referenced in place"
        );
        assert_eq!(
            manifest[1].path,
            user_pdf.to_string_lossy(),
            "a user-directory hit stays in place (no copy)"
        );
        assert!(
            !artifacts_dir.exists(),
            "nothing is materialized into the session tree"
        );
    }

    /// The preview whitelist source (ADR-0137 Decision 6):
    /// `referenced_paths` collects the `TurnArtifact` paths of every turn
    /// record -- first-seen order, deduplicated -- and nothing from the
    /// non-turn entry kinds.
    #[test]
    fn referenced_paths_collects_turn_artifacts_first_seen_deduped() {
        use crate::model::{
            SourceLifecycleEvent, SourceLifecycleKind, TurnFailure, TurnOutcome, TurnProvenance,
            TurnRecord,
        };
        let turn = |paths: &[&str]| {
            ThreadEntry::Turn(TurnRecord {
                question: "q".into(),
                outcome: TurnOutcome::Failed(TurnFailure::NotWired),
                trace: Vec::new(),
                provenance: TurnProvenance::default(),
                invocations: Vec::new(),
                asked_at: None,
                settled_at: None,
                artifacts: paths
                    .iter()
                    .map(|p| TurnArtifact {
                        path: (*p).to_string(),
                        file_name: "f".into(),
                        durable: true,
                    })
                    .collect(),
                usage: None,
                occupancy: None,
            })
        };
        let entries = vec![
            turn(&["C:/ws/report.pdf", "C:/ws/page.html"]),
            ThreadEntry::Source(SourceLifecycleEvent {
                kind: SourceLifecycleKind::Added,
                reference_name: "src".into(),
                display_name: "src".into(),
            }),
            turn(&["C:/ws/report.pdf", "C:/ws/other.md"]),
        ];
        let paths = referenced_paths(&entries);
        assert_eq!(
            paths,
            vec![
                PathBuf::from("C:/ws/report.pdf"),
                PathBuf::from("C:/ws/page.html"),
                PathBuf::from("C:/ws/other.md"),
            ],
            "first-seen order, deduplicated, turns only"
        );
    }
}
