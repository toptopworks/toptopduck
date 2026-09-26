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
const ARTIFACTS_DIR_NAME: &str = "artifacts";

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
        .map(|path| {
            let (path, durable) = materialize(path, cwd, artifacts_dir);
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

/// Materialize one resolved hit (the persistence ruling, ADR-0124 Decision
/// 2): a hit under the session temp working directory is COPIED into the
/// per-session `artifacts/` directory (the temp dir dies with the session;
/// the manifest must survive a close/reopen) and the copy's path is
/// returned; anything else (a user-directory absolute hit) returns
/// unchanged -- the app does not copy user files. Best-effort + logged: a
/// copy failure leaves the temp path in place (the card degrades after
/// close, honestly). A same-name collision takes a `_2`, `_3`, ... suffix
/// so two distinct same-named files never overwrite each other. The
/// returned flag is the entry's [`TurnArtifact::durable`] honest face:
/// `true` for a materialized copy or a user-directory original, `false`
/// for a temp path the copy could not move (openable until the session
/// closes).
/// Whether `path` names something strictly inside `dir` (the session
/// working directory -- the materialization trigger). `Path::starts_with`
/// compares components byte-exactly, so on Windows -- where the FS is
/// case-insensitive and a model may echo an absolute temp path with
/// drifted casing -- the comparison folds case through the same lens as
/// [`dedup_key`], keeping the dedup and materialization decisions on one
/// case semantics (PR #1089 review).
fn is_within(path: &Path, dir: &Path) -> bool {
    let mut dir_comps = dir.components();
    for comp in path.components() {
        match dir_comps.next() {
            Some(d) if component_eq(&comp, &d) => continue,
            // `dir` exhausted: this component is a child below it.
            None => return true,
            Some(_) => return false,
        }
    }
    false // `path` ended with `dir` components unconsumed (or equals it).
}

/// Component equality, case-folded on Windows (see [`is_within`]);
/// component comparison already normalizes `/` vs `\`.
#[cfg(windows)]
fn component_eq(a: &std::path::Component, b: &std::path::Component) -> bool {
    a.as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
}

#[cfg(not(windows))]
fn component_eq(a: &std::path::Component, b: &std::path::Component) -> bool {
    a == b
}

fn materialize(path: PathBuf, cwd: &Path, artifacts_dir: Option<&Path>) -> (PathBuf, bool) {
    let Some(dir) = artifacts_dir else {
        return (path, false);
    };
    // A hit outside the session working dir is a user-directory original:
    // durable in place -- the app does not copy user files.
    if !is_within(&path, cwd) {
        return (path, true);
    }
    // A declared-but-missing entry: nothing to copy. Durable stays `true`
    // -- the flag answers "survives the session close", and deadness is
    // the render-time existence fact's job, not this flag's.
    if !path.is_file() {
        return (path, true);
    }
    if let Err(e) = std::fs::create_dir_all(dir) {
        log::warn!(
            target: "toptopduck::session",
            "artifact materialization skipped: cannot create {}: {e}",
            dir.display()
        );
        return (path, false);
    }
    let file_name = match path.file_name().and_then(|n| n.to_str()) {
        Some(name) => name.to_string(),
        None => return (path, false),
    };
    let mut target = dir.join(&file_name);
    // Collision-loop invariants hoisted (#1090): stem/ext are constant per
    // attempt, and an empty extension formats without the separator dot
    // (`LICENSE_2`, never `LICENSE_2.`).
    let stem = Path::new(&file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("artifact");
    let ext = Path::new(&file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    let mut counter = 2u32;
    while target.exists() {
        target = dir.join(if ext.is_empty() {
            format!("{stem}_{counter}")
        } else {
            format!("{stem}_{counter}.{ext}")
        });
        counter += 1;
    }
    match std::fs::copy(&path, &target) {
        Ok(_) => (target, true),
        Err(e) => {
            log::warn!(
                target: "toptopduck::session",
                "artifact materialization failed for {}: {e}",
                path.display()
            );
            (path, false)
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
            None,
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
        let manifest = settle_manifest(&["Dup.pdf".to_string()], "见 dup.pdf", cwd, None);
        assert_eq!(manifest.len(), 1, "two spellings of one file merge");
        assert!(
            manifest[0].path.ends_with("Dup.pdf"),
            "the presented spelling wins"
        );
    }

    /// Windows case-insensitivity on the materialization trigger (PR
    /// #1089 review Important 4): an echoed absolute temp path with
    /// drifted casing is still a temp-dir member and materializes -- the
    /// same fold lens the dedup key uses. (Unix keeps byte-exact
    /// membership; pinned on Windows only.)
    #[cfg(windows)]
    #[test]
    fn settle_manifest_materializes_case_drifted_temp_paths_on_windows() {
        let work = tempfile::tempdir().expect("workdir");
        let session = tempfile::tempdir().expect("session dir");
        std::fs::write(work.path().join("page.html"), "x").expect("write");
        let drifted = work
            .path()
            .join("page.html")
            .to_string_lossy()
            .to_ascii_uppercase();
        let manifest = settle_manifest(
            &[drifted],
            "",
            work.path(),
            Some(&session.path().join(ARTIFACTS_DIR_NAME)),
        );
        assert_eq!(manifest.len(), 1);
        assert!(
            Path::new(&manifest[0].path).starts_with(session.path()),
            "the drifted-casing temp hit still materializes: {}",
            manifest[0].path
        );
        assert!(Path::new(&manifest[0].path).is_file(), "the copy exists");
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
            None,
        );
        assert_eq!(manifest.len(), 2);
        assert_eq!(manifest[0].file_name, "b.pdf", "the declaration leads");
        assert_eq!(manifest[1].file_name, "a.pdf", "the scan hit follows");
    }

    /// The cap runs BEFORE materialization (#1090): ten real files against
    /// a bound session leave exactly [`ARTIFACT_CAP`] copies on disk -- a
    /// reorder that materializes first would orphan two copies no manifest
    /// entry points at. Pins the order, not just the count.
    #[test]
    fn settle_manifest_caps_before_materializing_no_orphan_copies() {
        let work = tempfile::tempdir().expect("workdir");
        let session = tempfile::tempdir().expect("session dir");
        let cwd = work.path();
        let artifacts_dir = session.path().join(ARTIFACTS_DIR_NAME);
        let mut presented = Vec::new();
        for i in 1..=10 {
            let name = format!("declared_{i}.pdf");
            std::fs::write(cwd.join(&name), "x").expect("write");
            presented.push(name);
        }
        let manifest = settle_manifest(&presented, "", cwd, Some(&artifacts_dir));
        assert_eq!(manifest.len(), ARTIFACT_CAP);
        let on_disk = std::fs::read_dir(&artifacts_dir)
            .expect("artifacts dir")
            .count();
        assert_eq!(
            on_disk, ARTIFACT_CAP,
            "no orphan copies: what is on disk is what the manifest kept"
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
    /// durable; an unbound session's temp path and a failed
    /// materialization are not -- openable until the session closes,
    /// gone after.
    #[test]
    fn settle_manifest_marks_the_saved_honest_face() {
        let work = tempfile::tempdir().expect("workdir");
        let cwd = work.path();
        std::fs::write(cwd.join("page.html"), "x").expect("write");
        let user_dir = tempfile::tempdir().expect("user dir");
        let user_pdf = user_dir.path().join("external.pdf");
        std::fs::write(&user_pdf, "pdf").expect("write");

        // Unbound session: nothing persists, the temp path is not durable.
        let unbound = settle_manifest(&["page.html".to_string()], "", cwd, None);
        assert_eq!(unbound.len(), 1);
        assert!(!unbound[0].durable, "an unbound session saves nothing");

        // Bound session: the temp hit materializes (durable), the
        // user-directory original stays in place (durable -- the user's file
        // is durable by nature).
        let session = tempfile::tempdir().expect("session dir");
        let bound = settle_manifest(
            &[
                "page.html".to_string(),
                user_pdf.to_string_lossy().into_owned(),
            ],
            "",
            cwd,
            Some(&session.path().join(ARTIFACTS_DIR_NAME)),
        );
        assert_eq!(bound.len(), 2);
        assert!(bound[0].durable, "the materialized copy is durable");
        assert!(
            bound[1].durable,
            "a user-directory original is durable in place"
        );

        // A declared-but-missing entry against a bound session: nothing
        // to copy, and durable stays true -- the flag answers "survives
        // the session close", deadness is the render-time existence
        // fact's job (#1090).
        let ghost = settle_manifest(
            &["ghost.pdf".to_string()],
            "",
            cwd,
            Some(&session.path().join(ARTIFACTS_DIR_NAME)),
        );
        assert_eq!(ghost.len(), 1);
        assert!(
            ghost[0].durable,
            "a missing declaration is not this flag's job"
        );

        // A materialization that cannot even create the artifacts dir (its
        // parent is a file) degrades to the temp path, unsaved.
        let blocked = tempfile::tempdir().expect("blocked session dir");
        let blocker = blocked.path().join("blocker");
        std::fs::write(&blocker, "x").expect("write");
        let failed = settle_manifest(
            &["page.html".to_string()],
            "",
            cwd,
            Some(&blocker.join(ARTIFACTS_DIR_NAME)),
        );
        assert_eq!(failed.len(), 1);
        assert!(
            !failed[0].durable,
            "a failed materialization leaves the temp path unsaved"
        );
        assert!(
            Path::new(&failed[0].path).starts_with(cwd),
            "the entry keeps the temp path"
        );
    }

    /// A copy that fails mid-materialization (the source is unreadable)
    /// degrades to the temp path with durable false -- openable until
    /// the session closes, gone after (#1091 review). Unix-only: the
    /// permission denial is the portable trigger, and CI runs Linux.
    #[cfg(unix)]
    #[test]
    fn settle_manifest_copy_failure_leaves_the_temp_path_unsaved() {
        use std::os::unix::fs::PermissionsExt;
        let work = tempfile::tempdir().expect("workdir");
        let cwd = work.path();
        let secret = cwd.join("secret.pdf");
        std::fs::write(&secret, "pdf").expect("write");
        std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o000)).expect("chmod");
        let session = tempfile::tempdir().expect("session dir");
        let manifest = settle_manifest(
            &["secret.pdf".to_string()],
            "",
            cwd,
            Some(&session.path().join(ARTIFACTS_DIR_NAME)),
        );
        assert_eq!(manifest.len(), 1);
        assert!(!manifest[0].durable, "a failed copy is unsaved");
        assert!(
            Path::new(&manifest[0].path).starts_with(cwd),
            "the entry keeps the temp path"
        );
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

    /// A collision on an extension-less name (`LICENSE`) disambiguates
    /// without minting a trailing dot (`LICENSE_2.`, #1090).
    #[test]
    fn settle_manifest_collision_on_extensionless_names_has_no_trailing_dot() {
        let work = tempfile::tempdir().expect("workdir");
        let session = tempfile::tempdir().expect("session dir");
        let cwd = work.path();
        let artifacts_dir = session.path().join(ARTIFACTS_DIR_NAME);
        std::fs::create_dir_all(cwd.join("a")).expect("dirs");
        std::fs::create_dir_all(cwd.join("b")).expect("dirs");
        std::fs::write(cwd.join("a").join("LICENSE"), "one").expect("write");
        std::fs::write(cwd.join("b").join("LICENSE"), "two").expect("write");

        let manifest = settle_manifest(
            &["a/LICENSE".to_string(), "b/LICENSE".to_string()],
            "",
            cwd,
            Some(&artifacts_dir),
        );
        assert_eq!(manifest.len(), 2);
        assert_eq!(manifest[1].file_name, "LICENSE_2");
        assert!(Path::new(&manifest[1].path).is_file(), "the copy exists");
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
