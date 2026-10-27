//! The workspace write tools (ADR-0137, issue #1406): `write` + `edit`, the
//! sedimentation channel for model-authored files.
//!
//! Execution medium and sedimentation channel are deliberately split
//! (ADR-0108 D4): python execution keeps riding the transient file-delivery
//! pipeline, while `write` / `edit` are the model's EXPLICIT intent to leave
//! a file in the session workspace -- the first write lands a script, `edit`
//! iterates it in increments, and a later turn (or a resumed session; the
//! workspace survives) runs it with python.
//!
//! The pair follows the gated-builtin family shape (`create_skill`,
//! ADR-0122 Decision 3): mounted on the built-in runtime's table only (the
//! bridge face never lists the names and `tools::dispatch` has no arm for
//! them -- external runtimes bring their own file tools with full
//! authority), intercepted in the shared dispatch core AHEAD of
//! classification, refused on a malformed / out-of-domain / over-cap call
//! BEFORE the card (the model's error, never the approver's), and gated per
//! call with a Write badge + the write payload as card attachments (the
//! uncut snapshot rides the gate's pending slot, issue #1009, so a
//! broadcast-capped attachment still expands to the full view).
//!
//! Domain (ADR-0137): `file_path` resolves against the session workspace
//! (the bound canonical path); a path that canonicalizes outside it is
//! refused with a pointer to the other channels. A session with no bound
//! workspace (the temp-fallback domain) refuses both tools -- no lazy mint
//! from a write, no temp writes.

use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

use crate::approval::{
    ApprovalRequest, FileAttachment, GateCancelled, GateOutcome, OperationKind, ToolKey,
};
use crate::model::{Promotion, TraceEntryView, TurnPhase};
use crate::persistence::io::{write_str_atomic, WritePerms};
use crate::provider::tool_calling::{ToolDefinition, ToolResult, ToolUse};
use crate::session::loop_contract::{
    truncate_trace_excerpt, TraceEntry, DENIED_BY_GATEWAY_CONTENT, TRACE_EXCERPT_MAX,
};
use crate::session::materializer::TurnDeps;
use crate::session::turn_dispatch::GateCtx;
use crate::tools::definitions::get_str;

/// The `write` tool name (bare, snake_case params -- the Claude Code prior).
pub(crate) const WRITE_TOOL: &str = "write";

/// The `edit` tool name.
pub(crate) const EDIT_TOOL: &str = "edit";

/// Whether `name` is one of the workspace write tools -- the routing
/// predicate for the shared dispatch core's interception arm, so the arm
/// and the module agree on the family membership in one place.
pub(crate) fn is_workspace_tool(name: &str) -> bool {
    name == WRITE_TOOL || name == EDIT_TOOL
}

/// Cap on one model-emitted text payload (`content`, `old_string`,
/// `new_string`), the issue #1406 landed value: keeps one model-emitted
/// body model-sized.
const CONTENT_MAX_BYTES: usize = 50 * 1024;

/// Build the [`ToolDefinition`] for the `write` tool: whole-file replacement
/// (or creation) inside the session workspace.
pub(crate) fn write_definition() -> ToolDefinition {
    ToolDefinition {
        name: WRITE_TOOL.to_string(),
        description: "Write a UTF-8 text file into the session workspace. Creates the \
                      file (and any missing parent directories) or replaces the whole \
                      file -- this is a whole-file write, not an append. `file_path` \
                      resolves relative to the session workspace; an absolute path \
                      must land inside it. `content` is the complete file body \
                      (max 50 KiB). Each call requires approval; the content is shown \
                      on the approval card. Use `edit` for small incremental changes."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Target file path, relative to the session workspace \
                                    (or absolute inside it)."
                },
                "content": {
                    "type": "string",
                    "description": "The complete file content. UTF-8 text only, \
                                    max 50 KiB."
                }
            },
            "required": ["file_path", "content"]
        }),
    }
}

/// Build the [`ToolDefinition`] for the `edit` tool: exact-match text
/// replacement inside one workspace file.
pub(crate) fn edit_definition() -> ToolDefinition {
    ToolDefinition {
        name: EDIT_TOOL.to_string(),
        description: "Replace an exact text snippet inside one UTF-8 text file in the \
                      session workspace. `old_string` must match the file verbatim \
                      (no regex, no fuzzy matching) and must occur exactly once unless \
                      `replace_all` is true. `file_path` resolves relative to the \
                      session workspace; an absolute path must land inside it. Each \
                      call requires approval; the old and new text are shown on the \
                      approval card."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "The file to edit, relative to the session workspace \
                                    (or absolute inside it). Must already exist."
                },
                "old_string": {
                    "type": "string",
                    "description": "The exact text to replace. Must occur exactly once \
                                    unless replace_all is true."
                },
                "new_string": {
                    "type": "string",
                    "description": "The replacement text."
                },
                "replace_all": {
                    "type": "boolean",
                    "default": false,
                    "description": "Replace every occurrence of old_string instead of \
                                    requiring a unique match."
                }
            },
            "required": ["file_path", "old_string", "new_string"]
        }),
    }
}

/// What a resolver hands the dispatch arm: a refusal is the model's own tool
/// error (never surfaces a card); a gated plan carries everything the card
/// and the executor need.
enum WorkspaceToolOutcome {
    Refused(String),
    Gated(WritePlan),
}

/// One approved write, fully resolved ahead of the gate so the approver
/// signs an operation that can land: the canonical target, the final file
/// body (for `edit`, the post-replacement content), the card attachments,
/// and the summary (`file_path` as the model spelled it).
struct WritePlan {
    target: PathBuf,
    content: String,
    attachments: Vec<FileAttachment>,
    /// `Some(n)` on `edit` (the replacement count), `None` on `write`.
    replacements: Option<usize>,
    summary: String,
}

/// Fold one resolver's `Result` into the dispatch-facing outcome (the
/// shared tail of both resolvers).
fn to_outcome(resolved: Result<WritePlan, String>) -> WorkspaceToolOutcome {
    match resolved {
        Ok(plan) => WorkspaceToolOutcome::Gated(plan),
        Err(message) => WorkspaceToolOutcome::Refused(message),
    }
}

/// Resolve one `write` call against the session workspace (issue #1406).
fn resolve_write(call: &ToolUse, workspace: Option<&Path>) -> WorkspaceToolOutcome {
    let inner = || -> Result<WritePlan, String> {
        let file_path =
            get_str(&call.input, "file_path").map_err(|e| format!("{WRITE_TOOL}: {e}"))?;
        let content = get_str(&call.input, "content").map_err(|e| format!("{WRITE_TOOL}: {e}"))?;
        check_text_payload(WRITE_TOOL, "content", &content)?;
        let workspace = require_workspace(WRITE_TOOL, workspace)?;
        let target = resolve_in_workspace(workspace, &file_path)
            .map_err(|reason| format!("{WRITE_TOOL}: {reason}"))?;
        Ok(WritePlan {
            target,
            content: content.clone(),
            attachments: vec![FileAttachment {
                param: "content".into(),
                content,
            }],
            replacements: None,
            summary: file_path,
        })
    };
    to_outcome(inner())
}

/// Resolve one `edit` call against the session workspace (issue #1406). The
/// file must already exist and read as UTF-8 text; the match count is
/// settled ahead of the gate so an ambiguous or missing `old_string` is the
/// model's error, never the approver's.
fn resolve_edit(call: &ToolUse, workspace: Option<&Path>) -> WorkspaceToolOutcome {
    let inner = || -> Result<WritePlan, String> {
        let file_path =
            get_str(&call.input, "file_path").map_err(|e| format!("{EDIT_TOOL}: {e}"))?;
        let old_string =
            get_str(&call.input, "old_string").map_err(|e| format!("{EDIT_TOOL}: {e}"))?;
        let new_string =
            get_str(&call.input, "new_string").map_err(|e| format!("{EDIT_TOOL}: {e}"))?;
        let replace_all =
            get_bool(&call.input, "replace_all").map_err(|e| format!("{EDIT_TOOL}: {e}"))?;
        if old_string.is_empty() {
            return Err(format!(
                "{EDIT_TOOL}: old_string must not be empty; a whole-file \
                 rewrite is the `write` tool"
            ));
        }
        check_text_payload(EDIT_TOOL, "old_string", &old_string)?;
        check_text_payload(EDIT_TOOL, "new_string", &new_string)?;
        let workspace = require_workspace(EDIT_TOOL, workspace)?;
        let target = resolve_in_workspace(workspace, &file_path)
            .map_err(|reason| format!("{EDIT_TOOL}: {reason}"))?;
        let existing =
            read_text_file(&target).map_err(|reason| format!("{EDIT_TOOL}: {reason}"))?;
        let count = existing.match_indices(&old_string).count();
        if count == 0 {
            return Err(format!(
                "{EDIT_TOOL}: old_string was not found in {}; re-read the \
                 file and copy the exact current text",
                target.display()
            ));
        }
        if count > 1 && !replace_all {
            return Err(format!(
                "{EDIT_TOOL}: old_string matches {count} locations in {}; pass \
                 replace_all=true to replace every occurrence, or lengthen \
                 old_string until it is unique",
                target.display()
            ));
        }
        let updated = if replace_all {
            existing.replace(&old_string, &new_string)
        } else {
            existing.replacen(&old_string, &new_string, 1)
        };
        Ok(WritePlan {
            target,
            content: updated,
            attachments: vec![
                FileAttachment {
                    param: "old_string".into(),
                    content: old_string,
                },
                FileAttachment {
                    param: "new_string".into(),
                    content: new_string,
                },
            ],
            replacements: Some(if replace_all { count } else { 1 }),
            summary: file_path,
        })
    };
    to_outcome(inner())
}

/// The gated dispatch arm behind both tools (the `create_skill` ritual,
/// ADR-0122 Decision 3): refuse ahead of the card, gate per call, then
/// execute the already-resolved plan. Emits the ADR-0078 phase pair through
/// `on_phase` and records the trace entry like every dispatched call.
pub(crate) fn dispatch_workspace_tool(
    call: &ToolUse,
    deps: &TurnDeps,
    gate: &GateCtx<'_>,
    on_phase: &mut impl FnMut(TurnPhase),
    origin: Option<&str>,
) -> Result<(ToolResult, Option<TraceEntry>, Option<Promotion>), GateCancelled> {
    let workspace = deps.bound_workspace();
    let resolved = if call.name == WRITE_TOOL {
        resolve_write(call, workspace)
    } else {
        resolve_edit(call, workspace)
    };
    let mut plan = match resolved {
        WorkspaceToolOutcome::Refused(message) => {
            return Ok((
                ToolResult {
                    tool_use_id: call.id.clone(),
                    content: message,
                    is_error: true,
                },
                None,
                None,
            ));
        }
        WorkspaceToolOutcome::Gated(plan) => plan,
    };
    let gate_req = ApprovalRequest {
        key: ToolKey::builtin(call.name.as_str()),
        operation_kind: OperationKind::Write,
        summary: plan.summary.clone(),
        file_attachments: std::mem::take(&mut plan.attachments),
        // The originator annotation rides the gate like every other call's
        // (issue #934).
        origin_agent: origin.map(str::to_string),
        call_id: None,
    };
    match gate.approval.gate(gate_req, gate.sink, gate.cancel) {
        Err(cancelled) => Err(cancelled),
        Ok(GateOutcome::Denied) => {
            let entry = TraceEntry::denied(
                call.id.clone(),
                call.name.clone(),
                OperationKind::Write,
                plan.summary.clone(),
            );
            on_phase(TurnPhase::ToolCallCompleted(TraceEntryView::from(&entry)));
            Ok((
                ToolResult {
                    tool_use_id: call.id.clone(),
                    content: DENIED_BY_GATEWAY_CONTENT.to_string(),
                    is_error: true,
                },
                Some(entry),
                None,
            ))
        }
        Ok(GateOutcome::Allow) => {
            on_phase(TurnPhase::ToolCallStarted {
                id: None,
                name: call.name.clone(),
                operation_kind: OperationKind::Write,
                summary: plan.summary.clone(),
                task: None,
            });
            let (result, excerpt) = match execute(&plan, workspace) {
                Ok(payload) => (
                    ToolResult {
                        tool_use_id: call.id.clone(),
                        content: payload.to_string(),
                        is_error: false,
                    },
                    String::new(),
                ),
                Err(detail) => {
                    let message = format!("{}: {detail}", call.name);
                    (
                        ToolResult {
                            tool_use_id: call.id.clone(),
                            content: message.clone(),
                            is_error: true,
                        },
                        truncate_trace_excerpt(&message, TRACE_EXCERPT_MAX),
                    )
                }
            };
            let entry = if result.is_error {
                TraceEntry::failed(
                    call.id.clone(),
                    call.name.clone(),
                    OperationKind::Write,
                    plan.summary,
                    excerpt,
                )
            } else {
                TraceEntry::succeeded(
                    call.id.clone(),
                    call.name.clone(),
                    OperationKind::Write,
                    plan.summary,
                    excerpt,
                )
            };
            on_phase(TurnPhase::ToolCallCompleted(TraceEntryView::from(&entry)));
            Ok((result, Some(entry), None))
        }
    }
}

/// Land the approved plan: create missing parents, then one atomic
/// temp+rename write (the shared core every persisted artifact rides,
/// issue #1348 -- a crash leaves either the prior complete file or the next
/// one). The temp sibling is a fixed `<target>.tmp`, so two sessions sharing
/// a workspace and writing the SAME file concurrently race the temp like any
/// last-writer-wins file edit outside the app; the app's own single-writer
/// domains (recipe / app-config) keep their dedicated guards.
///
/// The parent is re-verified against the workspace under the approval
/// window: a symlink planted between resolve and execute must not carry
/// the temp file outside (the same escape AC, raced).
fn execute(plan: &WritePlan, workspace: Option<&Path>) -> Result<Value, String> {
    if let Some(parent) = plan.target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("creating the parent directory failed: {e}"))?;
        if let (Some(workspace), Ok(resolved)) = (workspace, std::fs::canonicalize(parent)) {
            if !resolved.starts_with(workspace) {
                return Err(format!(
                    "the target's directory {} resolved outside the session \
                     workspace during approval; re-run the call",
                    resolved.display()
                ));
            }
        }
    }
    write_str_atomic(&plan.target, &plan.content, WritePerms::Default)
        .map_err(|e| format!("writing {} failed: {e}", plan.target.display()))?;
    Ok(match plan.replacements {
        None => json!({ "path": plan.target.display().to_string() }),
        Some(count) => json!({
            "path": plan.target.display().to_string(),
            "replacements": count,
        }),
    })
}

/// The no-workspace refusal (issue #1406 triage): with no bound workspace
/// (the temp-fallback domain) both tools refuse -- a write never mints the
/// default workspace and never writes into the temp dir.
fn require_workspace<'a>(tool: &str, workspace: Option<&'a Path>) -> Result<&'a Path, String> {
    workspace.ok_or_else(|| {
        format!(
            "{tool}: no session workspace is bound; the write tools operate \
                 inside the session workspace only"
        )
    })
}

/// One text-payload guard shared by both tools: NUL marks a binary payload,
/// and the 50 KiB cap keeps one model-emitted body model-sized.
fn check_text_payload(tool: &str, field: &str, value: &str) -> Result<(), String> {
    if value.contains('\0') {
        return Err(format!(
            "{tool}: {field} contains a NUL byte; the write tools are \
             UTF-8 text only"
        ));
    }
    if value.len() > CONTENT_MAX_BYTES {
        return Err(format!(
            "{tool}: {field} is {} bytes, over the {} KiB cap; write a \
             smaller payload (split the file or apply multiple edits)",
            value.len(),
            CONTENT_MAX_BYTES / 1024
        ));
    }
    Ok(())
}

/// Read an edit target as editable text: a NUL byte or invalid UTF-8 marks
/// the file binary and refuses the edit whole.
fn read_text_file(target: &Path) -> Result<String, String> {
    let bytes =
        std::fs::read(target).map_err(|e| format!("cannot read {}: {e}", target.display()))?;
    if bytes.contains(&0) {
        return Err(format!(
            "{} contains a NUL byte; the write tools are UTF-8 text only",
            target.display()
        ));
    }
    String::from_utf8(bytes).map_err(|_| format!("{} is not valid UTF-8 text", target.display()))
}

/// Resolve a `file_path` to a canonical in-workspace target, or refuse with
/// a reason the model can self-correct from.
///
/// Relative spellings join the (already canonical) workspace. The existing
/// leaf canonicalizes whole -- following a symlink planted inside the
/// workspace to its real target, so a link cannot smuggle the write outside.
/// A not-yet-created leaf validates against its nearest EXISTING ancestor
/// (canonicalized) with the missing tail rejoined and lexically normalized
/// (`.` dropped, `..` popped): the tail's `..` components are semantically
/// resolvable against the canonical ancestor (it holds no symlinks), so a
/// `sub/../../escape.txt` spelling normalizes out of the workspace and fails
/// the compare instead of passing it lexically.
fn resolve_in_workspace(workspace: &Path, requested: &str) -> Result<PathBuf, String> {
    let candidate = if Path::new(requested).is_absolute() {
        PathBuf::from(requested)
    } else {
        workspace.join(requested)
    };
    if let Ok(existing) = std::fs::canonicalize(&candidate) {
        return leaf_check(workspace, existing, requested);
    }
    let Some((ancestor, tail)) = nearest_existing_ancestor(&candidate) else {
        return Err(format!(
            "`{requested}` cannot be resolved to an existing location; \
             use a path inside the workspace"
        ));
    };
    let joined = join_normalized(&ancestor, &tail);
    // The folded spelling can itself name an existing entity: a tail whose
    // `..` components folded down to a symlink planted inside the workspace
    // resolves whole, exactly like an existing leaf, so the compare follows
    // the link instead of the spelling (issue #1406's escape AC).
    if let Ok(existing) = std::fs::canonicalize(&joined) {
        return leaf_check(workspace, existing, requested);
    }
    // Or a not-yet-existing tail over such a link: re-anchor on the folded
    // path's own nearest existing ancestor (canonical, symlinks resolved)
    // before the compare -- the tail's normal components are links the
    // first anchor walk never saw.
    let Some((reanchor, retail)) = nearest_existing_ancestor(&joined) else {
        return Err(format!(
            "`{requested}` cannot be resolved to an existing location; \
             use a path inside the workspace"
        ));
    };
    let target = join_normalized(&reanchor, &retail);
    leaf_check(workspace, target, requested)
}

/// The shared final check for an existing (or fully re-anchored) target: a
/// file, and inside the workspace by the resolved spelling.
fn leaf_check(workspace: &Path, target: PathBuf, requested: &str) -> Result<PathBuf, String> {
    if target.is_dir() {
        return Err(format!(
            "`{requested}` resolves to a directory; name a file"
        ));
    }
    in_bounds(workspace, target, requested)
}

/// The domain check proper: component-wise containment in the canonical
/// workspace. Out of bounds, the error points at the other channels (manual
/// ingest for outside files).
fn in_bounds(workspace: &Path, resolved: PathBuf, requested: &str) -> Result<PathBuf, String> {
    if resolved.starts_with(workspace) {
        Ok(resolved)
    } else {
        Err(format!(
            "`{requested}` resolves outside the session workspace; write \
             inside the workspace, or bring an outside file in through \
             manual ingest"
        ))
    }
}

/// Walk up from `candidate` to the nearest EXISTING ancestor, returning its
/// canonical spelling plus the not-yet-existing tail to rejoin. `None` when
/// no ancestor resolves at all (an unmounted volume).
fn nearest_existing_ancestor(candidate: &Path) -> Option<(PathBuf, PathBuf)> {
    let total = candidate.components().count();
    let mut ancestor = candidate.parent()?;
    let mut depth = 1usize;
    loop {
        if let Ok(canon) = std::fs::canonicalize(ancestor) {
            let tail: PathBuf = candidate.components().skip(total - depth).collect();
            return Some((canon, tail));
        }
        depth += 1;
        ancestor = ancestor.parent()?;
    }
}

/// Rejoin `tail` onto the canonical `ancestor` with `.` / `..` lexically
/// resolved: `.` dropped, a `..` pops one normal component, and a `..` at
/// the anchor's root is a no-op (the filesystem treats a root's parent as
/// itself), matching POSIX. This is pure lexical folding -- whether the
/// result sits inside the workspace is decided by the component-wise
/// compare in `in_bounds`, never here.
fn join_normalized(ancestor: &Path, tail: &Path) -> PathBuf {
    let mut out: Vec<Component<'_>> = ancestor.components().collect();
    for component in tail.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(out.last(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            other => out.push(other),
        }
    }
    out.into_iter().collect()
}

/// The bool twin of [`get_str`]: absent or null means the parameter's
/// default, a non-bool is the shared mis-shaped-call error.
fn get_bool(input: &Value, field: &str) -> Result<bool, String> {
    match input.get(field) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(format!("parameter `{field}`: expected a boolean")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::{ApprovalRequestBody, ApprovalResponse, ApprovalSink, ApprovalState};
    use crate::cancel::CancelToken;
    use crate::session::engine::AdminEngine;
    use crate::session::materializer::{CachedDerivedRef, TurnDeps};
    use crate::session::turn_dispatch::GateCtx;
    use crate::workingset::WorkingSet;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;

    /// A canonicalized workspace tempdir -- the session's bound-path shape
    /// (canonicalize at bind, ADR-0137 Decision 1), so every starts_with
    /// compare runs against the same spelling production binds.
    fn ws_dir() -> (TempDir, PathBuf) {
        let dir = TempDir::new().unwrap();
        let canonical = std::fs::canonicalize(dir.path()).unwrap();
        (dir, canonical)
    }

    fn write_call(file_path: &str, content: &str) -> ToolUse {
        ToolUse {
            id: "t1".into(),
            name: WRITE_TOOL.into(),
            input: json!({"file_path": file_path, "content": content}),
        }
    }

    fn edit_call(file_path: &str, old: &str, new: &str) -> ToolUse {
        ToolUse {
            id: "t1".into(),
            name: EDIT_TOOL.into(),
            input: json!({"file_path": file_path, "old_string": old, "new_string": new}),
        }
    }

    fn edit_call_replace_all(file_path: &str, old: &str, new: &str) -> ToolUse {
        ToolUse {
            id: "t1".into(),
            name: EDIT_TOOL.into(),
            input: json!({
                "file_path": file_path,
                "old_string": old,
                "new_string": new,
                "replace_all": true,
            }),
        }
    }

    fn refused(outcome: WorkspaceToolOutcome) -> String {
        match outcome {
            WorkspaceToolOutcome::Refused(message) => message,
            _ => panic!("expected a refusal"),
        }
    }

    fn gated(outcome: WorkspaceToolOutcome) -> WritePlan {
        match outcome {
            WorkspaceToolOutcome::Gated(plan) => plan,
            _ => panic!("expected the gated shape"),
        }
    }

    // --- definitions --------------------------------------------------------

    /// Both tools advertise their bare names, required fields, and object
    /// schemas -- the contract every definition test in the repo pins.
    #[test]
    fn definitions_advertise_the_two_tools_with_required_fields() {
        let write = write_definition();
        assert_eq!(write.name, WRITE_TOOL);
        assert_eq!(
            write.input_schema["required"],
            json!(["file_path", "content"])
        );
        assert_eq!(write.input_schema["type"], "object");

        let edit = edit_definition();
        assert_eq!(edit.name, EDIT_TOOL);
        assert_eq!(
            edit.input_schema["required"],
            json!(["file_path", "old_string", "new_string"])
        );
        assert_eq!(
            edit.input_schema["properties"]["replace_all"]["type"],
            "boolean"
        );
    }

    // --- resolve: write -----------------------------------------------------

    /// A valid write resolves in-workspace with the requested spelling as
    /// the card summary and the body mounted as the `content` attachment.
    #[test]
    fn resolve_write_yields_the_gated_shape() {
        let (_dir, ws) = ws_dir();
        let plan = gated(resolve_write(&write_call("notes.txt", "hello"), Some(&ws)));
        assert_eq!(plan.summary, "notes.txt");
        assert_eq!(plan.attachments.len(), 1);
        assert_eq!(plan.attachments[0].param, "content");
        assert_eq!(plan.attachments[0].content, "hello");
        assert_eq!(plan.content, "hello");
        assert!(plan.target.starts_with(&ws), "{}", plan.target.display());
        assert_eq!(plan.replacements, None);
    }

    /// A not-yet-existing nested path validates against its nearest
    /// existing ancestor (the workspace) and stays in-bounds.
    #[test]
    fn resolve_write_accepts_a_new_nested_path() {
        let (_dir, ws) = ws_dir();
        let plan = gated(resolve_write(
            &write_call("scripts/deep/analyze.py", "print(1)"),
            Some(&ws),
        ));
        assert!(plan.target.starts_with(&ws), "{}", plan.target.display());
        assert_eq!(plan.target.file_name().unwrap(), "analyze.py");
    }

    /// The 50 KiB cap refuses an over-cap body with the cap named for
    /// self-correction.
    #[test]
    fn resolve_write_refuses_an_over_cap_payload() {
        let (_dir, ws) = ws_dir();
        let message = refused(resolve_write(
            &write_call("big.txt", &"x".repeat(CONTENT_MAX_BYTES + 1)),
            Some(&ws),
        ));
        assert!(message.starts_with(WRITE_TOOL), "{message}");
        assert!(message.contains("50 KiB cap"), "{message}");
    }

    #[test]
    fn resolve_write_refuses_a_nul_payload() {
        let (_dir, ws) = ws_dir();
        let message = refused(resolve_write(&write_call("bin.txt", "a\u{0}b"), Some(&ws)));
        assert!(message.contains("NUL"), "{message}");
    }

    /// A missing parameter is the shared mis-shaped-call error, prefixed
    /// with the tool name (the create_skill refusal shape).
    #[test]
    fn resolve_write_refuses_a_missing_parameter() {
        let (_dir, ws) = ws_dir();
        let message = refused(resolve_write(
            &ToolUse {
                id: "t1".into(),
                name: WRITE_TOOL.into(),
                input: json!({"file_path": "a.txt"}),
            },
            Some(&ws),
        ));
        assert!(message.contains(WRITE_TOOL), "{message}");
        assert!(message.contains("content"), "{message}");
    }

    /// A `..` escape that lands on an EXISTING outside file is caught by
    /// the whole-leaf canonicalize (the resolved path is outside).
    #[test]
    fn resolve_write_refuses_a_dotdot_escape() {
        let outside = TempDir::new().unwrap();
        let ws = ws_dir().1;
        let target_name = "escape.txt";
        std::fs::write(outside.path().join(target_name), "secret").unwrap();
        let message = refused(resolve_write(
            &write_call(&format!("../{target_name}"), "x"),
            Some(&ws),
        ));
        assert!(
            message.contains("outside the session workspace"),
            "{message}"
        );
    }

    /// A `..` smuggled through the NOT-yet-existing tail must never land
    /// outside the workspace. The legs differ per platform (probe-verified):
    /// on Windows a verbatim base folds `sub\..` inside `Path::join`, so the
    /// folded spelling anchors its existing ancestor OUTSIDE the workspace;
    /// on unix `join` keeps the `..` and the ancestor walk reaches the
    /// workspace with `sub/../..` still in the tail, where the lexical
    /// normalization pops past it. Both legs must refuse.
    #[test]
    fn resolve_write_refuses_a_lexical_smuggle_through_the_missing_tail() {
        let (_dir, ws) = ws_dir();
        for path in ["sub/../../escape.txt", "a/b/../../../escape.txt"] {
            let message = refused(resolve_write(&write_call(path, "x"), Some(&ws)));
            assert!(
                message.contains("outside the session workspace"),
                "`{path}`: {message}"
            );
        }
    }

    /// The fold must not over-reach: `sub/./../x.txt` semantically IS
    /// `x.txt` in the workspace, and resolves in-bounds (the folding is
    /// normalization, not suspicion).
    #[test]
    fn resolve_write_folds_a_dot_dot_pair_that_lands_inside() {
        let (_dir, ws) = ws_dir();
        let plan = gated(resolve_write(&write_call("sub/./../x.txt", "x"), Some(&ws)));
        assert_eq!(plan.target.file_name().unwrap(), "x.txt");
        assert!(plan.target.starts_with(&ws), "{}", plan.target.display());
    }

    /// (Windows) An UNFOLDED verbatim `..\..` tail -- a model-supplied
    /// absolute spelling `Path::join` never touched. Verbatim plus a
    /// missing `sub` fails canonicalize all the way down (probe-verified:
    /// NotFound, no lexical folding), so the ancestor walk anchors at the
    /// workspace with `sub/../..` still in the tail and the lexical
    /// normalization must pop past it. This is the Windows-reachable pin
    /// for the join_normalized leg; the folded-join samples above reach it
    /// only on unix.
    #[test]
    #[cfg(windows)]
    fn resolve_write_refuses_an_unfolded_verbatim_dotdot_tail() {
        let (_dir, ws) = ws_dir();
        let raw = format!("{}\\sub\\..\\..\\escape.txt", ws.display());
        let message = refused(resolve_write(&write_call(&raw, "x"), Some(&ws)));
        assert!(
            message.contains("outside the session workspace"),
            "{message}"
        );
    }

    #[test]
    fn resolve_write_refuses_an_absolute_outside_path() {
        let outside = TempDir::new().unwrap();
        let (_dir, ws) = ws_dir();
        let message = refused(resolve_write(
            &write_call(&outside.path().join("elsewhere.txt").to_string_lossy(), "x"),
            Some(&ws),
        ));
        assert!(
            message.contains("outside the session workspace"),
            "{message}"
        );
    }

    /// An absolute spelling that lands inside the workspace passes -- the
    /// domain is containment, not the relative form.
    #[test]
    fn resolve_write_accepts_an_absolute_inside_path() {
        let (_dir, ws) = ws_dir();
        let absolute = ws.join("abs.txt");
        let plan = gated(resolve_write(
            &write_call(&absolute.to_string_lossy(), "x"),
            Some(&ws),
        ));
        assert_eq!(plan.target, absolute);
    }

    /// The workspace itself (or any directory) is not a writable target --
    /// including a spelling whose missing prefix folds down to one.
    #[test]
    fn resolve_write_refuses_a_directory_target() {
        let (dir, ws) = ws_dir();
        std::fs::create_dir_all(dir.path().join("sub")).unwrap();
        for path in [".", "sub", "missing/../sub"] {
            let message = refused(resolve_write(&write_call(path, "x"), Some(&ws)));
            assert!(message.contains("directory"), "`{path}`: {message}");
        }
    }

    /// An in-workspace symlink pointing outside: the whole-leaf
    /// canonicalize resolves the link to its real target and the compare
    /// fails -- a planted link cannot smuggle the write.
    #[test]
    #[cfg(unix)]
    fn resolve_write_refuses_a_symlink_escape() {
        use std::os::unix::fs::symlink;
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("secret.txt");
        std::fs::write(&outside_file, "secret").unwrap();
        let (dir, ws) = ws_dir();
        symlink(&outside_file, dir.path().join("alias.txt")).unwrap();
        let message = refused(resolve_write(&write_call("alias.txt", "x"), Some(&ws)));
        assert!(
            message.contains("outside the session workspace"),
            "{message}"
        );
    }

    /// The same planted link reached through a folded spelling: a missing
    /// prefix plus a `..` folds down to the link name, and the folded
    /// spelling -- whether it lands ON the link or a not-yet-existing tail
    /// UNDER it -- must resolve through the link and fail the compare, not
    /// pass it lexically (the review-found bypass).
    #[test]
    #[cfg(unix)]
    fn resolve_write_refuses_a_symlink_escape_through_a_folded_tail() {
        use std::os::unix::fs::symlink;
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("secret.txt");
        std::fs::write(&outside_file, "secret").unwrap();
        let (dir, ws) = ws_dir();
        symlink(&outside_file, dir.path().join("alias.txt")).unwrap();
        for path in ["missing/../alias.txt", "missing/../alias.txt/new.txt"] {
            let message = refused(resolve_write(&write_call(path, "x"), Some(&ws)));
            assert!(
                message.contains("outside the session workspace"),
                "`{path}`: {message}"
            );
        }
    }

    /// (Windows) Create a junction (no privilege needed, unlike a true
    /// symlink) via the shell's `mklink /J` -- the test-only local analog
    /// of the unix symlink pins.
    #[cfg(windows)]
    fn mklink_junction(link: &std::path::Path, target: &std::path::Path) -> std::io::Result<()> {
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()?;
        if output.status.success() {
            Ok(())
        } else {
            Err(std::io::Error::other(format!(
                "mklink /J failed: {}",
                String::from_utf8_lossy(&output.stderr)
            )))
        }
    }

    /// (Windows) The folded-tail escape on the junction analog of a
    /// symlink: a missing prefix plus a `..` folds down to a junction
    /// planted inside the workspace, and whether the folded spelling lands
    /// ON the link or a not-yet-existing tail UNDER it, the resolve must
    /// follow the junction and fail the compare -- not pass it lexically
    /// (the review-found bypass; junctions need no privilege to create, so
    /// this leg pins the fix locally, not only on CI).
    #[test]
    #[cfg(windows)]
    fn resolve_write_refuses_a_junction_escape_through_a_folded_tail() {
        let outside = TempDir::new().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        let (dir, ws) = ws_dir();
        mklink_junction(&dir.path().join("alias_dir"), outside.path()).unwrap();
        // A not-yet-existing tail under the folded-down junction: the
        // folded spelling resolves through the junction and the compare
        // fails. A RELATIVE spelling gets pre-folded by `Path::join`
        // itself (probe-verified: join lexically folds `missing/..`), so
        // the tail-folding leg is only reachable through an ABSOLUTE
        // spelling that keeps its `..` components verbatim.
        let absolute = format!("{}\\missing\\..\\alias_dir\\new.txt", ws.to_string_lossy());
        let message = refused(resolve_write(&write_call(&absolute, "x"), Some(&ws)));
        assert!(
            message.contains("outside the session workspace"),
            "{message}"
        );
        // The relative spelling still names the junction's tail: the
        // direct candidate leg resolves the junction too.
        let message = refused(resolve_write(
            &write_call("alias_dir/new.txt", "x"),
            Some(&ws),
        ));
        assert!(
            message.contains("outside the session workspace"),
            "{message}"
        );
        // The fold landing ON the junction: a directory target, refused
        // as one.
        let message = refused(resolve_write(
            &write_call("missing/../alias_dir", "x"),
            Some(&ws),
        ));
        assert!(message.contains("directory"), "{message}");
    }

    /// (Windows) A junction planted during the approval window under the
    /// target's parent directory: execute re-verifies the parent against
    /// the workspace and refuses -- the race cannot carry the temp file
    /// outside.
    #[test]
    #[cfg(windows)]
    fn dispatch_refuses_when_a_parent_becomes_a_junction_during_approval() {
        let mut fixture = DepsFixture::new();
        std::fs::create_dir(fixture.workspace_dir.path().join("pkg")).unwrap();
        let outside = TempDir::new().unwrap();
        let ws_root = fixture.workspace_dir.path().to_path_buf();
        let outside_root = outside.path().to_path_buf();
        let approval = Arc::new(ApprovalState::new());
        let sink = Arc::new(RecordingSink::default());
        let cancel = CancelToken::new();
        let approval_c = Arc::clone(&approval);
        let sink_c = Arc::clone(&sink);
        let responder = std::thread::spawn(move || {
            let body = poll_body(&sink_c, std::time::Duration::from_secs(2))
                .expect("the gate emitted an approval request");
            // The approval window: swap the target's parent directory for
            // a junction pointing outside. Any swap failure still answers
            // (deny) so the parked gate never deadlocks; the assertions
            // below then fail on the wrong outcome instead of hanging.
            let swapped = (|| {
                std::fs::rename(ws_root.join("pkg"), outside_root.join("pkg"))?;
                mklink_junction(&ws_root.join("pkg"), &outside_root.join("pkg"))
            })();
            if swapped.is_err() {
                eprintln!("junction swap failed: {swapped:?}");
            }
            let id = uuid::Uuid::parse_str(&body.request_id).expect("request id parses");
            let answer = if swapped.is_ok() {
                ApprovalResponse::AllowOnce
            } else {
                ApprovalResponse::Deny
            };
            approval_c.respond(id, answer).expect("respond ok");
        });
        let gate = GateCtx {
            approval: &approval,
            sink: &*sink,
            cancel: &cancel,
        };
        let phases = Mutex::new(Vec::new());
        let mut on_phase = |p: TurnPhase| phases.lock().unwrap().push(p);
        let outcome = dispatch_workspace_tool(
            &write_call("pkg/script.py", "print('ok')"),
            &fixture.deps(),
            &gate,
            &mut on_phase,
            None,
        );
        responder.join().expect("responder thread");
        let (result, entry, _) = outcome.expect("the dispatch completes");
        assert!(result.is_error, "{}", result.content);
        assert!(
            result
                .content
                .contains("outside the session workspace during approval"),
            "{}",
            result.content
        );
        assert!(
            !outside.path().join("pkg/script.py").exists(),
            "nothing landed outside the workspace"
        );
        assert!(!entry.expect("a failed execute records an entry").success);
    }

    /// (Windows) A verbatim `\\?\` spelling of an in-workspace path -- the
    /// form std::fs::canonicalize itself returns -- stays in-bounds: issue
    /// #1406's AC that the prefix spelling does not break the domain check.
    #[test]
    #[cfg(windows)]
    fn resolve_write_accepts_a_verbatim_workspace_spelling() {
        let (_dir, ws) = ws_dir();
        // `ws` is already the verbatim canonical form on Windows; write
        // through that exact spelling plus the file name.
        let verbatim = ws.join("verbatim.txt");
        let plan = gated(resolve_write(
            &write_call(&verbatim.to_string_lossy(), "x"),
            Some(&ws),
        ));
        assert_eq!(plan.target, verbatim);
    }

    /// (Windows) A verbatim spelling whose DIRECTORY-segment case differs
    /// from the disk still canonicalizes to the corrected form (probe-
    /// verified: verbatim + wrong case resolves Ok, not NotFound) -- the
    /// case drift must not break the domain check on an in-workspace path.
    /// This is issue #1406's AC leg "the prefix spelling difference does
    /// not break the domain check (in-bounds still passes)".
    #[test]
    #[cfg(windows)]
    fn resolve_write_normalizes_a_verbatim_case_misspelling() {
        let (dir, ws) = ws_dir();
        let spelling = ws.to_string_lossy().into_owned();
        // Flip the case of one alphabetic character inside a real DIRECTORY
        // segment (beyond the `\\?\C:\` prefix), then address a file under
        // the misspelled directory.
        let mut flipped = spelling.clone();
        let dir_part = &spelling[..spelling.rfind('\\').unwrap_or(spelling.len())];
        if let Some((i, c)) = dir_part
            .char_indices()
            .find(|(i, c)| *i > 4 && c.is_alphabetic() && c.is_uppercase())
        {
            flipped = format!(
                "{}{}{}",
                &spelling[..i],
                c.to_lowercase().next().unwrap(),
                &spelling[i + c.len_utf8()..]
            );
        }
        if flipped == spelling {
            eprintln!("skipped: no uppercase directory segment to flip");
            return;
        }
        let plan = gated(resolve_write(
            &write_call(&format!("{flipped}\\probe.txt"), "x"),
            Some(&ws),
        ));
        // The plan canonicalizes back to the on-disk spelling.
        assert_eq!(plan.target, ws.join("probe.txt"));
        let _ = dir;
    }

    // --- resolve: edit ------------------------------------------------------

    /// A unique match produces the post-replacement body plus the old/new
    /// pair as card attachments.
    #[test]
    fn resolve_edit_replaces_a_unique_match() {
        let (dir, ws) = ws_dir();
        std::fs::write(dir.path().join("s.py"), "a = 1\nb = 2\n").unwrap();
        let plan = gated(resolve_edit(
            &edit_call("s.py", "a = 1", "a = 11"),
            Some(&ws),
        ));
        assert_eq!(plan.content, "a = 11\nb = 2\n");
        assert_eq!(plan.replacements, Some(1));
        assert_eq!(plan.summary, "s.py");
        assert_eq!(plan.attachments.len(), 2);
        assert_eq!(plan.attachments[0].param, "old_string");
        assert_eq!(plan.attachments[0].content, "a = 1");
        assert_eq!(plan.attachments[1].param, "new_string");
        assert_eq!(plan.attachments[1].content, "a = 11");
    }

    #[test]
    fn resolve_edit_replaces_every_match_with_replace_all() {
        let (dir, ws) = ws_dir();
        std::fs::write(dir.path().join("s.py"), "x, x, x\n").unwrap();
        let plan = gated(resolve_edit(
            &edit_call_replace_all("s.py", "x", "y"),
            Some(&ws),
        ));
        assert_eq!(plan.content, "y, y, y\n");
        assert_eq!(plan.replacements, Some(3));
    }

    #[test]
    fn resolve_edit_refuses_a_missing_match() {
        let (dir, ws) = ws_dir();
        std::fs::write(dir.path().join("s.py"), "a = 1\n").unwrap();
        let message = refused(resolve_edit(&edit_call("s.py", "zzz", "y"), Some(&ws)));
        assert!(message.starts_with(EDIT_TOOL), "{message}");
        assert!(message.contains("not found"), "{message}");
    }

    /// An ambiguous match without replace_all names the count and the
    /// self-correction levers (replace_all or a longer old_string).
    #[test]
    fn resolve_edit_refuses_an_ambiguous_match() {
        let (dir, ws) = ws_dir();
        std::fs::write(dir.path().join("s.py"), "a = 1\na = 2\n").unwrap();
        let message = refused(resolve_edit(&edit_call("s.py", "a =", "b ="), Some(&ws)));
        assert!(message.contains("2 locations"), "{message}");
        assert!(message.contains("replace_all"), "{message}");
    }

    #[test]
    fn resolve_edit_refuses_an_empty_old_string() {
        let (dir, ws) = ws_dir();
        std::fs::write(dir.path().join("s.py"), "a\n").unwrap();
        let message = refused(resolve_edit(&edit_call("s.py", "", "y"), Some(&ws)));
        assert!(message.contains("must not be empty"), "{message}");
    }

    #[test]
    fn resolve_edit_refuses_a_binary_file() {
        let (dir, ws) = ws_dir();
        std::fs::write(dir.path().join("blob.bin"), b"a\0b").unwrap();
        let message = refused(resolve_edit(&edit_call("blob.bin", "a", "y"), Some(&ws)));
        assert!(message.contains("NUL"), "{message}");
    }

    #[test]
    fn resolve_edit_refuses_a_non_utf8_file() {
        let (dir, ws) = ws_dir();
        std::fs::write(dir.path().join("raw.txt"), b"\xFF\xFE").unwrap();
        let message = refused(resolve_edit(&edit_call("raw.txt", "a", "y"), Some(&ws)));
        assert!(message.contains("UTF-8"), "{message}");
    }

    #[test]
    fn resolve_edit_refuses_a_missing_file() {
        let (_dir, ws) = ws_dir();
        let message = refused(resolve_edit(&edit_call("ghost.py", "a", "y"), Some(&ws)));
        assert!(message.contains("cannot read"), "{message}");
    }

    // --- resolve: the no-workspace domain -----------------------------------

    /// With no bound workspace (the temp-fallback domain) both tools
    /// refuse -- no mint, no temp write (the #1406 triage lock).
    #[test]
    fn both_tools_refuse_without_a_workspace() {
        for (tool, outcome) in [
            (WRITE_TOOL, resolve_write(&write_call("a.txt", "x"), None)),
            (EDIT_TOOL, resolve_edit(&edit_call("a.txt", "a", "b"), None)),
        ] {
            let message = refused(outcome);
            assert!(message.starts_with(tool), "{message}");
            assert!(message.contains("no session workspace"), "{message}");
        }
    }

    // --- dispatch: gate + execution -----------------------------------------

    /// A TurnDeps with the workspace axis connected, mirroring the
    /// production shape the dispatch arm reads.
    struct DepsFixture {
        engine: AdminEngine,
        working_set: WorkingSet,
        sources: HashMap<String, PathBuf>,
        refs: HashMap<String, CachedDerivedRef>,
        temp: TempDir,
        workspace_dir: TempDir,
        slot: Option<PathBuf>,
    }

    impl DepsFixture {
        fn new() -> Self {
            let workspace_dir = TempDir::new().unwrap();
            let slot = Some(std::fs::canonicalize(workspace_dir.path()).unwrap());
            Self {
                engine: AdminEngine::materialized(),
                working_set: WorkingSet::default(),
                sources: HashMap::new(),
                refs: HashMap::new(),
                temp: TempDir::new().unwrap(),
                workspace_dir,
                slot,
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

    #[derive(Default)]
    struct RecordingSink {
        bodies: Mutex<Vec<ApprovalRequestBody>>,
    }

    impl ApprovalSink for RecordingSink {
        fn emit_request(&self, body: &ApprovalRequestBody) {
            self.bodies.lock().unwrap().push(body.clone());
        }
        fn emit_resolved(&self, _body: &ApprovalRequestBody, _response: ApprovalResponse) {}
    }

    fn poll_body(
        sink: &RecordingSink,
        timeout: std::time::Duration,
    ) -> Option<ApprovalRequestBody> {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if let Some(body) = sink.bodies.lock().unwrap().first() {
                return Some(body.clone());
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        None
    }

    /// Drive one call through the dispatch arm with a background responder
    /// answering the card, returning (result, entry, phases, card body).
    #[allow(clippy::type_complexity)]
    fn run_dispatch(
        call: &ToolUse,
        fixture: &mut DepsFixture,
        answer: ApprovalResponse,
    ) -> (
        crate::provider::tool_calling::ToolResult,
        Option<TraceEntry>,
        Vec<TurnPhase>,
        Option<ApprovalRequestBody>,
    ) {
        let approval = Arc::new(ApprovalState::new());
        let sink = Arc::new(RecordingSink::default());
        let cancel = CancelToken::new();
        let approval_c = Arc::clone(&approval);
        let sink_c = Arc::clone(&sink);
        let responder = std::thread::spawn(move || {
            let body = poll_body(&sink_c, std::time::Duration::from_secs(2))
                .expect("the gate emitted an approval request");
            let id = uuid::Uuid::parse_str(&body.request_id).expect("request id parses");
            approval_c.respond(id, answer).expect("respond ok");
        });
        let gate = GateCtx {
            approval: &approval,
            sink: &*sink,
            cancel: &cancel,
        };
        let phases = Mutex::new(Vec::new());
        let mut on_phase = |p: TurnPhase| phases.lock().unwrap().push(p);
        let outcome = dispatch_workspace_tool(call, &fixture.deps(), &gate, &mut on_phase, None);
        responder.join().expect("responder thread");
        let (result, entry, promotion) = outcome.expect("the dispatch completes");
        assert!(promotion.is_none(), "the write tools never promote");
        let phases = phases.into_inner().unwrap();
        let body = sink.bodies.lock().unwrap().first().cloned();
        (result, entry, phases, body)
    }

    /// An allowed write lands the file (creating parents), returns the
    /// canonical path as JSON, and emits the started/completed pair.
    #[test]
    fn dispatch_writes_the_file_after_allow() {
        let mut fixture = DepsFixture::new();
        let (result, entry, phases, body) = run_dispatch(
            &write_call("scripts/analyze.py", "print('ok')"),
            &mut fixture,
            ApprovalResponse::AllowOnce,
        );
        assert!(!result.is_error, "{}", result.content);
        let written =
            std::fs::read_to_string(fixture.workspace_dir.path().join("scripts/analyze.py"))
                .expect("the approved write landed");
        assert_eq!(written, "print('ok')");
        let payload: Value = serde_json::from_str(&result.content).expect("JSON payload");
        let expected =
            std::fs::canonicalize(fixture.workspace_dir.path().join("scripts/analyze.py")).unwrap();
        assert_eq!(payload["path"], expected.to_string_lossy().as_ref());
        let entry = entry.expect("a dispatched call records an entry");
        assert!(entry.success);
        assert_eq!(entry.operation_kind, OperationKind::Write);
        assert_eq!(phases.len(), 2, "started + completed");
        assert!(matches!(phases[0], TurnPhase::ToolCallStarted { .. }));
        assert!(matches!(phases[1], TurnPhase::ToolCallCompleted { .. }));
        let body = body.expect("the card surfaced");
        assert_eq!(body.tool, WRITE_TOOL);
        assert_eq!(body.server, "builtin");
        assert_eq!(body.operation_kind, OperationKind::Write);
        // The card carries the whole `content` as its attachment (the
        // approver sees the exact bytes that will land).
        let attachment = body
            .file_attachments
            .iter()
            .find(|a| a.param == "content")
            .expect("a content attachment");
        assert_eq!(attachment.content, "print('ok')");
    }

    /// `write` over an existing file replaces it whole: the prior body is
    /// gone, not appended to (the tool's one-line contract).
    #[test]
    fn dispatch_replaces_a_whole_existing_file() {
        let mut fixture = DepsFixture::new();
        let target = fixture.workspace_dir.path().join("draft.py");
        std::fs::write(&target, "old line one\nold line two\n").unwrap();
        let (result, entry, _, _) = run_dispatch(
            &write_call("draft.py", "print('new')"),
            &mut fixture,
            ApprovalResponse::AllowOnce,
        );
        assert!(!result.is_error, "{}", result.content);
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "print('new')",
            "the write replaces the whole prior body"
        );
        assert!(!std::fs::read_to_string(&target)
            .unwrap()
            .contains("old line"));
        assert!(entry.expect("an approved write records an entry").success);
    }

    /// A denial never writes: the file stays absent, the result is the
    /// shared denial content, and the trace entry is the denied shape.
    #[test]
    fn dispatch_denies_without_writing() {
        let mut fixture = DepsFixture::new();
        let (result, entry, phases, _) = run_dispatch(
            &write_call("never.txt", "x"),
            &mut fixture,
            ApprovalResponse::Deny,
        );
        assert!(result.is_error);
        assert_eq!(result.content, DENIED_BY_GATEWAY_CONTENT);
        assert!(!fixture.workspace_dir.path().join("never.txt").exists());
        let entry = entry.expect("a denial records an entry");
        assert!(!entry.success);
        assert_eq!(entry.operation_kind, OperationKind::Write);
        // No started event for a denied call -- only the completion flips
        // the pending card to its resolved-deny row (ADR-0078).
        assert_eq!(phases.len(), 1);
        assert!(matches!(phases[0], TurnPhase::ToolCallCompleted { .. }));
    }

    /// An edit call's card carries the old/new pair as attachments (the
    /// approver sees the exact transformation), and an allowed edit lands
    /// the replacement.
    #[test]
    fn dispatch_mounts_the_edit_pair_as_card_attachments() {
        let mut fixture = DepsFixture::new();
        std::fs::write(fixture.workspace_dir.path().join("s.py"), "a = 1\n").unwrap();
        let (result, entry, _, body) = run_dispatch(
            &edit_call("s.py", "a = 1", "a = 11"),
            &mut fixture,
            ApprovalResponse::AllowOnce,
        );
        assert!(!result.is_error, "{}", result.content);
        assert_eq!(
            std::fs::read_to_string(fixture.workspace_dir.path().join("s.py")).unwrap(),
            "a = 11\n"
        );
        let entry = entry.expect("an approved edit records an entry");
        assert!(entry.success);
        let body = body.expect("the card surfaced");
        assert_eq!(body.tool, EDIT_TOOL);
        let params: Vec<&str> = body
            .file_attachments
            .iter()
            .map(|a| a.param.as_str())
            .collect();
        assert_eq!(params, vec!["old_string", "new_string"]);
    }

    /// A resolution failure (here: no bound workspace) surfaces the model's
    /// error with NO card -- the approver never sees an operation that
    /// cannot land -- and nothing lands anywhere (neither the workspace nor
    /// the temp dir).
    #[test]
    fn dispatch_refuses_without_a_workspace_and_writes_nothing() {
        let mut fixture = DepsFixture::new();
        fixture.slot = None;
        let approval = Arc::new(ApprovalState::new());
        let sink = Arc::new(RecordingSink::default());
        let cancel = CancelToken::new();
        let gate = GateCtx {
            approval: &approval,
            sink: &*sink,
            cancel: &cancel,
        };
        let phases = Mutex::new(Vec::new());
        let mut on_phase = |p: TurnPhase| phases.lock().unwrap().push(p);
        let (result, entry, promotion) = dispatch_workspace_tool(
            &write_call("a.txt", "x"),
            &fixture.deps(),
            &gate,
            &mut on_phase,
            None,
        )
        .expect("a refusal is a tool result, not an abort");
        assert!(result.is_error);
        assert!(
            result.content.contains("no session workspace"),
            "{}",
            result.content
        );
        assert!(entry.is_none(), "a pre-gate refusal records no trace entry");
        assert!(promotion.is_none());
        assert_eq!(sink.bodies.lock().unwrap().len(), 0, "no card is emitted");
        assert!(
            fixture.temp.path().read_dir().unwrap().next().is_none(),
            "nothing lands in temp"
        );
        assert_eq!(
            fixture.workspace_dir.path().read_dir().unwrap().count(),
            0,
            "nothing lands in the workspace"
        );
    }

    /// The over-cap attachment leg on the write tools' own face (AC5): a
    /// body over the 4 KiB broadcast cap rides the card capped to exactly
    /// the cap with the visible ellipsis, while the gate's pending slot
    /// serves the UNcut original for the card's expand view (issue #1009)
    /// -- asserted while the gate is still parked, before the responder
    /// answers.
    #[test]
    fn dispatch_caps_an_overlong_attachment_but_serves_the_full_snapshot() {
        use crate::approval::FILE_ATTACHMENT_MAX_CHARS;
        let mut fixture = DepsFixture::new();
        let payload = "y".repeat(FILE_ATTACHMENT_MAX_CHARS + 512);
        let approval = Arc::new(ApprovalState::new());
        let sink = Arc::new(RecordingSink::default());
        let cancel = CancelToken::new();
        let approval_c = Arc::clone(&approval);
        let sink_c = Arc::clone(&sink);
        let expected = payload.clone();
        let responder = std::thread::spawn(move || {
            let body = poll_body(&sink_c, std::time::Duration::from_secs(2))
                .expect("the gate emitted an approval request");
            // The broadcast copy is capped to the visible budget...
            assert_eq!(body.file_attachments.len(), 1);
            assert_eq!(
                body.file_attachments[0].content.chars().count(),
                FILE_ATTACHMENT_MAX_CHARS,
                "an over-cap content truncates to exactly the cap"
            );
            assert!(
                body.file_attachments[0].content.ends_with("..."),
                "the cut is visible (the ellipsis), never silent"
            );
            // ...while the pending slot still serves the uncut original.
            let id = uuid::Uuid::parse_str(&body.request_id).expect("request id parses");
            let pending = approval_c
                .pending_attachments(id)
                .expect("pending snapshot");
            assert_eq!(pending.len(), 1);
            assert_eq!(
                pending[0].content, expected,
                "the full body outlives the cap"
            );
            approval_c
                .respond(id, ApprovalResponse::AllowOnce)
                .expect("respond ok");
        });
        let gate = GateCtx {
            approval: &approval,
            sink: &*sink,
            cancel: &cancel,
        };
        let phases = Mutex::new(Vec::new());
        let mut on_phase = |p: TurnPhase| phases.lock().unwrap().push(p);
        let (result, _, _) = dispatch_workspace_tool(
            &write_call("big.txt", &payload),
            &fixture.deps(),
            &gate,
            &mut on_phase,
            None,
        )
        .expect("the dispatch completes");
        responder.join().expect("responder thread");
        assert!(!result.is_error, "{}", result.content);
        let phases = phases.into_inner().unwrap();
        assert_eq!(phases.len(), 2);
    }
}
