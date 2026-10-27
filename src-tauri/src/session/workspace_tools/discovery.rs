//! The workspace discovery tools (ADR-0137, issue #1385): `glob` / `grep`
//! / `read`, the read-only navigation channel over the session workspace.
//!
//! Discovery closes the reuse loop's gap (discover -> judge -> reuse):
//! cross-session sediment (issue #1406's `write` / `edit`) stays dead
//! capital without a listing or search face, and the model's fallback --
//! hand-rolled python traversal -- is slow, heavy, and outside the
//! governance semantics. Navigation stays out of the ingestion governance
//! on purpose (ADR-0137): the tools only point and read inside the
//! workspace; bringing data IN still rides manual ingest or the SQL
//! reference channel (issue #1382).
//!
//! Family posture (issue #1385 grilling): the trio mounts on the built-in
//! runtime's table only (the bridge face never lists the names), rides the
//! ADR-0080 Decision 1 zero-approval builtin pass -- a read inside the
//! workspace has no approval surface, so unlike the gated `write` pair the
//! dispatch arm below never touches the gate -- and refuses on a
//! malformed / out-of-domain call with a self-correctable error, exactly
//! like the write pair ahead of its card.
//!
//! Traversal core (shared by `glob` and `grep`): a fixed exclusion list
//! (build/VCS directories -- no `.gitignore` parsing, v1), hidden entries
//! skipped by default but reachable by explicit naming, symlinked entries
//! pruned entirely (a walk that followed links could list or read outside
//! the workspace, sidestepping the domain check the direct paths get), and
//! the NUL heuristic marking a file binary.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use regex::Regex;
use serde_json::{json, Value};

use crate::model::{TraceEntryView, TurnPhase};
use crate::provider::tool_calling::{ToolDefinition, ToolResult, ToolUse};
use crate::session::loop_contract::{truncate_trace_excerpt, TraceEntry, TRACE_EXCERPT_MAX};
use crate::session::materializer::TurnDeps;
use crate::tools::definitions::get_str;

use super::{require_workspace, resolve_entity_in_workspace};

/// The `glob` tool name (bare, snake_case params -- the Claude Code prior).
pub(crate) const GLOB_TOOL: &str = "glob";

/// The `grep` tool name.
pub(crate) const GREP_TOOL: &str = "grep";

/// The `read` tool name.
pub(crate) const READ_TOOL: &str = "read";

/// Directories the traversal core prunes (issue #1385 grilling): build and
/// VCS trees are never discovery targets. A fixed list, not `.gitignore`
/// parsing -- repo-directory pain is a v2 question.
const EXCLUDED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "__pycache__",
    ".venv",
];

/// `glob` result cap: newest-first listing with a truncation footnote the
/// model narrows the pattern from.
const GLOB_RESULT_CAP: usize = 100;

/// `grep` result cap, the same shape as `glob`'s (files in
/// `files_with_matches`/`count`, matched lines in `content`).
const GREP_RESULT_CAP: usize = 100;

/// A text file over this size is skipped by `grep` and counted in the
/// footnote -- the search face, not the bulk reader.
const GREP_FILE_MAX_BYTES: u64 = 10 * 1024 * 1024;

/// `read` page size: the default AND the maximum `limit`.
const READ_LINE_CAP: usize = 2000;

/// `read` truncates one line at this many characters.
const READ_LINE_CHAR_CAP: usize = 2000;

/// `read` truncates the whole output at this many bytes (issue #1385
/// landed value; the tool_output domain's 1 MiB read family is a different
/// channel with a different budget).
const READ_OUTPUT_MAX_BYTES: usize = 50 * 1024;

/// Whether `name` is one of the discovery tools -- half of the family
/// predicate the shared dispatch core routes on.
pub(crate) fn is_discovery_tool(name: &str) -> bool {
    name == GLOB_TOOL || name == GREP_TOOL || name == READ_TOOL
}

/// Build the [`ToolDefinition`] for the `glob` tool: file-name pattern
/// discovery inside the session workspace.
pub(crate) fn glob_definition() -> ToolDefinition {
    ToolDefinition {
        name: GLOB_TOOL.to_string(),
        description: "Find files in the session workspace by glob pattern. `pattern` uses \
                      standard glob syntax (`*`, `?`, `[...]`, and `**` for recursive \
                      segments) matched against paths relative to `path` (default: the \
                      workspace root). Hidden files and common build/VCS directories are \
                      skipped unless named explicitly. Returns matching file paths sorted \
                      by modification time (newest first), capped at 100 results with a \
                      truncation note."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Glob pattern, e.g. `**/*.py` or `data/2024-*.csv`."
                },
                "path": {
                    "type": "string",
                    "description": "Directory to search in, relative to the session \
                                    workspace. Defaults to the workspace root."
                }
            },
            "required": ["pattern"]
        }),
    }
}

/// Build the [`ToolDefinition`] for the `grep` tool: content search inside
/// the session workspace.
pub(crate) fn grep_definition() -> ToolDefinition {
    ToolDefinition {
        name: GREP_TOOL.to_string(),
        description: "Search file contents in the session workspace with a regular \
                      expression. `path` defaults to the workspace root; a specific \
                      file path searches that file alone. `glob` filters candidate \
                      files by name (e.g. `*.py`). `output_mode` is `files_with_matches` \
                      (default), `content` (`path:line:text` per matched line), or \
                      `count` (`path:N` per file). Binary files and files over 10 MB \
                      are skipped and counted."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Regular expression (Rust regex syntax)."
                },
                "path": {
                    "type": "string",
                    "description": "File or directory to search, relative to the session \
                                    workspace. Defaults to the whole workspace."
                },
                "glob": {
                    "type": "string",
                    "description": "Glob pattern filtering candidate files by name, \
                                    e.g. `*.py`."
                },
                "output_mode": {
                    "type": "string",
                    "enum": ["files_with_matches", "content", "count"],
                    "description": "Output shape. Defaults to `files_with_matches`."
                }
            },
            "required": ["pattern"]
        }),
    }
}

/// Build the [`ToolDefinition`] for the `read` tool: line-numbered whole-
/// file reading inside the session workspace.
pub(crate) fn read_definition() -> ToolDefinition {
    ToolDefinition {
        name: READ_TOOL.to_string(),
        description: "Read a UTF-8 text file from the session workspace with 1-based \
                      line numbers. `offset` is the first line to return (default 1); \
                      `limit` is the number of lines (default and maximum 2000). Lines \
                      longer than 2000 characters are truncated; the output is capped \
                      at 50 KiB. Binary files are refused. Paths outside the session \
                      workspace are refused -- bring outside files in through manual \
                      ingest."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "File to read, relative to the session workspace \
                                    (or absolute inside it)."
                },
                "offset": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "First line to return, 1-based. Defaults to 1."
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Number of lines to return. Defaults to 2000, \
                                    which is also the maximum."
                }
            },
            "required": ["path"]
        }),
    }
}

/// The ungated dispatch arm behind the trio: resolve, execute, record --
/// no approval card exists for an in-workspace read (ADR-0080 Decision 1),
/// so unlike the write pair there is no gate hop and no pre-gate refusal
/// split; a refusal and an execution error both land as the model's tool
/// error with a failed trace entry (the `explore` posture: failures record
/// too).
pub(crate) fn dispatch_readonly(
    call: &ToolUse,
    deps: &TurnDeps,
    on_phase: &mut impl FnMut(TurnPhase),
    _origin: Option<&str>,
) -> (ToolResult, Option<TraceEntry>) {
    let workspace = deps.bound_workspace();
    let summary = call_summary(call);
    let resolved = match call.name.as_str() {
        GLOB_TOOL => resolve_glob(call, workspace),
        GREP_TOOL => resolve_grep(call, workspace),
        _ => resolve_read(call, workspace),
    };
    on_phase(TurnPhase::ToolCallStarted {
        id: None,
        name: call.name.clone(),
        operation_kind: crate::approval::OperationKind::Read,
        summary: summary.clone(),
        task: None,
    });
    let (content, is_error) = match resolved {
        Ok(output) => (output, false),
        Err(message) => (message, true),
    };
    let entry = if is_error {
        TraceEntry::failed(
            call.id.clone(),
            call.name.clone(),
            crate::approval::OperationKind::Read,
            summary,
            truncate_trace_excerpt(&content, TRACE_EXCERPT_MAX),
        )
    } else {
        TraceEntry::succeeded(
            call.id.clone(),
            call.name.clone(),
            crate::approval::OperationKind::Read,
            summary,
            String::new(),
        )
    };
    on_phase(TurnPhase::ToolCallCompleted(TraceEntryView::from(&entry)));
    (
        ToolResult {
            tool_use_id: call.id.clone(),
            content,
            is_error,
        },
        Some(entry),
    )
}

/// The trace summary: the leading positional argument (the pattern, or the
/// read path).
fn call_summary(call: &ToolUse) -> String {
    let key = if call.name == READ_TOOL {
        "path"
    } else {
        "pattern"
    };
    call.input
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Resolve one `glob` call (issue #1385).
fn resolve_glob(call: &ToolUse, workspace: Option<&Path>) -> Result<String, String> {
    let pattern = get_str(&call.input, "pattern").map_err(|e| format!("{GLOB_TOOL}: {e}"))?;
    let matcher = glob::Pattern::new(&pattern)
        .map_err(|e| format!("{GLOB_TOOL}: invalid glob pattern `{pattern}`: {e}"))?;
    let base_req = opt_str(&call.input, "path")?;
    let workspace = require_workspace(GLOB_TOOL, workspace)?;
    let base = match &base_req {
        Some(spelling) => {
            let base = resolve_entity_in_workspace(workspace, spelling)
                .map_err(|reason| format!("{GLOB_TOOL}: {reason}"))?;
            if !base.is_dir() {
                return Err(format!(
                    "{GLOB_TOOL}: `{spelling}` is not a directory; `path` names the \
                     search root"
                ));
            }
            base
        }
        None => workspace.to_path_buf(),
    };
    // A wildcard-free spelling is an explicit naming: one direct stat
    // replaces the walk, so a hidden or excluded entry the walk would
    // prune is reachable (the "explicit naming wins" carve-out). An
    // out-of-domain spelling still refuses, never silently matches empty.
    let mut matches: Vec<(String, SystemTime)> = if !pattern_has_wildcard(&pattern) {
        let spelling = match &base_req {
            Some(base) => format!("{base}/{pattern}"),
            None => pattern.clone(),
        };
        let target = resolve_entity_in_workspace(workspace, &spelling)
            .map_err(|reason| format!("{GLOB_TOOL}: {reason}"))?;
        if target.is_file() {
            vec![(rel_from(&base, &target), mtime_of(&target))]
        } else {
            Vec::new()
        }
    } else {
        let mut hits: Vec<(String, SystemTime)> = walk_visible_files(&base)
            .into_iter()
            .filter(|file| matcher.matches(&file.rel))
            .map(|file| (file.rel, file.mtime))
            .collect();
        // Newest first; the rel path tie-break keeps the order deterministic
        // for same-moment writes.
        hits.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        hits
    };
    let truncated = matches.len() > GLOB_RESULT_CAP;
    matches.truncate(GLOB_RESULT_CAP);
    if matches.is_empty() {
        return Ok(format!("no files matched `{pattern}`"));
    }
    let mut out = String::new();
    for (rel, _) in &matches {
        out.push_str(rel);
        out.push('\n');
    }
    if truncated {
        out.push_str(&format!(
            "[list truncated at {GLOB_RESULT_CAP} entries; narrow the pattern]\n"
        ));
    }
    Ok(out)
}

/// Resolve one `grep` call (issue #1385).
fn resolve_grep(call: &ToolUse, workspace: Option<&Path>) -> Result<String, String> {
    let pattern = get_str(&call.input, "pattern").map_err(|e| format!("{GREP_TOOL}: {e}"))?;
    let regex =
        Regex::new(&pattern).map_err(|e| format!("{GREP_TOOL}: invalid regex `{pattern}`: {e}"))?;
    let mode_req = opt_str(&call.input, "output_mode")?;
    let mode = match mode_req.as_deref() {
        None | Some("files_with_matches") => "files_with_matches",
        Some("content") | Some("count") => mode_req.as_deref().unwrap(),
        Some(other) => {
            return Err(format!(
                "{GREP_TOOL}: output_mode must be files_with_matches, content, or \
                 count (got `{other}`)"
            ));
        }
    };
    let name_filter = opt_str(&call.input, "glob")?
        .map(|spelling| {
            glob::Pattern::new(&spelling)
                .map_err(|e| format!("{GREP_TOOL}: invalid glob filter `{spelling}`: {e}"))
        })
        .transpose()?;
    let path_req = opt_str(&call.input, "path")?;
    let workspace = require_workspace(GREP_TOOL, workspace)?;
    // The candidate set: one explicitly-named file searched alone, or the
    // walk over an explicitly-named directory / the workspace root.
    let candidates: Vec<WalkedFile> = match &path_req {
        Some(spelling) => {
            let target = resolve_entity_in_workspace(workspace, spelling)
                .map_err(|reason| format!("{GREP_TOOL}: {reason}"))?;
            if target.is_file() {
                let rel = rel_from(workspace, &target);
                let metadata = std::fs::metadata(&target)
                    .map_err(|e| format!("{GREP_TOOL}: cannot stat {rel}: {e}"))?;
                vec![WalkedFile {
                    rel,
                    mtime: modified_of(&metadata),
                    size: metadata.len(),
                    abs: target,
                }]
            } else {
                walk_visible_files(&target)
            }
        }
        None => walk_visible_files(workspace),
    };
    let mut files: Vec<String> = Vec::new();
    let mut content_hits: Vec<String> = Vec::new();
    let mut counts: Vec<(String, usize)> = Vec::new();
    let mut skipped = 0usize;
    for file in &candidates {
        if let Some(filter) = &name_filter {
            let base = Path::new(&file.rel)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| file.rel.clone());
            if !filter.matches(&base) {
                continue;
            }
        }
        if file.size > GREP_FILE_MAX_BYTES {
            skipped += 1;
            continue;
        }
        let bytes = std::fs::read(&file.abs);
        let Ok(bytes) = bytes else {
            skipped += 1;
            continue;
        };
        if bytes.contains(&0) {
            skipped += 1;
            continue;
        }
        let Ok(text) = String::from_utf8(bytes) else {
            skipped += 1;
            continue;
        };
        let mut count = 0usize;
        for (index, line) in text.lines().enumerate() {
            if regex.is_match(line) {
                count += 1;
                if mode == "content" && content_hits.len() < GREP_RESULT_CAP {
                    content_hits.push(format!("{}:{}:{}", file.rel, index + 1, line));
                }
            }
        }
        if count > 0 {
            files.push(file.rel.clone());
            counts.push((file.rel.clone(), count));
        }
    }
    let mut out = match mode {
        "files_with_matches" => {
            let truncated = files.len() > GREP_RESULT_CAP;
            files.truncate(GREP_RESULT_CAP);
            render_lines(files.into_iter(), truncated)
        }
        "content" => {
            let truncated = total_match_lines(&counts) > content_hits.len();
            render_lines(content_hits.into_iter(), truncated)
        }
        _ => {
            let truncated = counts.len() > GREP_RESULT_CAP;
            counts.truncate(GREP_RESULT_CAP);
            render_lines(
                counts.into_iter().map(|(rel, n)| format!("{rel}:{n}")),
                truncated,
            )
        }
    };
    if out.is_empty() {
        out = format!("no matches for `{pattern}`");
    }
    if skipped > 0 {
        out.push_str(&format!(
            "[{skipped} files skipped: binary, oversized, or unreadable]\n"
        ));
    }
    Ok(out)
}

/// Resolve one `read` call (issue #1385).
fn resolve_read(call: &ToolUse, workspace: Option<&Path>) -> Result<String, String> {
    let path = get_str(&call.input, "path").map_err(|e| format!("{READ_TOOL}: {e}"))?;
    let offset = opt_index(&call.input, "offset", 1)?;
    let limit = opt_index(&call.input, "limit", READ_LINE_CAP)?.min(READ_LINE_CAP);
    let workspace = require_workspace(READ_TOOL, workspace)?;
    let target = resolve_entity_in_workspace(workspace, &path)
        .map_err(|reason| format!("{READ_TOOL}: {reason}"))?;
    if !target.exists() {
        return Err(format!(
            "{READ_TOOL}: `{path}` does not exist; list candidates with glob"
        ));
    }
    if target.is_dir() {
        return Err(format!(
            "{READ_TOOL}: `{path}` is a directory; read a file, or search with \
             glob/grep"
        ));
    }
    let bytes =
        std::fs::read(&target).map_err(|e| format!("{READ_TOOL}: cannot read `{path}`: {e}"))?;
    if bytes.contains(&0) {
        return Err(format!(
            "{READ_TOOL}: `{path}` contains a NUL byte; the read tool is UTF-8 \
             text only"
        ));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| format!("{READ_TOOL}: `{path}` is not valid UTF-8 text"))?;
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    if offset > total {
        return Ok(format!(
            "[`{path}` has {total} lines; offset {offset} is past the end]"
        ));
    }
    let window: Vec<&str> = lines.iter().skip(offset - 1).take(limit).copied().collect();
    let mut out = String::new();
    let mut shown = 0usize;
    let mut budget_truncated = false;
    let mut truncated_lines = 0usize;
    for (index, line) in window.iter().enumerate() {
        if line.chars().count() > READ_LINE_CHAR_CAP {
            truncated_lines += 1;
        }
        let truncated_line: String = line.chars().take(READ_LINE_CHAR_CAP).collect();
        let rendered = format!("{}\t{}\n", offset + index, truncated_line);
        if out.len() + rendered.len() > READ_OUTPUT_MAX_BYTES && shown > 0 {
            budget_truncated = true;
            break;
        }
        out.push_str(&rendered);
        shown += 1;
    }
    let next = offset + shown;
    if truncated_lines > 0 {
        out.push_str(&format!(
            "[{truncated_lines} lines truncated at {READ_LINE_CHAR_CAP} characters]\n"
        ));
    }
    if budget_truncated {
        out.push_str(&format!(
            "[output truncated at {} KiB; re-run with a smaller limit]\n",
            READ_OUTPUT_MAX_BYTES / 1024
        ));
    }
    if next <= total {
        out.push_str(&format!(
            "[`{path}` has {total} lines; continue with offset {next}]\n"
        ));
    }
    Ok(out)
}

// --- traversal core ---------------------------------------------------------

/// One walk product: an in-workspace regular file with its workspace-
/// relative `/`-joined path, modification time, and size.
struct WalkedFile {
    rel: String,
    mtime: SystemTime,
    size: u64,
    abs: PathBuf,
}

/// Walk `root` for visible regular files: symlinked entries pruned (a
/// followed link could list or read outside the workspace), hidden entries
/// and the fixed exclusion list skipped below the root (the root itself is
/// the explicit naming and always honored).
fn walk_visible_files(root: &Path) -> Vec<WalkedFile> {
    fn visit(dir: &Path, prefix: &str, out: &mut Vec<WalkedFile>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if file_type.is_dir() {
                if is_hidden(&name) || EXCLUDED_DIRS.contains(&name.as_str()) {
                    continue;
                }
                visit(&entry.path(), &rel, out);
            } else {
                if is_hidden(&name) {
                    continue;
                }
                let Ok(metadata) = entry.metadata() else {
                    continue;
                };
                out.push(WalkedFile {
                    rel,
                    mtime: modified_of(&metadata),
                    size: metadata.len(),
                    abs: entry.path(),
                });
            }
        }
    }
    let mut out = Vec::new();
    visit(root, "", &mut out);
    out
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

fn modified_of(metadata: &std::fs::Metadata) -> SystemTime {
    metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH)
}

fn mtime_of(target: &Path) -> SystemTime {
    std::fs::metadata(target)
        .map(|m| modified_of(&m))
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

/// `target` rendered relative to `base` with `/` separators (the model-
/// facing spelling; `base` is canonical so the strip is prefix-clean on
/// every platform).
fn rel_from(base: &Path, target: &Path) -> String {
    target
        .strip_prefix(base)
        .unwrap_or(target)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn pattern_has_wildcard(pattern: &str) -> bool {
    pattern.contains(['*', '?', '['])
}

fn total_match_lines(counts: &[(String, usize)]) -> usize {
    counts.iter().map(|(_, n)| n).sum()
}

fn render_lines(lines: impl Iterator<Item = String>, truncated: bool) -> String {
    let mut out = String::new();
    for line in lines {
        out.push_str(&line);
        out.push('\n');
    }
    if truncated {
        out.push_str(&format!(
            "[truncated at {GREP_RESULT_CAP} matches; narrow the pattern or path]\n"
        ));
    }
    out
}

// --- parameter helpers ------------------------------------------------------

/// The optional-string twin of [`get_str`]: absent or null is `None`, a
/// non-string is the shared mis-shaped-call error.
fn opt_str(input: &Value, field: &str) -> Result<Option<String>, String> {
    match input.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(format!("parameter `{field}`: expected a string")),
    }
}

/// The optional-index twin: absent or null is `default`, a non-number or a
/// zero value is the mis-shaped-call error.
fn opt_index(input: &Value, field: &str, default: usize) -> Result<usize, String> {
    match input.get(field) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Number(n)) => n
            .as_u64()
            .filter(|v| *v > 0)
            .map(|v| v as usize)
            .ok_or_else(|| format!("parameter `{field}`: expected a positive integer")),
        Some(_) => Err(format!("parameter `{field}`: expected a positive integer")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::tool_calling::ToolUse;
    use crate::session::materializer::CachedDerivedRef;
    use crate::session::workspace_tools::is_workspace_tool;
    use crate::workingset::WorkingSet;
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use tempfile::TempDir;

    fn ws_dir() -> (TempDir, PathBuf) {
        let dir = TempDir::new().unwrap();
        let canonical = std::fs::canonicalize(dir.path()).unwrap();
        (dir, canonical)
    }

    fn tool_use(name: &str, input: Value) -> ToolUse {
        ToolUse {
            id: "t1".into(),
            name: name.into(),
            input,
        }
    }

    fn glob_call(pattern: &str) -> ToolUse {
        tool_use(GLOB_TOOL, json!({ "pattern": pattern }))
    }

    /// The TurnDeps fixture (the write pair's shape): owners live on the
    /// struct, `deps` borrows them per call.
    struct DepsFixture {
        engine: crate::session::engine::AdminEngine,
        working_set: WorkingSet,
        sources: HashMap<String, PathBuf>,
        refs: HashMap<String, CachedDerivedRef>,
        temp: TempDir,
        slot: Option<PathBuf>,
    }

    impl DepsFixture {
        fn new(workspace: &Path) -> Self {
            Self {
                engine: crate::session::engine::AdminEngine::materialized(),
                working_set: WorkingSet::default(),
                sources: HashMap::new(),
                refs: HashMap::new(),
                temp: TempDir::new().unwrap(),
                slot: Some(workspace.to_path_buf()),
            }
        }

        fn deps(&mut self) -> TurnDeps<'_> {
            TurnDeps::test_deps_with_workspace(
                &self.engine,
                &mut self.working_set,
                &mut self.sources,
                self.temp.path(),
                &mut self.refs,
                &mut self.slot,
            )
        }
    }

    // --- glob -----------------------------------------------------------------

    #[test]
    fn glob_lists_recursively_newest_first() {
        let (_dir, ws) = ws_dir();
        std::fs::write(ws.join("old.py"), "x").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(15));
        std::fs::create_dir(ws.join("sub")).unwrap();
        std::fs::write(ws.join("sub/new.py"), "y").unwrap();
        let out = resolve_glob(&glob_call("**/*.py"), Some(&ws)).unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "sub/new.py", "newest first: {out}");
        assert_eq!(lines[1], "old.py", "{out}");
        // Every hit rides a `/`-joined relative spelling.
        assert!(!lines[0].contains('\\'), "{out}");
    }

    #[test]
    fn glob_caps_at_one_hundred_with_a_footnote() {
        let (_dir, ws) = ws_dir();
        for k in 0..105 {
            std::fs::write(ws.join(format!("f{k:03}.txt")), "x").unwrap();
        }
        let out = resolve_glob(&glob_call("*.txt"), Some(&ws)).unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), GLOB_RESULT_CAP + 1, "{out}");
        assert_eq!(
            *lines.last().unwrap(),
            format!("[list truncated at {GLOB_RESULT_CAP} entries; narrow the pattern]"),
            "{out}"
        );
    }

    #[test]
    fn glob_prunes_excluded_and_hidden_by_default() {
        let (_dir, ws) = ws_dir();
        for excluded in [
            ".git",
            "node_modules",
            "target",
            "dist",
            "build",
            "__pycache__",
            ".venv",
        ] {
            std::fs::create_dir(ws.join(excluded)).unwrap();
            std::fs::write(ws.join(excluded).join("inside.txt"), "x").unwrap();
        }
        std::fs::write(ws.join(".secret.txt"), "x").unwrap();
        let out = resolve_glob(&glob_call("**/*"), Some(&ws)).unwrap();
        assert_eq!(out, "no files matched `**/*`\n".trim_end().to_string());
    }

    #[test]
    fn glob_reaches_an_explicitly_named_hidden_entry() {
        let (_dir, ws) = ws_dir();
        std::fs::write(ws.join(".secret.txt"), "x").unwrap();
        let out = resolve_glob(&glob_call(".secret.txt"), Some(&ws)).unwrap();
        assert_eq!(out, ".secret.txt\n");
    }

    #[test]
    fn glob_searches_under_an_explicit_path() {
        let (_dir, ws) = ws_dir();
        std::fs::create_dir_all(ws.join("data/2024")).unwrap();
        std::fs::write(ws.join("data/2024/a.csv"), "x").unwrap();
        std::fs::write(ws.join("root.csv"), "x").unwrap();
        let call = tool_use(GLOB_TOOL, json!({"pattern": "*.csv", "path": "data/2024"}));
        let out = resolve_glob(&call, Some(&ws)).unwrap();
        assert_eq!(out, "a.csv\n", "{out}");
    }

    #[test]
    fn glob_refuses_a_path_outside_the_workspace() {
        let (_dir, ws) = ws_dir();
        let call = tool_use(GLOB_TOOL, json!({"pattern": "*.txt", "path": "../outside"}));
        let err = resolve_glob(&call, Some(&ws)).unwrap_err();
        assert!(err.contains("outside the session workspace"), "{err}");
        assert!(err.contains("ingest"), "{err}");
    }

    #[test]
    fn grep_prunes_excluded_and_hidden_dirs_from_the_walk() {
        let (_dir, ws) = ws_dir();
        std::fs::create_dir_all(ws.join("node_modules")).unwrap();
        std::fs::write(ws.join("node_modules/pkg.js"), "needle\n").unwrap();
        std::fs::create_dir_all(ws.join(".hidden")).unwrap();
        std::fs::write(ws.join(".hidden/h.txt"), "needle\n").unwrap();
        std::fs::write(ws.join("ok.txt"), "needle\n").unwrap();
        let out = resolve_grep(
            &tool_use(GREP_TOOL, json!({"pattern": "needle"})),
            Some(&ws),
        )
        .unwrap();
        assert_eq!(out, "ok.txt\n", "{out}");
    }

    /// (Unix) A symlink planted inside the workspace pointing outside: the
    /// shared resolver follows the link on read and the bounds compare
    /// refuses -- the walk never lists links, but the direct path must not
    /// smuggle either (issue #1385's AC on folded-tail escapes, pinned for
    /// the read channel).
    #[test]
    #[cfg(unix)]
    fn read_refuses_a_symlink_escape() {
        let outside = TempDir::new().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        let (dir, ws) = ws_dir();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            dir.path().join("link.txt"),
        )
        .unwrap();
        let err =
            resolve_read(&tool_use(READ_TOOL, json!({"path": "link.txt"})), Some(&ws)).unwrap_err();
        assert!(err.contains("outside the session workspace"), "{err}");
    }

    /// The exclusion list governs WALK results (the AC's "do not appear in
    /// search results"); an explicit no-wildcard naming stays reachable,
    /// the same carve-out hidden files get -- a directed lookup is not a
    /// traversal result, and `read` has no exclusion semantics at all.
    #[test]
    fn glob_reaches_an_explicitly_named_excluded_entry() {
        let (_dir, ws) = ws_dir();
        std::fs::create_dir(ws.join("node_modules")).unwrap();
        std::fs::write(ws.join("node_modules/pkg.json"), "{}").unwrap();
        let out = resolve_glob(&glob_call("node_modules/pkg.json"), Some(&ws)).unwrap();
        assert_eq!(out, "node_modules/pkg.json\n");
    }

    #[test]
    fn glob_refuses_an_invalid_pattern() {
        let (_dir, ws) = ws_dir();
        let err = resolve_glob(&glob_call("[unclosed"), Some(&ws)).unwrap_err();
        assert!(err.contains("invalid glob pattern"), "{err}");
    }

    // --- grep -----------------------------------------------------------------

    #[test]
    fn grep_files_with_matches_is_the_default_mode() {
        let (_dir, ws) = ws_dir();
        std::fs::write(ws.join("a.py"), "import os\nprint(1)\n").unwrap();
        std::fs::write(ws.join("b.txt"), "nothing here\n").unwrap();
        let out = resolve_grep(&tool_use(GREP_TOOL, json!({"pattern": "os"})), Some(&ws)).unwrap();
        assert_eq!(out, "a.py\n");
    }

    #[test]
    fn grep_content_mode_carries_file_and_line() {
        let (_dir, ws) = ws_dir();
        std::fs::write(ws.join("a.py"), "one\nimport os\nthree\n").unwrap();
        let call = tool_use(
            GREP_TOOL,
            json!({"pattern": "import", "output_mode": "content"}),
        );
        let out = resolve_grep(&call, Some(&ws)).unwrap();
        assert_eq!(out, "a.py:2:import os\n");
    }

    #[test]
    fn grep_count_mode_counts_per_file() {
        let (_dir, ws) = ws_dir();
        std::fs::write(ws.join("a.py"), "os\nos\nx\n").unwrap();
        std::fs::write(ws.join("b.py"), "os\n").unwrap();
        let call = tool_use(GREP_TOOL, json!({"pattern": "os", "output_mode": "count"}));
        let out = resolve_grep(&call, Some(&ws)).unwrap();
        assert_eq!(out, "a.py:2\nb.py:1\n");
    }

    #[test]
    fn grep_filters_by_name_glob_and_searches_one_named_file() {
        let (_dir, ws) = ws_dir();
        std::fs::write(ws.join("a.py"), "match\n").unwrap();
        std::fs::write(ws.join("b.txt"), "match\n").unwrap();
        let filtered = tool_use(GREP_TOOL, json!({"pattern": "match", "glob": "*.py"}));
        assert_eq!(resolve_grep(&filtered, Some(&ws)).unwrap(), "a.py\n");
        let single = tool_use(GREP_TOOL, json!({"pattern": "match", "path": "b.txt"}));
        assert_eq!(resolve_grep(&single, Some(&ws)).unwrap(), "b.txt\n");
    }

    #[test]
    fn grep_skips_binary_and_oversized_files_with_a_count() {
        let (_dir, ws) = ws_dir();
        std::fs::write(ws.join("bin.dat"), "a\0b").unwrap();
        std::fs::write(
            ws.join("big.log"),
            vec![b'x'; (GREP_FILE_MAX_BYTES as usize) + 1],
        )
        .unwrap();
        std::fs::write(ws.join("ok.txt"), "needle\n").unwrap();
        let out = resolve_grep(
            &tool_use(GREP_TOOL, json!({"pattern": "needle|x"})),
            Some(&ws),
        )
        .unwrap();
        assert!(out.starts_with("ok.txt\n"), "{out}");
        assert!(
            out.contains("[2 files skipped: binary, oversized, or unreadable]"),
            "{out}"
        );
    }

    #[test]
    fn grep_refuses_an_invalid_regex_and_mode() {
        let (_dir, ws) = ws_dir();
        let bad_regex = tool_use(GREP_TOOL, json!({"pattern": "(unclosed"}));
        assert!(resolve_grep(&bad_regex, Some(&ws))
            .unwrap_err()
            .contains("invalid regex"));
        let bad_mode = tool_use(GREP_TOOL, json!({"pattern": "x", "output_mode": "loud"}));
        assert!(resolve_grep(&bad_mode, Some(&ws))
            .unwrap_err()
            .contains("output_mode"));
    }

    #[test]
    fn grep_refuses_a_path_outside_the_workspace() {
        let (_dir, ws) = ws_dir();
        let call = tool_use(GREP_TOOL, json!({"pattern": "x", "path": "../../etc"}));
        let err = resolve_grep(&call, Some(&ws)).unwrap_err();
        assert!(err.contains("outside the session workspace"), "{err}");
    }

    // --- read -----------------------------------------------------------------

    #[test]
    fn read_pages_with_line_numbers_from_offset_one() {
        let (_dir, ws) = ws_dir();
        std::fs::write(ws.join("n.txt"), "a\nb\nc\nd\ne\n").unwrap();
        let out = resolve_read(
            &tool_use(READ_TOOL, json!({"path": "n.txt", "offset": 2, "limit": 2})),
            Some(&ws),
        )
        .unwrap();
        assert_eq!(
            out,
            "2\tb\n3\tc\n[`n.txt` has 5 lines; continue with offset 4]\n"
        );
    }

    #[test]
    fn read_limit_is_capped_at_two_thousand_lines() {
        let (_dir, ws) = ws_dir();
        let body: String = (0..2500).map(|k| format!("line{k}\n")).collect();
        std::fs::write(ws.join("long.txt"), body).unwrap();
        let out = resolve_read(
            &tool_use(READ_TOOL, json!({"path": "long.txt", "limit": 9999})),
            Some(&ws),
        )
        .unwrap();
        let lines: Vec<&str> = out.lines().collect();
        // 2000 rendered lines (the window cap; ~23 KiB stays under the
        // byte budget) + the continue footnote.
        assert_eq!(lines.len(), READ_LINE_CAP + 1, "{out}");
        assert!(!out.contains("output truncated"), "{out}");
        assert!(
            out.contains(&format!("continue with offset {}", READ_LINE_CAP + 1)),
            "{out}"
        );
    }

    #[test]
    fn read_truncates_the_output_at_the_byte_budget() {
        let (_dir, ws) = ws_dir();
        // 60 lines x ~1.2 KiB each stays under the per-line cap but runs
        // the whole output past 50 KiB.
        let body: String = (0..60).map(|_| format!("{}\n", "y".repeat(1200))).collect();
        std::fs::write(ws.join("fat.txt"), body).unwrap();
        let out =
            resolve_read(&tool_use(READ_TOOL, json!({"path": "fat.txt"})), Some(&ws)).unwrap();
        assert!(out.contains("[output truncated at 50 KiB"), "{out}");
        assert!(out.contains("continue with offset"), "{out}");
    }

    #[test]
    fn read_truncates_long_lines_with_a_footnote() {
        let (_dir, ws) = ws_dir();
        let long = "x".repeat(READ_LINE_CHAR_CAP + 100);
        std::fs::write(ws.join("wide.txt"), format!("{long}\nshort\n")).unwrap();
        let out =
            resolve_read(&tool_use(READ_TOOL, json!({"path": "wide.txt"})), Some(&ws)).unwrap();
        let body = out.lines().next().unwrap();
        let text = body.split('\t').nth(1).unwrap();
        assert_eq!(text.chars().count(), READ_LINE_CHAR_CAP);
        // The truncation is announced, not silent (the spec's footnote AC).
        assert!(
            out.contains(&format!(
                "[1 lines truncated at {READ_LINE_CHAR_CAP} characters]"
            )),
            "{out}"
        );
    }

    #[test]
    fn read_refuses_binary_missing_directory_and_escapes() {
        let (_dir, ws) = ws_dir();
        std::fs::write(ws.join("blob.bin"), "a\0b").unwrap();
        std::fs::create_dir(ws.join("adir")).unwrap();
        let binary =
            resolve_read(&tool_use(READ_TOOL, json!({"path": "blob.bin"})), Some(&ws)).unwrap_err();
        assert!(binary.contains("NUL"), "{binary}");
        let missing =
            resolve_read(&tool_use(READ_TOOL, json!({"path": "gone.txt"})), Some(&ws)).unwrap_err();
        assert!(missing.contains("does not exist"), "{missing}");
        let dir =
            resolve_read(&tool_use(READ_TOOL, json!({"path": "adir"})), Some(&ws)).unwrap_err();
        assert!(dir.contains("directory"), "{dir}");
        let escape = resolve_read(
            &tool_use(READ_TOOL, json!({"path": "../../etc/passwd"})),
            Some(&ws),
        )
        .unwrap_err();
        assert!(escape.contains("outside the session workspace"), "{escape}");
    }

    #[test]
    fn read_offset_zero_is_refused() {
        let (_dir, ws) = ws_dir();
        std::fs::write(ws.join("a.txt"), "x\n").unwrap();
        let call = tool_use(READ_TOOL, json!({"path": "a.txt", "offset": 0}));
        assert!(resolve_read(&call, Some(&ws))
            .unwrap_err()
            .contains("positive"));
    }

    // --- family + dispatch ------------------------------------------------------

    #[test]
    fn the_family_predicate_covers_both_channels() {
        assert!(is_workspace_tool(GLOB_TOOL));
        assert!(is_workspace_tool(GREP_TOOL));
        assert!(is_workspace_tool(READ_TOOL));
        assert!(!is_discovery_tool("write"));
    }

    #[test]
    fn all_three_refuse_without_a_bound_workspace() {
        for (name, input) in [
            (GLOB_TOOL, json!({"pattern": "*"})),
            (GREP_TOOL, json!({"pattern": "x"})),
            (READ_TOOL, json!({"path": "a.txt"})),
        ] {
            let resolved = match name {
                GLOB_TOOL => resolve_glob(&tool_use(name, input), None).unwrap_err(),
                GREP_TOOL => resolve_grep(&tool_use(name, input), None).unwrap_err(),
                _ => resolve_read(&tool_use(name, input), None).unwrap_err(),
            };
            assert!(
                resolved.contains("no session workspace"),
                "{name}: {resolved}"
            );
        }
    }

    #[test]
    fn dispatch_is_ungated_and_records_both_trace_faces() {
        let (dir, ws) = ws_dir();
        std::fs::write(dir.path().join("a.txt"), "hello\n").unwrap();
        let mut fixture = DepsFixture::new(&ws);
        let phases: Mutex<Vec<TurnPhase>> = Mutex::new(Vec::new());
        let mut on_phase = |p: TurnPhase| phases.lock().unwrap().push(p);
        let (result, entry) = dispatch_readonly(
            &tool_use(GREP_TOOL, json!({"pattern": "hello"})),
            &fixture.deps(),
            &mut on_phase,
            None,
        );
        assert!(!result.is_error, "{}", result.content);
        assert_eq!(result.content, "a.txt\n");
        let entry = entry.expect("a successful read records an entry");
        assert!(entry.success);
        assert_eq!(entry.name, GREP_TOOL);
        assert_eq!(phases.lock().unwrap().len(), 2, "the phase pair fires");

        let (failing, entry) = dispatch_readonly(
            &tool_use(READ_TOOL, json!({"path": "missing.txt"})),
            &fixture.deps(),
            &mut |_| {},
            None,
        );
        assert!(failing.is_error);
        assert!(failing.content.contains("does not exist"));
        assert!(!entry.expect("a failed read records an entry").success);
    }
}
